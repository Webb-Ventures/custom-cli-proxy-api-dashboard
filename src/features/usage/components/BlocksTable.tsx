import { useTranslation } from 'react-i18next';
import type { BlockRow } from '../usageModel';
import { formatInstant, formatMoney, formatSpan, formatTokens } from '../format';
import styles from './UsagePanels.module.scss';

const VISIBLE_BLOCKS = 12;

/** Recent 5-hour blocks, newest first. Blocks need minute data, so they cover its retention only. */
export function BlocksTable({
  rows,
  tz,
  retentionDays,
  clamped,
}: {
  rows: readonly BlockRow[];
  tz: string;
  retentionDays: number | null;
  clamped: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const visible = rows.slice(0, VISIBLE_BLOCKS);

  return (
    <section className={styles.panel} aria-labelledby="usage-blocks-title">
      <div className={styles.panelHead}>
        <h2 id="usage-blocks-title" className={styles.panelTitle}>
          {t('usage.blocks_title')}
        </h2>
        {clamped && retentionDays !== null && (
          <span className={styles.panelAside}>
            {t('usage.blocks_clamped', { count: retentionDays })}
          </span>
        )}
      </div>
      {visible.length === 0 ? (
        <p className={styles.note}>{t('usage.blocks_empty')}</p>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('usage.blocks_start')}</th>
                <th scope="col" className={styles.num}>
                  {t('usage.blocks_active')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.metric_tokens')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.metric_value')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.blocks_peak')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.blocks_credentials')}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.start}>
                  <th scope="row">
                    {formatInstant(row.start, locale, tz, 'dayHour')}
                    {row.active && <span className={styles.liveTag}>{t('usage.blocks_live')}</span>}
                  </th>
                  <td className={styles.num}>{formatSpan(row.activeMs)}</td>
                  <td className={styles.num}>{formatTokens(row.tokens)}</td>
                  <td className={styles.num}>{formatMoney(row.valueUsd, locale)}</td>
                  <td className={styles.num}>
                    {formatTokens(row.peakTokensPerMinute)}
                    {t('usage.per_minute')}
                  </td>
                  <td className={styles.num}>{row.credentials}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > VISIBLE_BLOCKS && (
        <p className={styles.note}>
          {t('usage.blocks_more', { count: rows.length - VISIBLE_BLOCKS })}
        </p>
      )}
    </section>
  );
}
