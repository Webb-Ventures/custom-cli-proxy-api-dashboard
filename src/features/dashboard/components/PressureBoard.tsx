/**
 * Credentials ranked by pressure: each row shows the credential's tightest limit
 * on a usage meter with its pace marker, a status, and when it can take requests.
 */

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { ResolvedTheme } from '@/types';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { QuotaMeter } from '@/features/quota/components/QuotaMeter';
import {
  windowMeterUsage,
  windowPace,
  windowRunsOutAtMs,
  type HeadroomSummary,
  type HeadroomWindow,
} from '@/features/quota/headroom';
import type { QuotaFileEntry } from '@/features/quota/logic';
import type { QuotaClassMap } from '@/features/quota/types';
import type { HeadroomRow } from '../headroomOverview';
import styles from './PressureBoard.module.scss';

/** Rows shown before the rest fold into a count. */
export const PRESSURE_BOARD_LIMIT = 8;

type StatusTone = 'bad' | 'warn' | 'calm';

function statusOf(summary: HeadroomSummary, now: number): { key: string; tone: StatusTone } {
  const { availability, tier, tightest } = summary;
  if (availability.state === 'blocked') {
    return availability.reason === 'cooldown'
      ? { key: 'quota_management.tier_cooldown', tone: 'bad' }
      : { key: 'quota_management.tier_exhausted', tone: 'bad' };
  }
  if (tier === 'runs-out') return { key: 'quota_management.tier_runs_out', tone: 'bad' };
  if (tier === 'ahead') return { key: 'quota_management.tier_ahead', tone: 'warn' };
  return tightest && windowPace(tightest, now)
    ? { key: 'dashboard.pressure_status_on_pace', tone: 'calm' }
    : { key: 'dashboard.pressure_status_room', tone: 'calm' };
}

export interface PressureBoardProps {
  rows: readonly HeadroomRow<QuotaFileEntry>[];
  now: number;
  resolvedTheme: ResolvedTheme;
  /** Quota meter classes, bound by the host. */
  classes: QuotaClassMap;
}

export function PressureBoard({ rows, now, resolvedTheme, classes }: PressureBoardProps) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage;

  if (rows.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyNote}>{t('dashboard.pressure_empty')}</p>
        <Link to="/quota" className={styles.link}>
          {t('dashboard.pressure_link')}
        </Link>
      </div>
    );
  }

  const labelOf = (window: HeadroomWindow) =>
    window.labelKey ? t(window.labelKey, window.labelParams ?? {}) : window.label || window.id;
  const shown = rows.slice(0, PRESSURE_BOARD_LIMIT);
  const hidden = rows.length - shown.length;

  return (
    <>
      <div className={styles.columns} aria-hidden="true">
        <span>{t('dashboard.pressure_col_credential')}</span>
        <span>{t('dashboard.pressure_col_limit')}</span>
        <span>{t('dashboard.pressure_col_status')}</span>
        <span className={styles.alignEnd}>{t('dashboard.pressure_col_available')}</span>
      </div>
      <ul className={styles.list}>
        {shown.map(({ item, headroom }) => {
          const { summary } = headroom;
          const tightest = summary.tightest;
          if (!tightest) return null;
          const { file } = item;
          const providerType =
            item.type === 'plugin'
              ? String(
                  file.quotaProvider ??
                    file['quota_provider'] ??
                    file.provider ??
                    file.type ??
                    'plugin'
                )
              : item.type;
          const iconSrc = getAuthFileIcon(providerType, resolvedTheme);
          const typeLabel = getTypeLabel(t, providerType);
          const name = getQuotaDisplayName(file);
          const label = labelOf(tightest);
          const status = statusOf(summary, now);
          const runsOutAtMs = windowRunsOutAtMs(tightest, now);
          const caption =
            summary.availability.state === 'available' && runsOutAtMs !== null
              ? t('dashboard.pressure_runs_out', {
                  window: label,
                  time: formatInstantShort(runsOutAtMs),
                })
              : tightest.resetAtMs !== null
                ? t('dashboard.pressure_resets', {
                    window: label,
                    time: formatRelativeInstant(tightest.resetAtMs, now, locale),
                  })
                : label;
          const { availability } = summary;
          const isAvailable = availability.state === 'available';
          const available =
            availability.state === 'available'
              ? t('dashboard.pressure_available_now')
              : availability.untilMs === null
                ? t('dashboard.next_capacity_unknown')
                : formatInstantShort(availability.untilMs);

          return (
            <li key={`${item.type}:${file.name}`} className={styles.row}>
              <div className={styles.identity}>
                <span
                  className={styles.iconWrap}
                  title={typeLabel}
                  style={
                    isThemeSurfaceIconProvider(providerType)
                      ? { background: getThemeSurfaceIconBackground(resolvedTheme) }
                      : undefined
                  }
                >
                  {iconSrc ? (
                    <img src={iconSrc} alt="" className={styles.icon} />
                  ) : (
                    <span className={styles.iconFallback}>
                      {typeLabel.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </span>
                <span className={styles.names}>
                  <span className={styles.name} title={name}>
                    {name}
                  </span>
                  <span className={styles.type}>{typeLabel}</span>
                </span>
              </div>
              <div className={styles.limit}>
                <QuotaMeter
                  usage={windowMeterUsage(tightest, now)}
                  classes={classes}
                  className={styles.meter}
                />
                <span className={styles.caption}>
                  <span className={styles.captionText}>{caption}</span>
                  <span className={styles.percent}>
                    {t('quota_management.window_percent', {
                      used: Math.round(tightest.usedPercent),
                    })}
                  </span>
                </span>
              </div>
              <span className={`${styles.status} ${styles[`status_${status.tone}`]}`}>
                {t(status.key)}
              </span>
              <span
                className={`${styles.available} ${isAvailable ? styles.availableNow : ''}`}
                data-label={t('dashboard.pressure_col_available')}
              >
                {available}
              </span>
            </li>
          );
        })}
      </ul>
      <div className={styles.footer}>
        {hidden > 0 && (
          <span className={styles.more}>{t('dashboard.pressure_more', { count: hidden })}</span>
        )}
        <Link to="/quota" className={styles.link}>
          {t('dashboard.pressure_link')}
        </Link>
      </div>
    </>
  );
}
