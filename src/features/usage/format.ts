/**
 * Number and date formatting for the Usage page. Money is always USD (model
 * prices are USD per token); plan costs in other currencies use their own code.
 */

import { formatCompactNumber } from '@/utils/format';

const moneyFormatters = new Map<string, Intl.NumberFormat>();

function moneyFormatter(locale: string, currency: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${currency}|${digits}`;
  let formatter = moneyFormatters.get(key);
  if (!formatter) {
    try {
      formatter = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    } catch {
      formatter = new Intl.NumberFormat('en', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      });
    }
    moneyFormatters.set(key, formatter);
  }
  return formatter;
}

/**
 * `$4,308.55`; `whole` drops cents from $10 up for headlines and axes. Sub-cent amounts
 * show as `<$0.01` rather than a misleading `$0.00`.
 */
export function formatMoney(
  value: number,
  locale: string,
  options: { currency?: string; whole?: boolean } = {}
): string {
  const currency = options.currency ?? 'USD';
  if (!Number.isFinite(value)) return moneyFormatter(locale, currency, 2).format(0);
  if (value > 0 && value < 0.01) return `<${moneyFormatter(locale, currency, 2).format(0.01)}`;
  const digits = options.whole && (value === 0 || Math.abs(value) >= 10) ? 0 : 2;
  return moneyFormatter(locale, currency, digits).format(value);
}

/** `1.1B`, `742.6M`, `157K`. */
export const formatTokens = (value: number): string => formatCompactNumber(value);

/** `+18%`, `−4%`; null when there is nothing to compare. */
export function formatChange(change: number | null): string | null {
  if (change === null || !Number.isFinite(change)) return null;
  const percent = Math.round(change * 100);
  if (percent === 0) return '0%';
  return `${percent > 0 ? '+' : '−'}${Math.abs(percent)}%`;
}

/** `5.4×`, `12×`. */
export function formatMultiple(multiple: number): string {
  if (!Number.isFinite(multiple)) return '—';
  return `${multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}×`;
}

/** `3h 20m`, `45m`. */
export function formatSpan(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}m`;
  return `${hours}h ${String(rest).padStart(2, '0')}m`;
}

/** `28 Sep 2026` from a `YYYY-MM-DD` day, without shifting it through a zone. */
export function formatDay(day: string, locale: string, withYear = true): string {
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) return day;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, date)));
}

/** A bucket or block start in the ledger's zone. */
export function formatInstant(
  iso: string,
  locale: string,
  timeZone: string,
  style: 'hour' | 'day' | 'dayShort' | 'dayHour'
): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const options: Intl.DateTimeFormatOptions =
    style === 'hour'
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
      : style === 'day'
        ? { weekday: 'short', day: 'numeric', month: 'short' }
        : style === 'dayShort'
          ? { day: 'numeric', month: 'short' }
          : {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
            };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(new Date(ms));
  }
}

const AXIS_STEPS = [1, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The smallest readable step (1, 2, 2.5, 3, 4, 5, 6 or 8 times a power of ten) that fits the peak. */
export function niceAxisMax(peak: number, intervals: number): number {
  if (!(peak > 0)) return intervals;
  const raw = peak / intervals;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = (AXIS_STEPS.find((candidate) => candidate * power >= raw - 1e-9) ?? 10) * power;
  return step * intervals;
}
