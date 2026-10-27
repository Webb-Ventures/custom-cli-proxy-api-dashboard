/**
 * Tightest limit first: the binding window gets a large meter with its run-out
 * estimate and reset, the others become thin meters underneath, each with its
 * own pace marker. Shared by the Quota page card and the compact auth-file host.
 */

import { useTranslation } from 'react-i18next';
import { buildResetDisplay, formatInstantShort } from '@/utils/quota';
import {
  windowMeterUsage,
  windowRunsOutAtMs,
  type HeadroomSummary,
  type HeadroomWindow,
} from '../headroom';
import type { QuotaClassMap } from '../types';
import { QuotaMeter } from './QuotaMeter';
import { QuotaResetLabel } from './QuotaResetLabel';
import styles from './HeadroomWindows.module.scss';

export interface HeadroomWindowsProps {
  summary: HeadroomSummary;
  classes: QuotaClassMap;
  now: number;
  /** Compact hosts show the tightest window only. */
  tightestOnly?: boolean;
}

export function HeadroomWindows({ summary, classes, now, tightestOnly }: HeadroomWindowsProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;
  const { tightest, availability } = summary;
  if (!tightest) return null;

  const labelOf = (window: HeadroomWindow) =>
    window.labelKey ? t(window.labelKey, window.labelParams ?? {}) : window.label || window.id;
  const resetOf = (window: HeadroomWindow) =>
    buildResetDisplay(null, window.resetAtMs, now, locale);
  const others = tightestOnly ? [] : summary.windows.filter((window) => window !== tightest);

  const runsOutAtMs = windowRunsOutAtMs(tightest, now);
  let alert: string | null = null;
  if (availability.state === 'blocked') {
    const time = availability.untilMs === null ? null : formatInstantShort(availability.untilMs);
    alert =
      availability.reason === 'cooldown'
        ? t('quota_management.blocked_cooldown_until', { time })
        : time === null
          ? t('quota_management.blocked_exhausted')
          : t('quota_management.blocked_exhausted_until', { time });
  } else if (runsOutAtMs !== null) {
    alert = t('quota_management.runs_out_at', { time: formatInstantShort(runsOutAtMs) });
  }
  const leadReset = resetOf(tightest);

  return (
    <div className={styles.headroom}>
      <div className={classes.quotaRow}>
        <div className={classes.quotaRowHeader}>
          <span className={classes.quotaModel}>{labelOf(tightest)}</span>
          <div className={classes.quotaMeta}>
            <span className={classes.quotaPercent}>
              {t('quota_management.meter_used', { used: Math.round(tightest.usedPercent) })}
            </span>
          </div>
        </div>
        <QuotaMeter
          usage={windowMeterUsage(tightest, now)}
          classes={classes}
          index={0}
          className={styles.leadMeter}
        />
        {(alert || leadReset) && (
          <div className={`${classes.quotaMeta} ${styles.leadCaption}`}>
            {alert && <span className={styles.alert}>{alert}</span>}
            {leadReset && (
              <span className={styles.leadReset}>
                <QuotaResetLabel display={leadReset} classes={classes} />
              </span>
            )}
          </div>
        )}
      </div>

      {others.map((window, index) => {
        const reset = resetOf(window);
        return (
          <div key={window.id} className={classes.quotaRow}>
            <div className={classes.quotaRowHeader}>
              <span className={classes.quotaModel}>{labelOf(window)}</span>
              <div className={classes.quotaMeta}>
                <span className={classes.quotaPercent}>
                  {t('quota_management.window_percent', {
                    used: Math.round(window.usedPercent),
                  })}
                </span>
                {reset && <QuotaResetLabel display={reset} classes={classes} />}
              </div>
            </div>
            <QuotaMeter usage={windowMeterUsage(window, now)} classes={classes} index={index + 1} />
          </div>
        );
      })}
    </div>
  );
}
