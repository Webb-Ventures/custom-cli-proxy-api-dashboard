/**
 * Estimated capacity per credential: each credential's longest limit window
 * from the shared headroom data, joined with the ledger's tokens since that
 * window reset (POST windows).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { useCredentialHeadroom } from '@/features/quota/hooks/useCredentialHeadroom';
import { apiClient, usageLedgerApi } from '@/services/api';
import type { UsagePrices, UsageWindowResult } from '@/services/api/usageLedger';
import type { HeadroomWindow } from '@/features/quota/headroom';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/authIndex';
import {
  capacityWindow,
  estimateAccountCapacity,
  windowStartMs,
  type AccountCapacity,
} from '../capacity';

export function useUsageCapacity(options: {
  files: readonly AuthFileItem[];
  prices: UsagePrices | null;
  enabled: boolean;
  now: number;
  reloadKey: number;
}) {
  const { files, prices, enabled, now, reloadKey } = options;
  const entries = useMemo(() => classifyQuotaFiles([...files]), [files]);
  const { headroomFor } = useCredentialHeadroom(entries, now);

  // One request per credential with a readable window, keyed so it only refetches when one moves.
  const targets = useMemo(() => {
    const list: { authIndex: string; provider: string; sinceMs: number; window: HeadroomWindow }[] =
      [];
    entries.forEach((entry) => {
      const authIndex = normalizeAuthIndex(entry.file['auth_index'] ?? entry.file.authIndex);
      const headroom = headroomFor(entry);
      const window = headroom ? capacityWindow(headroom.summary.windows) : null;
      const sinceMs = window ? windowStartMs(window) : null;
      if (!authIndex || !window || sinceMs === null || sinceMs > now) return;
      list.push({ authIndex, provider: entry.type, sinceMs, window });
    });
    return list;
  }, [entries, headroomFor, now]);
  const requestKey = targets.map((target) => `${target.authIndex}@${target.sinceMs}`).join('|');

  const [results, setResults] = useState<Map<string, UsageWindowResult>>(new Map());
  const requestId = useRef(0);

  useEffect(() => {
    if (!enabled || !requestKey) return;
    const id = ++requestId.current;
    const revision = apiClient.getConnectionRevision();
    usageLedgerApi
      .windows(
        requestKey.split('|').map((part) => {
          const at = part.lastIndexOf('@');
          return { authIndex: part.slice(0, at), sinceMs: Number(part.slice(at + 1)) };
        })
      )
      .then((response) => {
        if (id !== requestId.current || revision !== apiClient.getConnectionRevision()) return;
        setResults(new Map(response.windows.map((window) => [window.authIndex, window])));
      })
      .catch(() => {
        // Capacity is an extra; without it the views simply leave the columns empty.
      });
  }, [enabled, requestKey, reloadKey]);

  const byAuthIndex = useMemo(() => {
    const map = new Map<string, AccountCapacity>();
    targets.forEach((target) => {
      const result = results.get(target.authIndex);
      if (!result) return;
      map.set(
        target.authIndex,
        estimateAccountCapacity(target.window, result, target.provider, prices)
      );
    });
    return map;
  }, [targets, results, prices]);

  return { byAuthIndex };
}
