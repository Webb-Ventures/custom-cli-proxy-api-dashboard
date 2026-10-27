/**
 * Accounts already signed in per OAuth provider, with the most constrained
 * one's tightest limit, so the login gallery shows what each provider has left.
 */

import type { BuiltInOAuthProvider } from '@/services/api';
import type { SummarizedHeadroom } from '@/features/quota/freshness';
import {
  compareHeadroomPressure,
  type HeadroomSummary,
  type HeadroomWindow,
} from '@/features/quota/headroom';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaProviderType } from '@/features/quota/providers/types';

/** Kimi's two sites share one credential type, so neither tile can claim its accounts. */
export const OAUTH_QUOTA_TYPES: Partial<Record<BuiltInOAuthProvider, QuotaProviderType>> = {
  anthropic: 'claude',
  codex: 'codex',
  antigravity: 'antigravity',
  xai: 'xai',
  devin: 'devin',
  meta: 'meta',
};

export interface ProviderAccounts {
  count: number;
  /** Accounts cooling down or used up right now. */
  blocked: number;
  /** The most constrained account's summary; null when none has a reading. */
  tightest: HeadroomSummary | null;
}

export function summarizeProviderAccounts(
  entries: readonly QuotaFileEntry[],
  headroomFor: (entry: QuotaFileEntry) => SummarizedHeadroom | undefined
): Map<QuotaProviderType, ProviderAccounts> {
  const byType = new Map<QuotaProviderType, ProviderAccounts>();
  entries.forEach((entry) => {
    const current = byType.get(entry.type) ?? { count: 0, blocked: 0, tightest: null };
    current.count += 1;
    const summary = headroomFor(entry)?.summary;
    if (summary?.availability.state === 'blocked') current.blocked += 1;
    if (
      summary?.tightest &&
      (!current.tightest || compareHeadroomPressure(summary, current.tightest) < 0)
    ) {
      current.tightest = summary;
    }
    byType.set(entry.type, current);
  });
  return byType;
}

export interface ProviderAccountsLine {
  key: string;
  params: Record<string, string | number>;
  /** bad: nothing usable or about to run out; warn: some blocked or ahead of pace. */
  tone?: 'bad' | 'warn';
}

/** The tile's account line; null when nobody has signed in with this provider. */
export function providerAccountsLine(
  accounts: ProviderAccounts | undefined,
  labelOf: (window: HeadroomWindow) => string
): ProviderAccountsLine | null {
  if (!accounts || accounts.count === 0) return null;
  const { count, blocked, tightest } = accounts;
  const window = tightest?.tightest;
  if (!tightest || !window) return { key: 'auth_login.tile_accounts', params: { count } };

  if (tightest.availability.state === 'blocked' && count === 1) {
    return tightest.availability.reason === 'cooldown'
      ? { key: 'auth_login.tile_accounts_cooling', params: { count }, tone: 'bad' }
      : {
          key: 'auth_login.tile_accounts_blocked',
          params: { count, window: labelOf(window) },
          tone: 'bad',
        };
  }
  if (blocked > 0) {
    return {
      key: 'auth_login.tile_accounts_unavailable',
      params: { count, blocked },
      tone: blocked === count ? 'bad' : 'warn',
    };
  }
  return {
    key: 'auth_login.tile_accounts_limit',
    params: { count, window: labelOf(window), used: Math.round(window.usedPercent) },
    tone: tightest.tier === 'runs-out' ? 'bad' : tightest.tier === 'ahead' ? 'warn' : undefined,
  };
}
