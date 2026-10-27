/**
 * Background quota refresher.
 *
 * While the tab is visible, re-checks credentials that passive traffic is not
 * keeping current: every AUTO_REFRESH_INTERVAL_MS, and as soon as the tab becomes
 * visible again. A pass fetches at most AUTO_REFRESH_CONCURRENCY at a time and
 * commits silently — no loading state, and a failure never replaces a good
 * reading. The same guards as the batch loader apply: a newer pass or unmount
 * drops results, and a cache-generation change (reconnect, logout, file mutation)
 * keeps old responses out of the new session.
 */

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent, useQuotaStore } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import {
  AUTO_REFRESH_CONCURRENCY,
  AUTO_REFRESH_INTERVAL_MS,
  runWithConcurrency,
  selectAutoRefreshTargets,
} from '../freshness';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, getQuotaSetter } from '../providers';
import { enrichQuotaInBackground } from '../quotaEnrichment';

const isVisible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

export function useQuotaAutoRefresh(entries: readonly QuotaFileEntry[], disabled: boolean) {
  const { t } = useTranslation();
  const entriesRef = useRef(entries);
  // Declared before the refresher effect so its first pass sees the current list.
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  const passRef = useRef(0);
  const runningRef = useRef(false);

  useEffect(() => {
    if (disabled) return undefined;

    const runPass = async () => {
      if (runningRef.current || !isVisible()) return;
      const state = useQuotaStore.getState();
      const targets = selectAutoRefreshTargets({
        entries: entriesRef.current,
        quotaFor: (entry) =>
          QUOTA_ADAPTERS[entry.type].storeSelector(state)[getQuotaCacheKey(entry.file)],
        observedQuota: state.observedQuota,
        quotaCheckedAt: state.quotaCheckedAt,
        now: Date.now(),
      });
      if (targets.length === 0) return;

      runningRef.current = true;
      const pass = ++passRef.current;
      const isCurrentPass = () => pass === passRef.current;
      try {
        await runWithConcurrency(
          targets,
          AUTO_REFRESH_CONCURRENCY,
          async ({ file, type }) => {
            const adapter = QUOTA_ADAPTERS[type];
            const cacheKey = getQuotaCacheKey(file);
            const generation = captureQuotaCacheGeneration(file.name);
            const before = adapter.storeSelector(useQuotaStore.getState())[cacheKey];
            let data: unknown;
            let failure: { message: string; status?: number } | null = null;
            try {
              data = await adapter.fetchQuota(file, t);
            } catch (err: unknown) {
              failure = {
                message: err instanceof Error ? err.message : t('common.unknown_error'),
                status: getStatusFromError(err),
              };
            }
            if (!isCurrentPass()) return;

            commitIfQuotaCacheCurrent(generation, () => {
              const store = useQuotaStore.getState();
              const current = adapter.storeSelector(store)[cacheKey];
              // A user-triggered load started meanwhile owns this card now.
              if (current !== before) return;
              if (failure && current?.status === 'success') {
                // Keep the good reading; the stamp still starts the error back-off.
                store.markQuotaChecked([cacheKey], Date.now());
                return;
              }
              const next = failure
                ? adapter.buildErrorState(failure.message, failure.status)
                : adapter.buildSuccessState(data);
              getQuotaSetter(adapter)((prev) => ({ ...prev, [cacheKey]: next }));
              if (!failure) void enrichQuotaInBackground(adapter, file, data, next, t);
            });
          },
          () => !isCurrentPass() || !isVisible()
        );
      } finally {
        if (isCurrentPass()) runningRef.current = false;
      }
    };

    void runPass();
    const interval = window.setInterval(() => void runPass(), AUTO_REFRESH_INTERVAL_MS);
    const onVisibility = () => {
      if (isVisible()) void runPass();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      // Invalidate the pass in flight; its results are dropped.
      passRef.current += 1;
      runningRef.current = false;
    };
  }, [disabled, t]);
}
