import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Select } from '@/components/ui/Select';
import { IconDownload, IconRefreshCw, IconX } from '@/components/ui/icons';
import { useNow } from '@/hooks/useNow';
import { classifyQuotaFiles } from '@/features/quota/logic';
import { useQuotaAutoRefresh } from '@/features/quota/hooks/useQuotaAutoRefresh';
import { usageLedgerApi } from '@/services/api';
import type { UsageGroup } from '@/services/api/usageLedger';
import { useNotificationStore } from '@/stores';
import { downloadBlob } from '@/utils/download';
import { AccountsTable } from './components/AccountsTable';
import { BlocksTable } from './components/BlocksTable';
import { CurrentBlockCard } from './components/CurrentBlockCard';
import { GroupTable } from './components/GroupTable';
import { HistoryChart } from './components/HistoryChart';
import { ProvidersView } from './components/ProvidersView';
import { Segmented } from './components/Segmented';
import { TokenClassTable } from './components/TokenClassTable';
import { UsageUnavailable } from './components/UsageUnavailable';
import { formatDay } from './format';
import { usageVerdict } from './labels';
import { useUsageCapacity } from './hooks/useUsageCapacity';
import { useLedgerPlugin, useUsageCredentials, useUsageRangeData } from './hooks/useUsageLedger';
import {
  MAX_RANGE_DAYS,
  USAGE_GROUPS,
  USAGE_RANGE_PRESETS,
  USAGE_VIEWS,
  addDays,
  browserTimeZone,
  dayInZone,
  ledgerParams,
  parseUsageState,
  resolveUsageRange,
  serializeUsageState,
  type UsageRangeKind,
  type UsageUrlState,
} from './range';
import { buildAccounts, buildBlocks, buildProviderPools, buildUsageOverview } from './usageModel';
import styles from './UsagePage.module.scss';

/** While the range includes today, reload this often so the open bucket and block stay current. */
const LIVE_RELOAD_MS = 60_000;

