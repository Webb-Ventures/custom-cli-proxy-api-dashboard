import { beforeEach, describe, expect, test } from 'bun:test';
import {
  AUTO_REFRESH_ERROR_BACKOFF_MS,
  AUTO_REFRESH_INTERVAL_MS,
  PASSIVE_FRESH_MS,
  resolveCredentialHeadroom,
  runWithConcurrency,
  selectAutoRefreshTargets,
} from '../src/features/quota/freshness';
import type { QuotaFileEntry } from '../src/features/quota/logic';
import type { QuotaCardState } from '../src/features/quota/providers';
import { normalizeAuthFileQuotaObservation } from '../src/services/api/quotaSignals';
import { useQuotaStore } from '../src/stores/useQuotaStore';
import type { AuthFileQuotaObservation, ClaudeQuotaState } from '../src/types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const now = Date.parse('2026-10-27T12:00:00Z');

const claudeEntry: QuotaFileEntry = { type: 'claude', file: { name: 'claude-a.json' } };
const kimiEntry: QuotaFileEntry = { type: 'kimi', file: { name: 'kimi-a.json' } };

const activeClaude = (fiveHourUsed: number): ClaudeQuotaState => ({
  status: 'success',
  windows: [
    {
      id: 'five-hour',
      label: '5-hour limit',
      usedPercent: fiveHourUsed,
      resetLabel: '',
      resetAtMs: now + HOUR,
      periodHours: 5,
    },
    {
      id: 'seven-day-opus',
      label: '7-day Opus',
      usedPercent: 12,
      resetLabel: '',
      resetAtMs: now + 48 * HOUR,
      periodHours: 168,
    },
  ],
});

const passiveClaude = (fiveHourUsed: number, seenAtMs?: number): AuthFileQuotaObservation => ({
  provider: 'claude',
  receivedAtMs: now,
  ...(seenAtMs !== undefined ? { seenAtMs } : {}),
  windows: [{ id: '5h', usedPercent: fiveHourUsed, periodHours: 5, resetAtMs: now + HOUR }],
});

describe('seenAtMs from server timestamps', () => {
  test('subtracts the server-measured age from local receipt time', () => {
    const observation = normalizeAuthFileQuotaObservation(
      'claude',
      {
        observed_at: '2026-10-27T11:58:00Z',
        signals: { 'anthropic-ratelimit-unified-5h-utilization': '0.4' },
      },
      undefined,
      now + 30_000,
      '2026-10-27T12:00:00Z'
    );
    expect(observation?.seenAtMs).toBe(now + 30_000 - 2 * MINUTE);
  });

  test('is absent without the list timestamp', () => {
    const observation = normalizeAuthFileQuotaObservation(
      'claude',
      {
        observed_at: '2026-10-27T11:58:00Z',
        signals: { 'anthropic-ratelimit-unified-5h-utilization': '0.4' },
      },
      undefined,
      now
    );
    expect(observation).toBeDefined();
    expect('seenAtMs' in observation!).toBe(false);
  });
});

describe('resolveCredentialHeadroom', () => {
  test('a fresher passive reading replaces the matching active window only', () => {
    const result = resolveCredentialHeadroom(
      claudeEntry,
      activeClaude(30),
      passiveClaude(64, now - 2 * MINUTE),
      now - HOUR
    );
    expect(result.source).toBe('mixed');
    expect(result.seenAtMs).toBe(now - 2 * MINUTE);
    expect(result.seenFrom).toBe('traffic');
    expect(result.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['five-hour', 64],
      ['seven-day-opus', 12],
    ]);
  });

  test('an older or undated passive reading never replaces an active one', () => {
    const older = resolveCredentialHeadroom(
      claudeEntry,
      activeClaude(30),
      passiveClaude(64, now - 2 * HOUR),
      now - HOUR
    );
    expect(older.windows[0].usedPercent).toBe(30);
    expect(older.source).toBe('active');
    expect(older.seenAtMs).toBe(now - HOUR);
    expect(older.seenFrom).toBe('fetch');

    const undated = resolveCredentialHeadroom(
      claudeEntry,
      activeClaude(30),
      passiveClaude(64),
      now - HOUR
    );
    expect(undated.windows[0].usedPercent).toBe(30);
  });

  test('either source alone stands on its own', () => {
    const passiveOnly = resolveCredentialHeadroom(
      claudeEntry,
      undefined,
      passiveClaude(64, now - MINUTE),
      undefined
    );
    expect(passiveOnly).toMatchObject({ source: 'passive', seenAtMs: now - MINUTE });
    expect(passiveOnly.windows).toHaveLength(1);

    expect(resolveCredentialHeadroom(claudeEntry, undefined, undefined, undefined)).toEqual({
      windows: [],
      seenAtMs: null,
      seenFrom: null,
      source: null,
    });
  });

  test('passive snapshots are ignored for providers that send no headers', () => {
    const result = resolveCredentialHeadroom(
      kimiEntry,
      undefined,
      passiveClaude(64, now),
      undefined
    );
    expect(result.windows).toEqual([]);
  });
});

