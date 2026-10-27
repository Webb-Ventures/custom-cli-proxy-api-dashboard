import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import i18n from '@/i18n';
import type {
  UsageBlock,
  UsageGroupTotals,
  UsageModelRow,
  UsagePrices,
  UsageSeries,
  UsageSummary,
  UsageTokens,
} from '@/services/api/usageLedger';
import type { CredentialPlan } from '@/features/usage/cost';
import { usageVerdict } from '@/features/usage/labels';
import { resolveUsageRange } from '@/features/usage/range';
import {
  buildAccounts,
  buildBlocks,
  buildProviderPools,
  buildUsageOverview,
  parseGroupKey,
  type UsageCredential,
} from '@/features/usage/usageModel';

const M = 1e-6;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-10-27T12:00:00Z');
const previousLanguage = i18n.language;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

const tokens = (partial: Partial<UsageTokens>): UsageTokens => {
  const merged = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    unclassified: 0,
    ...partial,
  };
  return {
    ...merged,
    total:
      merged.input +
      merged.cacheRead +
      merged.cacheWrite +
      merged.output +
      merged.reasoning +
      merged.unclassified,
  };
};

const modelRow = (model: string, partial: Partial<UsageTokens>, requests = 10): UsageModelRow => ({
  model,
  serviceTier: '',
  requests,
  failed: 0,
  tokens: tokens(partial),
});

const group = (key: string, rows: UsageModelRow[]): UsageGroupTotals => {
  const sum = rows.reduce(
    (acc, row) => {
      (Object.keys(acc.tokens) as (keyof UsageTokens)[]).forEach((field) => {
        acc.tokens[field] += row.tokens[field];
      });
      acc.requests += row.requests;
      return acc;
    },
    { requests: 0, tokens: tokens({}) }
  );
  return { key, requests: sum.requests, failed: 0, tokens: sum.tokens, byModel: rows };
};

const summary = (
  groups: UsageGroupTotals[],
  options: { from?: string; to?: string; recordingSince?: string | null } = {}
): UsageSummary => ({
  range: {
    from: options.from ?? '2026-09-28T00:00:00Z',
    to: options.to ?? '2026-10-28T00:00:00Z',
    tz: 'UTC',
    recordingSince:
      options.recordingSince === undefined ? '2026-01-01T00:00:00Z' : options.recordingSince,
    resolution: 'hour',
    approximate: false,
  },
  group: 'model',
  groups,
  totals: { requests: 0, failed: 0, tokens: tokens({}), byModel: [] },
});

const prices: UsagePrices = {
  source: 'remote',
  fetchedAt: '2026-10-27T06:00:00Z',
  sourceUrl: '',
  embeddedAsOf: '2026-10-01',
  lastAttemptAt: null,
  lastError: null,
  models: {
    'claude-opus-5-5': {
      provider: 'anthropic',
      mode: 'chat',
      input: 5 * M,
      output: 25 * M,
      cacheRead: 0.5 * M,
      cacheWrite: 6.25 * M,
      tiers: [],
      serviceTiers: {},
    },
    'gpt-5.6-sol': {
      provider: 'openai',
      mode: 'chat',
      input: 1 * M,
      output: 10 * M,
      tiers: [],
      serviceTiers: {},
    },
  },
  plans: {},
  plansAsOf: '',
  overrides: null,
};

const plan = (monthlyPrice: number, name = 'Max 20×'): CredentialPlan => ({
  provider: 'claude',
  plan: 'max_20x',
  name,
  monthlyPrice,
  currency: 'USD',
  billing: 'per_account',
  verified: true,
  source: 'override',
});

const credentials = new Map<string, UsageCredential>([
  ['a1', { authIndex: 'a1', name: 'claude-max.json', type: 'claude', plan: plan(200) }],
  ['c1', { authIndex: 'c1', name: 'codex-a.json', type: 'codex', plan: null }],
  ['k1', { authIndex: 'k1', name: 'kimi.json', type: 'kimi', plan: null }],
]);

// $10 of opus (1M input + 200k output) and $2 of gpt (1M input + 100k output).
const opus = modelRow('claude-opus-5-5', { input: 1_000_000, output: 200_000 });
const gpt = modelRow('gpt-5.6-sol', { input: 1_000_000, output: 100_000 });
const byCredential = summary([group('auth:a1', [opus]), group('auth:c1', [gpt])]);

