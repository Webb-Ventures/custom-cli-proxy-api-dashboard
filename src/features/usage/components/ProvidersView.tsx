import { useTranslation } from 'react-i18next';
import { providerLabel } from '@/features/dashboard/utils';
import { poolCapacity, type AccountCapacity } from '../capacity';
import type { ProviderPool, UsageCredential } from '../usageModel';
import { formatMoney, formatMultiple, formatTokens } from '../format';
import { AccountsTable } from './AccountsTable';
import styles from './UsagePanels.module.scss';

export interface ProvidersViewProps {
  pools: readonly ProviderPool[];
  capacity: ReadonlyMap<string, AccountCapacity>;
  onEditPlan?: (credential: UsageCredential) => void;
  onSelectCredential: (authIndex: string) => void;
}

/** One panel per provider: its accounts pooled, with plan cost against API value. */
export function ProvidersView({
  pools,
  capacity,
  onEditPlan,
  onSelectCredential,
}: ProvidersViewProps) {
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
            <PoolCapacityBar
              provider={name}
              estimates={pool.accounts.map((account) => capacity.get(account.row.id))}
              names={pool.accounts.map((account) => account.row.credential?.name ?? account.row.id)}
            />
            <AccountsTable
              capacity={capacity}
              onEditPlan={onEditPlan}
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

const toneOf = (usedPercent: number) =>
  usedPercent >= 90
    ? 'var(--viz-failure)'
    : usedPercent >= 70
      ? 'var(--quota-medium-color)'
      : 'var(--viz-success)';

/** The pool as one bar: each account a segment sized by its estimated capacity. */
function PoolCapacityBar({
  provider,
  estimates,
  names,
}: {
  provider: string;
  estimates: (AccountCapacity | undefined)[];
  names: string[];
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const known = estimates.filter((entry): entry is AccountCapacity => Boolean(entry));
  const pool = poolCapacity(known);
  if (!pool) return null;
  const unestimated = estimates.length - pool.estimated.length;
  const window = pool.estimated[0].window;
  const windowName = window.labelKey
    ? t(window.labelKey, window.labelParams ?? {})
    : window.label || window.id;
  const nameOf = (estimate: AccountCapacity) =>
    names[estimates.indexOf(estimate)] ?? estimate.authIndex;
  const description = pool.estimated
    .map((estimate) =>
      t('usage.pool_segment', {
        name: nameOf(estimate),
        percent: Math.round(estimate.usedPercent),
        capacity: formatTokens(estimate.capacityTokens ?? 0),
      })
    )
    .join('; ');

  return (
    <div className={styles.pool}>
      <div className={styles.poolCap}>
        <span>{t('usage.pool_title', { window: windowName })}</span>
        <span className={styles.poolCapValue}>
          {t('usage.pool_left', {
            percent: Math.round(pool.usedPercent),
            tokens: formatTokens(pool.tokensLeft),
            value: formatMoney(pool.valueLeftUsd, locale, { whole: true }),
          })}
        </span>
      </div>
      <div
        className={styles.poolBar}
        role="img"
        aria-label={t('usage.pool_label', { provider, accounts: description })}
      >
        {pool.estimated.map((estimate) => (
          <span
            key={estimate.authIndex}
            className={styles.poolSegment}
            style={{ flexGrow: estimate.capacityTokens ?? 0 }}
            title={t('usage.pool_segment', {
              name: nameOf(estimate),
              percent: Math.round(estimate.usedPercent),
              capacity: formatTokens(estimate.capacityTokens ?? 0),
            })}
          >
            <span
              style={{
                width: `${estimate.usedPercent}%`,
                background: toneOf(estimate.usedPercent),
              }}
            />
          </span>
        ))}
      </div>
      <p className={styles.note}>
        {unestimated > 0 && `${t('usage.pool_unestimated', { count: unestimated })} `}
        {t('usage.capacity_note')}
      </p>
    </div>
  );
}