export function UsagePage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const location = useLocation();
  const navigate = useNavigate();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const tz = useMemo(() => browserTimeZone(), []);
  const today = dayInZone(now, tz);

  const state = useMemo(() => parseUsageState(location.search), [location.search]);
  const setState = useCallback(
    (patch: Partial<UsageUrlState>) => {
      const next = { ...state, ...patch };
      navigate({ pathname: '/usage', search: serializeUsageState(next) }, { replace: true });
    },
    [navigate, state]
  );

  const range = useMemo(
    () => resolveUsageRange(state, now, tz),
    // `today` stands in for `now`: the range only moves when the day does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.range, state.from, state.to, today, tz]
  );

  const plugin = useLedgerPlugin();
  const enabled = plugin.availability === 'available';
  const { credentials, files } = useUsageCredentials(plugin.prices, enabled);
  // Plans come from the quota adapters, so keep their data fresh while the page is open.
  const quotaEntries = useMemo(() => classifyQuotaFiles(files), [files]);
  useQuotaAutoRefresh(quotaEntries, !enabled || files.length === 0);

  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!enabled || !range.includesToday) return undefined;
    const timer = window.setInterval(() => setReloadKey((key) => key + 1), LIVE_RELOAD_MS);
    return () => window.clearInterval(timer);
  }, [enabled, range.includesToday]);

  const capacity = useUsageCapacity({
    files,
    prices: plugin.prices,
    enabled: enabled && state.view !== 'overview',
    now,
    reloadKey,
  });

  const overviewView = state.view === 'overview';
  const credentialFilter = overviewView ? state.credential : undefined;
  const group: UsageGroup = overviewView ? state.group : 'credential';
  const { data, loading, error } = useUsageRangeData({
    enabled,
    range,
    group,
    credentialFilter,
    reloadKey,
  });

  const overview = useMemo(
    () =>
      data
        ? buildUsageOverview({
            group: credentialFilter ? 'credential' : group,
            metric: state.metric,
            summary: data.summary,
            previous: data.previous,
            byCredential: data.byCredential,
            series: data.series,
            prices: plugin.prices,
            credentials,
            credentialFilter,
            now,
          })
        : null,
    [data, group, credentialFilter, state.metric, plugin.prices, credentials, now]
  );
  const blocks = useMemo(
    () => buildBlocks(data?.blocks?.blocks ?? [], plugin.prices, now),
    [data, plugin.prices, now]
  );
  const accounts = useMemo(
    () =>
      data && overview && !overviewView
        ? buildAccounts(overview.rows, data.summary, credentials, now)
        : null,
    [data, overview, overviewView, credentials, now]
  );
  const pools = useMemo(() => (accounts ? buildProviderPools(accounts.accounts) : []), [accounts]);

  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await usageLedgerApi.exportCsv({
        ...ledgerParams(range, tz),
        bucket: range.bucket,
        group,
      });
      downloadBlob({ blob, filename });
    } catch (err: unknown) {
      showNotification(
        t('usage.export_failed', { error: err instanceof Error ? err.message : String(err) }),
        'error'
      );
    } finally {
      setExporting(false);
    }
  };

  const selectCredential = (authIndex: string) =>
    setState({ view: 'overview', credential: authIndex });

  const openRange = (from: string, to: string) =>
    setState({ range: 'custom', from, to: to > today ? today : to });

  const chooseRange = (kind: UsageRangeKind) => {
    if (kind === 'custom') {
      setState({ range: 'custom', from: range.from, to: range.to });
      return;
    }
    setState({ range: kind, from: undefined, to: undefined });
  };

  const setCustomDay = (edge: 'from' | 'to', day: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    let from = edge === 'from' ? day : range.from;
    let to = edge === 'to' ? day : range.to;
    if (from > to) [from, to] = edge === 'from' ? [from, from] : [to, to];
    setState({ range: 'custom', from, to });
  };

  const filteredCredential = credentialFilter
    ? (credentials.get(credentialFilter)?.name ?? credentialFilter)
    : null;
  const verdict = overview ? usageVerdict(overview, range, state.range, locale, t) : null;
  const recordingSince =
    data?.summary.range.recordingSince ?? plugin.status?.recordingSince ?? null;
  const unpricedModels = overview?.totals.value.unpricedModels ?? [];

  const pricesNote = plugin.prices
    ? plugin.prices.fetchedAt
      ? t(`usage.prices_${plugin.prices.source}`, {
          time: new Date(plugin.prices.fetchedAt).toLocaleString(locale),
        })
      : t('usage.prices_embedded_as_of', { date: plugin.prices.embeddedAsOf || '—' })
    : t('usage.prices_missing');

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>{t('usage.title')}</h1>
          {enabled && verdict ? (
            <>
              <p className={styles.verdict}>{verdict.headline}</p>
              {verdict.meta.length > 0 && <p className={styles.meta}>{verdict.meta.join(' ')}</p>}
            </>
          ) : (
            <p className={styles.meta}>{t('usage.subtitle')}</p>
          )}
        </div>
        {enabled && (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.ghostAction}
              onClick={() => setReloadKey((key) => key + 1)}
              disabled={loading}
              aria-label={t('usage.reload')}
              title={t('usage.reload')}
            >
              <IconRefreshCw size={14} className={loading ? styles.spinning : undefined} />
            </button>
            <button
              type="button"
              className={styles.primaryAction}
              onClick={exportCsv}
              disabled={exporting}
            >
              <IconDownload size={14} />
              {t('usage.export_csv')}
            </button>
          </div>
        )}
      </header>

      {!enabled ? (
        <UsageUnavailable
          availability={plugin.availability as Exclude<typeof plugin.availability, 'available'>}
          error={plugin.error}
          onRetry={plugin.reload}
        />
      ) : (
        <>
          <div className={styles.controls}>
            <Segmented
              label={t('usage.view_label')}
              options={USAGE_VIEWS.map((view) => ({ value: view, label: t(`usage.view_${view}`) }))}
              value={state.view}
              onChange={(view) => setState({ view })}
            />
            <Segmented
              label={t('usage.range_label')}
              options={[...USAGE_RANGE_PRESETS, 'custom' as const].map((kind) => ({
                value: kind,
                label: t(`usage.range_${kind}`),
              }))}
              value={state.range}
              onChange={chooseRange}
            />
            {state.range === 'custom' ? (
              <span className={styles.dates}>
                <input
                  type="date"
                  className={styles.dateInput}
                  value={range.from}
                  min={addDays(today, -(MAX_RANGE_DAYS - 1))}
                  max={today}
                  aria-label={t('usage.custom_from')}
                  onChange={(event) => setCustomDay('from', event.target.value)}
                />
                <span aria-hidden="true">–</span>
                <input
                  type="date"
                  className={styles.dateInput}
                  value={range.to}
                  min={addDays(today, -(MAX_RANGE_DAYS - 1))}
                  max={today}
                  aria-label={t('usage.custom_to')}
                  onChange={(event) => setCustomDay('to', event.target.value)}
                />
              </span>
            ) : (
              <span className={styles.datesText}>
                {range.from === range.to
                  ? formatDay(range.from, locale)
                  : `${formatDay(range.from, locale)} – ${formatDay(range.to, locale)}`}
              </span>
            )}
            {overviewView && (
              <Segmented
                label={t('usage.metric_label')}
                options={[
                  { value: 'value' as const, label: t('usage.metric_value') },
                  { value: 'tokens' as const, label: t('usage.metric_tokens') },
                ]}
                value={state.metric}
                onChange={(metric) => setState({ metric })}
              />
            )}
            {overviewView && !credentialFilter && (
              <Select
                size="sm"
                fullWidth={false}
                value={state.group}
                options={USAGE_GROUPS.map((item) => ({
                  value: item,
                  label: t(`usage.group_${item}`),
                }))}
                onChange={(value) => setState({ group: value as UsageGroup })}
                ariaLabel={t('usage.group_label')}
              />
            )}
            {filteredCredential && (
              <span className={styles.filterChip}>
                {t('usage.filtered_to', { name: filteredCredential })}
                <button
                  type="button"
                  onClick={() => setState({ credential: undefined })}
                  aria-label={t('usage.clear_filter')}
                  title={t('usage.clear_filter')}
                >
                  <IconX size={12} />
                </button>
              </span>
            )}
          </div>

          {error && !data && (
            <UsageUnavailable
              availability="error"
              error={error}
              onRetry={() => setReloadKey((key) => key + 1)}
            />
          )}

          {overview && data && (
            <div
              className={`${styles.body} ${loading ? styles.bodyLoading : ''}`}
              aria-busy={loading}
            >
              {overviewView ? (
                <>
                  <section className={styles.panel} aria-label={t('usage.chart_region')}>
                    <HistoryChart
                      bars={overview.bars}
                      metric={state.metric}
                      bucket={range.bucket}
                      tz={tz}
                      onOpenRange={openRange}
                    />
                  </section>

                  <div className={styles.split}>
                    <CurrentBlockCard block={blocks.current} tz={tz} />
                    <TokenClassTable
                      shares={overview.tokenClasses}
                      days={range.days}
                      footnote={
                        unpricedModels.length > 0
                          ? t('usage.unpriced_models', {
                              count: unpricedModels.length,
                              models: unpricedModels.slice(0, 3).join(', '),
                            })
                          : undefined
                      }
                    />
                  </div>

                  <GroupTable
                    rows={overview.rows}
                    totals={{
                      requests: overview.totals.requests,
                      tokens: overview.totals.tokens.total,
                      valueUsd: overview.totals.value.usd,
                      change:
                        state.metric === 'value' ? overview.change.value : overview.change.tokens,
                    }}
                    days={range.days}
                    filtered={Boolean(credentialFilter)}
                    onSelectCredential={selectCredential}
                  />

                  <BlocksTable
                    rows={blocks.rows}
                    tz={tz}
                    retentionDays={plugin.status?.retention.minuteDays ?? null}
                    clamped={data.blocks?.range.clamped ?? false}
                  />
                </>
              ) : state.view === 'providers' ? (
                <ProvidersView
                  pools={pools}
                  capacity={capacity.byAuthIndex}
                  onSelectCredential={selectCredential}
                />
              ) : (
                <section className={styles.panel}>
                  {accounts && accounts.accounts.length > 0 ? (
                    <AccountsTable
                      accounts={accounts.accounts}
                      showProvider
                      capacity={capacity.byAuthIndex}
                      label={t('usage.accounts_label')}
                      onSelectCredential={selectCredential}
                    />
                  ) : (
                    <p className={styles.note}>{t('usage.accounts_empty')}</p>
                  )}
                </section>
              )}

              {!overviewView && accounts && accounts.idle > 0 && (
                <p className={styles.note}>{t('usage.accounts_idle', { count: accounts.idle })}</p>
              )}

              <p className={styles.footnote}>
                {recordingSince
                  ? t('usage.recording_since', {
                      date: formatDay(dayInZone(Date.parse(recordingSince), tz), locale),
                    })
                  : t('usage.recording_none')}{' '}
                {pricesNote}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
