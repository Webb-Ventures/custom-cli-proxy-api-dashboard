import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  IconBot,
  IconFileText,
  IconSidebarConfig,
  IconSidebarLogs,
  IconSidebarQuota,
  IconSidebarSystem,
} from '@/components/ui/icons';
import { useAuthStore, useThemeStore } from '@/stores';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNow } from '@/hooks/useNow';
import { formatCompactNumber, formatDateValue, formatPercent } from '@/utils/format';
import { formatInstantShort, formatRelativeInstant } from '@/utils/quota';
import { getQuotaDisplayName } from '@/utils/quota/identity';
import { MINUTE_MS } from '@/utils/time/durations';
import { useCredentialHeadroom } from '@/features/quota/hooks/useCredentialHeadroom';
import { useQuotaAutoRefresh } from '@/features/quota/hooks/useQuotaAutoRefresh';
import quotaBodyStyles from '@/features/quota/components/QuotaBody.module.scss';
import { bindQuotaClasses } from '@/features/quota/types';
import { useDashboardOverview } from './hooks/useDashboardOverview';
import { summarizeFleetHeadroom, type HeadroomRow } from './headroomOverview';
import { LiveWire } from './components/LiveWire';
import { Meter } from './components/Meter';
import { PressureBoard } from './components/PressureBoard';
import { ThroughputChart } from './components/ThroughputChart';
import { useCountUp, useRevealGroup, useRevealOnScroll } from '@/hooks/motion';
import { providerLabel, splitWindowMinutes, toneForSuccessRate, type MeterTone } from './utils';
import type { QuotaFileEntry } from '@/features/quota/logic';
import styles from './dashboard.module.scss';

const DASH = '—';

const quotaClasses = bindQuotaClasses(quotaBodyStyles, 'QuotaBody.module.scss');

/** KPI 卡左上角色签：有语义色调的卡用状态色，其余保持中性 */
const TILE_ACCENTS: Record<MeterTone, string> = {
  good: 'var(--viz-success)',
  warning: 'var(--amber-color)',
  critical: 'var(--viz-failure)',
  idle: 'var(--text-quaternary)',
};

/** 大数字：六位以内用千分位，再往上压缩，避免撑破排版 */
const formatHeadline = (value: number): string =>
  value < 100_000 ? value.toLocaleString() : formatCompactNumber(value);

/** Clock time for today, date and time otherwise. */
const formatCapacityTime = (ms: number, now: number): string => {
  const date = new Date(ms);
  if (date.toDateString() !== new Date(now).toDateString()) return formatInstantShort(ms);
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
};