describe('selectAutoRefreshTargets', () => {
  const select = (
    quota: Record<string, QuotaCardState>,
    observedQuota: Record<string, AuthFileQuotaObservation>,
    quotaCheckedAt: Record<string, number>
  ) =>
    selectAutoRefreshTargets({
      entries: [claudeEntry, kimiEntry],
      quotaFor: (entry) => quota[entry.file.name],
      observedQuota,
      quotaCheckedAt,
      now,
    }).map((entry) => entry.file.name);

  test('never-checked credentials are due; loading ones are not', () => {
    expect(select({}, {}, {})).toEqual(['claude-a.json', 'kimi-a.json']);
    expect(select({ 'kimi-a.json': { status: 'loading' } }, {}, {})).toEqual(['claude-a.json']);
  });

  test('fresh passive traffic keeps a credential off the list', () => {
    const fresh = { 'claude-a.json': passiveClaude(10, now - PASSIVE_FRESH_MS + MINUTE) };
    expect(select({}, fresh, {})).toEqual(['kimi-a.json']);
    const stale = { 'claude-a.json': passiveClaude(10, now - PASSIVE_FRESH_MS) };
    expect(select({}, stale, {})).toEqual(['claude-a.json', 'kimi-a.json']);
  });

  test('checked credentials wait for the interval; failures wait for the back-off', () => {
    const checked = {
      'claude-a.json': now - AUTO_REFRESH_INTERVAL_MS + MINUTE,
      'kimi-a.json': now - AUTO_REFRESH_INTERVAL_MS,
    };
    const success = { status: 'success' as const };
    expect(select({ 'claude-a.json': success, 'kimi-a.json': success }, {}, checked)).toEqual([
      'kimi-a.json',
    ]);

    const failed = { 'kimi-a.json': { status: 'error' as const } };
    expect(select(failed, {}, { 'kimi-a.json': now - AUTO_REFRESH_INTERVAL_MS })).toEqual([
      'claude-a.json',
    ]);
    expect(select(failed, {}, { 'kimi-a.json': now - AUTO_REFRESH_ERROR_BACKOFF_MS })).toEqual([
      'claude-a.json',
      'kimi-a.json',
    ]);
  });
});

describe('runWithConcurrency', () => {
  test('never exceeds the limit and processes every item', async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      done.push(item);
      inFlight -= 1;
    });
    expect(peak).toBe(3);
    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('stops starting new work once asked to', async () => {
    const started: number[] = [];
    await runWithConcurrency(
      [1, 2, 3, 4],
      1,
      async (item) => {
        started.push(item);
      },
      () => started.length >= 2
    );
    expect(started).toEqual([1, 2]);
  });
});

describe('quota store freshness state', () => {
  beforeEach(() => {
    useQuotaStore.getState().clearQuotaCache();
  });

  test('finished fetches are stamped; loading states are not', () => {
    const store = useQuotaStore.getState();
    store.setKimiQuota({ 'kimi-a.json': { status: 'loading', rows: [] } });
    expect(useQuotaStore.getState().quotaCheckedAt['kimi-a.json']).toBeUndefined();
    store.setKimiQuota((prev) => ({ ...prev, 'kimi-a.json': { status: 'success', rows: [] } }));
    expect(useQuotaStore.getState().quotaCheckedAt['kimi-a.json']).toBeNumber();
  });

  test('passive snapshots are replaced per list and cleared with the session', () => {
    const observation = passiveClaude(10, now);
    useQuotaStore
      .getState()
      .syncObservedQuota([
        { name: 'claude-a.json', quotaObservation: observation },
        { name: 'kimi-a.json' },
      ]);
    expect(Object.keys(useQuotaStore.getState().observedQuota)).toEqual(['claude-a.json']);

    useQuotaStore.getState().syncObservedQuota([{ name: 'kimi-a.json' }]);
    expect(useQuotaStore.getState().observedQuota).toEqual({});

    useQuotaStore
      .getState()
      .syncObservedQuota([{ name: 'claude-a.json', quotaObservation: observation }]);
    useQuotaStore.getState().markQuotaChecked(['claude-a.json'], now);
    useQuotaStore.getState().clearQuotaCache(['claude-a.json']);
    expect(useQuotaStore.getState().observedQuota).toEqual({});
    expect(useQuotaStore.getState().quotaCheckedAt).toEqual({});
  });
});
