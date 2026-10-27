import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { LedgerAvailability } from '../hooks/useUsageLedger';
import styles from './UsagePanels.module.scss';

export interface UsageUnavailableProps {
  availability: Exclude<LedgerAvailability, 'available'>;
  error?: string | null;
  onRetry?: () => void;
}

/** Why the page has no ledger to read, and what to do about it. */
export function UsageUnavailable({ availability, error, onRetry }: UsageUnavailableProps) {
  const { t } = useTranslation();

  if (availability === 'checking') {
    return (
      <section className={styles.unavailable} aria-busy="true">
        <p className={styles.unavailableBody}>{t('usage.checking')}</p>
      </section>
    );
  }

  const title = t(`usage.unavailable_${availability}_title`);
  const body =
    availability === 'error'
      ? t('usage.unavailable_error_body', { error: error || t('usage.unknown_error') })
      : t(`usage.unavailable_${availability}_body`);

  return (
    <section className={styles.unavailable} aria-labelledby="usage-unavailable-title">
      <h2 id="usage-unavailable-title" className={styles.unavailableTitle}>
        {title}
      </h2>
      <p className={styles.unavailableBody}>{body}</p>
      <div className={styles.unavailableActions}>
        {availability === 'absent' && (
          <>
            <Link className={styles.primaryAction} to="/plugin-store">
              {t('usage.open_plugin_store')}
            </Link>
            <Link className={styles.ghostAction} to="/plugins">
              {t('usage.open_plugins')}
            </Link>
          </>
        )}
        {availability === 'error' && onRetry && (
          <button type="button" className={styles.primaryAction} onClick={onRetry}>
            {t('usage.retry')}
          </button>
        )}
      </div>
    </section>
  );
}