describe('parseGroupKey', () => {
  test('splits ledger group keys', () => {
    expect(parseGroupKey('auth:7f3a')).toEqual({ kind: 'credential', id: '7f3a' });
    expect(parseGroupKey('key:ci …9f2a')).toEqual({ kind: 'client_key', id: 'ci …9f2a' });
    expect(parseGroupKey('model:a:b')).toEqual({ kind: 'model', id: 'a:b' });
    expect(parseGroupKey('nonsense')).toBeNull();
  });
});

describe('buildUsageOverview', () => {
  const overview = buildUsageOverview({
    group: 'model',
    metric: 'value',
    summary: summary([group('model:gpt-5.6-sol', [gpt]), group('model:claude-opus-5-5', [opus])]),
    previous: summary([
      group('model:claude-opus-5-5', [modelRow('claude-opus-5-5', { input: 1_000_000 })]),
    ]),
    byCredential,
    series: null,
    prices,
    credentials,
    now,
  });

  test('values rows at API prices and sorts by the metric', () => {
    expect(overview.rows.map((row) => row.id)).toEqual(['claude-opus-5-5', 'gpt-5.6-sol']);
    expect(overview.rows[0].value.usd).toBeCloseTo(10);
    expect(overview.rows[1].value.usd).toBeCloseTo(2);
    expect(overview.totals.value.usd).toBeCloseTo(12);
    expect(overview.totals.requests).toBe(20);
  });

  test('compares each row and the total with the previous period', () => {
    // Opus went from $5 to $10; gpt had no previous row.
    expect(overview.rows[0].change).toBeCloseTo(1);
    expect(overview.rows[1].change).toBeNull();
    expect(overview.change.value).toBeCloseTo(12 / 5 - 1);
  });

  test('splits value by token class, largest share first', () => {
    expect(overview.tokenClasses.map((entry) => entry.tokenClass)).toEqual(['input', 'output']);
    const shares = overview.tokenClasses.reduce((sum, entry) => sum + entry.share, 0);
    expect(shares).toBeCloseTo(1);
  });

  test('compares only credentials with a plan against their prorated cost', () => {
    const { subscription } = overview;
    expect(subscription.withPlan).toBe(1);
    expect(subscription.withoutPlan).toBe(1);
    expect(subscription.coveredValueUsd).toBeCloseTo(10);
    // Sept 28 00:00 to Oct 27 12:00 is 29.5 days of a $200 month.
    const cost = (200 * 29.5 * DAY) / ((365.25 / 12) * DAY);
    expect(subscription.costByCurrency.USD).toBeCloseTo(cost);
    expect(subscription.multiple).toBeCloseTo(10 / cost);
  });

  test('charges plans only from when recording began', () => {
    const late = buildUsageOverview({
      group: 'model',
      metric: 'value',
      summary: summary([group('model:claude-opus-5-5', [opus])], {
        recordingSince: '2026-10-20T12:00:00Z',
      }),
      previous: null,
      byCredential: summary([group('auth:a1', [opus])], { recordingSince: '2026-10-20T12:00:00Z' }),
      series: null,
      prices,
      credentials,
      now,
    });
    const cost = (200 * 7 * DAY) / ((365.25 / 12) * DAY);
    expect(late.subscription.costByCurrency.USD).toBeCloseTo(cost);
  });

  test('a credential filter lists that credential models and its own bars', () => {
    const series: UsageSeries = {
      range: summary([]).range,
      bucket: 'day',
      group: 'credential',
      buckets: [
        {
          start: '2026-10-26T00:00:00Z',
          end: '2026-10-27T00:00:00Z',
          beforeRecording: false,
          ...group('', [opus, gpt]),
        },
      ],
      groups: [
        {
          key: 'auth:a1',
          buckets: [
            {
              start: '2026-10-26T00:00:00Z',
              end: '2026-10-27T00:00:00Z',
              beforeRecording: false,
              ...group('', [opus]),
            },
          ],
        },
      ],
    };
    const filtered = buildUsageOverview({
      group: 'credential',
      metric: 'tokens',
      summary: byCredential,
      previous: null,
      byCredential,
      series,
      prices,
      credentials,
      credentialFilter: 'a1',
      now,
    });
    expect(filtered.rows.map((row) => row.id)).toEqual(['claude-opus-5-5']);
    expect(filtered.bars[0].valueUsd).toBeCloseTo(10);
    expect(filtered.bars[0].partial).toBe(false);
    expect(filtered.subscription.withPlan).toBe(1);
  });
});

