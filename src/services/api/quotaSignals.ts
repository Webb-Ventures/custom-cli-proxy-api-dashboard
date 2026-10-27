import type {
  AuthFileQuotaObservation,
  ObservedQuota,
  ObservedQuotaCredits,
  ObservedQuotaProvider,
  ObservedQuotaWindow,
} from '@/types/authFile';
import { normalizeCooldownTimestamp } from './authFileCooldowns';

/**
 * Normalizes the passive quota snapshot the v8 credentials list returns as
 * `quota: { observed_at, signals }` and `model_quotas: { <model>: { observed_at, signals } }`.
 *
 * The backend stores the rate-limit headers of the latest proxied response as-is
 * (canonical header names, string values); see `sdk/cliproxy/auth/quota_signals.go`.
 * Only Claude (`anthropic-ratelimit-unified-*`) and Codex (`x-codex-*`) carry windows.
 */

const CLAUDE_WINDOWS: ReadonlyArray<{ id: string; periodHours: number }> = [
  { id: '5h', periodHours: 5 },
  { id: '7d', periodHours: 24 * 7 },
  { id: '7d_oi', periodHours: 24 * 7 },
];

const CODEX_WINDOW_KEY = /^x-codex-(?:(.+)-)?(primary|secondary)-used-percent$/;

type SignalMap = ReadonlyMap<string, string>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const toSignalMap = (value: unknown): SignalMap => {
  const signals = new Map<string, string>();
  if (!isRecord(value)) return signals;
  Object.entries(value).forEach(([key, raw]) => {
    if (typeof raw !== 'string') return;
    const name = key.trim().toLowerCase();
    const text = raw.trim();
    if (name && text) signals.set(name, text);
  });
  return signals;
};

