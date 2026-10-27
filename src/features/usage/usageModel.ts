/**
 * Usage page view model: ledger responses in, rows, bars and headline numbers
 * out. Pure so the page's arithmetic is testable without rendering.
 */

import type {
  UsageBlock,
  UsageGroup,
  UsageModelRow,
  UsagePrices,
  UsageSeries,
  UsageSeriesBucket,
  UsageSummary,
  UsageTokens,
  UsageTotals,
} from '@/services/api/usageLedger';
import {
  EMPTY_VALUE,
  TOKEN_CLASSES,
  addValues,
  proratedPlanCost,
  valueMultiple,
  valueOfModelRows,
  type CredentialPlan,
  type TokenClass,
  type UsageValue,
} from './cost';
import { periodChange, type UsageMetric } from './range';

export interface UsageCredential {
  authIndex: string;
  /** File name or account label shown in tables. */
  name: string;
  /** Credential provider type, e.g. `claude`; also the price-lookup hint. */
  type: string;
  plan: CredentialPlan | null;
}

export type UsageRowKind = 'model' | 'credential' | 'provider' | 'client_key';

export interface UsageRow {
  /** Ledger group key, e.g. `auth:7f3a`, or the model name inside one credential. */
  key: string;
  kind: UsageRowKind;
  /** The part after the prefix: model, auth_index, provider or masked key. Empty when unattributed. */
  id: string;
  credential: UsageCredential | null;
  requests: number;
  failed: number;
  tokens: UsageTokens;
  value: UsageValue;
  /** Change in the selected metric from the previous period; null without a comparison. */
  change: number | null;
}

export interface UsageBar {
  start: string;
  end: string;
  tokens: number;
  valueUsd: number;
  beforeRecording: boolean;
  /** Still filling: the bucket ends after now. */
  partial: boolean;
}

export interface TokenClassShare {
  tokenClass: TokenClass;
  tokens: number;
  usd: number;
  /** Share of value, 0–1. */
  share: number;
}

export interface Subscription {
  /** Plan cost prorated over the range so far, per currency. */
  costByCurrency: Record<string, number>;
  /** Value of the credentials that have a plan. */
  coveredValueUsd: number;
  /** Value divided by a USD plan cost; null with no plan or another currency. */
  multiple: number | null;
  withPlan: number;
  /** Credentials seen in the range without a known plan. */
  withoutPlan: number;
}

export interface UsageOverview {
  totals: { requests: number; failed: number; tokens: UsageTokens; value: UsageValue };
  previous: { tokens: number; valueUsd: number } | null;
  change: { tokens: number | null; value: number | null };
  rows: UsageRow[];
  bars: UsageBar[];
  tokenClasses: TokenClassShare[];
  subscription: Subscription;
}

const EMPTY_TOKENS: UsageTokens = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  unclassified: 0,
  total: 0,
};

const addTokens = (a: UsageTokens, b: UsageTokens): UsageTokens => ({
  input: a.input + b.input,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  output: a.output + b.output,
  reasoning: a.reasoning + b.reasoning,
  unclassified: a.unclassified + b.unclassified,
  total: a.total + b.total,
});

const PREFIX_KIND: Record<string, UsageRowKind> = {
  model: 'model',
  auth: 'credential',
  provider: 'provider',
  key: 'client_key',
};

/** `auth:7f3a` → credential `7f3a`; unknown prefixes stay whole. */
export function parseGroupKey(key: string): { kind: UsageRowKind; id: string } | null {
  const separator = key.indexOf(':');
  if (separator < 0) return null;
  const kind = PREFIX_KIND[key.slice(0, separator)];
  return kind ? { kind, id: key.slice(separator + 1) } : null;
}

export interface BuildOverviewInput {
  group: UsageGroup;
  metric: UsageMetric;
  summary: UsageSummary;
  previous: UsageSummary | null;
  /** Credential-grouped summary for plan math; the main summary when grouped by credential. */
  byCredential: UsageSummary | null;
  series: UsageSeries | null;
  prices: UsagePrices | null;
  credentials: ReadonlyMap<string, UsageCredential>;
  /**
   * Narrow everything to one credential's models. The summaries and series must
   * then be grouped by credential.
   */
  credentialFilter?: string;
  now: number;
}

/**
 * The part of the range plan cost is charged for: from recording start (value
 * before it is unknown, so charging for it would understate the multiple) to now.
 */