describe('accounts and provider pools', () => {
  const overview = buildUsageOverview({
    group: 'credential',
    metric: 'value',
    summary: byCredential,
    previous: null,
    byCredential,
    series: null,
    prices,
    credentials,
    now,
  });
  const { accounts, idle } = buildAccounts(overview.rows, byCredential, credentials, now);

  test('lists credentials with traffic and counts the idle ones', () => {
    expect(accounts.map((account) => account.row.id)).toEqual(['a1', 'c1']);
    expect(idle).toBe(1);
    expect(accounts[0].multiple).toBeGreaterThan(0);
    expect(accounts[1].planCost).toBeNull();
    expect(accounts[1].multiple).toBeNull();
  });

  test('pools accounts by provider, most valuable first', () => {
    const pools = buildProviderPools(accounts);
    expect(pools.map((pool) => pool.provider)).toEqual(['claude', 'codex']);
    expect(pools[0].plans).toEqual([{ name: 'Max 20×', count: 1 }]);
    expect(pools[0].multiple).toBeCloseTo(accounts[0].multiple ?? 0);
    expect(pools[1].multiple).toBeNull();
  });
});

describe('buildBlocks', () => {
  const block = (
    start: string,
    active: boolean,
    minutes: number,
    rows: UsageModelRow[]
  ): UsageBlock => {
    const startMs = Date.parse(start);
    return {
      ...group('', rows),
      start,
      end: new Date(startMs + 5 * HOUR).toISOString(),
      actualEnd: new Date(startMs + (minutes - 1) * 60_000).toISOString(),
      active,
      peakTokensPerMinute: 0,
      burnRateTokensPerMinute: 0,
      activeMinutes: minutes,
      authIndexes: ['a1'],
    };
  };

  test('projects the active block to its end at the burn rate since it started', () => {
    // Started at 10:00, active through 11:59 (120 minutes), 3 hours left at noon.
    const { rows, current } = buildBlocks(
      [
        block('2026-10-27T03:00:00Z', false, 60, [opus]),
        block('2026-10-27T10:00:00Z', true, 120, [opus]),
      ],
      prices,
      now
    );
    expect(rows.map((row) => row.active)).toEqual([true, false]);
    expect(rows[1].activeMs).toBe(HOUR);
    expect(current).not.toBeNull();
    expect(current!.burnPerMinute).toBeCloseTo(1_200_000 / 120);
    expect(current!.remainingMinutes).toBe(180);
    expect(current!.projectedTokens).toBeCloseTo(1_200_000 * 2.5);
    expect(current!.projectedValueUsd).toBeCloseTo(25);
  });
});

describe('usageVerdict', () => {
  const t = i18n.t.bind(i18n) as unknown as Parameters<typeof usageVerdict>[4];
  const range = resolveUsageRange({ range: '30d' }, now, 'UTC');

  test('states tokens, value, subscription multiple and change', () => {
    const overview = buildUsageOverview({
      group: 'model',
      metric: 'value',
      summary: summary([group('model:claude-opus-5-5', [opus])]),
      previous: summary([
        group('model:claude-opus-5-5', [modelRow('claude-opus-5-5', { input: 1_000_000 })]),
      ]),
      byCredential: summary([group('auth:a1', [opus])]),
      series: null,
      prices,
      credentials,
      now,
    });
    const verdict = usageVerdict(overview, range, '30d', 'en', t);
    expect(verdict.headline).toBe('1.2M tokens in 30 days, worth $10 at API prices.');
    expect(verdict.meta[0]).toMatch(/^Subscriptions cost \$194 over the same days: 0\.1× value\.$/);
    expect(verdict.meta[1]).toBe('Up 100% on the previous 30 days.');
  });

  test('says so when nothing was recorded', () => {
    const empty = buildUsageOverview({
      group: 'model',
      metric: 'value',
      summary: summary([]),
      previous: null,
      byCredential: null,
      series: null,
      prices,
      credentials,
      now,
    });
    expect(usageVerdict(empty, range, '30d', 'en', t)).toEqual({
      headline: 'No usage recorded in 30 days.',
      meta: [],
    });
  });
});