const readNumber = (signals: SignalMap, key: string): number | undefined => {
  const raw = signals.get(key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

const readBoolean = (signals: SignalMap, key: string): boolean | undefined => {
  const raw = signals.get(key)?.toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return undefined;
};

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

/** Upstream reset instants are Unix seconds. */
const unixSecondsToMs = (value: number | undefined): number | undefined =>
  value !== undefined && value > 0 ? value * 1000 : undefined;

const readRetryAfterSeconds = (signals: SignalMap): number | undefined => {
  const value = readNumber(signals, 'retry-after');
  return value !== undefined && value >= 0 ? value : undefined;
};

const parseClaudeSignals = (signals: SignalMap): ObservedQuota => {
  const windows: ObservedQuotaWindow[] = [];
  CLAUDE_WINDOWS.forEach(({ id, periodHours }) => {
    const prefix = `anthropic-ratelimit-unified-${id}-`;
    const utilization = readNumber(signals, `${prefix}utilization`);
    if (utilization === undefined) return;
    const resetAtMs = unixSecondsToMs(readNumber(signals, `${prefix}reset`));
    const status = signals.get(`${prefix}status`);
    windows.push({
      id,
      usedPercent: clampPercent(utilization * 100),
      periodHours,
      ...(resetAtMs !== undefined ? { resetAtMs } : {}),
      ...(status ? { status } : {}),
    });
  });

  const status = signals.get('anthropic-ratelimit-unified-status');
  const retryAfterSeconds = readRetryAfterSeconds(signals);
  return {
    provider: 'claude',
    windows,
    ...(status ? { status, limitReached: status === 'rejected' } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
};

const codexLimitRank = (limit: string): number => {
  if (limit === '') return 0;
  if (limit === 'code-review') return 1;
  return 2;
};

const parseCodexSignals = (signals: SignalMap, anchorMs: number): ObservedQuota => {
  const windows: ObservedQuotaWindow[] = [];
  signals.forEach((rawUsed, key) => {
    const match = CODEX_WINDOW_KEY.exec(key);
    if (!match) return;
    const used = Number(rawUsed);
    if (!Number.isFinite(used)) return;
    const limit = match[1] ?? '';
    const slot = match[2];
    const prefix = `x-codex-${limit ? `${limit}-` : ''}${slot}-`;
    const windowMinutes = readNumber(signals, `${prefix}window-minutes`);
    const resetAfterSeconds = readNumber(signals, `${prefix}reset-after-seconds`);
    const resetAtMs =
      unixSecondsToMs(readNumber(signals, `${prefix}reset-at`)) ??
      (resetAfterSeconds !== undefined && resetAfterSeconds >= 0
        ? anchorMs + resetAfterSeconds * 1000
        : undefined);
    const limitName = limit ? signals.get(`x-codex-${limit}-limit-name`) : undefined;
    windows.push({
      id: `${limit}:${slot}`,
      limit,
      ...(limitName ? { limitName } : {}),
      usedPercent: clampPercent(used),
      ...(windowMinutes !== undefined && windowMinutes > 0
        ? { periodHours: windowMinutes / 60 }
        : {}),
      ...(resetAtMs !== undefined ? { resetAtMs } : {}),
    });
  });
  windows.sort(
    (a, b) =>
      codexLimitRank(a.limit ?? '') - codexLimitRank(b.limit ?? '') ||
      (a.limit ?? '').localeCompare(b.limit ?? '') ||
      a.id.localeCompare(b.id)
  );

  const balance = readNumber(signals, 'x-codex-credits-balance');
  const hasCredits = readBoolean(signals, 'x-codex-credits-has-credits');
  const unlimited = readBoolean(signals, 'x-codex-credits-unlimited');
  const credits: ObservedQuotaCredits = {
    ...(balance !== undefined ? { balance } : {}),
    ...(hasCredits !== undefined ? { hasCredits } : {}),
    ...(unlimited !== undefined ? { unlimited } : {}),
  };
  const limitReached = readBoolean(signals, 'x-codex-limit-reached');
  const retryAfterSeconds = readRetryAfterSeconds(signals);
  const planType = signals.get('x-codex-plan-type')?.toLowerCase();
  const activeLimit = signals.get('x-codex-active-limit');
  return {
    provider: 'codex',
    windows,
    ...(limitReached !== undefined ? { limitReached } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    ...(planType ? { planType } : {}),
    ...(activeLimit ? { activeLimit } : {}),
    ...(Object.keys(credits).length > 0 ? { credits } : {}),
  };
};

const isEmptyObservation = (quota: ObservedQuota): boolean =>
  quota.windows.length === 0 &&
  quota.status === undefined &&
  quota.limitReached === undefined &&
  quota.retryAfterSeconds === undefined &&
  quota.planType === undefined &&
  quota.credits === undefined;

export const resolveObservedQuotaProvider = (value: unknown): ObservedQuotaProvider | null => {
  const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return provider === 'claude' || provider === 'codex' ? provider : null;
};

/** Parses one `{ observed_at, signals }` payload; undefined when it carries nothing usable. */
export const parseQuotaSignals = (
  provider: ObservedQuotaProvider,
  payload: unknown,
  receivedAtMs: number
): (ObservedQuota & { observedAt?: string }) | undefined => {
  if (!isRecord(payload)) return undefined;
  const signals = toSignalMap(payload.signals);
  if (signals.size === 0) return undefined;
  const observedAt = normalizeCooldownTimestamp(payload.observed_at);
  // Relative resets count from when the headers were captured, not when the list arrived.
  const anchorMs = observedAt ? Date.parse(observedAt) : receivedAtMs;
  const quota =
    provider === 'claude' ? parseClaudeSignals(signals) : parseCodexSignals(signals, anchorMs);
  if (isEmptyObservation(quota)) return undefined;
  return { ...quota, ...(observedAt ? { observedAt } : {}) };
};

export const normalizeAuthFileQuotaObservation = (
  providerValue: unknown,
  quota: unknown,
  modelQuotas: unknown,
  receivedAtMs: number
): AuthFileQuotaObservation | undefined => {
  const provider = resolveObservedQuotaProvider(providerValue);
  if (!provider) return undefined;

  const models: NonNullable<AuthFileQuotaObservation['models']> = {};
  if (isRecord(modelQuotas)) {
    Object.entries(modelQuotas).forEach(([model, payload]) => {
      const key = model.trim();
      const parsed = key ? parseQuotaSignals(provider, payload, receivedAtMs) : undefined;
      if (parsed) models[key] = parsed;
    });
  }
  const hasModels = Object.keys(models).length > 0;
  const credential = parseQuotaSignals(provider, quota, receivedAtMs);
  if (!credential && !hasModels) return undefined;

  return {
    ...(credential ?? { provider, windows: [] }),
    receivedAtMs,
    ...(hasModels ? { models } : {}),
  };
};
