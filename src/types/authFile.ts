/**
 * Auth-file types.
 */

import type { RecentRequestBucket } from '@/utils/recentRequests';

export type AuthFileType =
  | 'qwen'
  | 'kimi'
  | 'gemini'
  | 'aistudio'
  | 'claude'
  | 'codex'
  | 'devin'
  | 'meta'
  | 'antigravity'
  | 'xai'
  | 'iflow'
  | 'vertex'
  | 'empty'
  | 'unknown';

export interface AuthFileCooldown {
  scope: 'model' | 'credential';
  modelKey?: string;
  reason: string;
  retryAt: string;
  remainingSeconds: number;
  backoffLevel?: number;
  httpStatus?: number;
}

export interface AuthFileCooldownSnapshot {
  /** Server observation time, not the start of the cooldown. */
  observedAt?: string;
  /** Local receipt time anchors relative timers without relying on synchronized clocks. */
  receivedAtMs: number;
  /** null = runtime state unknown; [] = known, with no active timers. */
  records: AuthFileCooldown[] | null;
}

export type ObservedQuotaProvider = 'claude' | 'codex';

/** One rate-limit window read from passively captured upstream response headers. */
export interface ObservedQuotaWindow {
  /**
   * Stable within a provider. Claude: `5h`, `7d`, `7d_oi`. Codex: `<limit>:primary` or
   * `<limit>:secondary`, where `<limit>` is empty for the main limit, `code-review`,
   * `additional-<name>` or an upstream short name.
   */
  id: string;
  /** Codex limit namespace; empty for the main limit. Absent for Claude. */
  limit?: string;
  /** Upstream display name for a named Codex limit, when sent. */
  limitName?: string;
  /** 0–100. */
  usedPercent: number;
  periodHours?: number;
  resetAtMs?: number;
  /** Claude per-window status such as `allowed`, `allowed_warning` or `rejected`. */
  status?: string;
}

export interface ObservedQuotaCredits {
  balance?: number;
  hasCredits?: boolean;
  unlimited?: boolean;
}

export interface ObservedQuota {
  provider: ObservedQuotaProvider;
  windows: ObservedQuotaWindow[];
  /** Claude unified status. */
  status?: string;
  /** Codex `limit-reached`; Claude derives it from a `rejected` status. */
  limitReached?: boolean;
  retryAfterSeconds?: number;
  /** Codex plan type as sent in `x-codex-plan-type`. */
  planType?: string;
  /** Codex active limit namespace. */
  activeLimit?: string;
  credits?: ObservedQuotaCredits;
}

/**
 * Rate-limit headers the backend captured from the latest proxied response (`quota.signals`).
 * Only Claude and Codex send parseable windows; refreshed by traffic, never by polling.
 */
export interface AuthFileQuotaObservation extends ObservedQuota {
  /** Server time the headers were captured. */
  observedAt?: string;
  /** Local receipt time of the credentials list. */
  receivedAtMs: number;
  /** Per-model snapshots from `model_quotas`, keyed by model. */
  models?: Record<string, ObservedQuota & { observedAt?: string }>;
}

export interface AuthFileItem {
  name: string;
  siwcBindSupported?: boolean;
  useSiwc?: boolean;
  siwcBound?: boolean;
  siwcExpiresAt?: string;
  type?: AuthFileType | string;
  provider?: string;
  /**
   * Account email supplied by the file scanner or credential registry.
   * Never display or search account/account_type: API-key credentials may expose
   * the API key itself through those fields.
   */
  email?: string;
  /** GCP / Vertex project ID, used when account email is absent. */
  projectId?: string;
  size?: number;
  authIndex?: string | number | null;
  /** Generic plugin quota capability advertised by CPA's auth-files API. */
  supportsQuota?: boolean;
  quotaProvider?: string;
  /** Backend-selected quota plugin; authoritative when supplied by v8 credentials. */
  quotaPluginId?: string;
  runtimeOnly?: boolean | string;
  disabled?: boolean;
  unavailable?: boolean;
  status?: string;
  statusMessage?: string;
  lastRefresh?: string | number;
  modified?: number;
  priority?: number;
  weight?: number;
  note?: string;
  success?: unknown;
  failed?: unknown;
  /** Cumulative success/failure counts normalized by the API boundary. */
  successCount?: number;
  failureCount?: number;
  recent_requests?: RecentRequestBucket[];
  recentRequests?: RecentRequestBucket[];
  /** Absent on older servers. Never interpreted as credential health. */
  cooldownSnapshot?: AuthFileCooldownSnapshot;
  /** Absent when the provider sends no passive quota headers or none were captured yet. */
  quotaObservation?: AuthFileQuotaObservation;
  [key: string]: unknown;
}

export interface AuthFilesResponse {
  files: AuthFileItem[];
  total?: number;
  observed_at?: unknown;
  observedAt?: string;
}
