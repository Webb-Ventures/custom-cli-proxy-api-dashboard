/**
 * Headroom model: which credentials have room, and for how long.
 *
 * Pure functions with no React and no clock of their own (`now` is always passed
 * in). Every provider's quota is first converted to percent USED, so the
 * primitives below never have to know which way a provider counts.
 */

import type { AuthFileCooldownSnapshot, AuthFileQuotaObservation } from '@/types/authFile';
import { HOUR_MS } from '@/utils/time/durations';
import type { QuotaProviderType } from './providers/types';

/** One rate-limit window, normalized to percent used. */
export interface HeadroomWindow {
  id: string;
  /** Display label already resolved by the provider's data layer, when it had one. */
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  /** 0–100. */
  usedPercent: number;
  resetAtMs: number | null;
  periodHours: number | null;
  /** The upstream said this window is refusing requests, whatever the percentage. */
  rejected?: boolean;
}

export type HeadroomPaceState = 'ahead' | 'on-pace' | 'under';

export interface HeadroomPace {
  usedPercent: number;
  /** How much of the window has elapsed, 0–100. */
  elapsedPercent: number;
  /** usedPercent − elapsedPercent: positive means spending faster than the window refills. */
  deltaPercent: number;
  state: HeadroomPaceState;
}

export type HeadroomAvailability =
  | { state: 'available' }
  | {
      state: 'blocked';
      reason: 'cooldown' | 'exhausted';
      /** When requests should succeed again; null when no reset instant is known. */
      untilMs: number | null;
    };

/** Lower sorts first on a pressure board. */
export type HeadroomPressureTier = 'blocked' | 'runs-out' | 'ahead' | 'steady' | 'unknown';

export interface HeadroomSummary {
  windows: HeadroomWindow[];
  tightest: HeadroomWindow | null;
  /** Pace of the tightest window. */
  pace: HeadroomPace | null;
  /** Earliest projected run-out across all windows, before their resets. */
  runsOutAtMs: number | null;
  availability: HeadroomAvailability;
  tier: HeadroomPressureTier;
}

/** Projections from the first few minutes of a window are noise, not a trend. */
export const RUNS_OUT_MIN_ELAPSED_PERCENT = 15;

/** Pace within this many points of elapsed time reads as on pace. */
export const PACE_TOLERANCE_PERCENT = 5;

const TIER_ORDER: Record<HeadroomPressureTier, number> = {
  blocked: 0,
  'runs-out': 1,
  ahead: 2,
  steady: 3,
  unknown: 4,
};

const clampPercent = (value: number) => Math.min(100, Math.max(0, value));

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const positiveOrNull = (value: unknown): number | null => {
  const number = finiteOrNull(value);
  return number !== null && number > 0 ? number : null;
};

/* -------------------------------------------------------------- conversion */

