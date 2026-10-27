/**
 * 额度水位条（原 QuotaProgressBar 的类型化后继）。
 *
 * dataviz 语法：细轨道退居背景，填充按剩余量三档着色（≥70 绿 / ≥30 琥珀 / <30 红），
 * percent === null 渲染空轨道 —— 未知不着色（Medium 类在 width 0 下不可见，行为与旧版一致）。
 * `index` 写入 `--meter-index`，供全页外衣做逐行入场级差；紧凑外衣不消费该变量。
 *
 * Usage mode (`usage`): the fill shows percent USED, a marker shows how much of the
 * window has elapsed, and a hatch shows the projected use by reset. Color follows
 * pace rather than the absolute level, and the meter carries its own accessible label.
 */

import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  quotaMeterModel,
  round2,
  toneFromRemaining,
  type QuotaMeterTone,
  type QuotaMeterUsage,
} from '../quotaMeterModel';
import type { QuotaClassMap } from '../types';

const TONE_VARS: Record<QuotaMeterTone, string> = {
  high: 'var(--viz-success)',
  medium: 'var(--quota-medium-color)',
  low: 'var(--viz-failure)',
};

export interface QuotaMeterProps {
  /** Remaining percent (legacy mode); ignored when `usage` is given. */
  percent?: number | null;
  /** Percent-used mode with pace. */
  usage?: QuotaMeterUsage;
  classes: QuotaClassMap;
  index?: number;
}

export function QuotaMeter({ percent = null, usage, classes, index }: QuotaMeterProps) {
  const { t } = useTranslation();
  const toneClass: Record<QuotaMeterTone, string> = {
    high: classes.quotaBarFillHigh,
    medium: classes.quotaBarFillMedium,
    low: classes.quotaBarFillLow,
  };

  const fillStyle = (widthPercent: number) => {
    const style: CSSProperties & { '--meter-index'?: number } = { width: `${widthPercent}%` };
    if (index !== undefined) {
      style['--meter-index'] = index;
    }
    return style;
  };

  if (!usage) {
    const normalized = percent === null ? null : Math.min(100, Math.max(0, percent));
    const fillClass =
      normalized === null ? classes.quotaBarFillMedium : toneClass[toneFromRemaining(normalized)];
    return (
      <div className={classes.quotaBar}>
        <div
          className={`${classes.quotaBarFill} ${fillClass}`}
          style={fillStyle(round2(normalized ?? 0))}
        />
      </div>
    );
  }

  const model = quotaMeterModel(usage);
  const used = Math.round(model.fillPercent);
  const label =
    model.pacePercent === null
      ? t('quota_management.meter_used', { used })
      : t(
          model.runsOut
            ? 'quota_management.meter_used_with_pace_runs_out'
            : 'quota_management.meter_used_with_pace',
          { used, elapsed: Math.round(model.pacePercent) }
        );
  const trackStyle: CSSProperties & { '--meter-tone'?: string } = {
    '--meter-tone': TONE_VARS[model.tone],
  };

  return (
    <div
      className={classes.quotaBar}
      style={trackStyle}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={used}
      aria-valuetext={label}
      aria-label={label}
    >
      <div
        className={`${classes.quotaBarFill} ${toneClass[model.tone]}`}
        style={fillStyle(model.fillPercent)}
      />
      {model.projection && (
        <div
          className={classes.quotaBarProjection}
          style={{
            left: `${model.projection.leftPercent}%`,
            width: `${model.projection.widthPercent}%`,
          }}
          aria-hidden="true"
        />
      )}
      {model.pacePercent !== null && (
        <div
          className={classes.quotaBarPace}
          style={{ left: `${model.pacePercent}%` }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
