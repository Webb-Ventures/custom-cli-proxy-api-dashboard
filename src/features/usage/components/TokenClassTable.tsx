import { useTranslation } from 'react-i18next';
import type { TokenClassShare } from '../usageModel';
import { formatMoney, formatTokens } from '../format';
import styles from './UsagePanels.module.scss';

/** Which token types the value came from: cache reads are cheap per token but often dominate. */
export function TokenClassTable({
  shares,
  days,
  footnote,
}: {
  shares: readonly TokenClassShare[];
  days: number;
  footnote?: string;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  return (
    <section className={styles.panel} aria-labelledby="usage-classes-title">
      <h2 id="usage-classes-title" className={styles.panelTitle}>
        {t('usage.classes_title', { count: days })}
      </h2>
      {shares.length === 0 ? (
        <p className={styles.note}>{t('usage.classes_empty')}</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('usage.classes_type')}</th>
              <th scope="col" className={styles.num}>
                {t('usage.metric_tokens')}
              </th>
              <th scope="col" className={styles.num}>
                {t('usage.metric_value')}
              </th>
              <th scope="col" className={styles.shareCol}>
                {t('usage.classes_share')}
              </th>
            </tr>
          </thead>
          <tbody>
            {shares.map((share) => (
              <tr key={share.tokenClass}>
                <th scope="row">{t(`usage.class_${share.tokenClass}`)}</th>
                <td className={styles.num}>{formatTokens(share.tokens)}</td>
                <td className={styles.num}>{formatMoney(share.usd, locale)}</td>
                <td>
                  <span
                    className={styles.shareMeter}
                    role="img"
                    aria-label={t('usage.classes_share_label', {
                      percent: Math.round(share.share * 100),
                    })}
                  >
                    <span
                      style={{ width: `${Math.max(share.share * 100, share.usd > 0 ? 2 : 0)}%` }}
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {footnote && <p className={styles.note}>{footnote}</p>}
    </section>
  );
}