/** Weekly pool tone: the same 70/90 bands the quota meters use for percent used. */
const toneForUsedPercent = (used: number): MeterTone =>
  used >= 90 ? 'critical' : used >= 70 ? 'warning' : 'good';

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const serverBuildDate = useAuthStore((state) => state.serverBuildDate);

  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const {
    connectionStatus,
    connected,
    config,
    authFiles,
    quotaEntries,
    counts,
    traffic,
    credentials,
    refresh,
  } = useDashboardOverview();

  useHeaderRefresh(refresh, connected);

  const now = useNow();
  const { headroomFor } = useCredentialHeadroom(quotaEntries, now);
  useQuotaAutoRefresh(quotaEntries, !connected || !authFiles);

  const fleet = useMemo(() => {
    const rows: HeadroomRow<QuotaFileEntry>[] = [];
    quotaEntries.forEach((entry) => {
      const headroom = headroomFor(entry);
      if (headroom) rows.push({ item: entry, headroom });
    });
    return summarizeFleetHeadroom(rows);
  }, [quotaEntries, headroomFor]);
  const hasHeadroom = connected && fleet.total > 0;

  /* Hero 与静态网格走分组级联；异步内容区（图表/供应商）保持整块 reveal */
  const heroRef = useRevealGroup<HTMLElement>();
  const statsRef = useRevealGroup<HTMLElement>(0.12);
  const trafficRef = useRevealOnScroll<HTMLElement>();
  const pressureRef = useRevealOnScroll<HTMLElement>();
  const detailRef = useRevealGroup<HTMLElement>();
  const ctaRef = useRevealGroup<HTMLElement>();

  const animatedTotal = useCountUp(traffic.total, connected);

  const windowLabel = useMemo(() => {
    if (traffic.windowMinutes <= 0) return DASH;
    const { hours, minutes } = splitWindowMinutes(traffic.windowMinutes);
    if (hours === 0) return t('dashboard.window_m', { minutes });
    if (minutes === 0) return t('dashboard.window_h', { hours });
    return t('dashboard.window_hm', { hours, minutes });
  }, [traffic.windowMinutes, t]);

  const heroSparkPoints = useMemo(
    () => traffic.buckets.map((bucket) => bucket.success + bucket.failed),
    [traffic.buckets]
  );

  const routingStrategy = useMemo(() => {
    const raw = config?.routingStrategy?.trim() ?? '';
    if (!raw) return DASH;
    if (raw === 'round-robin') return t('basic_settings.routing_strategy_round_robin');
    if (raw === 'weighted-round-robin') {
      return t('basic_settings.routing_strategy_weighted_round_robin');
    }
    if (raw === 'fill-first') return t('basic_settings.routing_strategy_fill_first');
    return raw;
  }, [config?.routingStrategy, t]);

  const unknownProviderLabel = t('dashboard.provider_unknown');
  const successRateTone = toneForSuccessRate(traffic.successRate);

  /** 标题是算出来的判词，不是写死的口号；句尾句号充当状态灯 */
  const verdict = useMemo(() => {
    if (!connected) {
      return connectionStatus === 'connecting'
        ? { key: 'hero_verdict_connecting', accent: 'var(--amber-color)' }
        : { key: 'hero_verdict_offline', accent: 'var(--text-quaternary)' };
    }
    if (fleet.total > 0) {
      const blocked = fleet.cooling + fleet.exhausted;
      const params = { room: fleet.withRoom, total: fleet.total };
      if (fleet.withRoom === 0) {
        return { text: t('dashboard.headroom_verdict_none'), accent: TILE_ACCENTS.critical };
      }
      return {
        text:
          blocked === 0
            ? t('dashboard.headroom_verdict_all', params)
            : t('dashboard.headroom_verdict', params),
        accent: blocked > 0 || fleet.ahead > 0 ? TILE_ACCENTS.warning : TILE_ACCENTS.good,
      };
    }
    if (traffic.total === 0 || traffic.successRate === null) {
      return { key: 'hero_verdict_idle', accent: 'var(--text-quaternary)' };
    }
    const keyByTone: Record<MeterTone, string> = {
      good: 'hero_verdict_good',
      warning: 'hero_verdict_warning',
      critical: 'hero_verdict_critical',
      idle: 'hero_verdict_idle',
    };
    return { key: keyByTone[successRateTone], accent: TILE_ACCENTS[successRateTone] };
  }, [connected, connectionStatus, fleet, traffic.total, traffic.successRate, successRateTone, t]);

  /* 句号状态灯只在「有活着的流量」时呼吸；离线/静默时保持安静 */
  const heroAlive = connected && traffic.total > 0;

  const connectionLabel = t(
    connectionStatus === 'connected'
      ? 'common.connected'
      : connectionStatus === 'connecting'
        ? 'common.connecting'
        : 'common.disconnected'
  );
  const versionLabel = serverVersion ? `v${serverVersion.trim().replace(/^[vV]+/, '')}` : null;
  const heroMetaLine = [versionLabel, connectionLabel].filter(Boolean).join(' · ');

  const headroomMetaLine = useMemo(() => {
    if (!hasHeadroom) return null;
    const parts: string[] = [];
    if (fleet.ahead > 0) parts.push(t('dashboard.headroom_meta_ahead', { count: fleet.ahead }));
    if (fleet.cooling > 0)
      parts.push(t('dashboard.headroom_meta_cooling', { count: fleet.cooling }));
    if (fleet.exhausted > 0) {
      parts.push(t('dashboard.headroom_meta_exhausted', { count: fleet.exhausted }));
    }
    if (fleet.latestSeenAtMs !== null) {
      parts.push(
        now - fleet.latestSeenAtMs < MINUTE_MS
          ? t('dashboard.headroom_meta_seen_now')
          : t('dashboard.headroom_meta_seen', {
              time: formatRelativeInstant(fleet.latestSeenAtMs, now, i18n.resolvedLanguage),
            })
      );
    }
    return parts.join(', ');
  }, [hasHeadroom, fleet, now, t, i18n.resolvedLanguage]);

  const nextCapacity = hasHeadroom ? fleet.next : null;
  const nextCapacityReason = (() => {
    if (!nextCapacity) return '';
    const name = getQuotaDisplayName(nextCapacity.item.file);
    if (nextCapacity.reason === 'cooldown' || !nextCapacity.window) {
      return t('dashboard.next_capacity_cooldown', { name });
    }
    const { window } = nextCapacity;
    const label = window.labelKey
      ? t(window.labelKey, window.labelParams ?? {})
      : window.label || window.id;
    return t('dashboard.next_capacity_window', { name, window: label });
  })();

  const successTile = {
    key: 'success',
    label: t('dashboard.success_rate'),
    value: traffic.successRate === null ? DASH : formatPercent(traffic.successRate),
    hint: t('dashboard.stat_success_hint', { total: traffic.total.toLocaleString() }),
    meter: traffic.successRate,
    tone: successRateTone,
  };
  const unavailable = fleet.cooling + fleet.exhausted;
  const headroomTiles = [
    {
      key: 'ahead',
      label: t('dashboard.kpi_ahead'),
      value: fleet.ahead.toLocaleString(),
      hint: t('dashboard.kpi_ahead_hint'),
      meter: null,
      tone: (fleet.ahead > 0 ? 'warning' : 'good') as MeterTone,
    },
    {
      key: 'unavailable',
      label: t('dashboard.kpi_unavailable'),
      value: unavailable.toLocaleString(),
      hint: t('dashboard.kpi_unavailable_hint'),
      meter: null,
      tone: (unavailable > 0 ? 'critical' : 'good') as MeterTone,
    },
    {
      key: 'weeklyPool',
      label: t('dashboard.kpi_weekly_pool'),
      value: fleet.weeklyPoolUsed === null ? DASH : formatPercent(fleet.weeklyPoolUsed),
      hint:
        fleet.weeklyPoolUsed === null
          ? t('dashboard.kpi_weekly_pool_empty')
          : t('dashboard.kpi_weekly_pool_hint', { count: fleet.weeklyCount }),
      meter: fleet.weeklyPoolUsed,
      tone: fleet.weeklyPoolUsed === null ? undefined : toneForUsedPercent(fleet.weeklyPoolUsed),
    },
    successTile,
  ];

  const trafficTiles = [
    successTile,
    {
      key: 'credentials',
      label: t('dashboard.stat_credentials'),
      value: credentials ? credentials.total.toLocaleString() : DASH,
      hint: credentials
        ? t('dashboard.stat_credentials_hint', {
            active: credentials.active,
            disabled: credentials.disabled + credentials.unavailable,
          })
        : t('dashboard.stat_credentials_empty'),
      meter:
        credentials && credentials.total > 0
          ? (credentials.active / credentials.total) * 100
          : null,
      tone: undefined,
    },
    {
      key: 'providerKeys',
      label: t('dashboard.stat_provider_keys'),
      value: counts.providerKeys === null ? DASH : counts.providerKeys.toLocaleString(),
      hint: t('dashboard.stat_provider_keys_hint'),
      meter: null,
      tone: undefined,
    },
    {
      key: 'models',
      label: t('dashboard.stat_models'),
      value: counts.models === null ? DASH : counts.models.toLocaleString(),
      hint: t('dashboard.stat_models_hint'),
      meter: null,
      tone: undefined,
    },
  ];
  const statTiles = hasHeadroom ? headroomTiles : trafficTiles;

  const runtimeRows: Array<{ label: string; value: string; mono?: boolean }> = [
    { label: t('dashboard.runtime_routing'), value: routingStrategy },
    { label: t('dashboard.runtime_retry'), value: String(config?.requestRetry ?? 0) },
    {
      label: t('dashboard.runtime_management_keys'),
      value: counts.managementKeys === null ? DASH : String(counts.managementKeys),
    },
    { label: t('dashboard.runtime_version'), value: serverVersion?.trim() || DASH },
    {
      label: t('dashboard.runtime_build'),
      value: formatDateValue(serverBuildDate, i18n.language) || DASH,
    },
    { label: t('dashboard.runtime_proxy'), value: config?.proxyUrl?.trim() || DASH, mono: true },
  ];

  const runtimeToggles = config
    ? [
        { label: t('dashboard.runtime_debug'), on: Boolean(config.debug) },
        { label: t('dashboard.runtime_file_logging'), on: Boolean(config.loggingToFile) },
        { label: t('dashboard.runtime_request_log'), on: Boolean(config.requestLog) },
        { label: t('dashboard.runtime_ws_auth'), on: Boolean(config.wsAuth) },
        { label: t('dashboard.runtime_model_prefix'), on: Boolean(config.forceModelPrefix) },
      ]
    : [];

  const ctaCards = [
    {
      to: '/ai-providers',
      icon: <IconBot size={20} />,
      title: t('nav.ai_providers'),
      description: t('dashboard.cta_providers_desc'),
    },
    {
      to: '/auth-files',
      icon: <IconFileText size={20} />,
      title: t('nav.auth_files'),
      description: t('dashboard.cta_auth_files_desc'),
    },
    {
      to: '/config',
      icon: <IconSidebarConfig size={20} />,
      title: t('nav.config_management'),
      description: t('dashboard.cta_config_desc'),
    },
    {
      to: '/quota',
      icon: <IconSidebarQuota size={20} />,
      title: t('nav.quota_management'),
      description: t('dashboard.cta_quota_desc'),
    },
    {
      to: '/logs',
      icon: <IconSidebarLogs size={20} />,
      title: t('nav.logs'),
      description: t('dashboard.cta_logs_desc'),
    },
    {
      to: '/system',
      icon: <IconSidebarSystem size={20} />,
      title: t('nav.system_info'),
      description: t('dashboard.cta_system_desc'),
    },
  ];

  return (
    <div className={styles.page}>
      <div className={styles.ambient} aria-hidden="true">
        <span className={styles.washTop} />
        <span className={styles.gridWash} />
      </div>

      {/* ---------- Hero ---------- */}
      <section className={styles.hero} ref={heroRef}>
        <div className={styles.heroCopy}>
          <h1 className={styles.heroTitle} data-reveal>
            {'text' in verdict ? verdict.text : t(`dashboard.${verdict.key}`)}
            <span
              className={`${styles.heroPeriod} ${heroAlive ? styles.heroPeriodLive : ''}`}
              style={{ color: verdict.accent }}
            >
              {t('dashboard.hero_period')}
            </span>
          </h1>
          {headroomMetaLine && (
            <p className={styles.heroHeadroomMeta} data-reveal>
              {headroomMetaLine}
            </p>
          )}
          <p className={styles.heroMeta} data-reveal>
            {heroMetaLine}
          </p>
          <div className={styles.heroActions} data-reveal>
            <Link to="/ai-providers" className={styles.primaryAction}>
              {t('dashboard.cta_manage_providers')}
            </Link>
            <Link to="/logs" className={styles.ghostAction}>
              {t('dashboard.cta_inspect_logs')}{' '}
              <span className={styles.linkArrow} aria-hidden="true">
                →
              </span>
            </Link>
          </div>
        </div>

        {nextCapacity ? (
          <div className={styles.heroPanel} data-reveal="scale">
            <div className={styles.heroPanelTop}>
              <span className={styles.heroPanelLabel}>{t('dashboard.next_capacity_label')}</span>
            </div>
            <strong className={styles.heroFigure}>
              {nextCapacity.atMs === null
                ? t('dashboard.next_capacity_unknown')
                : formatCapacityTime(nextCapacity.atMs, now)}
            </strong>
            {nextCapacity.atMs !== null && (
              <span className={styles.heroPanelMeta}>
                {formatRelativeInstant(nextCapacity.atMs, now, i18n.resolvedLanguage)}
              </span>
            )}
            <span className={styles.heroCapacityReason}>{nextCapacityReason}</span>
          </div>
        ) : (
          <div className={styles.heroPanel} data-reveal="scale">
            <div className={styles.heroPanelTop}>
              <span className={styles.heroPanelLabel}>{t('dashboard.hero_requests_label')}</span>
              {connected && (
                <span className={styles.liveBadge}>
                  <i className={styles.liveDot} aria-hidden="true" />
                  {t('dashboard.hero_live')}
                </span>
              )}
            </div>
            <strong className={styles.heroFigure}>
              {connected ? formatHeadline(animatedTotal) : DASH}
            </strong>
            <span className={styles.heroPanelMeta}>
              {t('dashboard.hero_window_meta', { window: windowLabel })}
            </span>
            {traffic.total > 0 && (
              <div className={styles.ratioBar} aria-hidden="true">
                {traffic.totalSuccess > 0 && (
                  <span
                    className={`${styles.ratioSegment} ${styles.splitSuccess}`}
                    style={{ flexGrow: traffic.totalSuccess }}
                  />
                )}
                {traffic.totalFailure > 0 && (
                  <span
                    className={`${styles.ratioSegment} ${styles.splitFailure}`}
                    style={{ flexGrow: traffic.totalFailure }}
                  />
                )}
              </div>
            )}
            <div className={styles.heroSplit}>
              <span className={styles.heroSplitItem}>
                <i className={`${styles.splitSwatch} ${styles.splitSuccess}`} aria-hidden="true" />
                {t('stats.success')}
                <b>{traffic.totalSuccess.toLocaleString()}</b>
              </span>
              <span className={styles.heroSplitItem}>
                <i className={`${styles.splitSwatch} ${styles.splitFailure}`} aria-hidden="true" />
                {t('stats.failure')}
                <b>{traffic.totalFailure.toLocaleString()}</b>
              </span>
            </div>
          </div>
        )}

        <div className={styles.heroWire}>
          <LiveWire
            points={heroSparkPoints}
            ariaLabel={t('dashboard.hero_spark_label', { window: windowLabel })}
          />
        </div>
      </section>

      {/* ---------- KPI ---------- */}
      <section className={styles.statsRow} ref={statsRef} aria-label={t('dashboard.stats_aria')}>
        {statTiles.map((tile) => (
          <article
            key={tile.key}
            className={styles.statTile}
            data-reveal
            style={
              {
                '--tile-accent': tile.tone ? TILE_ACCENTS[tile.tone] : 'var(--border-hover)',
              } as React.CSSProperties
            }
          >
            <span className={styles.statLabel}>{tile.label}</span>
            <strong className={styles.statValue}>{tile.value}</strong>
            {tile.meter !== null && tile.meter !== undefined && (
              <Meter
                value={tile.meter}
                tone={tile.tone}
                ariaLabel={tile.label}
                className={styles.statMeter}
              />
            )}
            <span className={styles.statHint}>{tile.hint}</span>
          </article>
        ))}
      </section>

      {/* ---------- Traffic ---------- */}
      <section className={styles.section} ref={trafficRef}>
        <header className={styles.sectionHead}>
          <span className={styles.eyebrow}>{t('dashboard.traffic_eyebrow')}</span>
          <h2 className={styles.sectionTitle}>{t('dashboard.traffic_title')}</h2>
          <p className={styles.sectionDescription}>
            {t('dashboard.traffic_description', { window: windowLabel })}
          </p>
        </header>
        <div className={styles.panel}>
          <ThroughputChart traffic={traffic} />
        </div>
      </section>

      {/* ---------- Headroom pressure ---------- */}
      <section className={styles.section} ref={pressureRef}>
        <header className={styles.sectionHead}>
          <span className={styles.eyebrow}>{t('dashboard.pressure_eyebrow')}</span>
          <h2 className={styles.sectionTitle}>{t('dashboard.pressure_title')}</h2>
          <p className={styles.sectionDescription}>{t('dashboard.pressure_description')}</p>
        </header>
        <div className={styles.panel}>
          <PressureBoard
            rows={connected ? fleet.ranked : []}
            now={now}
            resolvedTheme={resolvedTheme}
            classes={quotaClasses}
          />
        </div>
      </section>

      {/* ---------- Credential health + runtime ---------- */}
      <section className={styles.detailGrid} ref={detailRef}>
        <div className={styles.panel} data-reveal>
          <header className={styles.panelHead}>
            <span className={styles.eyebrow}>{t('dashboard.health_eyebrow')}</span>
            <h2 className={styles.panelTitle}>{t('dashboard.health_title')}</h2>
          </header>
          {!credentials || credentials.total === 0 ? (
            <p className={styles.emptyNote}>{t('dashboard.health_empty')}</p>
          ) : (
            <>
              <div className={styles.healthBar}>
                {credentials.active > 0 && (
                  <span
                    className={`${styles.healthSegment} ${styles.healthActive}`}
                    style={{ flexGrow: credentials.active }}
                  />
                )}
                {credentials.unavailable > 0 && (
                  <span
                    className={`${styles.healthSegment} ${styles.healthUnavailable}`}
                    style={{ flexGrow: credentials.unavailable }}
                  />
                )}
                {credentials.disabled > 0 && (
                  <span
                    className={`${styles.healthSegment} ${styles.healthDisabled}`}
                    style={{ flexGrow: credentials.disabled }}
                  />
                )}
              </div>
              <ul className={styles.healthLegend}>
                <li>
                  <i className={`${styles.healthKey} ${styles.healthActive}`} aria-hidden="true" />
                  {t('dashboard.health_active')}
                  <b>{credentials.active.toLocaleString()}</b>
                </li>
                <li>
                  <i
                    className={`${styles.healthKey} ${styles.healthUnavailable}`}
                    aria-hidden="true"
                  />
                  {t('dashboard.health_unavailable')}
                  <b>{credentials.unavailable.toLocaleString()}</b>
                </li>
                <li>
                  <i
                    className={`${styles.healthKey} ${styles.healthDisabled}`}
                    aria-hidden="true"
                  />
                  {t('dashboard.health_disabled')}
                  <b>{credentials.disabled.toLocaleString()}</b>
                </li>
              </ul>
              <div className={styles.typeBreakdown}>
                <span className={styles.typeBreakdownLabel}>{t('dashboard.health_by_type')}</span>
                <ul className={styles.typeList}>
                  {credentials.byType.map((entry) => (
                    <li key={entry.type} className={styles.typeChip}>
                      {providerLabel(entry.type, unknownProviderLabel)}
                      <b>{entry.count.toLocaleString()}</b>
                    </li>
                  ))}
                </ul>
              </div>
              <Link to="/auth-files" className={styles.panelLink}>
                {t('dashboard.health_link')}{' '}
                <span className={styles.linkArrow} aria-hidden="true">
                  →
                </span>
              </Link>
            </>
          )}
        </div>

        <div className={styles.panel} data-reveal>
          <header className={styles.panelHead}>
            <span className={styles.eyebrow}>{t('dashboard.runtime_eyebrow')}</span>
            <h2 className={styles.panelTitle}>{t('dashboard.runtime_title')}</h2>
          </header>
          <dl className={styles.specList}>
            {runtimeRows.map((row) => (
              <div key={row.label} className={styles.specRow}>
                <dt className={styles.specLabel}>{row.label}</dt>
                <dd className={`${styles.specValue} ${row.mono ? styles.specMono : ''}`}>
                  {row.value}
                </dd>
              </div>
            ))}
          </dl>
          {runtimeToggles.length > 0 && (
            <ul className={styles.toggleList}>
              {runtimeToggles.map((toggle) => (
                <li
                  key={toggle.label}
                  className={`${styles.togglePill} ${toggle.on ? styles.toggleOn : styles.toggleOff}`}
                >
                  {toggle.label}
                  <b>{toggle.on ? t('common.yes') : t('common.no')}</b>
                </li>
              ))}
            </ul>
          )}
          <Link to="/config" className={styles.panelLink}>
            {t('dashboard.runtime_link')}{' '}
            <span className={styles.linkArrow} aria-hidden="true">
              →
            </span>
          </Link>
        </div>
      </section>

      {/* ---------- CTA ---------- */}
      <section className={styles.section} ref={ctaRef}>
        <header className={styles.sectionHead} data-reveal>
          <span className={styles.eyebrow}>{t('dashboard.cta_eyebrow')}</span>
          <h2 className={styles.sectionTitle}>{t('dashboard.cta_title')}</h2>
        </header>
        <div className={styles.ctaGrid}>
          {ctaCards.map((card) => (
            <Link key={card.to} to={card.to} className={styles.ctaCard} data-reveal>
              <span className={styles.ctaIcon}>{card.icon}</span>
              <span className={styles.ctaTitle}>{card.title}</span>
              <span className={styles.ctaDescription}>{card.description}</span>
              <span className={styles.ctaArrow} aria-hidden="true">
                →
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
