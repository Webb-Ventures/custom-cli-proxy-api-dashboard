import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';
import { HistoryChart } from '@/features/usage/components/HistoryChart';
import { UsageTodayStrip } from '@/features/usage/components/UsageTodayStrip';
import { UsageUnavailable } from '@/features/usage/components/UsageUnavailable';
import {
  formatChange,
  formatMoney,
  formatMultiple,
  formatSpan,
  niceAxisMax,
} from '@/features/usage/format';
import type { UsageBar } from '@/features/usage/usageModel';

const previousLanguage = i18n.language;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

const render = (element: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, element));

describe('UsageUnavailable', () => {
  test('an absent plugin points to the plugin store and plugins page', () => {
    const html = render(createElement(UsageUnavailable, { availability: 'absent' }));
    expect(html).toContain('Install Usage Ledger to see usage history');
    expect(html).toContain('href="/plugin-store"');
    expect(html).toContain('href="/plugins"');
  });

  test('a backend without plugins explains what is needed, with no actions', () => {
    const html = render(createElement(UsageUnavailable, { availability: 'unsupported' }));
    expect(html).toContain('This backend doesn&#x27;t support plugins');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<button');
  });

  test('an error names the error and offers a retry', () => {
    const html = render(
      createElement(UsageUnavailable, {
        availability: 'error',
        error: 'database locked',
        onRetry: () => {},
      })
    );
    expect(html).toContain('The Usage Ledger plugin returned an error: database locked');
    expect(html).toContain('Try again');
  });

  test('checking is announced as busy', () => {
    const html = render(createElement(UsageUnavailable, { availability: 'checking' }));
    expect(html).toContain('aria-busy="true"');
  });
});

describe('HistoryChart', () => {
  const bar = (day: string, valueUsd: number, extra: Partial<UsageBar> = {}): UsageBar => ({
    start: `${day}T00:00:00Z`,
    end: `${day}T23:59:59Z`,
    tokens: valueUsd * 100_000,
    valueUsd,
    beforeRecording: false,
    partial: false,
    ...extra,
  });
  const bars = [
    bar('2026-10-24', 0, { beforeRecording: true }),
    bar('2026-10-25', 12.5),
    bar('2026-10-26', 40),
    bar('2026-10-27', 8, { partial: true }),
  ];

  test('day bars open their day and carry accessible names', () => {
    const html = render(
      createElement(HistoryChart, {
        bars,
        metric: 'value',
        bucket: 'day',
        tz: 'UTC',
        onOpenRange: () => {},
      })
    );
    expect(html).toContain('aria-label="Sun, Oct 25: $12.50, 1.3M tokens"');
    expect(html).toContain('aria-label="Tue, Oct 27 (so far): $8.00, 800K tokens"');
    expect(html).toContain('Sat, Oct 24: before recording began');
    // Three recorded days are buttons; the day before recording is not.
    expect(html.match(/<button type="button"/g)?.length).toBe(3);
    expect(html).toContain('Still filling');
    expect(html).toContain('Before recording began');
    expect(html).toContain('Show as table');
  });

  test('hourly bars are not buttons', () => {
    const html = render(
      createElement(HistoryChart, {
        bars,
        metric: 'tokens',
        bucket: 'hour',
        tz: 'UTC',
        onOpenRange: () => {},
      })
    );
    expect(html).not.toContain('<button type="button"');
    expect(html).toContain('Tokens per hour');
  });
});

describe('UsageTodayStrip', () => {
  const usage = {
    available: true,
    tokens: 48_200_000,
    valueUsd: 186.4,
    byCredential: new Map(),
    current: null,
  };

  test('renders nothing without the plugin', () => {
    expect(render(createElement(UsageTodayStrip, { usage: { ...usage, available: false } }))).toBe(
      ''
    );
  });

  test("states today's tokens and value and links to today's usage", () => {
    const html = render(createElement(UsageTodayStrip, { usage }));
    expect(html).toContain('Usage today');
    expect(html).toContain('48.2M');
    expect(html).toContain('$186');
    expect(html).toContain('None active');
    expect(html).toContain('href="/usage?range=today"');
  });
});

describe('usage formatting', () => {
  test('money keeps cents below $10 and never rounds a cost to zero', () => {
    expect(formatMoney(4308.55, 'en')).toBe('$4,308.55');
    expect(formatMoney(4308.55, 'en', { whole: true })).toBe('$4,309');
    expect(formatMoney(8.4, 'en', { whole: true })).toBe('$8.40');
    expect(formatMoney(0, 'en', { whole: true })).toBe('$0');
    expect(formatMoney(0.004, 'en')).toBe('<$0.01');
    expect(formatMoney(20, 'en', { currency: 'EUR' })).toBe('€20.00');
  });

  test('changes, multiples and spans', () => {
    expect(formatChange(0.18)).toBe('+18%');
    expect(formatChange(-0.04)).toBe('−4%');
    expect(formatChange(null)).toBeNull();
    expect(formatMultiple(5.42)).toBe('5.4×');
    expect(formatMultiple(12.6)).toBe('13×');
    expect(formatSpan(200 * 60_000)).toBe('3h 20m');
    expect(formatSpan(45 * 60_000)).toBe('45m');
  });

  test('axis maxima land on readable steps', () => {
    expect(niceAxisMax(225, 4)).toBe(240);
    expect(niceAxisMax(0.9, 4)).toBe(1);
    expect(niceAxisMax(0, 4)).toBe(4);
  });
});

describe('route and navigation', () => {
  test('the Usage route and nav item exist only with plugin support', () => {
    const routes = readFileSync('src/router/MainRoutes.tsx', 'utf8');
    const pluginBranch = routes.slice(routes.indexOf('...(supportsPlugin'), routes.indexOf(': ['));
    expect(pluginBranch).toContain("{ path: '/usage', element: <UsagePage /> }");
    const layout = readFileSync('src/components/layout/MainLayout.tsx', 'utf8');
    const observe = layout.slice(layout.indexOf("id: 'observe'"), layout.indexOf("path: '/quota'"));
    expect(observe).toContain('...(supportsPlugin');
    expect(observe).toContain("path: '/usage'");
  });
});
