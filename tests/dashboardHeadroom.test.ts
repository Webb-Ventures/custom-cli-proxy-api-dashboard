import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { PRESSURE_BOARD_LIMIT, PressureBoard } from '@/features/dashboard/components/PressureBoard';
import { summarizeFleetHeadroom, type HeadroomRow } from '@/features/dashboard/headroomOverview';
import type { SummarizedHeadroom } from '@/features/quota/freshness';
import { summarizeHeadroom, type HeadroomWindow } from '@/features/quota/headroom';
import type { QuotaFileEntry } from '@/features/quota/logic';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import type { AuthFileCooldownSnapshot } from '@/types';

const HOUR = 3_600_000;
const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);
const now = Date.parse('2026-10-27T12:00:00Z');

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

const cooldown = (seconds: number): AuthFileCooldownSnapshot => ({
  receivedAtMs: now,
  records: [{ scope: 'credential', reason: 'quota', retryAt: '', remainingSeconds: seconds }],
});

const row = (
  name: string,
  windows: HeadroomWindow[],
  options: { cooldown?: AuthFileCooldownSnapshot; seenAtMs?: number | null } = {}
): HeadroomRow<QuotaFileEntry> => {
  const headroom: SummarizedHeadroom = {
    summary: summarizeHeadroom({ windows, cooldown: options.cooldown, now }),
    seenAtMs: options.seenAtMs ?? null,
    seenFrom: options.seenAtMs ? 'traffic' : null,
  };
  return { item: { type: 'claude', file: { name } }, headroom };
};

// Other suites assume the default language, so put it back afterwards.
const previousLanguage = i18n.language;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

describe('summarizeFleetHeadroom', () => {
  const rows = [
    row('steady', [windowAt('five-hour', 20, 5, 2.5), windowAt('weekly', 40, 168, 84)], {
      seenAtMs: now - 5 * 60_000,
    }),
    row('ahead', [windowAt('weekly', 70, 168, 50)], { seenAtMs: now - 60_000 }),
    row('cooling', [windowAt('five-hour', 10, 5, 1)], { cooldown: cooldown(1800) }),
    row('exhausted', [windowAt('five-hour', 100, 5, 4)]),
  ];
  const fleet = summarizeFleetHeadroom(rows);

  test('counts room, pace and blockers', () => {
    expect(fleet.total).toBe(4);
    expect(fleet.withRoom).toBe(2);
    expect(fleet.ahead).toBe(1);
    expect(fleet.cooling).toBe(1);
    expect(fleet.exhausted).toBe(1);
  });

  test('ranks blocked credentials first', () => {
    expect(
      fleet.ranked
        .map((entry) => entry.item.file.name)
        .slice(0, 2)
        .sort()
    ).toEqual(['cooling', 'exhausted']);
    expect(fleet.ranked.at(-1)?.item.file.name).toBe('steady');
  });

  test('next capacity is the earliest blocker to clear', () => {
    // The used-up 5-hour window resets in one hour; the cooldown ends in 30 minutes.
    expect(fleet.next?.item.file.name).toBe('cooling');
    expect(fleet.next?.reason).toBe('cooldown');
    expect(fleet.next?.atMs).toBe(now + 1800 * 1000);
  });

  test('a used-up window names the window that resets', () => {
    const next = summarizeFleetHeadroom([rows[3]]).next;
    expect(next?.reason).toBe('exhausted');
    expect(next?.window?.id).toBe('five-hour');
    expect(next?.atMs).toBe(now + HOUR);
  });

  test('weekly pool averages the weekly window of credentials that have one', () => {
    expect(fleet.weeklyCount).toBe(2);
    expect(fleet.weeklyPoolUsed).toBe(55);
  });

  test('Codex weekly windows in minutes still count as weekly', () => {
    const codex = summarizeFleetHeadroom([row('codex', [windowAt('weekly', 30, 10080 / 60, 10)])]);
    expect(codex.weeklyPoolUsed).toBe(30);
  });

  test('latest reading and an empty fleet', () => {
    expect(fleet.latestSeenAtMs).toBe(now - 60_000);
    const empty = summarizeFleetHeadroom([]);
    expect(empty.total).toBe(0);
    expect(empty.next).toBeNull();
    expect(empty.weeklyPoolUsed).toBeNull();
    expect(empty.latestSeenAtMs).toBeNull();
  });
});

describe('PressureBoard', () => {
  const render = (rows: HeadroomRow<QuotaFileEntry>[]) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(PressureBoard, { rows, now, resolvedTheme: 'light', classes })
      )
    );

  test('shows each tightest limit with a status and when it is available', () => {
    const html = render(
      summarizeFleetHeadroom([
        row('busy.json', [windowAt('five-hour', 60, 5, 2, { labelKey: 'claude_quota.five_hour' })]),
        row('cool.json', [windowAt('five-hour', 10, 5, 1)], { cooldown: cooldown(600) }),
        row('calm.json', [windowAt('five-hour', 20, 5, 2.5)]),
      ]).ranked
    );
    expect(html.indexOf('cool.json')).toBeLessThan(html.indexOf('busy.json'));
    expect(html.indexOf('busy.json')).toBeLessThan(html.indexOf('calm.json'));
    expect(html).toContain('Cooling down');
    expect(html).toContain('Runs out before reset');
    expect(html).toContain('5-hour limit, runs out ');
    expect(html).toContain('On pace');
    expect(html).toContain('60%');
    expect(html.match(/role="meter"/g)).toHaveLength(3);
    expect(html).toContain('href="/quota"');
  });

  test('folds rows past the limit into a count', () => {
    const rows = Array.from({ length: PRESSURE_BOARD_LIMIT + 3 }, (_, index) =>
      row(`cred-${index}.json`, [windowAt('five-hour', 10, 5, 2.5)])
    );
    const html = render(rows);
    expect(html.match(/role="meter"/g)).toHaveLength(PRESSURE_BOARD_LIMIT);
    expect(html).toContain('3 more');
  });

  test('explains how readings arrive when there are none', () => {
    expect(render([])).toContain('Claude and Codex appear after their next request');
  });
});
