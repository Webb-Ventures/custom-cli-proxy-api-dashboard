/**
 * Today's ledger totals for surfaces outside the Usage page: the dashboard
 * strip and the auth-file cards. Reloads once a minute while mounted; reports
 * `available: false` (and renders nothing upstream) without the plugin.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiClient, usageLedgerApi } from '@/services/api';
import type { UsageBlocks, UsageSummary } from '@/services/api/usageLedger';
import { useNow } from '@/hooks/useNow';
import { resolveQuotaProviderType } from '@/features/quota/logic';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import { valueOfModelRows } from '../cost';
import { browserTimeZone, dayInZone } from '../range';
import { buildBlocks, parseGroupKey, type CurrentBlock } from '../usageModel';
import { useLedgerPlugin } from './useUsageLedger';

const RELOAD_MS = 60_000;

/** Credential type by `auth_index` from the auth-file list, for price lookups. */
export function useProviderLookup(files: readonly AuthFileItem[] | null | undefined) {
  const types = useMemo(() => {
    const map = new Map<string, string>();
    (files ?? []).forEach((file) => {
      const authIndex = normalizeAuthIndex(file['auth_index'] ?? file.authIndex);
      if (!authIndex) return;
      map.set(
        authIndex,
        resolveQuotaProviderType(file) ?? String(file.type ?? file.provider ?? '').toLowerCase()
      );
    });
    return map;
  }, [files]);
  return useCallback((authIndex: string) => types.get(authIndex) ?? null, [types]);
}

export interface CredentialToday {
  requests: number;
  tokens: number;
  valueUsd: number;
}

export interface UsageToday {
  available: boolean;
  tokens: number;
  valueUsd: number;
  byCredential: ReadonlyMap<string, CredentialToday>;
  current: CurrentBlock | null;
}

/**
 * @param providerOf credential type by `auth_index`, the price-lookup hint.
 */
export function useUsageToday(providerOf?: (authIndex: string) => string | null): UsageToday {
  const plugin = useLedgerPlugin();
  const available = plugin.availability === 'available';
  const now = useNow(available);
  const tz = useMemo(() => browserTimeZone(), []);
  const today = dayInZone(now, tz);
  const [data, setData] = useState<{ summary: UsageSummary; blocks: UsageBlocks | null } | null>(
    null
  );
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!available) return undefined;
    const timer = window.setInterval(() => setTick((value) => value + 1), RELOAD_MS);
    return () => window.clearInterval(timer);
  }, [available]);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    const revision = apiClient.getConnectionRevision();
    const params = { from: today, to: today, tz };
    Promise.all([
      usageLedgerApi.summary({ ...params, group: 'credential' }),
      usageLedgerApi.blocks(params).catch(() => null),
    ])
      .then(([summary, blocks]) => {
        if (!cancelled && revision === apiClient.getConnectionRevision())
          setData({ summary, blocks });
      })
      .catch(() => {
        // Optional surface: leave the last good numbers in place.
      });
    return () => {
      cancelled = true;
    };
  }, [available, today, tz, tick]);

  return useMemo(() => {
    const byCredential = new Map<string, CredentialToday>();
    let tokens = 0;
    let valueUsd = 0;
    data?.summary.groups.forEach((group) => {
      const parsed = parseGroupKey(group.key);
      const value = valueOfModelRows(
        group.byModel,
        parsed?.kind === 'credential' && providerOf ? providerOf(parsed.id) : null,
        plugin.prices
      ).usd;
      tokens += group.tokens.total;
      valueUsd += value;
      if (parsed?.kind === 'credential' && parsed.id) {
        byCredential.set(parsed.id, {
          requests: group.requests,
          tokens: group.tokens.total,
          valueUsd: value,
        });
      }
    });
    const current = buildBlocks(data?.blocks?.blocks ?? [], plugin.prices, now).current;
    return { available: available && data !== null, tokens, valueUsd, byCredential, current };
  }, [available, data, plugin.prices, providerOf, now]);
}
