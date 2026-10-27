import { describe, expect, test } from 'bun:test';
import {
  compareHeadroomPressure,
  headroomAvailability,
  headroomWindowsFromObservation,
  headroomWindowsFromQuota,
  summarizeHeadroom,
  tightestWindow,
  windowElapsedPercent,
  windowPace,
  windowRunsOutAtMs,
  type HeadroomWindow,
} from '../src/features/quota/headroom';
import type { AuthFileCooldownSnapshot } from '../src/types/authFile';

const HOUR = 3_600_000;
const now = Date.parse('2026-10-27T12:00:00Z');

/** A window of `periodHours` that has `elapsedHours` behind it at `now`. */
const windowAt = (
  usedPercent: number,
  periodHours: number,
  elapsedHours: number,
  extra: Partial<HeadroomWindow> = {}
): HeadroomWindow => ({
  id: `w-${periodHours}`,
  usedPercent,
  periodHours,
  resetAtMs: now + (periodHours - elapsedHours) * HOUR,
  ...extra,
});

describe('converting provider quotas to percent used', () => {
  test('Claude and Codex already report percent used', () => {
    const windows = headroomWindowsFromQuota('claude', {
      status: 'success',
      windows: [
        {
          id: 'five-hour',
          label: '5-hour limit',
          labelKey: 'claude_quota.five_hour',
          usedPercent: 82,
          resetLabel: '',
          resetAtMs: now + HOUR,
          periodHours: 5,
        },
        { id: 'seven-day', label: '', usedPercent: null, resetLabel: '' },
      ],
    });
    expect(windows).toEqual([
      {
        id: 'five-hour',
        label: '5-hour limit',
        labelKey: 'claude_quota.five_hour',
        usedPercent: 82,
        resetAtMs: now + HOUR,
        periodHours: 5,
      },
    ]);
  });

  test('remaining-based providers are inverted', () => {
    expect(
      headroomWindowsFromQuota('devin', {
        status: 'success',
        windows: [{ id: 'daily', remainingPercent: 30, resetAtMs: null, periodHours: 24 }],
      })[0].usedPercent
    ).toBe(70);
    expect(
      headroomWindowsFromQuota('antigravity', {
        status: 'success',
        groups: [{ buckets: [{ id: 'g', label: 'Gemini', remainingFraction: 0.25 }] }],
      })[0]
    ).toMatchObject({ id: 'g', label: 'Gemini', usedPercent: 75 });
  });

  test('Kimi counts become percentages; zero limits are skipped', () => {
    const windows = headroomWindowsFromQuota('kimi', {
      status: 'success',
      rows: [
        { id: 'weekly', used: 30, limit: 120, resetAtMs: now, periodHours: 168 },
        { id: 'broken', used: 1, limit: 0 },
      ],
    });
    expect(windows.map((window) => [window.id, window.usedPercent])).toEqual([['weekly', 25]]);
  });

  test('xAI counts only a weekly limit; Meta resets are Unix seconds', () => {
    expect(
      headroomWindowsFromQuota('xai', {
        status: 'success',
        billing: { periodType: 'monthly', usagePercent: 50 },
      })
    ).toEqual([]);
    expect(
      headroomWindowsFromQuota('xai', {
        status: 'success',
        billing: { periodType: 'weekly', usagePercent: 40, resetAtMs: now },
      })[0]
    ).toMatchObject({ id: 'weekly', usedPercent: 40, periodHours: 168 });
    expect(
      headroomWindowsFromQuota('meta', {
        status: 'success',
        data: { windows: [{ id: 'weekly', usedPercent: 12, resetAt: now / 1000 }] },
      })[0]
    ).toMatchObject({ id: 'weekly', usedPercent: 12, resetAtMs: now, periodHours: 168 });
  });

  test('loading, error and malformed states give no windows', () => {
    expect(headroomWindowsFromQuota('claude', { status: 'loading', windows: [] })).toEqual([]);
    expect(headroomWindowsFromQuota('codex', { status: 'error' })).toEqual([]);
    expect(headroomWindowsFromQuota('codex', null)).toEqual([]);
  });
});

