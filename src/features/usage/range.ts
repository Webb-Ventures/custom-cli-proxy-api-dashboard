/**
 * Usage page state kept in the URL (`#/usage?range=30d&metric=value…`) so a view
 * can be shared or reloaded, plus the date math for ranges and previous periods.
 *
 * Dates are local calendar days in the browser's IANA zone; the ledger takes
 * `YYYY-MM-DD` with an exclusive `to` that means "through the end of that day".
 */

import type { UsageBucket, UsageGroup } from '@/services/api/usageLedger';

export const USAGE_RANGE_PRESETS = ['today', '7d', '30d', '90d'] as const;
export type UsageRangePreset = (typeof USAGE_RANGE_PRESETS)[number];
export type UsageRangeKind = UsageRangePreset | 'custom';

export const USAGE_VIEWS = ['overview', 'providers', 'accounts'] as const;
export type UsageView = (typeof USAGE_VIEWS)[number];

export const USAGE_METRICS = ['value', 'tokens'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const USAGE_GROUPS: readonly UsageGroup[] = [
  'model',
  'credential',
  'provider',
  'client_key',
];

/** The ledger serves at most 400 calendar days per request. */
export const MAX_RANGE_DAYS = 400;

export interface UsageUrlState {
  view: UsageView;
  range: UsageRangeKind;
  /** Inclusive first day, only for `custom`. */
  from?: string;
  /** Inclusive last day, only for `custom`. */
  to?: string;
  metric: UsageMetric;
  group: UsageGroup;
  /** Narrow to one credential (`auth_index`). */
  credential?: string;
}

export const DEFAULT_USAGE_STATE: UsageUrlState = {
  view: 'overview',
  range: '30d',
  metric: 'value',
  group: 'model',
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const oneOf = <T extends string>(values: readonly T[], value: string | null): T | undefined =>
  value !== null && (values as readonly string[]).includes(value) ? (value as T) : undefined;

export function parseUsageState(search: string): UsageUrlState {
  const params = new URLSearchParams(search);
  const state: UsageUrlState = {
    view: oneOf(USAGE_VIEWS, params.get('view')) ?? DEFAULT_USAGE_STATE.view,
    range:
      oneOf<UsageRangeKind>([...USAGE_RANGE_PRESETS, 'custom'], params.get('range')) ??
      DEFAULT_USAGE_STATE.range,
    metric: oneOf(USAGE_METRICS, params.get('metric')) ?? DEFAULT_USAGE_STATE.metric,
    group: oneOf(USAGE_GROUPS, params.get('group')) ?? DEFAULT_USAGE_STATE.group,
  };
  const credential = params.get('credential')?.trim();
  if (credential) state.credential = credential;

  if (state.range === 'custom') {
    const from = params.get('from') ?? '';
    const to = params.get('to') ?? '';
    if (DAY_PATTERN.test(from) && DAY_PATTERN.test(to) && from <= to) {
      state.from = from;
      state.to = to;
    } else {
      state.range = DEFAULT_USAGE_STATE.range;
    }
  }
  return state;
}

/** Query string for the state, leaving defaults out so plain `#/usage` stays plain. */
export function serializeUsageState(state: UsageUrlState): string {
  const params = new URLSearchParams();
  if (state.view !== DEFAULT_USAGE_STATE.view) params.set('view', state.view);
  if (state.range !== DEFAULT_USAGE_STATE.range) params.set('range', state.range);
  if (state.range === 'custom' && state.from && state.to) {
    params.set('from', state.from);
    params.set('to', state.to);
  }
  if (state.metric !== DEFAULT_USAGE_STATE.metric) params.set('metric', state.metric);
  if (state.group !== DEFAULT_USAGE_STATE.group) params.set('group', state.group);
  if (state.credential) params.set('credential', state.credential);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/* ---------- Calendar days ---------- */

/** The browser's IANA zone; the ledger rejects `Local`, so fall back to UTC. */
export function browserTimeZone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone !== 'Local' ? zone : 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `YYYY-MM-DD` of an instant in a zone. */
export function dayInZone(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Calendar arithmetic on `YYYY-MM-DD`, independent of zones and DST. */
export function addDays(day: string, delta: number): string {
  const [year, month, date] = day.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, date + delta));
  return shifted.toISOString().slice(0, 10);
}

/** Inclusive day count between two `YYYY-MM-DD` days. */
export function daysBetween(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

export interface ResolvedUsageRange {
  /** Inclusive first day. */
  from: string;
  /** Inclusive last day. */
  to: string;
  days: number;
  tz: string;
  bucket: UsageBucket;
  /** The same number of days immediately before. */
  previous: { from: string; to: string };
  /** The range ends today, so its last bucket is still filling. */
  includesToday: boolean;
}

/** Hours for a single day, days up to a quarter, weeks beyond (the ledger caps buckets at 2000). */
export function bucketForDays(days: number): UsageBucket {
  if (days <= 1) return 'hour';
  if (days <= 120) return 'day';
  return 'week';
}

export function resolveUsageRange(
  state: Pick<UsageUrlState, 'range' | 'from' | 'to'>,
  now: number,
  tz: string
): ResolvedUsageRange {
  const today = dayInZone(now, tz);
  let from: string;
  let to = today;
  if (state.range === 'custom' && state.from && state.to) {
    from = state.from;
    to = state.to;
    if (daysBetween(from, to) > MAX_RANGE_DAYS) from = addDays(to, -(MAX_RANGE_DAYS - 1));
  } else {
    const days = state.range === 'today' ? 1 : Number.parseInt(state.range, 10) || 30;
    from = addDays(today, -(days - 1));
  }
  const days = daysBetween(from, to);
  return {
    from,
    to,
    days,
    tz,
    bucket: bucketForDays(days),
    previous: { from: addDays(from, -days), to: addDays(from, -1) },
    includesToday: from <= today && today <= to,
  };
}

/**
 * Ledger range params for inclusive days: `to` as a date already means the end
 * of that day, so inclusive and exclusive line up.
 */
export const ledgerParams = (range: { from: string; to: string }, tz: string) => ({
  from: range.from,
  to: range.to,
  tz,
});

/** Change, as a fraction, from the previous period; null when there is nothing to compare. */
export function periodChange(current: number, previous: number): number | null {
  if (!(previous > 0)) return null;
  return (current - previous) / previous;
}
