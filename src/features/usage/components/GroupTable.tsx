import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UsageRow } from '../usageModel';
import { formatChange, formatMoney, formatTokens } from '../format';
import { rowLabel } from '../labels';
import styles from './UsagePanels.module.scss';

const COLLAPSED_ROWS = 12;

export interface GroupTableProps {
  rows: readonly UsageRow[];
  totals: { requests: number; tokens: number; valueUsd: number; change: number | null };
  days: number;
  /** Rows are one credential's models. */
  filtered: boolean;
  onSelectCredential?: (authIndex: string) => void;
}

export function GroupTable({ rows, totals, days, filtered, onSelectCredential }: GroupTableProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const [expanded, setExpanded] = useState(false);
  const kind = filtered ? 'model' : (rows[0]?.kind ?? 'model');
  const visible = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
  const tierOf = (row: UsageRow) => (filtered ? row.key.split('|')[1] : '');

  return (
    <section className={styles.panel} aria-labelledby="usage-groups-title">
      <h2 id="usage-groups-title" className={styles.srOnly}>
        {t(`usage.groups_title_${kind}`)}
      </h2>
      {rows.length === 0 ? (
        <p className={styles.note}>{t('usage.groups_empty')}</p>
      ) : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t(`usage.group_${kind}`)}</th>
                <th scope="col" className={styles.num}>
                  {t('usage.requests')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.metric_tokens')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.metric_value')}
                </th>
                <th scope="col" className={styles.num}>
                  {t('usage.vs_previous', { count: days })}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const label = rowLabel(row, t);
                const tier = tierOf(row);
                const change = formatChange(row.change);
                return (
                  <tr key={row.key}>
                    <th scope="row">
                      {row.kind === 'credential' && row.id && onSelectCredential ? (
                        <button
                          type="button"
                          className={styles.rowLink}
                          onClick={() => onSelectCredential(row.id)}
                          aria-label={t('usage.filter_to', { name: label })}
                        >
                          {label}
                        </button>
                      ) : (
                        <span className={styles.rowName}>{label}</span>
                      )}
                      {row.kind === 'credential' && row.credential?.plan && (
                        <span className={styles.rowMeta}>{row.credential.plan.name}</span>
                      )}
                      {tier && tier !== 'default' && <span className={styles.rowMeta}>{tier}</span>}
                    </th>
                    <td className={styles.num}>{row.requests.toLocaleString(locale)}</td>
                    <td className={styles.num}>{formatTokens(row.tokens.total)}</td>
                    <td className={styles.num}>
                      {row.value.unpricedTokens > 0 && row.value.usd === 0
                        ? t('usage.unpriced')
                        : formatMoney(row.value.usd, locale)}
                    </td>
                    <td className={`${styles.num} ${styles.change}`}>{change ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{t('usage.range_days', { count: days })}</th>
                <td className={styles.num}>{totals.requests.toLocaleString(locale)}</td>
                <td className={styles.num}>{formatTokens(totals.tokens)}</td>
                <td className={styles.num}>{formatMoney(totals.valueUsd, locale)}</td>
                <td className={`${styles.num} ${styles.change}`}>
                  {formatChange(totals.change) ?? '—'}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      {rows.length > COLLAPSED_ROWS && (
        <button type="button" className={styles.moreButton} onClick={() => setExpanded((v) => !v)}>
          {expanded
            ? t('usage.groups_show_less')
            : t('usage.groups_show_all', { count: rows.length })}
        </button>
      )}
    </section>
  );
}
