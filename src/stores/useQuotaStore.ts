/**
 * Quota cache that survives route switches.
 */

import { create } from 'zustand';
import { getQuotaCacheFileName, getQuotaCacheKey } from '@/utils/quota/identity';
import type {
  AntigravityQuotaState,
  AuthFileItem,
  AuthFileQuotaObservation,
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  KimiQuotaState,
  MetaQuotaState,
  PluginQuotaState,
  XaiQuotaState,
} from '@/types';

type QuotaUpdater<T> = T | ((prev: T) => T);

interface QuotaStoreState {
  cacheGeneration: number;
  fileGenerations: Record<string, number>;
  antigravityQuota: Record<string, AntigravityQuotaState>;
  claudeQuota: Record<string, ClaudeQuotaState>;
  codexQuota: Record<string, CodexQuotaState>;
  devinQuota: Record<string, DevinQuotaState>;
  kimiQuota: Record<string, KimiQuotaState>;
  metaQuota: Record<string, MetaQuotaState>;
  pluginQuota: Record<string, PluginQuotaState>;
  xaiQuota: Record<string, XaiQuotaState>;
  /** Passive header snapshots from the latest credentials list, by quota cache key. */
  observedQuota: Record<string, AuthFileQuotaObservation>;
  /** Local time each credential's quota was last actively fetched, by quota cache key. */
  quotaCheckedAt: Record<string, number>;
  setAntigravityQuota: (updater: QuotaUpdater<Record<string, AntigravityQuotaState>>) => void;
  setClaudeQuota: (updater: QuotaUpdater<Record<string, ClaudeQuotaState>>) => void;
  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;
  setDevinQuota: (updater: QuotaUpdater<Record<string, DevinQuotaState>>) => void;
  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;
  setMetaQuota: (updater: QuotaUpdater<Record<string, MetaQuotaState>>) => void;
  setPluginQuota: (updater: QuotaUpdater<Record<string, PluginQuotaState>>) => void;
  setXaiQuota: (updater: QuotaUpdater<Record<string, XaiQuotaState>>) => void;
  clearQuotaCache: (names?: string[]) => void;
  /** Replace passive snapshots from a credentials list; credentials not listed are dropped. */
  syncObservedQuota: (files: AuthFileItem[]) => void;
  markQuotaChecked: (keys: string[], atMs: number) => void;
}

const resolveUpdater = <T>(updater: QuotaUpdater<T>, prev: T): T => {
  if (typeof updater === 'function') {
    return (updater as (value: T) => T)(prev);
  }
  return updater;
};

/**
 * Record when each credential last finished an active fetch: any entry that
 * changed and landed on success or error. Covers the batch loader, single-card
 * refresh, reset and background refresh without each having to remember.
 */
const stampCheckedAt = (
  prev: Record<string, { status: string }>,
  next: Record<string, { status: string }>,
  checkedAt: Record<string, number>
): Record<string, number> => {
  let stamped = checkedAt;
  const now = Date.now();
  for (const [key, quota] of Object.entries(next)) {
    if (quota === prev[key] || (quota.status !== 'success' && quota.status !== 'error')) continue;
    if (stamped === checkedAt) stamped = { ...checkedAt };
    stamped[key] = now;
  }
  return stamped;
};

