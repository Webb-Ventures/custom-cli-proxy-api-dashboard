/**
 * Per-credential headroom from the quota store: active fetches and passive
 * traffic headers merged, then summarized against the current minute.
 * Shared by the Quota page and the dashboard so both rank credentials the same way.
 */

import { useCallback, useMemo } from 'react';
import { useQuotaStore } from '@/stores';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { resolveCredentialHeadroom, type SummarizedHeadroom } from '../freshness';
import { summarizeHeadroom } from '../headroom';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS } from '../providers';

export function useCredentialHeadroom(entries: readonly QuotaFileEntry[], now: number) {
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const devinQuota = useQuotaStore((state) => state.devinQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);
  const metaQuota = useQuotaStore((state) => state.metaQuota);
  const pluginQuota = useQuotaStore((state) => state.pluginQuota);
  const xaiQuota = useQuotaStore((state) => state.xaiQuota);
  const observedQuota = useQuotaStore((state) => state.observedQuota);
  const quotaCheckedAt = useQuotaStore((state) => state.quotaCheckedAt);

  const headroomByKey = useMemo(() => {
    // Read through the adapters so the provider → store-slice mapping lives in one place.
    const state = {
      antigravityQuota,
      claudeQuota,
      codexQuota,
      devinQuota,
      kimiQuota,
      metaQuota,
      pluginQuota,
      xaiQuota,
    } as Parameters<(typeof QUOTA_ADAPTERS)['claude']['storeSelector']>[0];
    const byKey = new Map<string, SummarizedHeadroom>();
    entries.forEach((entry) => {
      const key = getQuotaCacheKey(entry.file);
      const resolved = resolveCredentialHeadroom(
        entry,
        QUOTA_ADAPTERS[entry.type].storeSelector(state)[key],
        observedQuota[key],
        quotaCheckedAt[key]
      );
      const summary = summarizeHeadroom({
        windows: resolved.windows,
        cooldown: entry.file.cooldownSnapshot,
        now,
      });
      // Nothing read and nothing blocking: leave the credential unknown.
      if (summary.tier === 'unknown') return;
      byKey.set(`${entry.type}:${key}`, {
        summary,
        seenAtMs: resolved.seenAtMs,
        seenFrom: resolved.seenFrom,
      });
    });
    return byKey;
  }, [
    entries,
    antigravityQuota,
    claudeQuota,
    codexQuota,
    devinQuota,
    kimiQuota,
    metaQuota,
    pluginQuota,
    xaiQuota,
    observedQuota,
    quotaCheckedAt,
    now,
  ]);

  const headroomFor = useCallback(
    (entry: QuotaFileEntry) => headroomByKey.get(`${entry.type}:${getQuotaCacheKey(entry.file)}`),
    [headroomByKey]
  );

  return { headroomByKey, headroomFor };
}
