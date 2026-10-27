import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaMeter } from '@/features/quota/components/QuotaMeter';
import { quotaMeterModel } from '@/features/quota/quotaMeterModel';
import { windowMeterUsage, windowProjectedUsedPercent } from '@/features/quota/headroom';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';

const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);

const HOUR = 3_600_000;
const now = Date.parse('2026-10-27T12:00:00Z');

// Other suites assume the default language, so put it back afterwards.
const previousLanguage = i18n.language;

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

describe('quotaMeterModel', () => {
  test('on pace stays green; ahead of pace or past 70% turns amber', () => {
    expect(quotaMeterModel({ usedPercent: 40, elapsedPercent: 42 }).tone).toBe('high');
    expect(quotaMeterModel({ usedPercent: 50, elapsedPercent: 30 }).tone).toBe('medium');
    expect(quotaMeterModel({ usedPercent: 82, elapsedPercent: 90 }).tone).toBe('medium');
  });

  test('spent or projected to run out before reset turns red', () => {
    expect(quotaMeterModel({ usedPercent: 100, elapsedPercent: 20 }).tone).toBe('low');
    const runsOut = quotaMeterModel({ usedPercent: 60, elapsedPercent: 40, projectedPercent: 150 });
    expect(runsOut.tone).toBe('low');
    expect(runsOut.runsOut).toBe(true);
  });

  test('without timing it falls back to the remaining-percent bands', () => {
    expect(quotaMeterModel({ usedPercent: 20 }).tone).toBe('high');
    expect(quotaMeterModel({ usedPercent: 50 }).tone).toBe('medium');
    expect(quotaMeterModel({ usedPercent: 75 }).tone).toBe('low');
  });

  test('the hatch runs from used to projected, capped at the end of the track', () => {
    expect(
      quotaMeterModel({ usedPercent: 40, elapsedPercent: 50, projectedPercent: 80 }).projection
    ).toEqual({ leftPercent: 40, widthPercent: 40 });
    expect(
      quotaMeterModel({ usedPercent: 60, elapsedPercent: 40, projectedPercent: 150 }).projection
    ).toEqual({ leftPercent: 60, widthPercent: 40 });
    expect(quotaMeterModel({ usedPercent: 40, projectedPercent: 30 }).projection).toBeNull();
  });

  test('clamps out-of-range input', () => {
    const model = quotaMeterModel({ usedPercent: 140, elapsedPercent: -10 });
    expect(model.fillPercent).toBe(100);
    expect(model.pacePercent).toBe(0);
  });
});

describe('windowMeterUsage', () => {
  const window = {
    id: 'five-hour',
    usedPercent: 60,
    periodHours: 5,
    resetAtMs: now + 3 * HOUR,
  };

  test('derives elapsed and projected use from the window timing', () => {
    expect(windowMeterUsage(window, now)).toEqual({
      usedPercent: 60,
      elapsedPercent: 40,
      projectedPercent: 150,
    });
  });

  test('no projection early in the window or once spent', () => {
    expect(windowProjectedUsedPercent({ ...window, resetAtMs: now + 4.5 * HOUR }, now)).toBeNull();
    expect(windowMeterUsage({ ...window, usedPercent: 100 }, now).projectedPercent).toBeNull();
  });
});

describe('QuotaMeter markup', () => {
  const render = (props: Parameters<typeof QuotaMeter>[0]) =>
    renderToStaticMarkup(createElement(QuotaMeter, props));

  test('legacy remaining mode is unchanged and carries no meter role', () => {
    const html = render({ percent: 25, classes });
    expect(html).toBe(
      '<div class="quotaBar"><div class="quotaBarFill quotaBarFillLow" style="width:25%"></div></div>'
    );
  });

  test('usage mode labels used and elapsed, and draws pace and hatch', () => {
    const html = render({
      usage: { usedPercent: 82, elapsedPercent: 77, projectedPercent: 96 },
      classes,
    });
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="82"');
    expect(html).toContain('aria-label="82% used, 77% of window elapsed"');
    expect(html).toContain('class="quotaBarPace" style="left:77%"');
    expect(html).toContain('class="quotaBarProjection" style="left:82%;width:14%"');
    expect(html).toContain('quotaBarFill quotaBarFillMedium');
  });

  test('says when the window is on pace to run out', () => {
    const html = render({
      usage: { usedPercent: 60, elapsedPercent: 40, projectedPercent: 150 },
      classes,
    });
    expect(html).toContain(
      'aria-label="60% used, 40% of window elapsed, on pace to run out before reset"'
    );
  });

  test('without timing there is no pace marker and a plain label', () => {
    const html = render({ usage: { usedPercent: 30 }, classes });
    expect(html).toContain('aria-label="30% used"');
    expect(html).not.toContain('quotaBarPace');
    expect(html).not.toContain('quotaBarProjection');
  });
});
