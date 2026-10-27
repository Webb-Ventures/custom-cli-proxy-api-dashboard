import { afterEach, describe, expect, test } from 'bun:test';
import type { AxiosAdapter, AxiosInstance } from 'axios';
import { apiClient } from '@/services/api/client';
import {
  filenameFromDisposition,
  normalizeBlocks,
  normalizePrices,
  normalizeSeries,
  normalizeSettings,
  normalizeSummary,
  normalizeWindows,
  serializeSettings,
  usageLedgerApi,
} from '@/services/api/usageLedger';

const tokens = (total: number) => ({
  input: 1,
  cache_read: 2,
  cache_write: 3,
  output: 4,
  reasoning: 5,
  unclassified: 0,
  total,
});

// The client's axios instance is private; tests swap its adapter to observe requests.
const instance = Reflect.get(apiClient, 'instance') as AxiosInstance;
const originalAdapter = instance.defaults.adapter;

afterEach(() => {
  instance.defaults.adapter = originalAdapter;
  apiClient.setConfig({ apiBase: '', managementKey: '' });
});

describe('plugin routes', () => {
  test('go to the v0 prefix with the same bearer key', async () => {
    apiClient.setConfig({
      apiBase: 'https://proxy.invalid/gateway/v8/management',
      managementKey: 'fixture-only',
    });
    const seen: string[] = [];
    const adapter: AxiosAdapter = async (config) => {
      seen.push(`${config.baseURL}${config.url}`);
      expect(config.headers.Authorization).toBe('Bearer fixture-only');
      return { data: {}, status: 200, statusText: 'OK', headers: {}, config };
    };
    await apiClient.get('/usage-ledger/status', { pluginRoute: true, adapter });
    await apiClient.get('/config', { adapter });
    expect(seen).toEqual([
      'https://proxy.invalid/gateway/v0/management/usage-ledger/status',
      'https://proxy.invalid/gateway/v8/management/config',
    ]);
  });

  test('detect treats a 404 as the plugin being absent and rethrows anything else', async () => {
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });
    let status = 404;
    instance.defaults.adapter = async (config) => {
      const response = { data: { error: 'nope' }, status, statusText: '', headers: {}, config };
      if (status >= 400) {
        const error = Object.assign(new Error('fail'), {
          isAxiosError: true,
          response,
          config,
        });
        throw error;
      }
      return response;
    };
    expect(await usageLedgerApi.detect()).toEqual({ state: 'absent' });
    status = 500;
    await expect(usageLedgerApi.detect()).rejects.toMatchObject({ status: 500 });
    status = 200;
    instance.defaults.adapter = async (config) => ({
      data: { schema: 1, plugin_version: '0.1.0', retention: { minute_days: 14, hour_days: 400 } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });
    const available = await usageLedgerApi.detect();
    expect(available.state).toBe('available');
    if (available.state === 'available') {
      expect(available.status.retention).toEqual({ minuteDays: 14, hourDays: 400 });
      expect(available.status.priceSource).toBe('none');
    }
  });

  test('windows send auth_index and an RFC 3339 since', async () => {
    apiClient.setConfig({ apiBase: 'http://proxy.invalid', managementKey: 'fixture-only' });
    instance.defaults.adapter = async (config) => {
      expect(config.method).toBe('post');
      expect(JSON.parse(String(config.data))).toEqual({
        windows: [{ auth_index: 'abc', since: '2026-10-27T05:00:00.000Z' }],
      });
      return {
        data: {
          now: '2026-10-27T09:41:30Z',
          windows: [{ auth_index: 'abc', since: '2026-10-27T05:00:00Z', tokens: tokens(15) }],
        },
        status: 200,
        statusText: 'OK',
        headers: {},
        config,
      };
    };
    const result = await usageLedgerApi.windows([
      { authIndex: 'abc', sinceMs: Date.parse('2026-10-27T05:00:00Z') },
    ]);
    expect(result.windows[0].authIndex).toBe('abc');
    expect(result.windows[0].tokens.total).toBe(15);
    expect(result.minuteDataSince).toBeNull();
  });
});