describe('passive observations', () => {
  test('map onto the active window ids so the two can merge', () => {
    const claude = headroomWindowsFromObservation({
      provider: 'claude',
      receivedAtMs: now,
      windows: [
        { id: '5h', usedPercent: 82, periodHours: 5, resetAtMs: now + HOUR },
        { id: '7d_oi', usedPercent: 100, periodHours: 168, status: 'rejected' },
      ],
    });
    expect(claude.map((window) => [window.id, window.labelKey, window.rejected])).toEqual([
      ['five-hour', 'claude_quota.five_hour', undefined],
      ['7d_oi', undefined, true],
    ]);

    const codex = headroomWindowsFromObservation({
      provider: 'codex',
      receivedAtMs: now,
      windows: [
        { id: ':primary', limit: '', usedPercent: 54, periodHours: 5 },
        { id: ':secondary', limit: '', usedPercent: 63, periodHours: 168 },
        { id: 'code-review:primary', limit: 'code-review', usedPercent: 10, periodHours: 5 },
        { id: 'bengalfox:primary', limit: 'bengalfox', limitName: 'Spark', usedPercent: 20 },
      ],
    });
    expect(codex.map((window) => window.id)).toEqual([
      'five-hour',
      'weekly',
      'code-review-five-hour',
      'bengalfox:primary',
    ]);
    expect(codex[3].label).toBe('Spark');
  });

  test('no observation gives no windows', () => {
    expect(headroomWindowsFromObservation(undefined)).toEqual([]);
  });
});

describe('pace and run-out', () => {
  test('elapsed share needs both a reset and a period', () => {
    expect(windowElapsedPercent(windowAt(0, 5, 1), now)).toBeCloseTo(20);
    expect(windowElapsedPercent({ ...windowAt(0, 5, 1), periodHours: null }, now)).toBeNull();
  });

  test('pace compares usage with elapsed time, with a tolerance band', () => {
    expect(windowPace(windowAt(82, 5, 3.85), now)).toMatchObject({ state: 'on-pace' });
    expect(windowPace(windowAt(82, 5, 2.5), now)).toMatchObject({
      state: 'ahead',
      elapsedPercent: 50,
      deltaPercent: 32,
    });
    expect(windowPace(windowAt(10, 168, 84), now)?.state).toBe('under');
  });

  test('projects a run-out before reset at the average rate so far', () => {
    // 60% used in 2h of a 5h window → 30%/h → the remaining 40% lasts 80 minutes.
    expect(windowRunsOutAtMs(windowAt(60, 5, 2), now)).toBe(now + (80 / 60) * HOUR);
  });

  test('hides run-out early in a window, when it resets first, and once exhausted', () => {
    expect(windowRunsOutAtMs(windowAt(10, 5, 0.5), now)).toBeNull();
    expect(windowRunsOutAtMs(windowAt(20, 5, 2.5), now)).toBeNull();
    expect(windowRunsOutAtMs(windowAt(100, 5, 2.5), now)).toBeNull();
    expect(windowRunsOutAtMs(windowAt(0, 5, 2.5), now)).toBeNull();
  });
});

describe('tightest limit', () => {
  test('least remaining wins; an exhausted window always wins', () => {
    const session = windowAt(82, 5, 3);
    const weekly = windowAt(47, 168, 80);
    expect(tightestWindow([weekly, session])).toBe(session);
    const rejected = { ...windowAt(30, 168, 10), id: 'oi', rejected: true };
    expect(tightestWindow([session, rejected])).toBe(rejected);
    expect(tightestWindow([])).toBeNull();
  });

  test('on a tie the window locked longest wins, unknown reset longest of all', () => {
    const soon = windowAt(90, 5, 4);
    const late = windowAt(90, 168, 10);
    expect(tightestWindow([soon, late])).toBe(late);
    const unknown = { ...soon, id: 'x', resetAtMs: null };
    expect(tightestWindow([late, unknown])).toBe(unknown);
  });
});

