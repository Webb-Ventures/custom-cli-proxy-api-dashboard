import { useTranslation } from 'react-i18next';
import type { CurrentBlock } from '../usageModel';
import { formatInstant, formatMoney, formatSpan, formatTokens } from '../format';
import styles from './UsagePanels.module.scss';

/**
 * The live 5-hour block, ccusage `blocks --live` style: tokens so far, burn rate
 * since the block started, and the projection to its end at that rate.
 */
export function CurrentBlockCard({ block, tz }: { block: CurrentBlock | null; tz: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  if (!block) {
    return (
      <section className={styles.panel} aria-labelledby="usage-block-title">
        <h2 id="usage-block-title" className={styles.panelTitle}>
          {t('usage.block_title_idle')}
        </h2>
        <p className={styles.note}>{t('usage.block_idle')}</p>
      </section>
    );
  }

  const soFarShare = block.projectedTokens > 0 ? block.tokens / block.projectedTokens : 0;
  const start = formatInstant(new Date(block.startMs).toISOString(), locale, tz, 'hour');
  const end = formatInstant(new Date(block.endMs).toISOString(), locale, tz, 'hour');

  return (
    <section
      className={`${styles.panel} ${styles.panelRaised}`}
      aria-labelledby="usage-block-title"
    >
      <div className={styles.panelHead}>
        <h2 id="usage-block-title" className={styles.panelTitle}>
          {t('usage.block_title', { start, end })}
        </h2>
        <span className={styles.panelAside}>
          {t('usage.block_left', { span: formatSpan(block.remainingMinutes * 60_000) })}
        </span>
      </div>

      <div
        className={styles.projection}
        role="img"
        aria-label={t('usage.block_projection_label', {
          tokens: formatTokens(block.tokens),
          projected: formatTokens(block.projectedTokens),
          end,
        })}
      >
        <div className={styles.projectionTrack}>
          <span className={styles.projectionSoFar} style={{ width: `${soFarShare * 100}%` }} />
          <span className={styles.projectionRest} style={{ width: `${(1 - soFarShare) * 100}%` }} />
        </div>
        <div className={styles.projectionLegend} aria-hidden="true">
          <span>{t('usage.block_so_far_short', { tokens: formatTokens(block.tokens) })}</span>
          <span>
            {t('usage.block_projected_short', { tokens: formatTokens(block.projectedTokens), end })}
          </span>
        </div>
      </div>

      <dl className={styles.stats}>
        <div>
          <dt>{t('usage.block_so_far')}</dt>
          <dd>{formatTokens(block.tokens)}</dd>
        </div>
        <div>
          <dt>{t('usage.block_burn')}</dt>
          <dd>
            {formatTokens(block.burnPerMinute)}
            <small>{t('usage.per_minute')}</small>
          </dd>
        </div>
        <div>
          <dt>{t('usage.block_value')}</dt>
          <dd>
            {formatMoney(block.valueUsd, locale)}
            <small> → {formatMoney(block.projectedValueUsd, locale)}</small>
          </dd>
        </div>
      </dl>
    </section>
  );
}
