import { describe, expect, test } from 'bun:test';
import type { UsageModelRow, UsagePrices, UsageTokens } from '@/services/api/usageLedger';
import {
  claudePlanId,
  codexPlanId,
  detectCredentialPlan,
  proratedPlanCost,
  resolveCredentialPlan,
  resolveModelPrice,
  tokensCostUsd,
  valueMultiple,
  valueOfModelRows,
} from '@/features/usage/cost';

const tokens = (partial: Partial<UsageTokens>): UsageTokens => {
  const base = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, unclassified: 0 };
  const merged = { ...base, ...partial };
  return {
    ...merged,
    total:
      merged.input +
      merged.cacheRead +
      merged.cacheWrite +
      merged.output +
      merged.reasoning +
      merged.unclassified,
  };
};

const prices: UsagePrices = {
  source: 'embedded',
  fetchedAt: null,
  sourceUrl: '',
  embeddedAsOf: '2026-10-27',
  lastAttemptAt: null,
  lastError: null,
  models: {
    'claude-opus-5-5': {
      provider: 'anthropic',
      mode: 'chat',
      input: 0.000004,
      output: 0.00002,
      cacheRead: 2e-7,
      cacheWrite: 0.000005,
      tiers: [],
      serviceTiers: {},
    },
    'chatgpt/gpt-5.5': {
      provider: 'openai',
      mode: 'chat',
      input: 0.000005,
      output: 0.00003,
      tiers: [],
      serviceTiers: { priority: { input: 0.00001, output: 0.00006 } },
    },
    'moonshot/kimi-k3': {
      provider: 'moonshot',
      mode: 'chat',
      input: 0.000001,
      output: 0.000004,
      reasoning: 0.000002,
      tiers: [],
      serviceTiers: {},
    },
  },
  plans: {
    claude: {
      max_5x: {
        name: 'Claude Max 5x',
        monthlyPrice: 100,
        currency: 'USD',
        billing: 'per_account',
        asOf: '2026-10-27',
        sourceUrl: '',
        verified: true,
      },
    },
    codex: {
      pro: {
        name: 'ChatGPT Pro',
        monthlyPrice: 200,
        currency: 'USD',
        billing: 'per_account',
        asOf: '2026-10-27',
        sourceUrl: '',
        verified: false,
      },
    },
  },
  plansAsOf: '2026-10-27',
  overrides: null,
};

const row = (model: string, t: Partial<UsageTokens>, serviceTier = 'auto'): UsageModelRow => ({
  model,
  serviceTier,
  requests: 1,
  failed: 0,
  tokens: tokens(t),
});

describe('resolveModelPrice', () => {
  test('exact, provider-prefixed, and dated names', () => {
    expect(resolveModelPrice('claude-opus-5-5', 'claude', prices)?.matchedKey).toBe(
      'claude-opus-5-5'
    );
    expect(resolveModelPrice('gpt-5.5', 'codex', prices)?.matchedKey).toBe('chatgpt/gpt-5.5');
    expect(resolveModelPrice('claude-opus-5-5-20261001', null, prices)?.matchedKey).toBe(
      'claude-opus-5-5'
    );
    expect(resolveModelPrice('gpt-5.5-2026-09-01', null, prices)?.matchedKey).toBe(
      'chatgpt/gpt-5.5'
    );
    expect(resolveModelPrice('kimi-k3', 'kimi', prices)?.matchedKey).toBe('moonshot/kimi-k3');
    expect(resolveModelPrice('mystery-1', 'claude', prices)).toBeNull();
  });

  test('a shared override wins over the price table', () => {
    const price = resolveModelPrice('claude-opus-5-5', 'claude', prices, {
      'claude-opus-5-5': { input: 1, output: 2 },
    });
    expect(price).toMatchObject({ input: 1, output: 2, matchedKey: 'claude-opus-5-5' });
  });
});

