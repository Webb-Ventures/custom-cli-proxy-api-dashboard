/**
 * Usage ledger data for the Usage page: plugin detection and prices, the
 * selected range's summaries, series and blocks, and the credential map with
 * each credential's plan.
 *
 * Every load records the connection revision and a request id; a response from
 * an older request or another connection is dropped.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiClient, authFilesApi, usageLedgerApi } from '@/services/api';
import type {
  UsageBlocks,
  UsageGroup,
  UsageLedgerSettings,
  UsageLedgerStatus,
  UsagePrices,
  UsageSeries,
  UsageSummary,
} from '@/services/api/usageLedger';
import { useAuthStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { resolveCodexPlanType } from '@/utils/quota/resolvers';
import { resolveQuotaProviderType } from '@/features/quota/logic';
import { detectCredentialPlan, resolveCredentialPlan } from '../cost';
import { ledgerParams, type ResolvedUsageRange } from '../range';
import type { UsageCredential } from '../usageModel';

export type LedgerAvailability = 'checking' | 'available' | 'absent' | 'unsupported' | 'error';

/** One guard per hook instance: newer requests and connection changes win. */
function useRequestGuard() {
  const requestId = useRef(0);
  return useCallback(() => {
    const id = ++requestId.current;
    const revision = apiClient.getConnectionRevision();
    return () => id === requestId.current && revision === apiClient.getConnectionRevision();
  }, []);
}

export function useLedgerPlugin() {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  const [availability, setAvailability] = useState<LedgerAvailability>('checking');
  const [status, setStatus] = useState<UsageLedgerStatus | null>(null);
  const [prices, setPrices] = useState<UsagePrices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const begin = useRequestGuard();

  useEffect(() => {
    if (!connected) return;
    const isCurrent = begin();
    if (!supportsPlugin) {
      setAvailability('unsupported');
      return;
    }
    setAvailability('checking');
    usageLedgerApi
      .detect()
      .then(async (result) => {
        if (!isCurrent()) return;
        if (result.state === 'absent') {
          setAvailability('absent');
          return;
        }
        setStatus(result.status);
        setAvailability('available');
        const loaded = await usageLedgerApi.prices().catch(() => null);
        if (isCurrent()) setPrices(loaded);
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return;
        setError(err instanceof Error ? err.message : String(err));
        setAvailability('error');
      });
  }, [connected, supportsPlugin, reloadKey, begin]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  const saveSettings = useCallback(async (settings: UsageLedgerSettings) => {
    const saved = await usageLedgerApi.saveSettings(settings);
    setPrices((current) => (current ? { ...current, overrides: saved } : current));
    return saved;
  }, []);

  return { availability, status, prices, error, reload, saveSettings };
}

export interface UsageRangeData {
  summary: UsageSummary;
  previous: UsageSummary | null;
  byCredential: UsageSummary | null;
  series: UsageSeries | null;
  blocks: UsageBlocks | null;
}

export function useUsageRangeData(options: {
  enabled: boolean;
  range: ResolvedUsageRange;
  group: UsageGroup;
  credentialFilter?: string;
  reloadKey: number;
}) {
  const { enabled, range, group, credentialFilter, reloadKey } = options;
  const [data, setData] = useState<UsageRangeData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const begin = useRequestGuard();
  const { from, to, tz, bucket } = range;
  const previousFrom = range.previous.from;
  const previousTo = range.previous.to;

  useEffect(() => {
    if (!enabled) return;
    const isCurrent = begin();
    // A credential filter reads that credential's group, so everything is grouped by credential.
    const effectiveGroup: UsageGroup = credentialFilter ? 'credential' : group;
    const current = ledgerParams({ from, to }, tz);
    setLoading(true);
    setError(null);
    Promise.all([
      usageLedgerApi.summary({ ...current, group: effectiveGroup }),
      usageLedgerApi
        .summary({
          ...ledgerParams({ from: previousFrom, to: previousTo }, tz),
          group: effectiveGroup,
        })
        .catch(() => null),
      effectiveGroup === 'credential'
        ? Promise.resolve(null)
        : usageLedgerApi.summary({ ...current, group: 'credential' }).catch(() => null),
      usageLedgerApi
        .series({
          ...current,
          bucket,
          ...(credentialFilter ? { group: 'credential' as const } : {}),
        })
        .catch(() => null),
      usageLedgerApi.blocks(current).catch(() => null),
    ])
      .then(([summary, previous, byCredential, series, blocks]) => {
        if (!isCurrent()) return;
        setData({
          summary,
          previous,
          byCredential: byCredential ?? (effectiveGroup === 'credential' ? summary : null),
          series,
          blocks,
        });
      })
      .catch((err: unknown) => {
        if (isCurrent()) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
  }, [
    enabled,
    from,
    to,
    tz,
    bucket,
    previousFrom,
    previousTo,
    group,
    credentialFilter,
    reloadKey,
    begin,
  ]);

  return { data, loading, error };
}

/** Credentials by `auth_index`, labelled and with their plan resolved. */
export function useUsageCredentials(prices: UsagePrices | null, enabled: boolean) {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const begin = useRequestGuard();

  useEffect(() => {
    if (!connected || !enabled) return;
    const isCurrent = begin();
    const generation = useQuotaStore.getState().cacheGeneration;
    authFilesApi
      .list()
      .then((response) => {
        if (!isCurrent() || generation !== useQuotaStore.getState().cacheGeneration) return;
        setFiles(response.files);
        useQuotaStore.getState().syncObservedQuota(response.files);
      })
      .catch(() => {
        // Without the list, credentials show by auth_index.
      });
  }, [connected, enabled, begin]);

  const credentials = useMemo(() => {
    const map = new Map<string, UsageCredential>();
    files.forEach((file) => {
      const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      if (!authIndex) return;
      const type =
        resolveQuotaProviderType(file) ?? String(file.type ?? file.provider ?? '').toLowerCase();
      const key = getQuotaCacheKey(file);
      const claude = type === 'claude' ? claudeQuota[key] : undefined;
      const codex = type === 'codex' ? codexQuota[key] : undefined;
      const detected = detectCredentialPlan({
        type,
        planType: claude?.planType ?? codex?.planType ?? null,
        rateLimitTier: claude?.rateLimitTier ?? null,
        observedPlanType: file.quotaObservation?.planType ?? null,
        filePlanType: type === 'codex' ? resolveCodexPlanType(file) : null,
      });
      map.set(authIndex, {
        authIndex,
        name: file.name,
        type,
        plan: resolveCredentialPlan(authIndex, detected, prices, prices?.overrides ?? null),
      });
    });
    return map;
  }, [files, claudeQuota, codexQuota, prices]);

  return { credentials, files };
}