function elapsedSpan(summary: UsageSummary, now: number): [number, number] {
  const { range } = summary;
  const recordingMs = range.recordingSince ? Date.parse(range.recordingSince) : NaN;
  const fromMs = Math.max(
    Date.parse(range.from),
    Number.isFinite(recordingMs) ? recordingMs : -Infinity
  );
  return [fromMs, Math.min(Date.parse(range.to), now)];
}

const metricOf = (metric: UsageMetric, tokens: UsageTokens, value: UsageValue) =>
  metric === 'value' ? value.usd : tokens.total;

export function buildUsageOverview(input: BuildOverviewInput): UsageOverview {
  const { metric, prices, credentials, now } = input;
  const filter = input.credentialFilter;

  const hintFor = (kind: UsageRowKind, id: string, fallback: string | null): string | null => {
    if (kind === 'credential') return credentials.get(id)?.type ?? null;
    if (kind === 'provider') return id || null;
    return fallback;
  };
  const valueOf = (rows: readonly UsageModelRow[], hint: string | null) =>
    valueOfModelRows(rows, hint, prices);

  // With a credential filter, that credential's models become the rows.
  const filteredGroup = (summary: UsageSummary | null) =>
    filter ? summary?.groups.find((group) => group.key === `auth:${filter}`) : undefined;
  const filterHint = filter ? (credentials.get(filter)?.type ?? null) : null;

  const rowsFrom = (summary: UsageSummary | null): UsageRow[] => {
    if (!summary) return [];
    if (filter) {
      const group = filteredGroup(summary);
      return (group?.byModel ?? []).map((row) => ({
        key: `${row.model}|${row.serviceTier}`,
        kind: 'model',
        id: row.model,
        credential: null,
        requests: row.requests,
        failed: row.failed,
        tokens: row.tokens,
        value: valueOf([row], filterHint),
        change: null,
      }));
    }
    return summary.groups.map((group) => {
      const parsed = parseGroupKey(group.key) ?? { kind: 'model' as const, id: group.key };
      return {
        key: group.key,
        kind: parsed.kind,
        id: parsed.id,
        credential: parsed.kind === 'credential' ? (credentials.get(parsed.id) ?? null) : null,
        requests: group.requests,
        failed: group.failed,
        tokens: group.tokens,
        value: valueOf(group.byModel, hintFor(parsed.kind, parsed.id, null)),
        change: null,
      };
    });
  };

  const rows = rowsFrom(input.summary);
  const previousRows = input.previous
    ? new Map(rowsFrom(input.previous).map((row) => [row.key, row]))
    : null;

  let totalTokens = EMPTY_TOKENS;
  let totalValue = EMPTY_VALUE;
  let requests = 0;
  let failed = 0;
  rows.forEach((row) => {
    const before = previousRows?.get(row.key);
    row.change = before
      ? periodChange(
          metricOf(metric, row.tokens, row.value),
          metricOf(metric, before.tokens, before.value)
        )
      : null;
    totalTokens = addTokens(totalTokens, row.tokens);
    totalValue = addValues(totalValue, row.value);
    requests += row.requests;
    failed += row.failed;
  });
  rows.sort(
    (a, b) =>
      metricOf(metric, b.tokens, b.value) - metricOf(metric, a.tokens, a.value) ||
      a.key.localeCompare(b.key)
  );

  let previous: UsageOverview['previous'] = null;
  if (previousRows) {
    let tokens = 0;
    let valueUsd = 0;
    previousRows.forEach((row) => {
      tokens += row.tokens.total;
      valueUsd += row.value.usd;
    });
    previous = { tokens, valueUsd };
  }

  return {
    totals: { requests, failed, tokens: totalTokens, value: totalValue },
    previous,
    change: {
      tokens: previous ? periodChange(totalTokens.total, previous.tokens) : null,
      value: previous ? periodChange(totalValue.usd, previous.valueUsd) : null,
    },
    rows,
    bars: buildBars(input.series, filter, filterHint, prices, now),
    tokenClasses: tokenClassShares(totalTokens, totalValue),
    subscription: buildSubscription(input),
  };
}

