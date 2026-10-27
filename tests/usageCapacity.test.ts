import { describe, expect, test } from 'bun:test';
import type { HeadroomWindow } from '@/features/quota/headroom';
import type { UsagePrices, UsageTokens, UsageWindowResult } from '@/services/api/usageLedger';
import {
  CAPACITY_MIN_USED_PERCENT,
  capacityWindow,
  estimateAccountCapacity,
  poolCapacity,
  windowStartMs,
} from '@/features/usage/capacity';

const HOUR = 3_600_000;
const now = Date.parse('2026-10-27T12:00:00Z');
const M = 1e-6;

const window = (
  id: string,
  usedPercent: number,
  periodHours: number | null,
  resetInHours: number | null
): HeadroomWindow => ({
  id,
  usedPercent,
  periodHours,
  resetAtMs: resetInHours === null ? null : now + resetInHours * HOUR,
});

const tokens = (input: number): UsageTokens => ({
  input,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  unclassified: 0,
  total: input,
});

const result = (authIndex: string, input: number): UsageWindowResult => ({
  authIndex,
  since: '',
  resolution: 'minute',
  approximate: false,
  requests: 1,
  failed: 0,
  tokens: tokens(input),
  byModel: [
    { model: 'claude-opus-5-5', serviceTier: '', requests: 1, failed: 0, tokens: tokens(input) },
  ],
});

const prices = {
  models: {
    'claude-opus-5-5': {
      provider: 'anthropic',
      mode: 'chat',
      input: 5 * M,
      output: 25 * M,
      tiers: [],
      serviceTiers: {},
    },
  },
  overrides: null,
} as unknown as UsagePrices;

describe('capacityWindow', () => {
  test('reads the longest window with a known reset and length', () => {
    const weekly = window('7d', 40, 168, 60);
    expect(capacityWindow([window('5h', 80, 5, 2), weekly, window('opus', 90, null, 10)])).toBe(
      weekly
    );
    expect(capacityWindow([window('5h', 80, 5, null)])).toBeNull();
  });

  test('a window started its length before its next reset', () => {
    expect(windowStartMs(window('7d', 40, 168, 60))).toBe(now - 108 * HOUR);
  });
});

describe('estimateAccountCapacity', () => {
  test('tokens per 1% times 100 is the capacity, the rest is left', () => {
    // 40M tokens at 40% used: 1M per 1%, 100M capacity, 60M left worth $300 at $5/M.
    const estimate = estimateAccountCapacity(
      window('7d', 40, 168, 60),
      result('a1', 40_000_000),
      'claude',
      prices
    );
    expect(estimate.tokensPerPercent).toBe(1_000_000);
    expect(estimate.capacityTokens).toBe(100_000_000);
    expect(estimate.tokensLeft).toBe(60_000_000);
    expect(estimate.valueLeftUsd).toBeCloseTo(300);
  });

  test('no estimate below the minimum used percent or without tokens', () => {
    const early = estimateAccountCapacity(
      window('7d', CAPACITY_MIN_USED_PERCENT - 1, 168, 160),
      result('a1', 2_000_000),
      'claude',
      prices
    );
    expect(early.capacityTokens).toBeNull();
    expect(early.tokensSinceReset).toBe(2_000_000);
    expect(
      estimateAccountCapacity(window('7d', 50, 168, 60), result('a1', 0), 'claude', prices)
        .capacityTokens
    ).toBeNull();
  });
});

describe('poolCapacity', () => {
  const weeklyA = estimateAccountCapacity(
    window('7d', 40, 168, 60),
    result('a1', 40_000_000),
    'claude',
    prices
  );
  const weeklyB = estimateAccountCapacity(
    window('7d', 80, 168, 20),
    result('a2', 8_000_000),
    'claude',
    prices
  );
  const fiveHour = estimateAccountCapacity(
    window('5h', 100, 5, 2),
    result('a3', 1_000_000),
    'claude',
    prices
  );
  const early = estimateAccountCapacity(
    window('7d', 2, 168, 160),
    result('a4', 100_000),
    'claude',
    prices
  );

  test('sums capacity across accounts on the same window and weights the used share', () => {
    const pool = poolCapacity([weeklyA, weeklyB, early]);
    expect(pool?.capacityTokens).toBe(110_000_000);
    expect(pool?.tokensLeft).toBe(62_000_000);
    expect(pool?.usedPercent).toBeCloseTo((48 / 110) * 100);
    expect(pool?.unestimated).toBe(1);
  });

  test('does not add a 5-hour capacity to weekly ones', () => {
    const pool = poolCapacity([weeklyA, fiveHour]);
    expect(pool?.estimated.map((account) => account.authIndex)).toEqual(['a1']);
    expect(pool?.unestimated).toBe(1);
  });

  test('null when no account has an estimate', () => {
    expect(poolCapacity([early])).toBeNull();
  });
});
