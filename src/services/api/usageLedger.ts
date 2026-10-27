/**
 * Usage ledger plugin (Webb-Ventures/cliproxy-usage-ledger): token rollups,
 * ccusage-style blocks, model and plan prices, and shared price overrides.
 *
 * The plugin declares its routes under `/v0/management/usage-ledger/`, so every
 * call uses `pluginRoute`. Responses are normalized to camelCase here; nothing
 * outside this module reads the plugin's raw field names.
 */

import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';
import type { ApiError } from '@/types';

const BASE = '/usage-ledger';
const PLUGIN = { pluginRoute: true } as const;

export type UsageGroup = 'model' | 'credential' | 'provider' | 'client_key';
export type UsageBucket = 'hour' | 'day' | 'week';
export type UsageResolution = 'minute' | 'hour' | 'mixed';

export interface UsageTokens {
  /** Uncached input. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Non-reasoning output. */
  output: number;
  reasoning: number;
  unclassified: number;
  total: number;
}

export interface UsageModelRow {
  model: string;
  serviceTier: string;
  requests: number;
  failed: number;
  tokens: UsageTokens;
}

export interface UsageTotals {
  /** Includes failed requests. */
  requests: number;
  failed: number;
  tokens: UsageTokens;
  byModel: UsageModelRow[];
}

export interface UsageRange {
  from: string;
  /** Exclusive end. */
  to: string;
  tz: string;
  recordingSince: string | null;
  resolution: UsageResolution;
  approximate: boolean;
}

export interface UsageGroupTotals extends UsageTotals {
  /** `model:<model>`, `auth:<auth_index>`, `provider:<provider>` or `key:<masked key>`. */
  key: string;
}

export interface UsageSummary {
  range: UsageRange;
  group: UsageGroup;
  groups: UsageGroupTotals[];
  totals: UsageTotals;
}

export interface UsageSeriesBucket extends UsageTotals {
  start: string;
  end: string;
  /** The whole bucket ends before recording began. */
  beforeRecording: boolean;
}

export interface UsageSeries {
  range: UsageRange;
  bucket: UsageBucket;
  group: UsageGroup | null;
  buckets: UsageSeriesBucket[];
  groups: { key: string; buckets: UsageSeriesBucket[] }[];
}

export interface UsageWindowRequest {
  authIndex: string;
  /** When the limit window last reset, as an instant. */
  sinceMs: number;
}

export interface UsageWindowResult extends UsageTotals {
  authIndex: string;
  since: string;
  resolution: UsageResolution;
  approximate: boolean;
}

export interface UsageWindows {
  now: string;
  minuteDataSince: string | null;
  windows: UsageWindowResult[];
}

export interface UsageBlock extends UsageTotals {
  start: string;
  end: string;
  /** Start of the last active minute. */
  actualEnd: string;
  active: boolean;
  peakTokensPerMinute: number;
  burnRateTokensPerMinute: number;
  activeMinutes: number;
  authIndexes: string[];
}

export interface UsageBlocks {
  range: {
    from: string;
    to: string;
    requestedFrom: string;
    tz: string;
    /** `from` was moved up to the start of minute retention. */
    clamped: boolean;
    minuteDataSince: string | null;
    recordingSince: string | null;
  };
  sessionHours: number;
  blocks: UsageBlock[];
}

