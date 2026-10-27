/**
 * Quota freshness: merging passive header snapshots with active fetches, and
 * deciding which credentials the background refresher should re-check.
 *
 * Pure functions; `now` is always passed in.
 */

import type { AuthFileQuotaObservation } from '@/types/authFile';
import { MINUTE_MS } from '@/utils/time/durations';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  headroomWindowsFromObservation,
  headroomWindowsFromQuota,
  type HeadroomWindow,
} from './headroom';
import type { QuotaFileEntry } from './logic';
import type { QuotaCardState } from './providers';

/** How often the background refresher looks for due credentials. */
export const AUTO_REFRESH_INTERVAL_MS = 5 * MINUTE_MS;
/** Active fetches in flight at once during a background pass. */
export const AUTO_REFRESH_CONCURRENCY = 3;
/** A passive snapshot younger than this keeps a credential off the refresh list. */
export const PASSIVE_FRESH_MS = 10 * MINUTE_MS;
/** A failed fetch waits this long before the refresher tries again. */
export const AUTO_REFRESH_ERROR_BACKOFF_MS = 15 * MINUTE_MS;

export type HeadroomSource = 'active' | 'passive' | 'mixed';

export interface CredentialHeadroom {
  windows: HeadroomWindow[];
  /** When the newest window was read; null when unknown. */
  seenAtMs: number | null;
  source: HeadroomSource | null;
}

/** Credential-level passive snapshot timing; null when its age is unknown. */
export const observationSeenAtMs = (
  observation: AuthFileQuotaObservation | undefined
): number | null =>
  observation && observation.windows.length > 0 ? (observation.seenAtMs ?? null) : null;

/**
 * One credential's windows from both sources, the fresher reading winning per window.
 *
 * Passive windows map onto active ids (see headroomWindowsFromObservation), so a
 * Claude 5-hour window seen in traffic two minutes ago replaces the one fetched an
 * hour ago, while windows only the active fetch knows about (per-model weekly
 * limits) stay. A passive snapshot of unknown age never replaces an active reading.
 */
export function resolveCredentialHeadroom(
  entry: QuotaFileEntry,
  quota: QuotaCardState | undefined,
  observation: AuthFileQuotaObservation | undefined,
  checkedAtMs: number | undefined
): CredentialHeadroom {
  const active = headroomWindowsFromQuota(entry.type, quota);
  const activeAtMs = active.length > 0 ? (checkedAtMs ?? null) : null;
  const passive =
    entry.type === 'claude' || entry.type === 'codex'
      ? headroomWindowsFromObservation(observation)
      : [];
  const passiveAtMs = observationSeenAtMs(observation);

  if (passive.length === 0) {
    return { windows: active, seenAtMs: activeAtMs, source: active.length ? 'active' : null };
  }
  if (active.length === 0) {
    return { windows: passive, seenAtMs: passiveAtMs, source: 'passive' };
  }

  const passiveWins = passiveAtMs !== null && (activeAtMs === null || passiveAtMs > activeAtMs);
  const byId = new Map(active.map((window) => [window.id, window]));
  let replaced = false;
  passive.forEach((window) => {
    if (!byId.has(window.id)) {
      // A window only the headers carry (e.g. a named Codex limit) adds information.
      byId.set(window.id, window);
      replaced = true;
    } else if (passiveWins) {
      byId.set(window.id, window);
      replaced = true;
    }
  });

  const seenAtMs = passiveWins ? passiveAtMs : activeAtMs;
  return { windows: Array.from(byId.values()), seenAtMs, source: replaced ? 'mixed' : 'active' };
}

export interface AutoRefreshInput {
  entries: readonly QuotaFileEntry[];
  quotaFor: (entry: QuotaFileEntry) => QuotaCardState | undefined;
  observedQuota: Readonly<Record<string, AuthFileQuotaObservation>>;
  quotaCheckedAt: Readonly<Record<string, number>>;
  now: number;
}

/**
 * Credentials due for a background re-check.
 *
 * Skipped: anything loading, anything whose passive snapshot is fresh (traffic is
 * already keeping it current), anything checked within the interval, and failed
 * credentials still inside their back-off. Never-checked credentials are due.
 */
export function selectAutoRefreshTargets(input: AutoRefreshInput): QuotaFileEntry[] {
  const { entries, quotaFor, observedQuota, quotaCheckedAt, now } = input;
  return entries.filter((entry) => {
    const key = getQuotaCacheKey(entry.file);
    const quota = quotaFor(entry);
    if (quota?.status === 'loading') return false;

    const passiveAtMs = observationSeenAtMs(observedQuota[key]);
    if (passiveAtMs !== null && now - passiveAtMs < PASSIVE_FRESH_MS) return false;

    const checkedAtMs = quotaCheckedAt[key];
    if (checkedAtMs === undefined) return true;
    const waitMs =
      quota?.status === 'error' ? AUTO_REFRESH_ERROR_BACKOFF_MS : AUTO_REFRESH_INTERVAL_MS;
    return now - checkedAtMs >= waitMs;
  });
}

/** Runs `worker` over `items` with at most `limit` in flight; stops starting new work once `shouldStop` is true. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean = () => false
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !shouldStop()) {
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}
