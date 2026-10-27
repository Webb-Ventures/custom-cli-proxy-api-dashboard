/**
 * QuotaMeter geometry and tone, kept out of the component file so it can be
 * shared and tested without React.
 */

import { PACE_TOLERANCE_PERCENT } from './headroom';

export const QUOTA_PROGRESS_HIGH_THRESHOLD = 70;
export const QUOTA_PROGRESS_MEDIUM_THRESHOLD = 30;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const round2 = (value: number) => Math.round(value * 100) / 100;

/** Percent-used reading for a window, with pace when its timing is known. */
export interface QuotaMeterUsage {
  usedPercent: number;
  /** Share of the window elapsed, 0–100. */
  elapsedPercent?: number | null;
  /** Percent used by reset at the current rate; may exceed 100. */
  projectedPercent?: number | null;
}

export type QuotaMeterTone = 'high' | 'medium' | 'low';

export interface QuotaMeterModel {
  fillPercent: number;
  tone: QuotaMeterTone;
  pacePercent: number | null;
  projection: { leftPercent: number; widthPercent: number } | null;
  runsOut: boolean;
}

/** Tone from remaining percent: the legacy three bands. */
export const toneFromRemaining = (remaining: number): QuotaMeterTone =>
  remaining >= QUOTA_PROGRESS_HIGH_THRESHOLD
    ? 'high'
    : remaining >= QUOTA_PROGRESS_MEDIUM_THRESHOLD
      ? 'medium'
      : 'low';

/**
 * Geometry and tone for usage mode.
 *
 * Red once the window is spent or projected to run out before reset; amber when
 * ahead of pace or past 70% used; green otherwise. Without timing it falls back
 * to the remaining-percent bands.
 */
export function quotaMeterModel(usage: QuotaMeterUsage): QuotaMeterModel {
  const used = clamp(usage.usedPercent, 0, 100);
  const elapsed =
    typeof usage.elapsedPercent === 'number' && Number.isFinite(usage.elapsedPercent)
      ? clamp(usage.elapsedPercent, 0, 100)
      : null;
  const projected =
    typeof usage.projectedPercent === 'number' && Number.isFinite(usage.projectedPercent)
      ? usage.projectedPercent
      : null;
  const runsOut = used < 100 && projected !== null && projected >= 100;

  let tone: QuotaMeterTone;
  if (used >= 100 || runsOut) tone = 'low';
  else if (elapsed === null) tone = toneFromRemaining(100 - used);
  else if (used - elapsed > PACE_TOLERANCE_PERCENT || used >= QUOTA_PROGRESS_HIGH_THRESHOLD) {
    tone = 'medium';
  } else tone = 'high';

  const projectedEnd = projected !== null ? clamp(projected, used, 100) : used;
  return {
    fillPercent: round2(used),
    tone,
    pacePercent: elapsed !== null ? round2(elapsed) : null,
    projection:
      projectedEnd > used
        ? { leftPercent: round2(used), widthPercent: round2(projectedEnd - used) }
        : null,
    runsOut,
  };
}
