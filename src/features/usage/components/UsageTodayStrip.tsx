import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { UsageToday } from '../hooks/useUsageToday';
import { formatInstant, formatMoney, formatTokens } from '../format';
import { browserTimeZone } from '../range';
import styles from './UsageTodayStrip.module.scss';

/** One line of today's ledger totals on the dashboard, linking to the Usage page. */
export function UsageTodayStrip({ usage }: { usage: UsageToday }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  if (!usage.available) return null;
  const { current } = usage;
  const end = current
    ? formatInstant(new Date(current.endMs).toISOString(), locale, browserTimeZone(), 'hour')
    : '';

  return (
    <section className={styles.strip} aria-labelledby="usage-today-title">
      <h2 id="usage-today-title" className={styles.title}>
        {t('usage.today_title')}
      </h2>
      <dl className={styles.figures}>
        <div>
          <dt>{t('usage.metric_tokens')}</dt>
          <dd>{formatTokens(usage.tokens)}</dd>
        </div>
        <div>
          <dt>{t('usage.today_value')}</dt>
          <dd>{formatMoney(usage.valueUsd, locale, { whole: true })}</dd>
        </div>
        <div>
          <dt>{t('usage.block_title_idle')}</dt>
          <dd>
            {current
              ? t('usage.today_block', {
                  tokens: formatTokens(current.tokens),
                  projected: formatTokens(current.projectedTokens),
                  end,
                })
              : t('usage.today_block_idle')}
          </dd>
        </div>
      </dl>
      <Link className={styles.link} to="/usage?range=today">
        {t('usage.today_open')}
      </Link>
    </section>
  );
}