describe('token value', () => {
  test('each class at its own rate; reasoning falls back to output', () => {
    const price = resolveModelPrice('claude-opus-5-5', 'claude', prices)!;
    const usd = tokensCostUsd(
      tokens({
        input: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite: 1_000_000,
        output: 1_000_000,
        reasoning: 1_000_000,
      }),
      price
    );
    // 4 + 0.2 + 5 + 20 + 20
    expect(usd).toBeCloseTo(49.2, 6);
  });

  test('a model without a cache price charges cached tokens as input', () => {
    const price = resolveModelPrice('gpt-5.5', 'codex', prices)!;
    expect(tokensCostUsd(tokens({ cacheRead: 1_000_000 }), price)).toBeCloseTo(5, 6);
  });

  test('priority service tier uses its own prices; separate reasoning price is honoured', () => {
    const gpt = resolveModelPrice('gpt-5.5', 'codex', prices)!;
    expect(tokensCostUsd(tokens({ output: 1_000_000 }), gpt, 'priority')).toBeCloseTo(60, 6);
    const kimi = resolveModelPrice('kimi-k3', 'kimi', prices)!;
    expect(tokensCostUsd(tokens({ reasoning: 1_000_000 }), kimi)).toBeCloseTo(2, 6);
  });

  test('rows add up and unknown models are reported, not guessed', () => {
    const value = valueOfModelRows(
      [
        row('claude-opus-5-5', { output: 1_000_000, unclassified: 10 }),
        row('mystery-1', { input: 500 }),
      ],
      'claude',
      prices
    );
    expect(value.usd).toBeCloseTo(20, 6);
    expect(value.unpricedTokens).toBe(500);
    expect(value.unpricedModels).toEqual(['mystery-1']);
    expect(value.unclassifiedTokens).toBe(10);
  });
});

describe('plans', () => {
  test('Claude plan from profile and rate_limit_tier', () => {
    expect(claudePlanId('plan_max', 'default_claude_max_20x')).toBe('max_20x');
    expect(claudePlanId('plan_max', 'default_claude_max_5x')).toBe('max_5x');
    expect(claudePlanId(null, 'default_claude_max_5x')).toBe('max_5x');
    expect(claudePlanId('plan_max', null)).toBeNull();
    expect(claudePlanId('plan_pro', 'default_claude_ai')).toBe('pro');
    expect(claudePlanId('plan_free', null)).toBeNull();
  });

  test('Codex plan from plan_type, preferring the fetched value', () => {
    expect(codexPlanId('Pro')).toBe('pro');
    expect(codexPlanId('self_serve_business_prolite')).toBe('prolite');
    expect(codexPlanId('free')).toBeNull();
    expect(
      detectCredentialPlan({
        type: 'codex',
        planType: null,
        observedPlanType: 'plus',
        filePlanType: 'pro',
      })
    ).toEqual({ provider: 'codex', plan: 'plus' });
    expect(detectCredentialPlan({ type: 'kimi' })).toBeNull();
  });

  test('an override beats detection; detection needs a listed plan', () => {
    const detected = resolveCredentialPlan(
      'a1',
      { provider: 'claude', plan: 'max_5x' },
      prices,
      null
    );
    expect(detected).toMatchObject({ monthlyPrice: 100, source: 'detected', verified: true });
    expect(
      resolveCredentialPlan('a1', { provider: 'claude', plan: 'max_9x' }, prices, null)
    ).toBeNull();
    const overridden = resolveCredentialPlan('a1', { provider: 'claude', plan: 'max_5x' }, prices, {
      planOverrides: { a1: { provider: 'claude', plan: 'max_20x', monthlyPrice: 180 } },
      defaultCurrency: 'EUR',
    });
    expect(overridden).toMatchObject({ monthlyPrice: 180, currency: 'EUR', source: 'override' });
  });

  test('prorating and the value multiple', () => {
    const day = 24 * 3_600_000;
    const week = proratedPlanCost(100, 0, 7 * day);
    expect(week).toBeCloseTo((100 * 7) / (365.25 / 12), 6);
    expect(proratedPlanCost(100, 10, 10)).toBe(0);
    expect(valueMultiple(46, 23, 'USD')).toBe(2);
    expect(valueMultiple(46, 23, 'EUR')).toBeNull();
    expect(valueMultiple(46, 0, 'USD')).toBeNull();
  });
});
