import { describe, expect, test } from 'bun:test';
import { normalizeAuthFilesResponse } from '../src/services/api/authFiles';
import {
  normalizeAuthFileQuotaObservation,
  parseQuotaSignals,
} from '../src/services/api/quotaSignals';
import type { AuthFilesResponse } from '../src/types/authFile';

// Header names and value formats mirror the backend's capture in
// sdk/cliproxy/auth/quota_signals.go and its executor tests: canonical header keys,
// Claude utilization as a 0–1 fraction, resets as Unix seconds.
const observedAt = '2026-10-27T12:20:00Z';
const observedAtMs = Date.parse(observedAt);
const receivedAtMs = observedAtMs + 5_000;
const unix = (ms: number) => String(Math.floor(ms / 1000));
const fiveHourReset = observedAtMs + 70 * 60_000;
const sevenDayReset = observedAtMs + 2 * 24 * 3_600_000;

const claudeSignals = {
  'Anthropic-Ratelimit-Unified-Status': 'allowed',
  'Anthropic-Ratelimit-Unified-5h-Utilization': '0.82',
  'Anthropic-Ratelimit-Unified-5h-Reset': unix(fiveHourReset),
  'Anthropic-Ratelimit-Unified-5h-Status': 'allowed_warning',
  'Anthropic-Ratelimit-Unified-7d-Utilization': '0.47',
  'Anthropic-Ratelimit-Unified-7d-Reset': unix(sevenDayReset),
  'Anthropic-Ratelimit-Unified-7d-Status': 'allowed',
  'Anthropic-Ratelimit-Unified-Representative-Claim': 'five_hour',
};

const codexSignals = {
  'X-Codex-Plan-Type': 'Pro',
  'X-Codex-Active-Limit': 'codex',
  'X-Codex-Primary-Used-Percent': '54',
  'X-Codex-Primary-Window-Minutes': '300',
  'X-Codex-Primary-Reset-After-Seconds': '3600',
  'X-Codex-Secondary-Used-Percent': '63.5',
  'X-Codex-Secondary-Window-Minutes': '10080',
  'X-Codex-Secondary-Reset-At': unix(sevenDayReset),
  'X-Codex-Secondary-Reset-After-Seconds': '1',
  'X-Codex-Code-Review-Primary-Used-Percent': '10',
  'X-Codex-Code-Review-Primary-Window-Minutes': '300',
  'X-Codex-Bengalfox-Primary-Used-Percent': '20',
  'X-Codex-Bengalfox-Limit-Name': 'GPT-5 Codex Spark',
  'X-Codex-Primary-Over-Secondary-Limit-Percent': '0',
  'X-Codex-Credits-Balance': '12.5',
  'X-Codex-Credits-Has-Credits': 'true',
  'X-Codex-Credits-Unlimited': 'false',
  'X-Codex-Limit-Reached': 'false',
};

describe('Claude quota signals', () => {
  test('reads 5h and 7d windows as percent used with reset times', () => {
    const quota = parseQuotaSignals(
      'claude',
      { observed_at: observedAt, signals: claudeSignals },
      receivedAtMs
    );
    expect(quota).toEqual({
      provider: 'claude',
      observedAt: '2026-10-27T12:20:00.000Z',
      status: 'allowed',
      limitReached: false,
      windows: [
        {
          id: '5h',
          usedPercent: 82,
          periodHours: 5,
          resetAtMs: Math.floor(fiveHourReset / 1000) * 1000,
          status: 'allowed_warning',
        },
        {
          id: '7d',
          usedPercent: 47,
          periodHours: 168,
          resetAtMs: Math.floor(sevenDayReset / 1000) * 1000,
          status: 'allowed',
        },
      ],
    });
  });

  test('a rejected status marks the limit reached and keeps Retry-After', () => {
    const quota = parseQuotaSignals(
      'claude',
      {
        signals: {
          'Anthropic-Ratelimit-Unified-Status': 'rejected',
          'Anthropic-Ratelimit-Unified-7d_oi-Utilization': '1.04',
          'Anthropic-Ratelimit-Unified-7d_oi-Status': 'rejected',
          'Retry-After': '120',
        },
      },
      receivedAtMs
    );
    expect(quota?.limitReached).toBe(true);
    expect(quota?.retryAfterSeconds).toBe(120);
    expect(quota?.windows).toEqual([
      { id: '7d_oi', usedPercent: 100, periodHours: 168, status: 'rejected' },
    ]);
  });
});