interface UsedWindowLike {
  id?: string;
  label?: string;
  labelKey?: string;
  labelParams?: Record<string, string | number>;
  usedPercent?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

interface RemainingFractionLike {
  id?: string;
  label?: string;
  /** Fraction 0..1 REMAINING. */
  remainingFraction?: number | null;
  resetAtMs?: number | null;
  periodHours?: number | null;
}

const fromUsed = (window: UsedWindowLike, fallbackId: string): HeadroomWindow | null => {
  const used = finiteOrNull(window.usedPercent);
  if (used === null) return null;
  return {
    id: window.id || fallbackId,
    ...(window.label ? { label: window.label } : {}),
    ...(window.labelKey ? { labelKey: window.labelKey } : {}),
    ...(window.labelParams ? { labelParams: window.labelParams } : {}),
    usedPercent: clampPercent(used),
    resetAtMs: finiteOrNull(window.resetAtMs),
    periodHours: positiveOrNull(window.periodHours),
  };
};

const compact = <T>(values: (T | null)[]): T[] =>
  values.filter((value): value is T => value !== null);

/**
 * Converts one provider's quota state into percent-used windows.
 *
 * Read structurally, like the timeline lane builder: the provider states disagree
 * about where a window lives and which way it counts. Anything but a successful
 * load yields no windows.
 */
export function headroomWindowsFromQuota(
  provider: QuotaProviderType,
  quota: unknown
): HeadroomWindow[] {
  if (!quota || typeof quota !== 'object') return [];
  const state = quota as Record<string, unknown>;
  if (state.status !== 'success') return [];

  switch (provider) {
    case 'claude':
    case 'codex':
      return compact(
        ((state.windows as UsedWindowLike[] | undefined) ?? []).map((window, index) =>
          fromUsed(window, `${provider}-${index}`)
        )
      );

    case 'devin':
      return compact(
        (
          (state.windows as
            | {
                id: string;
                label?: string;
                remainingPercent: number | null;
                resetAtMs: number | null;
                periodHours: number;
              }[]
            | undefined) ?? []
        ).map((window) => {
          const remaining = finiteOrNull(window.remainingPercent);
          return remaining === null
            ? null
            : fromUsed({ ...window, usedPercent: 100 - remaining }, window.id);
        })
      );

    case 'antigravity':
    case 'plugin':
      return compact(
        ((state.groups as { buckets?: RemainingFractionLike[] }[] | undefined) ?? [])
          .flatMap((group) => group.buckets ?? [])
          .map((bucket, index) => {
            const remaining = finiteOrNull(bucket.remainingFraction);
            return remaining === null
              ? null
              : fromUsed(
                  { ...bucket, labelKey: undefined, usedPercent: (1 - remaining) * 100 },
                  `bucket-${index}`
                );
          })
      );

    case 'kimi':
      return compact(
        (
          (state.rows as
            (UsedWindowLike & { used: number; limit: number; labelKey?: string })[] | undefined) ??
          []
        ).map((row, index) =>
          row.limit > 0
            ? fromUsed({ ...row, usedPercent: (row.used / row.limit) * 100 }, `kimi-${index}`)
            : null
        )
      );

    case 'xai': {
      // Only a weekly limit is rate-limited capacity; a monthly figure is a spend cap.
      const billing = state.billing as
        | {
            periodType?: string;
            usagePercent?: number | null;
            resetAtMs?: number | null;
            periodHours?: number | null;
          }
        | null
        | undefined;
      if (!billing || billing.periodType !== 'weekly') return [];
      return compact([
        fromUsed(
          {
            id: 'weekly',
            labelKey: 'xai_quota.weekly_limit',
            usedPercent: billing.usagePercent,
            resetAtMs: billing.resetAtMs,
            periodHours: billing.periodHours ?? 24 * 7,
          },
          'weekly'
        ),
      ]);
    }

    case 'meta': {
      const windows =
        (
          state.data as
            | {
                windows?: {
                  id: 'window' | 'weekly';
                  usedPercent: number | null;
                  resetAt?: number;
                  durationMinutes?: number;
                }[];
              }
            | undefined
        )?.windows ?? [];
      return compact(
        windows.map((window) => {
          const resetAt = finiteOrNull(window.resetAt);
          // The weekly bucket carries no duration; its scope defines seven days.
          const minutes = window.id === 'weekly' ? 7 * 24 * 60 : window.durationMinutes;
          return fromUsed(
            {
              id: window.id,
              labelKey: `meta_quota.${window.id}`,
              usedPercent: window.usedPercent,
              resetAtMs: resetAt !== null ? resetAt * 1000 : null,
              periodHours: typeof minutes === 'number' ? minutes / 60 : null,
            },
            window.id
          );
        })
      );
    }

    default:
      return [];
  }
}

/** Passive Claude window ids → the ids and labels the active usage endpoint produces. */
const CLAUDE_PASSIVE_IDS: Record<string, { id: string; labelKey: string }> = {
  '5h': { id: 'five-hour', labelKey: 'claude_quota.five_hour' },
  '7d': { id: 'seven-day', labelKey: 'claude_quota.seven_day' },
};

const CODEX_PERIOD_IDS: Record<number, { suffix: string; labelKey: string; reviewKey: string }> = {
  5: {
    suffix: 'five-hour',
    labelKey: 'codex_quota.primary_window',
    reviewKey: 'codex_quota.code_review_primary_window',
  },
  168: {
    suffix: 'weekly',
    labelKey: 'codex_quota.secondary_window',
    reviewKey: 'codex_quota.code_review_secondary_window',
  },
};

/**
 * Converts the passive header snapshot into the same windows the active fetch
 * produces, so the two can be compared and merged by id.
 *
 * Claude's 5h and 7d and Codex's main and code-review limits map onto the active
 * ids. Anything else keeps its passive id; `7d_oi` is not mapped because its
 * meaning upstream is unconfirmed.
 */
export function headroomWindowsFromObservation(
  observation: AuthFileQuotaObservation | undefined
): HeadroomWindow[] {
  if (!observation) return [];
  return observation.windows.map((window): HeadroomWindow => {
    const base: HeadroomWindow = {
      id: window.id,
      usedPercent: clampPercent(window.usedPercent),
      resetAtMs: finiteOrNull(window.resetAtMs),
      periodHours: positiveOrNull(window.periodHours),
      ...(window.status === 'rejected' ? { rejected: true } : {}),
    };

    if (observation.provider === 'claude') {
      const mapped = CLAUDE_PASSIVE_IDS[window.id];
      return mapped ? { ...base, ...mapped } : base;
    }

    if (window.limitName) base.label = window.limitName;
    const limit = window.limit ?? '';
    const period = base.periodHours !== null ? Math.round(base.periodHours) : null;
    const mapped = period !== null ? CODEX_PERIOD_IDS[period] : undefined;
    if (!mapped) return base;
    if (limit === '') return { ...base, id: mapped.suffix, labelKey: mapped.labelKey };
    if (limit === 'code-review') {
      return { ...base, id: `code-review-${mapped.suffix}`, labelKey: mapped.reviewKey };
    }
    return base;
  });
}

/* -------------------------------------------------------------- primitives */

export const isWindowExhausted = (window: HeadroomWindow): boolean =>
  window.rejected === true || window.usedPercent >= 100;

/** Share of the window already elapsed, 0–100; null without a reset instant and length. */
export function windowElapsedPercent(window: HeadroomWindow, now: number): number | null {
  if (window.resetAtMs === null || window.periodHours === null) return null;
  const periodMs = window.periodHours * HOUR_MS;
  const startMs = window.resetAtMs - periodMs;
  return clampPercent(((now - startMs) / periodMs) * 100);
}

/** Usage compared with elapsed time: the pace marker on a meter. */
export function windowPace(window: HeadroomWindow, now: number): HeadroomPace | null {
  const elapsedPercent = windowElapsedPercent(window, now);
  if (elapsedPercent === null) return null;
  const deltaPercent = window.usedPercent - elapsedPercent;
  const state: HeadroomPaceState =
    deltaPercent > PACE_TOLERANCE_PERCENT
      ? 'ahead'
      : deltaPercent < -PACE_TOLERANCE_PERCENT
        ? 'under'
        : 'on-pace';
  return { usedPercent: window.usedPercent, elapsedPercent, deltaPercent, state };
}

/**
 * Percent used the window reaches by its reset at its average rate so far; may
 * exceed 100. Null under the same early-window rule as the run-out estimate.
 */
export function windowProjectedUsedPercent(window: HeadroomWindow, now: number): number | null {
  const elapsedPercent = windowElapsedPercent(window, now);
  if (elapsedPercent === null || elapsedPercent < RUNS_OUT_MIN_ELAPSED_PERCENT) return null;
  return (window.usedPercent / elapsedPercent) * 100;
}

/** The usage-mode reading a QuotaMeter draws for one window. */
export function windowMeterUsage(
  window: HeadroomWindow,
  now: number
): { usedPercent: number; elapsedPercent: number | null; projectedPercent: number | null } {
  return {
    usedPercent: window.usedPercent,
    elapsedPercent: windowElapsedPercent(window, now),
    projectedPercent: isWindowExhausted(window) ? null : windowProjectedUsedPercent(window, now),
  };
}

/**
 * When the window runs out at its average rate so far, if that is before it resets.
 *
 * Null until RUNS_OUT_MIN_ELAPSED_PERCENT of the window has elapsed, when nothing
 * has been used, when the window is already exhausted, or when it resets first.
 */
export function windowRunsOutAtMs(window: HeadroomWindow, now: number): number | null {
  if (isWindowExhausted(window) || window.usedPercent <= 0) return null;
  const elapsedPercent = windowElapsedPercent(window, now);
  if (elapsedPercent === null || elapsedPercent < RUNS_OUT_MIN_ELAPSED_PERCENT) return null;
  const periodMs = (window.periodHours as number) * HOUR_MS;
  const elapsedMs = (elapsedPercent / 100) * periodMs;
  const msPerPercent = elapsedMs / window.usedPercent;
  const runsOutAtMs = now + (100 - window.usedPercent) * msPerPercent;
  return runsOutAtMs < (window.resetAtMs as number) ? runsOutAtMs : null;
}

/**
 * The binding limit: least remaining, then the one that stays locked longest.
 *
 * An unknown reset counts as the longest wait, since nothing can be planned on it.
 */
export function tightestWindow(windows: readonly HeadroomWindow[]): HeadroomWindow | null {
  if (windows.length === 0) return null;
  const resetOf = (window: HeadroomWindow) => window.resetAtMs ?? Number.POSITIVE_INFINITY;
  return windows.reduce((best, window) => {
    const byExhausted = Number(isWindowExhausted(window)) - Number(isWindowExhausted(best));
    if (byExhausted !== 0) return byExhausted > 0 ? window : best;
    if (window.usedPercent !== best.usedPercent) {
      return window.usedPercent > best.usedPercent ? window : best;
    }
    return resetOf(window) > resetOf(best) ? window : best;
  });
}

/**
 * Whether the credential can take requests now and, if not, when it can again.
 *
 * A credential-wide cooldown and every exhausted window each block it; it comes
 * back when the last of them clears. Model-scoped cooldowns leave other models
 * usable, so they don't block the credential. Cooldown timers count from when the
 * snapshot was received, as the auth-files card does.
 */
export function headroomAvailability(
  windows: readonly HeadroomWindow[],
  cooldown: AuthFileCooldownSnapshot | undefined,
  now: number
): HeadroomAvailability {
  let exhausted = false;
  let exhaustedUnknownEnd = false;
  let exhaustedUntilMs: number | null = null;
  windows.forEach((window) => {
    if (!isWindowExhausted(window)) return;
    if (window.resetAtMs !== null && window.resetAtMs <= now) return;
    exhausted = true;
    if (window.resetAtMs === null) exhaustedUnknownEnd = true;
    else exhaustedUntilMs = Math.max(exhaustedUntilMs ?? 0, window.resetAtMs);
  });

  let cooldownUntilMs: number | null = null;
  const elapsedMs = cooldown ? Math.max(0, now - cooldown.receivedAtMs) : 0;
  (cooldown?.records ?? []).forEach((record) => {
    if (record.scope !== 'credential') return;
    const remainingMs = record.remainingSeconds * 1000 - elapsedMs;
    if (remainingMs > 0) cooldownUntilMs = Math.max(cooldownUntilMs ?? 0, now + remainingMs);
  });

  if (!exhausted && cooldownUntilMs === null) return { state: 'available' };
  if (exhaustedUnknownEnd) return { state: 'blocked', reason: 'exhausted', untilMs: null };
  // Whichever clears last decides when the credential is back.
  if (
    cooldownUntilMs !== null &&
    (exhaustedUntilMs === null || cooldownUntilMs > exhaustedUntilMs)
  ) {
    return { state: 'blocked', reason: 'cooldown', untilMs: cooldownUntilMs };
  }
  return { state: 'blocked', reason: 'exhausted', untilMs: exhaustedUntilMs };
}

/** Everything a card, verdict or pressure board needs about one credential. */
export function summarizeHeadroom(input: {
  windows: readonly HeadroomWindow[];
  cooldown?: AuthFileCooldownSnapshot;
  now: number;
}): HeadroomSummary {
  const { cooldown, now } = input;
  const windows = [...input.windows];
  const tightest = tightestWindow(windows);
  const pace = tightest ? windowPace(tightest, now) : null;
  const runsOut = compact(windows.map((window) => windowRunsOutAtMs(window, now)));
  const runsOutAtMs = runsOut.length > 0 ? Math.min(...runsOut) : null;
  const availability = headroomAvailability(windows, cooldown, now);

  let tier: HeadroomPressureTier;
  if (availability.state === 'blocked') tier = 'blocked';
  else if (!tightest) tier = 'unknown';
  else if (runsOutAtMs !== null) tier = 'runs-out';
  else if (pace?.state === 'ahead') tier = 'ahead';
  else tier = 'steady';

  return { windows, tightest, pace, runsOutAtMs, availability, tier };
}

/**
 * Pressure order: blocked first (soonest back first), then projected to run out
 * (soonest first), then ahead of pace, then the rest, each by tightest usage.
 */
export function compareHeadroomPressure(a: HeadroomSummary, b: HeadroomSummary): number {
  const byTier = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
  if (byTier !== 0) return byTier;

  if (a.availability.state === 'blocked' && b.availability.state === 'blocked') {
    const untilA = a.availability.untilMs ?? Number.POSITIVE_INFINITY;
    const untilB = b.availability.untilMs ?? Number.POSITIVE_INFINITY;
    if (untilA !== untilB) return untilA - untilB;
  }
  if (a.runsOutAtMs !== null && b.runsOutAtMs !== null && a.runsOutAtMs !== b.runsOutAtMs) {
    return a.runsOutAtMs - b.runsOutAtMs;
  }
  return (b.tightest?.usedPercent ?? -1) - (a.tightest?.usedPercent ?? -1);
}
