import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@/components/ui/Collapsible';
import type { UsageBucket } from '@/services/api/usageLedger';
import { dayInZone } from '../range';
import type { UsageMetric } from '../range';
import type { UsageBar } from '../usageModel';
import { formatInstant, formatMoney, formatTokens, niceAxisMax } from '../format';
import styles from './HistoryChart.module.scss';

const TICK_COUNT = 4;
const X_LABELS = 5;

export interface HistoryChartProps {
  bars: readonly UsageBar[];
  metric: UsageMetric;
  bucket: UsageBucket;
  tz: string;
  /** Opens a day or week bucket as its own range. */
  onOpenRange?: (from: string, to: string) => void;
}

export function HistoryChart({ bars, metric, bucket, tz, onOpenRange }: HistoryChartProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const valueOf = (bar: UsageBar) => (metric === 'value' ? bar.valueUsd : bar.tokens);
  const format = (value: number) =>
    metric === 'value' ? formatMoney(value, locale, { whole: true }) : formatTokens(value);

  const peak = bars.reduce((max, bar) => Math.max(max, valueOf(bar)), 0);
  const scaleMax = niceAxisMax(peak, TICK_COUNT);
  const ticks = Array.from({ length: TICK_COUNT + 1 }, (_, index) => {
    const ratio = 1 - index / TICK_COUNT;
    return { ratio, value: scaleMax * ratio };
  });

  const label = (bar: UsageBar, withPartial = false) => {
    const text =
      bucket === 'hour'
        ? formatInstant(bar.start, locale, tz, 'hour')
        : bucket === 'week'
          ? t('usage.chart_week_of', { day: formatInstant(bar.start, locale, tz, 'day') })
          : formatInstant(bar.start, locale, tz, 'day');
    return withPartial && bar.partial ? t('usage.chart_so_far', { label: text }) : text;
  };

  // Evenly strided back from the newest bar, so labels never crowd each other.
  const xTicks = useMemo(() => {
    const stride = Math.max(1, Math.ceil(bars.length / X_LABELS));
    const positions: number[] = [];
    for (let index = bars.length - 1; index >= 0; index -= stride) positions.unshift(index);
    return positions;
  }, [bars.length]);

  const openable = bucket !== 'hour' && Boolean(onOpenRange);
  const openBar = (bar: UsageBar) => {
    if (!onOpenRange) return;
    const from = dayInZone(Date.parse(bar.start), tz);
    const to = dayInZone(Date.parse(bar.end) - 1, tz);
    onOpenRange(from, to);
  };

  const recorded = bars.filter((bar) => !bar.beforeRecording);
  const total = recorded.reduce((sum, bar) => sum + valueOf(bar), 0);
  const summary = t(
    metric === 'value' ? 'usage.chart_summary_value' : 'usage.chart_summary_tokens',
    {
      total: format(total),
      peak: format(peak),
    }
  );
  const title = t(
    metric === 'value' ? `usage.chart_title_value_${bucket}` : `usage.chart_title_tokens_${bucket}`
  );

  const active = activeIndex === null ? null : bars[activeIndex];

  return (
    <figure className={styles.chart}>
      <figcaption className={styles.caption}>
        <span className={styles.title}>{title}</span>
        {openable && <span className={styles.hint}>{t('usage.chart_open_hint')}</span>}
      </figcaption>

      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick.ratio}
              className={styles.yTick}
              style={{ top: `${(1 - tick.ratio) * 100}%` }}
            >
              {format(tick.value)}
            </span>
          ))}
        </div>

        <div className={styles.canvas}>
          <div className={styles.gridlines} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.ratio}
                className={styles.gridline}
                style={{ top: `${(1 - tick.ratio) * 100}%` }}
              />
            ))}
          </div>

          <div
            className={styles.columns}
            role="group"
            aria-label={summary}
            onMouseLeave={() => setActiveIndex(null)}
          >
            {bars.map((bar, index) => {
              const value = valueOf(bar);
              const height = Math.min(100, (value / scaleMax) * 100);
              const barClass = [
                styles.bar,
                bar.partial ? styles.barPartial : '',
                bar.beforeRecording ? styles.barBefore : '',
              ].join(' ');
              const content = bar.beforeRecording ? (
                <span className={styles.beforeTick} />
              ) : value > 0 ? (
                <span className={barClass} style={{ height: `${height}%` }} />
              ) : (
                <span className={styles.idleTick} />
              );
              const delay = bars.length > 1 ? Math.round((index / (bars.length - 1)) * 360) : 0;
              const columnProps = {
                className: `${styles.column} ${activeIndex === index ? styles.columnActive : ''}`,
                style: { '--bar-delay': `${delay}ms` } as CSSProperties,
                onMouseEnter: () => setActiveIndex(index),
              };
              const accessible = bar.beforeRecording
                ? t('usage.chart_bar_before', { label: label(bar) })
                : t('usage.chart_bar', {
                    label: label(bar, true),
                    value: formatMoney(bar.valueUsd, locale),
                    tokens: formatTokens(bar.tokens),
                  });
              return openable && !bar.beforeRecording ? (
                <button
                  key={bar.start}
                  type="button"
                  {...columnProps}
                  aria-label={accessible}
                  onFocus={() => setActiveIndex(index)}
                  onBlur={() => setActiveIndex(null)}
                  onClick={() => openBar(bar)}
                >
                  {content}
                </button>
              ) : (
                <div key={bar.start} {...columnProps} role="img" aria-label={accessible}>
                  {content}
                </div>
              );
            })}
          </div>

          {recorded.length > 0 && total === 0 && (
            <p className={styles.empty}>{t('usage.chart_no_usage')}</p>
          )}

          {active && (
            <div
              className={styles.tooltip}
              style={{
                left: `${((activeIndex! + 0.5) / bars.length) * 100}%`,
                transform:
                  activeIndex! < bars.length * 0.15
                    ? 'translateX(-12%)'
                    : activeIndex! > bars.length * 0.85
                      ? 'translateX(-88%)'
                      : 'translateX(-50%)',
              }}
              aria-hidden="true"
            >
              <span className={styles.tooltipTime}>{label(active, true)}</span>
              {active.beforeRecording ? (
                <span className={styles.tooltipMuted}>{t('usage.chart_before_recording')}</span>
              ) : (
                <>
                  <span className={styles.tooltipRow}>
                    {t('usage.metric_value')}
                    <b>{formatMoney(active.valueUsd, locale)}</b>
                  </span>
                  <span className={styles.tooltipRow}>
                    {t('usage.metric_tokens')}
                    <b>{formatTokens(active.tokens)}</b>
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {xTicks.map((index) => (
          <span
            key={index}
            className={styles.xTick}
            style={{ left: `${((index + 0.5) / bars.length) * 100}%` }}
          >
            {bars[index].partial && bucket !== 'hour'
              ? t('usage.chart_today')
              : bucket === 'hour'
                ? label(bars[index])
                : formatInstant(bars[index].start, locale, tz, 'dayShort')}
          </span>
        ))}
      </div>

      <div className={styles.legend}>
        {bars.some((bar) => bar.partial) && (
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.swatchPartial}`} aria-hidden="true" />
            {t('usage.chart_legend_partial')}
          </span>
        )}
        {bars.some((bar) => bar.beforeRecording) && (
          <span className={styles.legendItem}>
            <span className={`${styles.swatch} ${styles.swatchBefore}`} aria-hidden="true" />
            {t('usage.chart_legend_before')}
          </span>
        )}
      </div>

      <Collapsible className={styles.tableToggle} label={t('usage.chart_table')}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('usage.chart_table_period')}</th>
              <th scope="col">{t('usage.metric_tokens')}</th>
              <th scope="col">{t('usage.metric_value')}</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((bar) => (
              <tr key={bar.start}>
                <th scope="row">{label(bar, true)}</th>
                <td>{bar.beforeRecording ? '—' : formatTokens(bar.tokens)}</td>
                <td>{bar.beforeRecording ? '—' : formatMoney(bar.valueUsd, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Collapsible>
    </figure>
  );
}
