import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { HeadroomWindows } from '@/features/quota/components/HeadroomWindows';
import { DEFAULT_QUOTA_SORT_MODE } from '@/features/quota/constants';
import {
  summarizeHeadroom,
  type HeadroomSummary,
  type HeadroomWindow,
} from '@/features/quota/headroom';
import {
  filterEntriesByHeadroom,
  sortQuotaEntries,
  type QuotaFileEntry,
} from '@/features/quota/logic';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { isQuotaHeadroomFilter } from '@/features/quota/uiState';
import type { AuthFileCooldownSnapshot } from '@/types';

const HOUR = 3_600_000;
const now = Date.parse('2026-10-27T12:00:00Z');

const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);

const windowAt = (
  id: string,
  usedPercent: number,
  periodHours: number,
  elapsedHours: number,
  extra: Partial<HeadroomWindow> = {}
): HeadroomWindow => ({
  id,
  usedPercent,
  periodHours,
  resetAtMs: now + (periodHours - elapsedHours) * HOUR,
  ...extra,
});

const cooldown: AuthFileCooldownSnapshot = {
  receivedAtMs: now,
  records: [{ scope: 'credential', reason: 'quota', retryAt: '', remainingSeconds: 600 }],
};

const entry = (name: string): QuotaFileEntry => ({ type: 'claude', file: { name } });

// Other suites assume the default language, so put it back afterwards.
const previousLanguage = i18n.language;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

describe('pressure sort and headroom filters', () => {
  const summaries: Record<string, HeadroomSummary | undefined> = {
    steady: summarizeHeadroom({ windows: [windowAt('w', 20, 5, 2.5)], now }),
    ahead: summarizeHeadroom({ windows: [windowAt('w', 40, 168, 20)], now }),
    runsOut: summarizeHeadroom({ windows: [windowAt('w', 60, 5, 2)], now }),
    cooling: summarizeHeadroom({ windows: [windowAt('w', 10, 5, 1)], cooldown, now }),
    exhausted: summarizeHeadroom({ windows: [windowAt('w', 100, 5, 4)], now }),
    unknown: undefined,
  };
  const entries = Object.keys(summaries).map(entry);
  const resolve = (item: QuotaFileEntry) => summaries[item.file.name];
  const names = (items: QuotaFileEntry[]) => items.map((item) => item.file.name);

  test('pressure is the default sort', () => {
    expect(DEFAULT_QUOTA_SORT_MODE).toBe('pressure');
  });

  test('pressure puts blocked first and unknown last, keeping grouped order for ties', () => {
    expect(names(sortQuotaEntries(entries, 'pressure', () => null, resolve))).toEqual([
      'cooling',
      'exhausted',
      'runsOut',
      'ahead',
      'steady',
      'unknown',
    ]);
  });

  test('the provider-grouped order is untouched by headroom', () => {
    expect(names(sortQuotaEntries(entries, 'default', () => null, resolve))).toEqual(
      names(entries)
    );
  });

  test('filters select ahead of pace, cooling down and used up', () => {
    expect(names(filterEntriesByHeadroom(entries, 'all', resolve))).toEqual(names(entries));
    expect(names(filterEntriesByHeadroom(entries, 'ahead', resolve))).toEqual(['ahead', 'runsOut']);
    expect(names(filterEntriesByHeadroom(entries, 'cooling', resolve))).toEqual(['cooling']);
    expect(names(filterEntriesByHeadroom(entries, 'exhausted', resolve))).toEqual(['exhausted']);
  });

  test('stored filter values are validated', () => {
    expect(isQuotaHeadroomFilter('cooling')).toBe(true);
    expect(isQuotaHeadroomFilter('everything')).toBe(false);
  });
});

describe('HeadroomWindows', () => {
  const render = (summary: HeadroomSummary, tightestOnly = false) =>
    renderToStaticMarkup(createElement(HeadroomWindows, { summary, classes, now, tightestOnly }));

  test('leads with the tightest window and its run-out, then thin meters', () => {
    const summary = summarizeHeadroom({
      windows: [
        windowAt('seven-day', 47, 168, 100, { labelKey: 'claude_quota.seven_day' }),
        windowAt('five-hour', 60, 5, 2, { labelKey: 'claude_quota.five_hour' }),
      ],
      now,
    });
    const html = render(summary);
    expect(html.indexOf('5-hour limit')).toBeLessThan(html.indexOf('7-day limit'));
    expect(html).toContain('60% used');
    expect(html).toContain('Runs out ');
    expect(html).toContain('47%');
    expect(html.match(/role="meter"/g)).toHaveLength(2);
    expect(html).toContain('on pace to run out before reset');
  });

  test('a blocked credential says when it is back instead of a run-out', () => {
    const html = render(
      summarizeHeadroom({ windows: [windowAt('five-hour', 10, 5, 1)], cooldown, now })
    );
    expect(html).toContain('Cooling down until ');
    expect(html).not.toContain('Runs out');
  });

  test('used up with no reset instant says so', () => {
    const html = render(
      summarizeHeadroom({
        windows: [{ id: '7d_oi', usedPercent: 100, periodHours: 168, resetAtMs: null }],
        now,
      })
    );
    expect(html).toContain('Used up, reset time unknown');
    expect(html).toContain('7d_oi');
  });

  test('compact hosts show only the tightest window', () => {
    const summary = summarizeHeadroom({
      windows: [windowAt('a', 30, 5, 2.5), windowAt('b', 80, 168, 150)],
      now,
    });
    expect(render(summary, true).match(/role="meter"/g)).toHaveLength(1);
  });

  test('renders nothing without a window', () => {
    expect(render(summarizeHeadroom({ windows: [], now }))).toBe('');
  });
});