describe('Codex quota signals', () => {
  const quota = parseQuotaSignals(
    'codex',
    { observed_at: observedAt, signals: codexSignals },
    receivedAtMs
  )!;

  test('orders the main limit first, then code review, then named limits', () => {
    expect(quota.windows.map((window) => window.id)).toEqual([
      ':primary',
      ':secondary',
      'code-review:primary',
      'bengalfox:primary',
    ]);
  });

  test('relative resets count from capture time; absolute Reset-At wins', () => {
    const [primary, secondary] = quota.windows;
    expect(primary).toEqual({
      id: ':primary',
      limit: '',
      usedPercent: 54,
      periodHours: 5,
      resetAtMs: observedAtMs + 3_600_000,
    });
    expect(secondary.resetAtMs).toBe(Math.floor(sevenDayReset / 1000) * 1000);
    expect(secondary.periodHours).toBe(168);
    expect(secondary.usedPercent).toBe(63.5);
  });

  test('named limits keep their display name; windows without timing stay usable', () => {
    expect(quota.windows[3]).toEqual({
      id: 'bengalfox:primary',
      limit: 'bengalfox',
      limitName: 'GPT-5 Codex Spark',
      usedPercent: 20,
    });
  });

  test('reads plan, active limit, credits and limit state', () => {
    expect(quota.planType).toBe('pro');
    expect(quota.activeLimit).toBe('codex');
    expect(quota.credits).toEqual({ balance: 12.5, hasCredits: true, unlimited: false });
    expect(quota.limitReached).toBe(false);
  });

  test('falls back to receipt time when the capture time is missing', () => {
    const parsed = parseQuotaSignals(
      'codex',
      {
        signals: {
          'x-codex-primary-used-percent': '5',
          'x-codex-primary-reset-after-seconds': '60',
        },
      },
      receivedAtMs
    );
    expect(parsed?.windows[0].resetAtMs).toBe(receivedAtMs + 60_000);
  });
});

describe('quota observation boundaries', () => {
  test('ignores empty, malformed and non-string signals', () => {
    expect(parseQuotaSignals('claude', { signals: {} }, receivedAtMs)).toBeUndefined();
    expect(parseQuotaSignals('claude', null, receivedAtMs)).toBeUndefined();
    expect(
      parseQuotaSignals(
        'codex',
        { signals: { 'X-Codex-Primary-Used-Percent': 'n/a', 'X-Codex-Other': 4 } },
        receivedAtMs
      )
    ).toBeUndefined();
  });

  test('only Claude and Codex are parsed', () => {
    expect(
      normalizeAuthFileQuotaObservation(
        'devin',
        { signals: { plan_end: '2026-11-01' } },
        undefined,
        receivedAtMs
      )
    ).toBeUndefined();
  });

  test('keeps per-model snapshots even without a credential snapshot', () => {
    const observation = normalizeAuthFileQuotaObservation(
      'claude',
      { signals: {} },
      { 'claude-opus-5-5': { observed_at: observedAt, signals: claudeSignals }, ' ': {} },
      receivedAtMs
    );
    expect(observation?.windows).toEqual([]);
    expect(observation?.receivedAtMs).toBe(receivedAtMs);
    expect(Object.keys(observation?.models ?? {})).toEqual(['claude-opus-5-5']);
    expect(observation?.models?.['claude-opus-5-5'].windows).toHaveLength(2);
  });
});

describe('credentials list normalization', () => {
  test('attaches quotaObservation only where signals were captured', () => {
    const response = normalizeAuthFilesResponse(
      {
        observed_at: observedAt,
        files: [
          {
            name: 'claude-max-ops-1.json',
            type: 'claude',
            provider: 'claude',
            quota: { observed_at: observedAt, signals: claudeSignals },
            model_quotas: {},
          },
          { name: 'gemini.json', type: 'gemini', quota: { signals: {} } },
          { name: 'codex-pro-a.json', type: 'codex', quota: { signals: {} } },
        ],
      } as unknown as AuthFilesResponse,
      receivedAtMs
    );
    const byName = new Map(response.files.map((file) => [file.name, file]));
    expect(byName.get('claude-max-ops-1.json')?.quotaObservation?.windows[0].usedPercent).toBe(82);
    expect('quotaObservation' in byName.get('gemini.json')!).toBe(false);
    expect('quotaObservation' in byName.get('codex-pro-a.json')!).toBe(false);
  });
});
