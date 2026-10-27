/**
 * Headroom for one credential outside the Quota page (auth-file cards): its
 * active quota reading merged with the traffic headers on the file itself.
 */

import { useMemo } from 'react';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { resolveCredentialHeadroom, type SummarizedHeadroom } from '../freshness';
import { summarizeHeadroom } from '../headroom';
import { QUOTA_ADAPTERS } from '../providers';
import type { QuotaProviderType } from '../providers/types';

/** Null when the credential has no quota type or nothing has been read yet. */
export function useFileHeadroom(
  file: AuthFileItem,
  quotaType: QuotaProviderType | null,
  now: number
): SummarizedHeadroom | null {
  const cacheKey = getQuotaCacheKey(file);
  const quota = useQuotaStore((state) =>
    quotaType ? QUOTA_ADAPTERS[quotaType].storeSelector(state)[cacheKey] : undefined
  );
  const checkedAtMs = useQuotaStore((state) => state.quotaCheckedAt[cacheKey]);

  return useMemo(() => {
    if (!quotaType) return null;
    const resolved = resolveCredentialHeadroom(
      { type: quotaType, file },
      quota,
      file.quotaObservation,
      checkedAtMs
    );
    const summary = summarizeHeadroom({
      windows: resolved.windows,
      cooldown: file.cooldownSnapshot,
      now,
    });
    if (!summary.tightest) return null;
    return { summary, seenAtMs: resolved.seenAtMs, seenFrom: resolved.seenFrom };
  }, [quotaType, file, quota, checkedAtMs, now]);
}
