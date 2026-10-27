/**
 * Estimated capacity: how many tokens a credential's limit window holds, from
 * the tokens the ledger saw since the window last reset and the percent the
 * provider says is used. Tokens per 1% times 100 is the window's capacity; a
 * provider's pool is the sum over its accounts.
 *
 * Providers meter limits in units they don't publish, and traffic outside the
 * proxy counts against the window but not the ledger, so every figure here is
 * an estimate. Early in a window a few percent can't be told from rounding, so
 * nothing is estimated below CAPACITY_MIN_USED_PERCENT.
 */

import type { HeadroomWindow } from '@/features/quota/headroom';
import type { UsagePrices, UsageWindowResult } from '@/services/api/usageLedger';
import { HOUR_MS } from '@/utils/time/durations';
import { valueOfModelRows } from './cost';

export const CAPACITY_MIN_USED_PERCENT = 5;

/**
 * The window capacity is read from: the longest one with a known reset and
 * length (the weekly limit where there is one), since a short window's few
 * minutes of traffic give the noisiest ratio.
 */
export function capacityWindow(windows: readonly HeadroomWindow[]): HeadroomWindow | null {
  let best: HeadroomWindow | null = null;
  windows.forEach((window) => {
    if (window.resetAtMs === null || !window.periodHours || window.periodHours <= 0) return;
    if (!best || window.periodHours > (best.periodHours ?? 0)) best = window;
  });
  return best;
}

/** When the window last reset: its next reset minus its length. */
export function windowStartMs(window: HeadroomWindow): number | null {
  if (window.resetAtMs === null || !window.periodHours) return null;
  return window.resetAtMs - window.periodHours * HOUR_MS;
}

export interface AccountCapacity {
  authIndex: string;
  window: HeadroomWindow;
  usedPercent: number;
  tokensSinceReset: number;
  valueSinceResetUsd: number;
  /** Null below the minimum used percent, where the ratio is noise. */
  tokensPerPercent: number | null;
  capacityTokens: number | null;
  tokensLeft: number | null;
  valueLeftUsd: number | null;
  /** The ledger answered from hourly rows, so the reset instant was rounded. */
  approximate: boolean;
}

export function estimateAccountCapacity(
  window: HeadroomWindow,
  result: UsageWindowResult,
  provider: string | null,
  prices: UsagePrices | null
): AccountCapacity {
  const tokens = result.tokens.total;
  const valueUsd = valueOfModelRows(result.byModel, provider, prices).usd;
  const usedPercent = Math.min(100, Math.max(0, window.usedPercent));
  const base = {
    authIndex: result.authIndex,
    window,
    usedPercent,
    tokensSinceReset: tokens,
    valueSinceResetUsd: valueUsd,
    approximate: result.approximate,
  };
  if (usedPercent < CAPACITY_MIN_USED_PERCENT || tokens <= 0) {
    return {
      ...base,
      tokensPerPercent: null,
      capacityTokens: null,
      tokensLeft: null,
      valueLeftUsd: null,
    };
  }
  const tokensPerPercent = tokens / usedPercent;
  const capacityTokens = tokensPerPercent * 100;
  const tokensLeft = Math.max(0, capacityTokens - tokens);
  return {
    ...base,
    tokensPerPercent,
    capacityTokens,
    tokensLeft,
    valueLeftUsd: (valueUsd / tokens) * tokensLeft,
  };
}

export interface PoolCapacity {
  /** Accounts with an estimate; the others are counted in `unestimated`. */
  estimated: AccountCapacity[];
  unestimated: number;
  capacityTokens: number;
  tokensUsed: number;
  tokensLeft: number;
  valueLeftUsd: number;
  /** Share of the pooled capacity used, 0–100. */
  usedPercent: number;
}

/**
 * Pools the accounts that have an estimate on the same window length (the
 * longest one present), since a 5-hour capacity can't be added to a weekly one.
 * Null when no account has an estimate.
 */
export function poolCapacity(accounts: readonly AccountCapacity[]): PoolCapacity | null {
  const withEstimate = accounts.filter((account) => account.capacityTokens !== null);
  if (withEstimate.length === 0) return null;
  const periodHours = Math.max(...withEstimate.map((account) => account.window.periodHours ?? 0));
  const estimated = withEstimate.filter(
    (account) => (account.window.periodHours ?? 0) === periodHours
  );
  const capacityTokens = estimated.reduce((sum, account) => sum + (account.capacityTokens ?? 0), 0);
  const tokensUsed = estimated.reduce((sum, account) => sum + account.tokensSinceReset, 0);
  return {
    estimated,
    unestimated: accounts.length - estimated.length,
    capacityTokens,
    tokensUsed,
    tokensLeft: estimated.reduce((sum, account) => sum + (account.tokensLeft ?? 0), 0),
    valueLeftUsd: estimated.reduce((sum, account) => sum + (account.valueLeftUsd ?? 0), 0),
    usedPercent: capacityTokens > 0 ? Math.min(100, (tokensUsed / capacityTokens) * 100) : 0,
  };
}