export const useQuotaStore = create<QuotaStoreState>((set) => ({
  cacheGeneration: 0,
  fileGenerations: {},
  antigravityQuota: {},
  claudeQuota: {},
  codexQuota: {},
  devinQuota: {},
  kimiQuota: {},
  metaQuota: {},
  pluginQuota: {},
  xaiQuota: {},
  observedQuota: {},
  quotaCheckedAt: {},
  setAntigravityQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.antigravityQuota);
      return {
        antigravityQuota: next,
        quotaCheckedAt: stampCheckedAt(state.antigravityQuota, next, state.quotaCheckedAt),
      };
    }),
  setClaudeQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.claudeQuota);
      let retained = next;
      for (const [key, quota] of Object.entries(next)) {
        const previous = state.claudeQuota[key];
        if (
          previous &&
          quota !== previous &&
          (quota.status === 'loading' || quota.status === 'error') &&
          !quota.observedAt &&
          (previous.observedAt ||
            previous.windows.length ||
            previous.extraUsage ||
            previous.dollarWindows?.length)
        ) {
          if (retained === next) retained = { ...next };
          retained[key] = {
            ...quota,
            windows: previous.windows,
            extraUsage: previous.extraUsage,
            dollarWindows: previous.dollarWindows,
            observedAt: previous.observedAt,
            planType: previous.planType,
            rateLimitTier: previous.rateLimitTier,
            stale: quota.status === 'error' || previous.stale,
          };
        }
      }
      return {
        claudeQuota: retained,
        quotaCheckedAt: stampCheckedAt(state.claudeQuota, retained, state.quotaCheckedAt),
      };
    }),
  setCodexQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.codexQuota);
      return {
        codexQuota: next,
        quotaCheckedAt: stampCheckedAt(state.codexQuota, next, state.quotaCheckedAt),
      };
    }),
  setDevinQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.devinQuota);
      return {
        devinQuota: next,
        quotaCheckedAt: stampCheckedAt(state.devinQuota, next, state.quotaCheckedAt),
      };
    }),
  setKimiQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.kimiQuota);
      return {
        kimiQuota: next,
        quotaCheckedAt: stampCheckedAt(state.kimiQuota, next, state.quotaCheckedAt),
      };
    }),
  setMetaQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.metaQuota);
      return {
        metaQuota: next,
        quotaCheckedAt: stampCheckedAt(state.metaQuota, next, state.quotaCheckedAt),
      };
    }),
  setPluginQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.pluginQuota);
      return {
        pluginQuota: next,
        quotaCheckedAt: stampCheckedAt(state.pluginQuota, next, state.quotaCheckedAt),
      };
    }),
  setXaiQuota: (updater) =>
    set((state) => {
      const next = resolveUpdater(updater, state.xaiQuota);
      return {
        xaiQuota: next,
        quotaCheckedAt: stampCheckedAt(state.xaiQuota, next, state.quotaCheckedAt),
      };
    }),
  clearQuotaCache: (names) =>
    set((state) => {
      if (names) {
        if (names.length === 0) return state;
        const fileGenerations = { ...state.fileGenerations };
        names.forEach((name) => {
          fileGenerations[name] = (fileGenerations[name] ?? 0) + 1;
        });
        const invalidatedNames = new Set(names);
        const omitNames = <T>(cache: Record<string, T>): Record<string, T> => {
          const keysToDelete = Object.keys(cache).filter((key) =>
            invalidatedNames.has(getQuotaCacheFileName(key))
          );
          if (keysToDelete.length === 0) return cache;
          const next = { ...cache };
          keysToDelete.forEach((key) => delete next[key]);
          return next;
        };
        return {
          fileGenerations,
          antigravityQuota: omitNames(state.antigravityQuota),
          claudeQuota: omitNames(state.claudeQuota),
          codexQuota: omitNames(state.codexQuota),
          devinQuota: omitNames(state.devinQuota),
          kimiQuota: omitNames(state.kimiQuota),
          metaQuota: omitNames(state.metaQuota),
          pluginQuota: omitNames(state.pluginQuota),
          xaiQuota: omitNames(state.xaiQuota),
          observedQuota: omitNames(state.observedQuota),
          quotaCheckedAt: omitNames(state.quotaCheckedAt),
        };
      }
      return {
        cacheGeneration: state.cacheGeneration + 1,
        fileGenerations: {},
        antigravityQuota: {},
        claudeQuota: {},
        codexQuota: {},
        devinQuota: {},
        kimiQuota: {},
        metaQuota: {},
        pluginQuota: {},
        xaiQuota: {},
        observedQuota: {},
        quotaCheckedAt: {},
      };
    }),
  syncObservedQuota: (files) =>
    set(() => {
      const observedQuota: Record<string, AuthFileQuotaObservation> = {};
      files.forEach((file) => {
        if (file.quotaObservation) observedQuota[getQuotaCacheKey(file)] = file.quotaObservation;
      });
      return { observedQuota };
    }),
  markQuotaChecked: (keys, atMs) =>
    set((state) => {
      if (keys.length === 0) return state;
      const quotaCheckedAt = { ...state.quotaCheckedAt };
      keys.forEach((key) => {
        quotaCheckedAt[key] = atMs;
      });
      return { quotaCheckedAt };
    }),
}));

export const captureQuotaCacheGeneration = (name?: string) => {
  const { cacheGeneration, fileGenerations } = useQuotaStore.getState();
  return { cacheGeneration, fileGenerations, name };
};

export const commitIfQuotaCacheCurrent = (
  generation: ReturnType<typeof captureQuotaCacheGeneration>,
  commit: () => void,
  name: string | undefined = generation.name
): boolean => {
  const current = useQuotaStore.getState();
  if (current.cacheGeneration !== generation.cacheGeneration) return false;
  // File-scoped requests survive mutations to unrelated credentials.
  if (name !== undefined) {
    if ((current.fileGenerations[name] ?? 0) !== (generation.fileGenerations[name] ?? 0)) {
      return false;
    }
  } else if (current.fileGenerations !== generation.fileGenerations) {
    return false;
  }
  commit();
  return true;
};
