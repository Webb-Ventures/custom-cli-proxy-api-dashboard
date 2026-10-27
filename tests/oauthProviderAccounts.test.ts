import { describe, expect, test } from 'bun:test';
import type { SummarizedHeadroom } from '@/features/quota/freshness';
import { summarizeHeadroom, type HeadroomWindow } from '@/features/quota/headroom';
import type { QuotaFileEntry } from '@/features/quota/logic';
import {
  OAUTH_QUOTA_TYPES,
  providerAccountsLine,
  summarizeProviderAccounts,
} from '@/features/oauth/providerAccounts';
import type { AuthFileCooldownSnapshot } from '@/types';

const HOUR = 3_600_000;
const now = Date.parse('2026-10-27T12:00:00Z');

const windowAt = (
  usedPercent: number,
  periodHours: number,
  elapsedHours: number
): HeadroomWindow => ({
  id: 'five-hour',
  label: '5-hour limit',
  usedPercent,
  periodHours,
  resetAtMs: now + (periodHours - elapsedHours) * HOUR,
});

const cooldown: AuthFileCooldownSnapshot = {
  receivedAtMs: now,
  records: [{ scope: 'credential', reason: 'quota', retryAt: '', remainingSeconds: 600 }],
};

const entry = (type: QuotaFileEntry['type'], name: string): QuotaFileEntry => ({
  type,
  file: { name },
});

const headroomOf = (
  windows: HeadroomWindow[],
  blocked?: AuthFileCooldownSnapshot
): SummarizedHeadroom => ({
  summary: summarizeHeadroom({ windows, cooldown: blocked, now }),
  seenAtMs: now,
  seenFrom: 'traffic',
});

const labelOf = (window: HeadroomWindow) => window.label ?? window.id;

describe('summarizeProviderAccounts', () => {
  const readings: Record<string, SummarizedHeadroom | undefined> = {
    calm: headroomOf([windowAt(20, 5, 2.5)]),
    busy: headroomOf([windowAt(70, 5, 2)]),
    cool: headroomOf([windowAt(10, 5, 1)], cooldown),
  };
  const lookup = (item: QuotaFileEntry) => readings[item.file.name];

  test('counts accounts per type and keeps the most constrained reading', () => {
    const byType = summarizeProviderAccounts(
      [entry('claude', 'calm'), entry('claude', 'busy'), entry('codex', 'none')],
      lookup
    );
    expect(byType.get('claude')?.count).toBe(2);
    expect(byType.get('claude')?.blocked).toBe(0);
    expect(byType.get('claude')?.tightest?.tightest?.usedPercent).toBe(70);
    expect(byType.get('codex')).toEqual({ count: 1, blocked: 0, tightest: null });
  });

  test('Kimi sites share a credential type, so neither tile maps to it', () => {
    expect(OAUTH_QUOTA_TYPES.kimi).toBeUndefined();
    expect(OAUTH_QUOTA_TYPES['kimi-ai']).toBeUndefined();
    expect(OAUTH_QUOTA_TYPES.anthropic).toBe('claude');
  });

  describe('providerAccountsLine', () => {
    const line = (names: string[]) =>
      providerAccountsLine(
        summarizeProviderAccounts(
          names.map((name) => entry('claude', name)),
          lookup
        ).get('claude'),
        labelOf
      );

    test('nothing signed in shows nothing', () => {
      expect(providerAccountsLine(undefined, labelOf)).toBeNull();
    });

    test('accounts without readings show only the count', () => {
      expect(line(['unknown'])).toEqual({ key: 'auth_login.tile_accounts', params: { count: 1 } });
    });

    test('the tightest limit, flagged when it runs out before reset', () => {
      expect(line(['calm'])).toEqual({
        key: 'auth_login.tile_accounts_limit',
        params: { count: 1, window: '5-hour limit', used: 20 },
        tone: undefined,
      });
      expect(line(['calm', 'busy'])?.tone).toBe('bad');
    });

    test('a single blocked account says why; several count the unavailable ones', () => {
      expect(line(['cool'])).toMatchObject({
        key: 'auth_login.tile_accounts_cooling',
        tone: 'bad',
      });
      expect(line(['cool', 'calm'])).toEqual({
        key: 'auth_login.tile_accounts_unavailable',
        params: { count: 2, blocked: 1 },
        tone: 'warn',
      });
    });
  });
});
