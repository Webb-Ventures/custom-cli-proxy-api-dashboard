/**
 * Words for the Usage page: the headline verdict, range phrases and row names.
 */

import { providerLabel } from '@/features/dashboard/utils';
import { formatChange, formatDay, formatMoney, formatMultiple, formatTokens } from './format';
import type { ResolvedUsageRange, UsageRangeKind } from './range';
import type { UsageOverview, UsageRow } from './usageModel';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** "in 30 days", "today", "from 1 Oct to 14 Oct". */
export function rangePhrase(
  range: ResolvedUsageRange,
  kind: UsageRangeKind,
  locale: string,
  t: Translate
) {
  if (kind === 'today') return t('usage.phrase_today');
  if (kind !== 'custom') return t('usage.phrase_days', { count: range.days });
  if (range.from === range.to) return t('usage.phrase_day', { day: formatDay(range.from, locale) });
  return t('usage.phrase_between', {
    from: formatDay(range.from, locale, range.from.slice(0, 4) !== range.to.slice(0, 4)),
    to: formatDay(range.to, locale),
  });
}

/** Headline and the line under it, from the overview's totals. */
export function usageVerdict(
  overview: UsageOverview,
  range: ResolvedUsageRange,
  kind: UsageRangeKind,
  locale: string,
  t: Translate
): { headline: string; meta: string[] } {
  const phrase = rangePhrase(range, kind, locale, t);
  const { tokens, value } = overview.totals;
  if (tokens.total === 0) {
    return { headline: t('usage.verdict_none', { range: phrase }), meta: [] };
  }
  const headline =
    value.usd > 0
      ? t('usage.verdict', {
          tokens: formatTokens(tokens.total),
          range: phrase,
          value: formatMoney(value.usd, locale, { whole: true }),
        })
      : t('usage.verdict_unpriced', { tokens: formatTokens(tokens.total), range: phrase });

  const meta: string[] = [];
  const { subscription } = overview;
  const costs = Object.entries(subscription.costByCurrency);
  if (costs.length > 0) {
    const cost = costs
      .map(([currency, amount]) => formatMoney(amount, locale, { currency, whole: true }))
      .join(' + ');
    meta.push(
      subscription.multiple !== null
        ? t('usage.meta_subscription_multiple', {
            cost,
            multiple: formatMultiple(subscription.multiple),
          })
        : t('usage.meta_subscription', { cost })
    );
  } else if (subscription.withoutPlan > 0) {
    meta.push(t('usage.meta_no_plans'));
  }
  const change = overview.change.value ?? overview.change.tokens;
  const formatted = formatChange(change === null ? null : Math.abs(change));
  if (change !== null && formatted) {
    const key =
      Math.round(change * 100) === 0
        ? 'usage.meta_flat'
        : change > 0
          ? 'usage.meta_up'
          : 'usage.meta_down';
    meta.push(t(key, { percent: formatted.replace(/^[+−]/, ''), count: range.days }));
  }
  return { headline, meta };
}

export function rowLabel(row: UsageRow, t: Translate): string {
  if (row.kind === 'credential') return row.credential?.name || row.id || t('usage.unattributed');
  if (row.kind === 'provider') return providerLabel(row.id, t('usage.unattributed'));
  if (row.kind === 'client_key') return row.id || t('usage.no_client_key');
  return row.id || t('usage.unknown_model');
}
