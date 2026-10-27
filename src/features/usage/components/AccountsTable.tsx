import { useTranslation } from 'react-i18next';
import { providerLabel } from '@/features/dashboard/utils';
import type { AccountRow } from '../usageModel';
import { formatMoney, formatMultiple, formatTokens } from '../format';
import { rowLabel } from '../labels';
import styles from './UsagePanels.module.scss';

export interface AccountsTableProps {
  accounts: readonly AccountRow[];
  /** Show the provider column (the Accounts view); a provider panel leaves it out. */
  showProvider: boolean;
  label: string;
  onSelectCredential: (authIndex: string) => void;
}

export function AccountsTable({
  accounts,
  showProvider,
  label,
  onSelectCredential,
}: AccountsTableProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  return (
    <div className={styles.scroll}>
      <table className={styles.table} aria-label={label}>
        <thead>
          <tr>
            <th scope="col">{t('usage.group_credential')}</th>
            {showProvider && <th scope="col">{t('usage.group_provider')}</th>}
            <th scope="col">{t('usage.plan_monthly')}</th>
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
              {t('usage.multiple')}
            </th>
          </tr>
        </thead>
        <tbody>
          {accounts.map(({ row, multiple }) => {
            const name = rowLabel(row, t);
            const plan = row.credential?.plan;
            return (
              <tr key={row.key}>
                <th scope="row">
                  {row.id ? (
                    <button
                      type="button"
                      className={styles.rowLink}
                      onClick={() => onSelectCredential(row.id)}
                      aria-label={t('usage.filter_to', { name })}
                    >
                      {name}
                    </button>
                  ) : (
                    <span className={styles.rowName}>{name}</span>
                  )}
                </th>
                {showProvider && (
                  <td>{providerLabel(row.credential?.type ?? '', t('usage.unattributed'))}</td>
                )}
                <td>
                  {plan ? (
                    <>
                      {t('usage.plan_price', {
                        name: plan.name,
                        price: formatMoney(plan.monthlyPrice, locale, {
                          currency: plan.currency,
                          whole: true,
                        }),
                      })}
                      {!plan.verified && (
                        <span className={styles.rowMeta} title={t('usage.plan_unverified_hint')}>
                          {t('usage.plan_unverified')}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className={styles.muted}>{t('usage.plan_unknown')}</span>
                  )}
                </td>
                <td className={styles.num}>{row.requests.toLocaleString(locale)}</td>
                <td className={styles.num}>{formatTokens(row.tokens.total)}</td>
                <td className={styles.num}>{formatMoney(row.value.usd, locale)}</td>
                <td className={styles.num}>{multiple === null ? '—' : formatMultiple(multiple)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