export interface TokenPrices {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelPrice extends TokenPrices {
  provider: string;
  mode: string;
  cacheWrite1h?: number;
  /** Absent unless the source prices reasoning separately; price it as output then. */
  reasoning?: number;
  /** Higher prices once a request's prompt passes `aboveTokens`, ascending. */
  tiers: (TokenPrices & { aboveTokens: number })[];
  serviceTiers: { priority?: TokenPrices; flex?: TokenPrices };
}

export interface PlanPrice {
  name: string;
  monthlyPrice: number;
  currency: string;
  billing: 'per_account' | 'per_seat';
  asOf: string;
  sourceUrl: string;
  /** False when the price could not be read on the provider's own page. */
  verified: boolean;
  note?: string;
}

export interface PlanOverride {
  provider: string;
  plan: string;
  monthlyPrice: number;
  currency?: string;
}

export interface UsageLedgerSettings {
  /** Keyed by credential `auth_index`. */
  planOverrides: Record<string, PlanOverride>;
  /** Keyed by model name, USD per token. */
  modelPriceOverrides: Record<string, TokenPrices>;
  defaultCurrency: string;
  updatedAt: string | null;
}

export type PriceSource = 'remote' | 'cache' | 'embedded' | 'none';

export interface UsagePrices {
  source: PriceSource;
  fetchedAt: string | null;
  sourceUrl: string;
  embeddedAsOf: string;
  lastAttemptAt: string | null;
  lastError: string | null;
  /** Keyed exactly as LiteLLM keys them; USD per token. */
  models: Record<string, ModelPrice>;
  /** Provider, then plan id. */
  plans: Record<string, Record<string, PlanPrice>>;
  plansAsOf: string;
  /** Null while the plugin has no database open. */
  overrides: UsageLedgerSettings | null;
}

export interface UsageLedgerStatus {
  pluginVersion: string;
  recordsTotal: number;
  droppedTotal: number;
  skippedTotal: number;
  writeErrorsTotal: number;
  lastWriteError: string | null;
  recordingSince: string | null;
  lastRecordAt: string | null;
  retention: { minuteDays: number; hourDays: number };
  priceSource: PriceSource;
  pricesFetchedAt: string | null;
}

export interface UsageRangeParams {
  /** `YYYY-MM-DD` (local midnight in `tz`) or an RFC 3339 instant; inclusive. */
  from: string;
  /** `YYYY-MM-DD` (through the end of that day) or an RFC 3339 instant; exclusive. */
  to: string;
  /** IANA zone; the plugin rejects `Local`. */
  tz: string;
}

/* ---------- Normalizers ---------- */

const num = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const optNum = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const optStr = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;
const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const RESOLUTIONS: readonly UsageResolution[] = ['minute', 'hour', 'mixed'];
const resolution = (value: unknown): UsageResolution =>
  RESOLUTIONS.includes(value as UsageResolution) ? (value as UsageResolution) : 'minute';

const PRICE_SOURCES: readonly PriceSource[] = ['remote', 'cache', 'embedded', 'none'];
const priceSource = (value: unknown): PriceSource =>
  PRICE_SOURCES.includes(value as PriceSource) ? (value as PriceSource) : 'none';

export const normalizeTokens = (value: unknown): UsageTokens => {
  const raw = record(value);
  return {
    input: num(raw.input),
    cacheRead: num(raw.cache_read),
    cacheWrite: num(raw.cache_write),
    output: num(raw.output),
    reasoning: num(raw.reasoning),
    unclassified: num(raw.unclassified),
    total: num(raw.total),
  };
};

const normalizeTotals = (value: unknown): UsageTotals => {
  const raw = record(value);
  return {
    requests: num(raw.requests),
    failed: num(raw.failed),
    tokens: normalizeTokens(raw.tokens),
    byModel: list(raw.by_model).map((item) => {
      const row = record(item);
      return {
        model: str(row.model),
        serviceTier: str(row.service_tier),
        requests: num(row.requests),
        failed: num(row.failed),
        tokens: normalizeTokens(row.tokens),
      };
    }),
  };
};

const normalizeRange = (value: unknown): UsageRange => {
  const raw = record(value);
  return {
    from: str(raw.from),
    to: str(raw.to),
    tz: str(raw.tz) || 'UTC',
    recordingSince: optStr(raw.recording_since),
    resolution: resolution(raw.resolution),
    approximate: raw.approximate === true,
  };
};

const normalizeBucket = (value: unknown): UsageSeriesBucket => {
  const raw = record(value);
  return {
    ...normalizeTotals(raw),
    start: str(raw.start),
    end: str(raw.end),
    beforeRecording: raw.before_recording === true,
  };
};

const GROUPS: readonly UsageGroup[] = ['model', 'credential', 'provider', 'client_key'];
const group = (value: unknown): UsageGroup | null =>
  GROUPS.includes(value as UsageGroup) ? (value as UsageGroup) : null;

export const normalizeSummary = (value: unknown): UsageSummary => {
  const raw = record(value);
  return {
    range: normalizeRange(raw.range),
    group: group(raw.group) ?? 'model',
    groups: list(raw.groups).map((item) => ({
      ...normalizeTotals(item),
      key: str(record(item).key),
    })),
    totals: normalizeTotals(raw.totals),
  };
};

export const normalizeSeries = (value: unknown): UsageSeries => {
  const raw = record(value);
  const bucket = str(raw.bucket);
  return {
    range: normalizeRange(raw.range),
    bucket: bucket === 'hour' || bucket === 'week' ? bucket : 'day',
    group: group(raw.group),
    buckets: list(raw.buckets).map(normalizeBucket),
    groups: list(raw.groups).map((item) => {
      const entry = record(item);
      return { key: str(entry.key), buckets: list(entry.buckets).map(normalizeBucket) };
    }),
  };
};

export const normalizeWindows = (value: unknown): UsageWindows => {
  const raw = record(value);
  return {
    now: str(raw.now),
    minuteDataSince: optStr(raw.minute_data_since),
    windows: list(raw.windows).map((item) => {
      const entry = record(item);
      return {
        ...normalizeTotals(entry),
        authIndex: str(entry.auth_index),
        since: str(entry.since),
        resolution: resolution(entry.resolution),
        approximate: entry.approximate === true,
      };
    }),
  };
};

export const normalizeBlocks = (value: unknown): UsageBlocks => {
  const raw = record(value);
  const range = record(raw.range);
  return {
    range: {
      from: str(range.from),
      to: str(range.to),
      requestedFrom: str(range.requested_from),
      tz: str(range.tz) || 'UTC',
      clamped: range.clamped === true,
      minuteDataSince: optStr(range.minute_data_since),
      recordingSince: optStr(range.recording_since),
    },
    sessionHours: num(raw.session_hours) || 5,
    blocks: list(raw.blocks).map((item) => {
      const block = record(item);
      return {
        ...normalizeTotals(block),
        start: str(block.start),
        end: str(block.end),
        actualEnd: str(block.actual_end),
        active: block.active === true,
        peakTokensPerMinute: num(block.peak_tokens_per_minute),
        burnRateTokensPerMinute: num(block.burn_rate_tokens_per_minute),
        activeMinutes: num(block.active_minutes),
        authIndexes: list(block.auth_indexes).map(str).filter(Boolean),
      };
    }),
  };
};

const normalizeTokenPrices = (value: unknown): TokenPrices => {
  const raw = record(value);
  const prices: TokenPrices = {};
  const input = optNum(raw.input);
  const output = optNum(raw.output);
  const cacheRead = optNum(raw.cache_read);
  const cacheWrite = optNum(raw.cache_write);
  if (input !== undefined) prices.input = input;
  if (output !== undefined) prices.output = output;
  if (cacheRead !== undefined) prices.cacheRead = cacheRead;
  if (cacheWrite !== undefined) prices.cacheWrite = cacheWrite;
  return prices;
};

const normalizeModelPrice = (value: unknown): ModelPrice => {
  const raw = record(value);
  const serviceTiers = record(raw.service_tiers);
  const price: ModelPrice = {
    ...normalizeTokenPrices(raw),
    provider: str(raw.provider),
    mode: str(raw.mode),
    tiers: list(raw.tiers)
      .map((tier) => ({
        ...normalizeTokenPrices(tier),
        aboveTokens: num(record(tier).above_tokens),
      }))
      .sort((a, b) => a.aboveTokens - b.aboveTokens),
    serviceTiers: {},
  };
  const cacheWrite1h = optNum(raw.cache_write_1h);
  const reasoning = optNum(raw.reasoning);
  if (cacheWrite1h !== undefined) price.cacheWrite1h = cacheWrite1h;
  if (reasoning !== undefined) price.reasoning = reasoning;
  if (isRecord(serviceTiers.priority)) {
    price.serviceTiers.priority = normalizeTokenPrices(serviceTiers.priority);
  }
  if (isRecord(serviceTiers.flex))
    price.serviceTiers.flex = normalizeTokenPrices(serviceTiers.flex);
  return price;
};

const normalizePlanPrice = (value: unknown): PlanPrice => {
  const raw = record(value);
  const plan: PlanPrice = {
    name: str(raw.name),
    monthlyPrice: num(raw.monthly_price),
    currency: str(raw.currency) || 'USD',
    billing: raw.billing === 'per_seat' ? 'per_seat' : 'per_account',
    asOf: str(raw.as_of),
    sourceUrl: str(raw.source_url),
    verified: raw.verified === true,
  };
  if (typeof raw.note === 'string' && raw.note) plan.note = raw.note;
  return plan;
};

export const normalizeSettings = (value: unknown): UsageLedgerSettings => {
  const raw = record(value);
  const planOverrides: Record<string, PlanOverride> = {};
  Object.entries(record(raw.plan_overrides)).forEach(([authIndex, item]) => {
    const entry = record(item);
    const override: PlanOverride = {
      provider: str(entry.provider),
      plan: str(entry.plan),
      monthlyPrice: num(entry.monthly_price),
    };
    if (typeof entry.currency === 'string' && entry.currency) override.currency = entry.currency;
    planOverrides[authIndex] = override;
  });
  const modelPriceOverrides: Record<string, TokenPrices> = {};
  Object.entries(record(raw.model_price_overrides)).forEach(([model, item]) => {
    modelPriceOverrides[model] = normalizeTokenPrices(item);
  });
  return {
    planOverrides,
    modelPriceOverrides,
    defaultCurrency: str(raw.default_currency) || 'USD',
    updatedAt: optStr(raw.updated_at),
  };
};

export const serializeSettings = (settings: UsageLedgerSettings): Record<string, unknown> => {
  const tokenPrices = (prices: TokenPrices) => {
    const out: Record<string, number> = {};
    if (prices.input !== undefined) out.input = prices.input;
    if (prices.output !== undefined) out.output = prices.output;
    if (prices.cacheRead !== undefined) out.cache_read = prices.cacheRead;
    if (prices.cacheWrite !== undefined) out.cache_write = prices.cacheWrite;
    return out;
  };
  return {
    plan_overrides: Object.fromEntries(
      Object.entries(settings.planOverrides).map(([authIndex, override]) => [
        authIndex,
        {
          provider: override.provider,
          plan: override.plan,
          monthly_price: override.monthlyPrice,
          ...(override.currency ? { currency: override.currency } : {}),
        },
      ])
    ),
    model_price_overrides: Object.fromEntries(
      Object.entries(settings.modelPriceOverrides).map(([model, prices]) => [
        model,
        tokenPrices(prices),
      ])
    ),
    default_currency: settings.defaultCurrency,
  };
};

export const normalizePrices = (value: unknown): UsagePrices => {
  const raw = record(value);
  const models: Record<string, ModelPrice> = {};
  Object.entries(record(raw.models)).forEach(([key, item]) => {
    models[key] = normalizeModelPrice(item);
  });
  const plans: Record<string, Record<string, PlanPrice>> = {};
  Object.entries(record(raw.plans)).forEach(([provider, byPlan]) => {
    plans[provider] = {};
    Object.entries(record(byPlan)).forEach(([plan, item]) => {
      plans[provider][plan] = normalizePlanPrice(item);
    });
  });
  return {
    source: priceSource(raw.source),
    fetchedAt: optStr(raw.fetched_at),
    sourceUrl: str(raw.source_url),
    embeddedAsOf: str(raw.embedded_as_of),
    lastAttemptAt: optStr(raw.last_attempt_at),
    lastError: optStr(raw.last_error),
    models,
    plans,
    plansAsOf: str(raw.plans_as_of),
    overrides: isRecord(raw.overrides) ? normalizeSettings(raw.overrides) : null,
  };
};

export const normalizeStatus = (value: unknown): UsageLedgerStatus => {
  const raw = record(value);
  const retention = record(raw.retention);
  const prices = record(raw.prices);
  return {
    pluginVersion: str(raw.plugin_version),
    recordsTotal: num(raw.records_total),
    droppedTotal: num(raw.dropped_total),
    skippedTotal: num(raw.skipped_total),
    writeErrorsTotal: num(raw.write_errors_total),
    lastWriteError: optStr(raw.last_write_error),
    recordingSince: optStr(raw.recording_since),
    lastRecordAt: optStr(raw.last_record_at),
    retention: { minuteDays: num(retention.minute_days), hourDays: num(retention.hour_days) },
    priceSource: priceSource(prices.source),
    pricesFetchedAt: optStr(prices.fetched_at),
  };
};

/** `Content-Disposition` filename, falling back when the header is missing. */
export const filenameFromDisposition = (header: unknown, fallback: string): string => {
  const match = typeof header === 'string' ? /filename="?([^";]+)"?/i.exec(header) : null;
  return match?.[1]?.trim() || fallback;
};

