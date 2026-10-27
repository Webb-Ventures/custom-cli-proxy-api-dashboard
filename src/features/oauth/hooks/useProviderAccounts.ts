/**
 * Signed-in accounts per provider for the login gallery. Loads the auth-file
 * list (again after each new sign-in) and reads headroom from what the quota
 * store and traffic headers already know; it never fetches quota itself.
 */

import { useEffect, useMemo, useState } from 'react';
import { authFilesApi } from '@/services/api';
import { useAuthStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { useNow } from '@/hooks/useNow';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { useCredentialHeadroom } from '@/features/quota/hooks/useCredentialHeadroom';
import { summarizeProviderAccounts } from '../providerAccounts';

export function useProviderAccounts(addedCount: number) {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [files, setFiles] = useState<AuthFileItem[]>([]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    const generation = useQuotaStore.getState().cacheGeneration;
    authFilesApi
      .list()
      .then((response) => {
        if (cancelled || generation !== useQuotaStore.getState().cacheGeneration) return;
        setFiles(response.files);
        useQuotaStore.getState().syncObservedQuota(response.files);
      })
      .catch(() => {
        // The gallery works without account counts.
      });
    return () => {
      cancelled = true;
    };
  }, [connected, addedCount]);

  const entries = useMemo(() => classifyQuotaFiles(files), [files]);
  const now = useNow();
  const { headroomFor } = useCredentialHeadroom(entries, now);
  return useMemo(() => summarizeProviderAccounts(entries, headroomFor), [entries, headroomFor]);
}