describe('normalizers', () => {
  test('summary groups and totals', () => {
    const summary = normalizeSummary({
      schema: 1,
      range: { from: 'a', to: 'b', tz: 'Europe/London', resolution: 'mixed', approximate: true },
      group: 'credential',
      groups: [
        {
          key: 'auth:7f3a',
          requests: 3,
          failed: 1,
          tokens: tokens(15),
          by_model: [
            {
              model: 'claude-opus-5-5',
              service_tier: 'auto',
              requests: 3,
              failed: 1,
              tokens: tokens(15),
            },
          ],
        },
      ],
      totals: { requests: 3, failed: 1, tokens: tokens(15), by_model: [] },
    });
    expect(summary.range).toMatchObject({
      resolution: 'mixed',
      approximate: true,
      recordingSince: null,
    });
    expect(summary.groups[0].key).toBe('auth:7f3a');
    expect(summary.groups[0].tokens).toEqual({
      input: 1,
      cacheRead: 2,
      cacheWrite: 3,
      output: 4,
      reasoning: 5,
      unclassified: 0,
      total: 15,
    });
    expect(summary.groups[0].byModel[0]).toMatchObject({
      model: 'claude-opus-5-5',
      serviceTier: 'auto',
    });
  });

  test('series without a group has no groups; garbage falls back safely', () => {
    const series = normalizeSeries({
      bucket: 'week',
      group: null,
      buckets: [{ start: 's', end: 'e', before_recording: true, tokens: tokens(1) }],
    });
    expect(series.bucket).toBe('week');
    expect(series.group).toBeNull();
    expect(series.groups).toEqual([]);
    expect(series.buckets[0].beforeRecording).toBe(true);
    expect(normalizeSeries('nope').buckets).toEqual([]);
    expect(normalizeWindows(null).windows).toEqual([]);
  });

  test('blocks keep ccusage fields', () => {
    const blocks = normalizeBlocks({
      range: { from: 'f', to: 't', requested_from: 'r', clamped: true },
      session_hours: 5,
      blocks: [
        {
          start: 's',
          end: 'e',
          actual_end: 'a',
          active: true,
          peak_tokens_per_minute: 960,
          burn_rate_tokens_per_minute: 480,
          active_minutes: 2,
          auth_indexes: ['x', 'y'],
          requests: 5,
          failed: 1,
          tokens: tokens(960),
        },
      ],
    });
    expect(blocks.range.clamped).toBe(true);
    expect(blocks.blocks[0]).toMatchObject({
      active: true,
      burnRateTokensPerMinute: 480,
      authIndexes: ['x', 'y'],
    });
  });

  test('prices: per-token fields, tiers sorted, plans, absent overrides', () => {
    const prices = normalizePrices({
      source: 'embedded',
      fetched_at: null,
      models: {
        'gpt-5.5': {
          provider: 'openai',
          mode: 'chat',
          input: 0.000005,
          output: 0.00003,
          tiers: [
            { above_tokens: 500000, input: 0.00002 },
            { above_tokens: 272000, input: 0.00001 },
          ],
          service_tiers: { priority: { input: 0.0000125 } },
        },
      },
      plans: {
        claude: {
          max_5x: {
            name: 'Claude Max 5x',
            monthly_price: 100,
            currency: 'USD',
            billing: 'per_account',
            verified: true,
          },
        },
      },
      overrides: null,
    });
    const model = prices.models['gpt-5.5'];
    expect(prices.source).toBe('embedded');
    expect(model.input).toBe(0.000005);
    expect(model.cacheRead).toBeUndefined();
    expect(model.tiers.map((tier) => tier.aboveTokens)).toEqual([272000, 500000]);
    expect(model.serviceTiers.priority?.input).toBe(0.0000125);
    expect(model.serviceTiers.flex).toBeUndefined();
    expect(prices.plans.claude.max_5x).toMatchObject({ monthlyPrice: 100, verified: true });
    expect(prices.overrides).toBeNull();
  });

  test('settings round-trip to the plugin shape', () => {
    const raw = {
      schema: 1,
      plan_overrides: {
        '7f3a': { provider: 'claude', plan: 'max_20x', monthly_price: 180, currency: 'EUR' },
      },
      model_price_overrides: { 'kimi-k3': { input: 0.000003, output: 0.000012 } },
      default_currency: 'EUR',
      updated_at: '2026-10-27T09:45:00Z',
      retention: { minute_days: 14, hour_days: 400 },
    };
    const settings = normalizeSettings(raw);
    expect(settings.planOverrides['7f3a'].monthlyPrice).toBe(180);
    expect(serializeSettings(settings)).toEqual({
      plan_overrides: raw.plan_overrides,
      model_price_overrides: raw.model_price_overrides,
      default_currency: 'EUR',
    });
  });

  test('export filename comes from Content-Disposition when exposed', () => {
    expect(
      filenameFromDisposition(
        'attachment; filename="usage-ledger_2026-10-01_2026-10-27_day.csv"',
        'x'
      )
    ).toBe('usage-ledger_2026-10-01_2026-10-27_day.csv');
    expect(filenameFromDisposition(undefined, 'fallback.csv')).toBe('fallback.csv');
  });
});
