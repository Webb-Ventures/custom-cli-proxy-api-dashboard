import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_USAGE_STATE,
  addDays,
  bucketForDays,
  dayInZone,
  daysBetween,
  parseUsageState,
  periodChange,
  resolveUsageRange,
  serializeUsageState,
} from '@/features/usage/range';

const now = Date.parse('2026-10-27T12:00:00Z');

describe('usage URL state', () => {
  test('plain #/usage is the default state and serializes back to nothing', () => {
    expect(parseUsageState('')).toEqual(DEFAULT_USAGE_STATE);
    expect(serializeUsageState(DEFAULT_USAGE_STATE)).toBe('');
  });

  test('round-trips a full state', () => {
    const search =
      '?view=providers&range=custom&from=2026-10-01&to=2026-10-14&metric=tokens&group=credential&credential=a1';
    const state = parseUsageState(search);
    expect(state).toEqual({
      view: 'providers',
      range: 'custom',
      from: '2026-10-01',
      to: '2026-10-14',
      metric: 'tokens',
      group: 'credential',
      credential: 'a1',
    });
    expect(parseUsageState(serializeUsageState(state))).toEqual(state);
  });

  test('drops unknown values and malformed custom ranges', () => {
    expect(parseUsageState('?view=nope&metric=dollars&group=user')).toEqual(DEFAULT_USAGE_STATE);
    expect(parseUsageState('?range=custom&from=2026-10-14&to=2026-10-01').range).toBe('30d');
    expect(parseUsageState('?range=custom&from=yesterday&to=2026-10-01').range).toBe('30d');
  });
});

describe('calendar days', () => {
  test('day arithmetic ignores zones and DST', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(daysBetween('2026-10-01', '2026-10-01')).toBe(1);
    expect(daysBetween('2026-09-28', '2026-10-27')).toBe(30);
  });

  test('the day is read in the given zone', () => {
    const lateUtc = Date.parse('2026-10-27T23:30:00Z');
    expect(dayInZone(lateUtc, 'UTC')).toBe('2026-10-27');
    expect(dayInZone(lateUtc, 'Australia/Sydney')).toBe('2026-10-28');
  });

  test('buckets keep the ledger under its bucket cap', () => {
    expect(bucketForDays(1)).toBe('hour');
    expect(bucketForDays(90)).toBe('day');
    expect(bucketForDays(400)).toBe('week');
  });
});

describe('resolveUsageRange', () => {
  test('a preset ends today and compares with the same number of days before', () => {
    const range = resolveUsageRange({ range: '30d' }, now, 'UTC');
    expect(range).toMatchObject({
      from: '2026-09-28',
      to: '2026-10-27',
      days: 30,
      bucket: 'day',
      includesToday: true,
      previous: { from: '2026-08-29', to: '2026-09-27' },
    });
  });

  test('today is one hourly day', () => {
    const range = resolveUsageRange({ range: 'today' }, now, 'UTC');
    expect(range).toMatchObject({ from: '2026-10-27', to: '2026-10-27', days: 1, bucket: 'hour' });
    expect(range.previous).toEqual({ from: '2026-10-26', to: '2026-10-26' });
  });

  test('a past custom range does not include today and is capped at 400 days', () => {
    const past = resolveUsageRange(
      { range: 'custom', from: '2026-10-01', to: '2026-10-07' },
      now,
      'UTC'
    );
    expect(past.includesToday).toBe(false);
    expect(past.days).toBe(7);
    const long = resolveUsageRange(
      { range: 'custom', from: '2024-01-01', to: '2026-10-27' },
      now,
      'UTC'
    );
    expect(long.days).toBe(400);
    expect(long.to).toBe('2026-10-27');
  });

  test('period change is null without a previous value', () => {
    expect(periodChange(118, 100)).toBeCloseTo(0.18);
    expect(periodChange(5, 0)).toBeNull();
  });
});
