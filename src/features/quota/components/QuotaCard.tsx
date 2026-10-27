/**
 * Provider quota card: identity, loading/error state, quota body, and actions.
 * Claude observations remain visible while refreshing or after a failed read.
 *
 * When headroom windows exist (from an active fetch, live traffic headers, or
 * both), providers with flat windows show them tightest limit first and keep
 * only their plan and credit content from the provider body. A card with
 * traffic headers but no fetch yet shows them instead of the click-to-load hint.
 */

import { useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import type { ClaudeQuotaState, ResolvedTheme } from '@/types';
import { formatRelativeInstant, resolveQuotaErrorMessage } from '@/utils/quota';
import { MINUTE_MS } from '@/utils/time/durations';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import {
  getAuthFileIcon,
  getThemeSurfaceIconBackground,
  getTypeLabel,
  isThemeSurfaceIconProvider,
} from '@/features/authFiles/constants';
import { bindQuotaClasses } from '../types';
import { HEADROOM_WINDOW_PROVIDERS } from '../constants';
import type { SummarizedHeadroom } from '../freshness';
import type { HeadroomSummary } from '../headroom';
import { HeadroomWindows } from './HeadroomWindows';
import { QUOTA_ADAPTERS, type QuotaCardState } from '../providers';
import { isQuotaRefreshDisabled, type QuotaFileEntry } from '../logic';
import { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { ClaudeResetGrantDetails } from '../providers/claude/ClaudeResetGrantDetails';
import { hasClaudeUsageData } from '../providers/claude/data';
import bodyStyles from './QuotaBody.module.scss';
import type { AccountCapacity } from '@/features/usage/capacity';
import { formatMoney, formatTokens } from '@/features/usage/format';
import styles from './QuotaCard.module.scss';

/** Bind the quota-page styles to the shared rendering contract. */
const quotaClasses = bindQuotaClasses(bodyStyles, 'QuotaBody.module.scss');

export type QuotaCardHeadroom = SummarizedHeadroom;

const TIER_TAGS: Partial<Record<HeadroomSummary['tier'], { key: string; tone: 'bad' | 'warn' }>> = {
  'runs-out': { key: 'quota_management.tier_runs_out', tone: 'bad' },
  ahead: { key: 'quota_management.tier_ahead', tone: 'warn' },
};

export type QuotaCardProps = {
  entry: QuotaFileEntry;
  quota?: QuotaCardState;
  resolvedTheme: ResolvedTheme;
  canRefresh: boolean;
  resetting: boolean;
  /** Merged headroom; absent or windowless until any reading exists. */
  headroom?: QuotaCardHeadroom;
  now: number;
  /** Ledger tokens since the longest limit window reset; absent without the Usage Ledger plugin. */
  sinceReset?: AccountCapacity;
  /** Initial cascade delay; null disables entrance motion for later mounts. */
  entranceDelayMs?: number | null;
  onRefresh: () => void;
  onReset: () => void;
};

export function QuotaCard(props: QuotaCardProps) {
  const {
    entry,
    quota,
    resolvedTheme,
    canRefresh,
    resetting,
    headroom,
    now,
    sinceReset,
    entranceDelayMs,
    onRefresh,
    onReset,
  } = props;
  const { t, i18n } = useTranslation();
  const adapter = QUOTA_ADAPTERS[entry.type];
  const file = entry.file;
  const retainedClaudeUsage =
    entry.type === 'claude' && hasClaudeUsageData(quota as ClaudeQuotaState | undefined);
  const displayName = getQuotaDisplayName(file);

  // Capture the entrance delay only at mount, without a render-time ref read.
  const [mountEntranceDelayMs] = useState<number | null>(entranceDelayMs ?? null);
  const entranceStyle =
    mountEntranceDelayMs === null
      ? undefined
      : ({ '--card-delay': `${mountEntranceDelayMs}ms` } as CSSProperties);

  const status = quota?.status ?? 'idle';
  const loading = status === 'loading';
  const claudeReset = useClaudeResetGrants(
    file,
    entry.type === 'claude' && status !== 'idle',
    !canRefresh || loading || resetting,
    quota,
    onRefresh
  );
  const providerType =
    entry.type === 'plugin'
      ? String(
          file.quotaProvider ?? file['quota_provider'] ?? file.provider ?? file.type ?? 'plugin'
        )
      : entry.type;
  const iconSrc = getAuthFileIcon(providerType, resolvedTheme);
  const typeLabel = getTypeLabel(t, providerType);
  const errorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  // Claude banked resets join the plan chip row; their expiry list follows it.
  const showClaudeReset = entry.type === 'claude' && status === 'success';
  const claudePlanItems = showClaudeReset ? (
    <span className={quotaClasses.codexPlanItem}>
      <span className={quotaClasses.codexPlanLabel}>{t('claude_reset.remaining')}</span>
      <span className={quotaClasses.codexPlanValue}>{claudeReset.count ?? '--'}</span>
    </span>
  ) : undefined;
  const claudeAfterPlan = showClaudeReset ? (
    <>
      <ClaudeResetGrantDetails grants={claudeReset.grants} classes={quotaClasses} />
      {claudeReset.message && (
        <div role="status" className={quotaClasses.codexResetCreditsError}>
          {t(`claude_reset.${claudeReset.message}`)}
        </div>
      )}
    </>
  ) : undefined;
  const summary = headroom?.summary;
  const showHeadroom =
    HEADROOM_WINDOW_PROVIDERS.has(entry.type) && Boolean(summary?.windows.length);
  const hasBodyData = status === 'success' || retainedClaudeUsage;

  let freshness: string | null = null;
  if (headroom && headroom.seenAtMs !== null && headroom.seenFrom) {
    const justNow = now - headroom.seenAtMs < MINUTE_MS;
    const time = formatRelativeInstant(headroom.seenAtMs, now, i18n.resolvedLanguage);
    freshness =
      headroom.seenFrom === 'traffic'
        ? justNow
          ? t('quota_management.seen_traffic_now')
          : t('quota_management.seen_traffic', { time })
        : justNow
          ? t('quota_management.checked_now')
          : t('quota_management.checked', { time });
  }

  let tierTag: { label: string; tone: 'bad' | 'warn' } | null = null;
  if (summary?.availability.state === 'blocked') {
    tierTag = {
      label: t(
        summary.availability.reason === 'cooldown'
          ? 'quota_management.tier_cooldown'
          : 'quota_management.tier_exhausted'
      ),
      tone: 'bad',
    };
  } else if (summary && TIER_TAGS[summary.tier]) {
    const tag = TIER_TAGS[summary.tier]!;
    tierTag = { label: t(tag.key), tone: tag.tone };
  }

  const showReset =
    status === 'success' &&
    Boolean(adapter.resetQuota) &&
    quota !== undefined &&
    Boolean(adapter.canResetQuota?.(quota));

  return (
    <article
      className={`${styles.card} ${mountEntranceDelayMs === null ? '' : styles.cardEnter}`}
      style={entranceStyle}
    >
      <header className={styles.head}>
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
            <span className={styles.iconFallback}>{typeLabel.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className={styles.identity}>
          <span className={styles.fileName} title={displayName}>
            {displayName}
          </span>
          {freshness && <span className={styles.freshness}>{freshness}</span>}
        </span>
      </header>

      <div className={styles.body}>
        {showHeadroom && summary ? (
          <>
            <HeadroomWindows summary={summary} classes={quotaClasses} now={now} />
            {sinceReset && sinceReset.tokensSinceReset > 0 && (
              <p className={styles.ledgerLine}>
                {t('usage.quota_since_reset', {
                  window: sinceReset.window.labelKey
                    ? t(sinceReset.window.labelKey, sinceReset.window.labelParams ?? {})
                    : sinceReset.window.label || sinceReset.window.id,
                  tokens: formatTokens(sinceReset.tokensSinceReset),
                  value: formatMoney(sinceReset.valueSinceResetUsd, i18n.language),
                })}
                {sinceReset.tokensLeft !== null &&
                  sinceReset.tokensLeft > 0 &&
                  ` ${t('usage.quota_left', { tokens: formatTokens(sinceReset.tokensLeft) })}`}
              </p>
            )}
            {hasBodyData && quota && (
              <adapter.Body
                quota={quota}
                classes={quotaClasses}
                planItems={claudePlanItems}
                afterPlan={claudeAfterPlan}
                showWindows={false}
              />
            )}
            {loading && (
              <div role="status" aria-busy="true" className={quotaClasses.quotaMessage}>
                {t('quota_management.refreshing')}
              </div>
            )}
            {status === 'error' && (
              <div className={styles.errorStrip} role="alert">
                {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
              </div>
            )}
          </>
        ) : status === 'idle' ? (
          <button
            type="button"
            className={styles.idleBody}
            onClick={onRefresh}
            disabled={!canRefresh}
          >
            <IconRefreshCw size={15} aria-hidden="true" className={styles.idleGlyph} />
            <span className={styles.idleHint}>{t(`${adapter.i18nPrefix}.idle`)}</span>
          </button>
        ) : loading && !retainedClaudeUsage ? (
          <div className={styles.skeleton} aria-busy="true">
            <span className={styles.srOnly}>{t(`${adapter.i18nPrefix}.loading`)}</span>
            {[0, 1].map((row) => (
              <div key={row} className={styles.skeletonRow} aria-hidden="true">
                <span className={styles.skeletonLabel} />
                <span className={styles.skeletonTrack} />
              </div>
            ))}
          </div>
        ) : status === 'error' ? (
          <div className={styles.errorStrip} role="alert">
            {t(`${adapter.i18nPrefix}.load_failed`, { message: errorMessage })}
          </div>
        ) : quota && !retainedClaudeUsage ? (
          <adapter.Body
            quota={quota}
            classes={quotaClasses}
            planItems={claudePlanItems}
            afterPlan={claudeAfterPlan}
          />
        ) : !retainedClaudeUsage ? (
          <div className={styles.idleHint}>{t(`${adapter.i18nPrefix}.idle`)}</div>
        ) : null}
        {!showHeadroom && loading && retainedClaudeUsage && (
          <div role="status" aria-busy="true" className={quotaClasses.quotaMessage}>
            {t(`${adapter.i18nPrefix}.loading`)}
          </div>
        )}
        {!showHeadroom && retainedClaudeUsage && quota && (
          <adapter.Body
            quota={quota}
            classes={quotaClasses}
            planItems={claudePlanItems}
            afterPlan={claudeAfterPlan}
          />
        )}
      </div>

      {(status !== 'idle' || showHeadroom) && (
        <footer className={styles.actionRow}>
          {tierTag && (
            <span
              className={`${styles.tierTag} ${tierTag.tone === 'bad' ? styles.tierBad : styles.tierWarn}`}
            >
              {tierTag.label}
            </span>
          )}
          {entry.type === 'claude' && (
            <button
              type="button"
              className={styles.actionPill}
              disabled={claudeReset.blocked}
              onClick={claudeReset.confirm}
              title={t(`claude_reset.${claudeReset.buttonLabel}`)}
            >
              <IconRefreshCw size={13} className={claudeReset.busy ? styles.spinning : undefined} />
              {t(`claude_reset.${claudeReset.buttonLabel}`)}
            </button>
          )}
          {showReset && (
            <button
              type="button"
              className={styles.actionPill}
              onClick={onReset}
              disabled={!canRefresh || loading || resetting}
              title={t('codex_quota.reset_button')}
            >
              <IconRefreshCw size={13} className={resetting ? styles.spinning : undefined} />
              {t('codex_quota.reset_button')}
            </button>
          )}
          <button
            type="button"
            className={styles.actionPill}
            onClick={onRefresh}
            disabled={isQuotaRefreshDisabled(canRefresh, loading, resetting || claudeReset.busy)}
            title={t('auth_files.quota_refresh_hint')}
          >
            <IconRefreshCw size={13} className={loading ? styles.spinning : undefined} />
            {t('auth_files.quota_refresh_single')}
          </button>
        </footer>
      )}
    </article>
  );
}