/* ---------- Endpoints ---------- */

export type UsageLedgerAvailability =
  | { state: 'available'; status: UsageLedgerStatus }
  /** The plugin's routes are not mounted: not installed, disabled, or plugins are off. */
  | { state: 'absent' };

export const usageLedgerApi = {
  /** Status doubles as detection: a 404 means the plugin's routes are not mounted. */
  async detect(): Promise<UsageLedgerAvailability> {
    try {
      const data = await apiClient.get(`${BASE}/status`, PLUGIN);
      return { state: 'available', status: normalizeStatus(data) };
    } catch (error: unknown) {
      if ((error as ApiError | undefined)?.status === 404) return { state: 'absent' };
      throw error;
    }
  },

  async summary(params: UsageRangeParams & { group?: UsageGroup }): Promise<UsageSummary> {
    return normalizeSummary(await apiClient.get(`${BASE}/summary`, { ...PLUGIN, params }));
  },

  async series(
    params: UsageRangeParams & { bucket?: UsageBucket; group?: UsageGroup }
  ): Promise<UsageSeries> {
    return normalizeSeries(await apiClient.get(`${BASE}/series`, { ...PLUGIN, params }));
  },

  async windows(entries: UsageWindowRequest[]): Promise<UsageWindows> {
    const body = {
      windows: entries.map((entry) => ({
        auth_index: entry.authIndex,
        since: new Date(entry.sinceMs).toISOString(),
      })),
    };
    return normalizeWindows(await apiClient.post(`${BASE}/windows`, body, PLUGIN));
  },

  async blocks(params: UsageRangeParams): Promise<UsageBlocks> {
    return normalizeBlocks(await apiClient.get(`${BASE}/blocks`, { ...PLUGIN, params }));
  },

  async prices(): Promise<UsagePrices> {
    return normalizePrices(await apiClient.get(`${BASE}/prices`, PLUGIN));
  },

  async settings(): Promise<UsageLedgerSettings> {
    return normalizeSettings(await apiClient.get(`${BASE}/settings`, PLUGIN));
  },

  async saveSettings(settings: UsageLedgerSettings): Promise<UsageLedgerSettings> {
    return normalizeSettings(
      await apiClient.put(`${BASE}/settings`, serializeSettings(settings), PLUGIN)
    );
  },

  async exportCsv(
    params: UsageRangeParams & { bucket?: UsageBucket; group?: UsageGroup }
  ): Promise<{ blob: Blob; filename: string }> {
    const response = await apiClient.getRaw(`${BASE}/export`, {
      ...PLUGIN,
      params,
      responseType: 'blob',
    });
    return {
      blob: response.data as Blob,
      filename: filenameFromDisposition(
        response.headers['content-disposition'],
        `usage-ledger_${params.from}_${params.to}.csv`
      ),
    };
  },
};
