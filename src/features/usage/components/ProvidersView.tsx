import { useTranslation } from 'react-i18next';
import { providerLabel } from '@/features/dashboard/utils';
import type { ProviderPool } from '../usageModel';
import { formatMoney, formatMultiple, formatTokens } from '../format';
import { AccountsTable } from './AccountsTable';
import styles from './UsagePanels.module.scss';

export interface ProvidersViewProps {
  pools: readonly ProviderPool[];
  onSelectCredential: (authIndex: string) => void;
}

/** One panel per provider: its accounts pooled, with plan cost against API value. */
export function ProvidersView({ pools, onSelectCredential }: ProvidersViewProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;

  if (pools.length === 0) {
    return (
      <section className={styles.panel}>
        <p className={styles.note}>{t('usage.accounts_empty')}</p>
      </section>
    );
  }

  return (
    <>
      {pools.map((pool) => {
        const name = providerLabel(pool.provider, t('usage.unattributed'));
        const costs = Object.entries(pool.costByCurrency);
        const plans = pool.plans
          .map((plan) => t('usage.provider_plan_count', { count: plan.count, name: plan.name }))
          .join(', ');
        return (
          <section
            key={pool.provider || 'unattributed'}
            className={styles.panel}
            aria-labelledby={`usage-provider-${pool.provider || 'unattributed'}`}
          >
            <div className={styles.poolHead}>
              <div>
                <h2
                  id={`usage-provider-${pool.provider || 'unattributed'}`}
                  className={styles.poolName}
                >
                  {name}
                </h2>
                <p className={styles.poolMeta}>
                  {t('usage.provider_accounts', { count: pool.accounts.length })}
                  {plans && `: ${plans}`}
                </p>
              </div>
              <dl className={styles.poolStats}>
                <div>
                  <dt>{t('usage.metric_tokens')}</dt>
                  <dd>{formatTokens(pool.tokens)}</dd>
                </div>
                <div>
                  <dt>{t('usage.metric_value')}</dt>
                  <dd>{formatMoney(pool.valueUsd, locale)}</dd>
                </div>
                <div>
                  <dt>{t('usage.plans_cost')}</dt>
                  <dd>
                    {costs.length === 0
                      ? '—'
                      : costs
                          .map(([currency, cost]) => formatMoney(cost, locale, { currency }))
                          .join(' + ')}
                  </dd>
                </div>
                <div>
                  <dt>{t('usage.multiple')}</dt>
                  <dd>{pool.multiple === null ? '—' : formatMultiple(pool.multiple)}</dd>
                </div>
              </dl>
            </div>
            <AccountsTable
              accounts={pool.accounts}
              showProvider={false}
              label={t('usage.provider_accounts_label', { provider: name })}
              onSelectCredential={onSelectCredential}
            />
          </section>
        );
      })}
    </>
  );
}
