/**
 * Fleet-level headroom for the dashboard: how many credentials have room, which
 * comes back next, and how much of the weekly pool is spent.
 *
 * Pure; the caller passes credentials already summarized by the quota feature.
 */

import type { SummarizedHeadroom } from '@/features/quota/freshness';
import { compareHeadroomPressure, type HeadroomWindow } from '@/features/quota/headroom';

export interface HeadroomRow<T> {
  item: T;
  headroom: SummarizedHeadroom;
}

export interface NextCapacity<T> {
  item: T;
  /** When it can take requests again; null when no reset instant is known. */
  atMs: number | null;
  reason: 'cooldown' | 'exhausted';
  /** The used-up window, when that is what blocks it. */
  window: HeadroomWindow | null;
}

export interface FleetHeadroom<T> {
  /** Credentials with any reading. */
  total: number;
  withRoom: number;
  /** Ahead of pace, including those projected to run out before reset. */
  ahead: number;
  cooling: number;
  exhausted: number;
  /** Most constrained first. */
  ranked: HeadroomRow<T>[];
  next: NextCapacity<T> | null;
  /** Mean of each credential's highest weekly window, 0–100; null when none is known. */
  weeklyPoolUsed: number | null;
  weeklyCount: number;
  /** Newest reading across the fleet. */
  latestSeenAtMs: number | null;
}

const WEEK_HOURS = 24 * 7;

/** Long windows within a day of a week count as weekly (Codex reports 10080 minutes). */
const isWeekly = (window: HeadroomWindow) =>
  window.periodHours !== null && Math.abs(window.periodHours - WEEK_HOURS) <= 24;

export function summarizeFleetHeadroom<T>(rows: readonly HeadroomRow<T>[]): FleetHeadroom<T> {
  let withRoom = 0;
  let ahead = 0;
  let cooling = 0;
  let exhausted = 0;
  let weeklySum = 0;
  let weeklyCount = 0;
  let latestSeenAtMs: number | null = null;
  let next: NextCapacity<T> | null = null;

  rows.forEach(({ item, headroom }) => {
    const { summary } = headroom;
    const { availability } = summary;
    if (availability.state === 'available') withRoom += 1;
    else if (availability.reason === 'cooldown') cooling += 1;
    else exhausted += 1;
    if (summary.tier === 'ahead' || summary.tier === 'runs-out') ahead += 1;

    const weekly = summary.windows.filter(isWeekly);
    if (weekly.length > 0) {
      weeklySum += Math.max(...weekly.map((window) => window.usedPercent));
      weeklyCount += 1;
    }

    if (headroom.seenAtMs !== null) {
      latestSeenAtMs = Math.max(latestSeenAtMs ?? 0, headroom.seenAtMs);
    }

    if (availability.state === 'blocked') {
      const candidateAt = availability.untilMs ?? Number.POSITIVE_INFINITY;
      const currentAt = next ? (next.atMs ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
      if (!next || candidateAt < currentAt) {
        next = {
          item,
          atMs: availability.untilMs,
          reason: availability.reason,
          window:
            availability.reason === 'exhausted'
              ? (summary.windows.find(
                  (window) =>
                    window.resetAtMs === availability.untilMs &&
                    (window.rejected || window.usedPercent >= 100)
                ) ?? summary.tightest)
              : null,
        };
      }
    }
  });

  return {
    total: rows.length,
    withRoom,
    ahead,
    cooling,
    exhausted,
    ranked: [...rows].sort((a, b) =>
      compareHeadroomPressure(a.headroom.summary, b.headroom.summary)
    ),
    next,
    weeklyPoolUsed: weeklyCount > 0 ? weeklySum / weeklyCount : null,
    weeklyCount,
    latestSeenAtMs,
  };
}