describe('availability', () => {
  const cooldown = (
    remainingSeconds: number,
    scope: 'credential' | 'model' = 'credential'
  ): AuthFileCooldownSnapshot => ({
    receivedAtMs: now - 60_000,
    records: [
      {
        scope,
        ...(scope === 'model' ? { modelKey: 'm' } : {}),
        reason: 'quota',
        retryAt: '',
        remainingSeconds,
      },
    ],
  });

  test('available when nothing is exhausted or cooling down', () => {
    expect(headroomAvailability([windowAt(99, 5, 1)], undefined, now)).toEqual({
      state: 'available',
    });
  });

  test('an exhausted window blocks until it resets; a passed reset no longer blocks', () => {
    const exhausted = windowAt(100, 5, 4);
    expect(headroomAvailability([exhausted], undefined, now)).toEqual({
      state: 'blocked',
      reason: 'exhausted',
      untilMs: exhausted.resetAtMs,
    });
    expect(headroomAvailability([{ ...exhausted, resetAtMs: now - 1 }], undefined, now).state).toBe(
      'available'
    );
  });

  test('credential cooldowns count from receipt; model cooldowns do not block', () => {
    expect(headroomAvailability([], cooldown(600), now)).toEqual({
      state: 'blocked',
      reason: 'cooldown',
      untilMs: now + 540_000,
    });
    expect(headroomAvailability([], cooldown(30), now).state).toBe('available');
    expect(headroomAvailability([], cooldown(600, 'model'), now).state).toBe('available');
  });

  test('the latest blocker decides; an unknown reset means unknown', () => {
    const exhausted = windowAt(100, 5, 4.95);
    expect(headroomAvailability([exhausted], cooldown(600), now)).toMatchObject({
      reason: 'cooldown',
      untilMs: now + 540_000,
    });
    expect(headroomAvailability([{ ...exhausted, resetAtMs: null }], cooldown(600), now)).toEqual({
      state: 'blocked',
      reason: 'exhausted',
      untilMs: null,
    });
  });
});

describe('pressure ranking', () => {
  const summary = (windows: HeadroomWindow[]) => summarizeHeadroom({ windows, now });

  test('summaries pick a tier', () => {
    expect(summary([]).tier).toBe('unknown');
    expect(summary([windowAt(100, 5, 4)]).tier).toBe('blocked');
    expect(summary([windowAt(60, 5, 2)]).tier).toBe('runs-out');
    expect(summary([windowAt(40, 168, 20)]).tier).toBe('ahead');
    expect(summary([windowAt(20, 5, 2.5)]).tier).toBe('steady');
  });

  test('a summary carries the tightest window, its pace and the earliest run-out', () => {
    const result = summary([windowAt(60, 5, 2), windowAt(30, 168, 20)]);
    expect(result.tightest?.id).toBe('w-5');
    expect(result.pace?.state).toBe('ahead');
    expect(result.runsOutAtMs).toBe(now + (80 / 60) * HOUR);
  });

  test('blocked first by soonest return, then run-out by soonest, then usage', () => {
    const entries = {
      steady: summary([windowAt(20, 5, 2.5)]),
      steadyHigh: summary([windowAt(45, 5, 2.5)]),
      runsOutLate: summary([windowAt(60, 5, 2)]),
      runsOutSoon: summary([windowAt(80, 5, 2)]),
      blockedLate: summary([windowAt(100, 168, 10)]),
      blockedSoon: summary([windowAt(100, 5, 4)]),
      unknown: summary([]),
    };
    const order = Object.entries(entries)
      .sort(([, a], [, b]) => compareHeadroomPressure(a, b))
      .map(([name]) => name);
    expect(order).toEqual([
      'blockedSoon',
      'blockedLate',
      'runsOutSoon',
      'runsOutLate',
      'steadyHigh',
      'steady',
      'unknown',
    ]);
  });
});