function buildBars(
  series: UsageSeries | null,
  filter: string | undefined,
  filterHint: string | null,
  prices: UsagePrices | null,
  now: number
): UsageBar[] {
  if (!series) return [];
  const buckets: UsageSeriesBucket[] = filter
    ? (series.groups.find((group) => group.key === `auth:${filter}`)?.buckets ??
      series.buckets.map((bucket) => ({ ...bucket, ...emptyTotals() })))
    : series.buckets;
  return buckets.map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    tokens: bucket.tokens.total,
    valueUsd: valueOfModelRows(bucket.byModel, filterHint, prices).usd,
    beforeRecording: bucket.beforeRecording,
    partial: Date.parse(bucket.end) > now,
  }));
}

const emptyTotals = (): UsageTotals => ({
  requests: 0,
  failed: 0,
  tokens: EMPTY_TOKENS,
  byModel: [],
});

function tokenClassShares(tokens: UsageTokens, value: UsageValue): TokenClassShare[] {
  return TOKEN_CLASSES.map((tokenClass) => ({
    tokenClass,
    tokens: tokens[tokenClass],
    usd: value.byClass[tokenClass],
    share: value.usd > 0 ? value.byClass[tokenClass] / value.usd : 0,
  }))
    .filter((entry) => entry.tokens > 0)
    .sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

function buildSubscription(input: BuildOverviewInput): Subscription {
  const { credentials, now } = input;
  const [fromMs, toMs] = elapsedSpan(input.summary, now);

  // Value per credential, from the credential-grouped summary.
  const valueByCredential = new Map<string, number>();
  const source = input.byCredential ?? (input.group === 'credential' ? input.summary : null);
  source?.groups.forEach((group) => {
    const parsed = parseGroupKey(group.key);
    if (parsed?.kind !== 'credential' || !parsed.id) return;
    const hint = credentials.get(parsed.id)?.type ?? null;
    valueByCredential.set(parsed.id, valueOfModelRows(group.byModel, hint, input.prices).usd);
  });

  const costByCurrency: Record<string, number> = {};
  let coveredValueUsd = 0;
  let withPlan = 0;
  const scope = input.credentialFilter
    ? [credentials.get(input.credentialFilter)].filter((entry): entry is UsageCredential =>
        Boolean(entry)
      )
    : Array.from(credentials.values());
  scope.forEach((credential) => {
    if (!credential.plan) return;
    withPlan += 1;
    const cost = proratedPlanCost(credential.plan.monthlyPrice, fromMs, toMs);
    costByCurrency[credential.plan.currency] =
      (costByCurrency[credential.plan.currency] ?? 0) + cost;
    coveredValueUsd += valueByCredential.get(credential.authIndex) ?? 0;
  });
  const withoutPlan = Array.from(valueByCredential.keys()).filter(
    (authIndex) =>
      (!input.credentialFilter || authIndex === input.credentialFilter) &&
      !credentials.get(authIndex)?.plan
  ).length;

  const currencies = Object.keys(costByCurrency);
  const multiple =
    currencies.length === 1
      ? valueMultiple(coveredValueUsd, costByCurrency[currencies[0]], currencies[0])
      : null;
  return { costByCurrency, coveredValueUsd, multiple, withPlan, withoutPlan };
}

/* ---------- 5-hour blocks ---------- */

export interface BlockRow {
  start: string;
  end: string;
  active: boolean;
  /** From block start to the end of its last active minute. */
  activeMs: number;
  tokens: number;
  valueUsd: number;
  peakTokensPerMinute: number;
  credentials: number;
}

export interface CurrentBlock {
  startMs: number;
  endMs: number;
  /** Minutes left until the block ends. */
  remainingMinutes: number;
  tokens: number;
  valueUsd: number;
  /** Tokens per minute since the block started, as ccusage computes burn rate. */
  burnPerMinute: number;
  projectedTokens: number;
  projectedValueUsd: number;
}

const MINUTE = 60_000;

export function buildBlocks(
  blocks: readonly UsageBlock[],
  prices: UsagePrices | null,
  now: number
): { rows: BlockRow[]; current: CurrentBlock | null } {
  const rows = blocks
    .map((block) => {
      const startMs = Date.parse(block.start);
      const lastMs = Date.parse(block.actualEnd) + MINUTE;
      return {
        start: block.start,
        end: block.end,
        active: block.active,
        activeMs: Math.max(0, lastMs - startMs),
        tokens: block.tokens.total,
        valueUsd: valueOfModelRows(block.byModel, null, prices).usd,
        peakTokensPerMinute: block.peakTokensPerMinute,
        credentials: block.authIndexes.length,
      };
    })
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

  const active = blocks.find((block) => block.active);
  let current: CurrentBlock | null = null;
  if (active) {
    const startMs = Date.parse(active.start);
    const endMs = Date.parse(active.end);
    const elapsedMinutes = Math.max(1, (Date.parse(active.actualEnd) + MINUTE - startMs) / MINUTE);
    const remainingMinutes = Math.max(0, (endMs - now) / MINUTE);
    const tokens = active.tokens.total;
    const burnPerMinute = tokens / elapsedMinutes;
    const projectedTokens = tokens + burnPerMinute * remainingMinutes;
    const valueUsd = valueOfModelRows(active.byModel, null, prices).usd;
    current = {
      startMs,
      endMs,
      remainingMinutes,
      tokens,
      valueUsd,
      burnPerMinute,
      projectedTokens,
      projectedValueUsd: tokens > 0 ? valueUsd * (projectedTokens / tokens) : 0,
    };
  }
  return { rows, current };
}

/* ---------- Providers and accounts ---------- */

export interface AccountRow {
  row: UsageRow;
  /** Plan cost prorated over the range so far; null without a plan. */
  planCost: number | null;
  multiple: number | null;
}

export interface ProviderPool {
  /** Credential type, or empty for credentials the auth-file list does not know. */
  provider: string;
  accounts: AccountRow[];
  requests: number;
  tokens: number;
  valueUsd: number;
  costByCurrency: Record<string, number>;
  multiple: number | null;
  /** Plan name → account count, for "2 Max, 1 Pro". */
  plans: { name: string; count: number }[];
}

/**
 * One row per credential with its plan share and value multiple, most valuable
 * first. `rows` must be credential rows; known credentials with no traffic are
 * counted in `idle` rather than listed.
 */
export function buildAccounts(
  rows: readonly UsageRow[],
  summary: UsageSummary,
  credentials: ReadonlyMap<string, UsageCredential>,
  now: number
): { accounts: AccountRow[]; idle: number } {
  const [fromMs, toMs] = elapsedSpan(summary, now);
  const seen = new Set<string>();
  const accounts = rows
    .filter((row) => row.kind === 'credential')
    .map((row) => {
      seen.add(row.id);
      const plan = row.credential?.plan ?? null;
      const planCost = plan ? proratedPlanCost(plan.monthlyPrice, fromMs, toMs) : null;
      return {
        row,
        planCost,
        multiple:
          plan && planCost !== null ? valueMultiple(row.value.usd, planCost, plan.currency) : null,
      };
    });
  const idle = Array.from(credentials.keys()).filter((authIndex) => !seen.has(authIndex)).length;
  return { accounts, idle };
}

export function buildProviderPools(accounts: readonly AccountRow[]): ProviderPool[] {
  const pools = new Map<string, ProviderPool>();
  accounts.forEach((account) => {
    const provider = account.row.credential?.type ?? '';
    let pool = pools.get(provider);
    if (!pool) {
      pool = {
        provider,
        accounts: [],
        requests: 0,
        tokens: 0,
        valueUsd: 0,
        costByCurrency: {},
        multiple: null,
        plans: [],
      };
      pools.set(provider, pool);
    }
    pool.accounts.push(account);
    pool.requests += account.row.requests;
    pool.tokens += account.row.tokens.total;
    pool.valueUsd += account.row.value.usd;
    const plan = account.row.credential?.plan;
    if (plan && account.planCost !== null) {
      pool.costByCurrency[plan.currency] =
        (pool.costByCurrency[plan.currency] ?? 0) + account.planCost;
      const entry = pool.plans.find((item) => item.name === plan.name);
      if (entry) entry.count += 1;
      else pool.plans.push({ name: plan.name, count: 1 });
    }
  });
  return Array.from(pools.values())
    .map((pool) => {
      const currencies = Object.keys(pool.costByCurrency);
      // Only accounts with a plan count toward the multiple.
      const coveredValue = pool.accounts
        .filter((account) => account.planCost !== null)
        .reduce((sum, account) => sum + account.row.value.usd, 0);
      return {
        ...pool,
        multiple:
          currencies.length === 1
            ? valueMultiple(coveredValue, pool.costByCurrency[currencies[0]], currencies[0])
            : null,
        plans: pool.plans.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => b.valueUsd - a.valueUsd || b.tokens - a.tokens);
}
