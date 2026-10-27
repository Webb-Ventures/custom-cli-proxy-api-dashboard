/**
 * API-equivalent value of recorded tokens, and what each credential's plan
 * costs over the same range, so usage can be read as value against subscription.
 *
 * Model prices are USD per token from the usage ledger (LiteLLM), with shared
 * overrides first. Plan prices come from the ledger's bundled plan file; a
 * per-credential override wins over the plan detected from the provider.
 *
 * Aggregates cannot apply LiteLLM's above-N-token prompt tiers (they depend on
 * each request's prompt size), so long-context requests are valued at base rates.
 */

import type {
  ModelPrice,
  PlanPrice,
  TokenPrices,
  UsageLedgerSettings,
  UsageModelRow,
  UsagePrices,
  UsageTokens,
} from '@/services/api/usageLedger';
import { normalizePlanType } from '@/utils/quota/parsers';

/** LiteLLM key prefixes to try per credential provider, in order. */
const PROVIDER_PREFIXES: Record<string, readonly string[]> = {
  claude: ['anthropic/'],
  anthropic: ['anthropic/'],
  codex: ['chatgpt/', 'openai/'],
  openai: ['openai/'],
  kimi: ['moonshot/'],
  xai: ['xai/'],
  gemini: ['gemini/'],
  vertex: ['vertex_ai/'],
  antigravity: ['gemini/', 'vertex_ai/'],
  deepseek: ['deepseek/'],
};

const ALL_PREFIXES = Array.from(new Set(Object.values(PROVIDER_PREFIXES).flat()));

/** Dated responses: `claude-opus-5-5-20261001`, `gpt-5.5-2026-09-01`. */
const DATE_SUFFIX = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

export type ResolvedPrice = (ModelPrice | TokenPrices) & { matchedKey: string };

/**
 * Price for a model as the upstream reported it. Overrides first, then the exact
 * LiteLLM key, then provider-prefixed keys, then the same without a date suffix.
 */
export function resolveModelPrice(
  model: string,
  provider: string | null,
  prices: Pick<UsagePrices, 'models'> | null,
  overrides: UsageLedgerSettings['modelPriceOverrides'] = {}
): ResolvedPrice | null {
  if (!model) return null;
  const undated = model.replace(DATE_SUFFIX, '');
  const names = undated === model ? [model] : [model, undated];

  for (const name of names) {
    if (overrides[name]) return { ...overrides[name], matchedKey: name };
  }
  if (!prices) return null;

  const prefixes = (provider && PROVIDER_PREFIXES[provider.toLowerCase()]) || ALL_PREFIXES;
  for (const name of names) {
    const candidates = [name, ...prefixes.map((prefix) => `${prefix}${name}`)];
    for (const key of candidates) {
      const price = prices.models[key];
      if (price) return { ...price, matchedKey: key };
    }
  }
  return null;
}

const isPriced = (price: TokenPrices) => price.input !== undefined || price.output !== undefined;

export const TOKEN_CLASSES = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const;
export type TokenClass = (typeof TOKEN_CLASSES)[number];
export type TokenClassUsd = Record<TokenClass, number>;

const zeroClasses = (): TokenClassUsd => ({
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
});

/** USD per token class for one model row. Unclassified tokens are not priced. */
export function tokenClassCostsUsd(
  tokens: UsageTokens,
  price: ResolvedPrice,
  serviceTier = ''
): TokenClassUsd {
  const tierPrices =
    'serviceTiers' in price
      ? serviceTier === 'priority'
        ? price.serviceTiers.priority
        : serviceTier === 'flex'
          ? price.serviceTiers.flex
          : undefined
      : undefined;
  const rate = (field: keyof TokenPrices) => tierPrices?.[field] ?? price[field];
  const input = rate('input') ?? 0;
  const output = rate('output') ?? 0;
  // A model without a cache price has no discount: its cached tokens cost as input.
  const cacheRead = rate('cacheRead') ?? input;
  const cacheWrite = rate('cacheWrite') ?? input;
  const reasoning = ('reasoning' in price ? price.reasoning : undefined) ?? output;
  return {
    input: tokens.input * input,
    cacheRead: tokens.cacheRead * cacheRead,
    cacheWrite: tokens.cacheWrite * cacheWrite,
    output: tokens.output * output,
    reasoning: tokens.reasoning * reasoning,
  };
}

/** USD for one model row's tokens. */
export function tokensCostUsd(tokens: UsageTokens, price: ResolvedPrice, serviceTier = ''): number {
  const costs = tokenClassCostsUsd(tokens, price, serviceTier);
  return TOKEN_CLASSES.reduce((sum, key) => sum + costs[key], 0);
}

export interface UsageValue {
  usd: number;
  byClass: TokenClassUsd;
  /** Tokens on models with no price; excluded from `usd`. */
  unpricedTokens: number;
  unpricedModels: string[];
  /** Unclassified tokens, which have no price class. */
  unclassifiedTokens: number;
}

export const EMPTY_VALUE: UsageValue = {
  usd: 0,
  byClass: zeroClasses(),
  unpricedTokens: 0,
  unpricedModels: [],
  unclassifiedTokens: 0,
};

/** API-equivalent value of a usage block's per-model rows. */
export function valueOfModelRows(
  rows: readonly UsageModelRow[],
  provider: string | null,
  prices: UsagePrices | null,
  overrides?: UsageLedgerSettings['modelPriceOverrides']
): UsageValue {
  let usd = 0;
  const byClass = zeroClasses();
  let unpricedTokens = 0;
  let unclassifiedTokens = 0;
  const unpriced = new Set<string>();
  rows.forEach((row) => {
    unclassifiedTokens += row.tokens.unclassified;
    const price = resolveModelPrice(
      row.model,
      provider,
      prices,
      overrides ?? prices?.overrides?.modelPriceOverrides
    );
    if (!price || !isPriced(price)) {
      unpricedTokens += row.tokens.total - row.tokens.unclassified;
      if (row.model) unpriced.add(row.model);
      return;
    }
    const costs = tokenClassCostsUsd(row.tokens, price, row.serviceTier);
    TOKEN_CLASSES.forEach((key) => {
      byClass[key] += costs[key];
      usd += costs[key];
    });
  });
  return {
    usd,
    byClass,
    unpricedTokens,
    unpricedModels: Array.from(unpriced).sort(),
    unclassifiedTokens,
  };
}

export function addValues(a: UsageValue, b: UsageValue): UsageValue {
  return {
    usd: a.usd + b.usd,
    byClass: Object.fromEntries(
      TOKEN_CLASSES.map((key) => [key, a.byClass[key] + b.byClass[key]])
    ) as TokenClassUsd,
    unpricedTokens: a.unpricedTokens + b.unpricedTokens,
    unpricedModels: Array.from(new Set([...a.unpricedModels, ...b.unpricedModels])).sort(),
    unclassifiedTokens: a.unclassifiedTokens + b.unclassifiedTokens,
  };
}

/* ---------- Plans ---------- */

/** Plan file id for a Claude account from its profile plan and `rate_limit_tier`. */
export function claudePlanId(
  planType: string | null | undefined,
  rateLimitTier: string | null | undefined
): string | null {
  const tier = (rateLimitTier ?? '').toLowerCase();
  if (planType === 'plan_max' || tier.includes('max')) {
    if (tier.includes('20x')) return 'max_20x';
    if (tier.includes('5x')) return 'max_5x';
    return null;
  }
  if (planType === 'plan_pro') return 'pro';
  if (planType === 'plan_team') return 'team_standard';
  return null;
}

const CODEX_PLAN_IDS: Record<string, string> = {
  plus: 'plus',
  pro: 'pro',
  prolite: 'prolite',
  'pro-lite': 'prolite',
  pro_lite: 'prolite',
  self_serve_business_prolite: 'prolite',
  business: 'business',
  team: 'team',
};

/** Plan file id for a Codex account from its `plan_type`. */
export function codexPlanId(planType: string | null | undefined): string | null {
  const normalized = normalizePlanType(planType);
  return normalized ? (CODEX_PLAN_IDS[normalized] ?? null) : null;
}

export interface CredentialPlan {
  provider: string;
  plan: string;
  name: string;
  monthlyPrice: number;
  currency: string;
  billing: PlanPrice['billing'];
  /** Price not confirmed on the provider's own page. */
  verified: boolean;
  source: 'override' | 'detected';
}

/**
 * The plan a credential pays for: its override, else the detected plan priced
 * from the plan file. Null when neither is known (shown as "set a plan").
 */
export function resolveCredentialPlan(
  authIndex: string,
  detected: { provider: string; plan: string } | null,
  prices: Pick<UsagePrices, 'plans'> | null,
  settings: Pick<UsageLedgerSettings, 'planOverrides' | 'defaultCurrency'> | null
): CredentialPlan | null {
  const override = settings?.planOverrides[authIndex];
  if (override) {
    const listed = prices?.plans[override.provider]?.[override.plan];
    return {
      provider: override.provider,
      plan: override.plan,
      name: listed?.name || override.plan,
      monthlyPrice: override.monthlyPrice,
      currency: override.currency || settings?.defaultCurrency || 'USD',
      billing: listed?.billing ?? 'per_account',
      verified: true,
      source: 'override',
    };
  }
  if (!detected) return null;
  const listed = prices?.plans[detected.provider]?.[detected.plan];
  if (!listed) return null;
  return {
    provider: detected.provider,
    plan: detected.plan,
    name: listed.name,
    monthlyPrice: listed.monthlyPrice,
    currency: listed.currency,
    billing: listed.billing,
    verified: listed.verified,
    source: 'detected',
  };
}

const AVERAGE_MONTH_MS = (365.25 / 12) * 24 * 3_600_000;

/** A monthly price spread evenly over `[fromMs, toMs)`. */
export function proratedPlanCost(monthlyPrice: number, fromMs: number, toMs: number): number {
  if (!(toMs > fromMs)) return 0;
  return (monthlyPrice * (toMs - fromMs)) / AVERAGE_MONTH_MS;
}

/**
 * How many times over the plan paid for itself: API value divided by the plan's
 * share of the range. Null without a comparable USD plan cost.
 */
export function valueMultiple(
  valueUsd: number,
  planCost: number,
  planCurrency: string
): number | null {
  if (planCurrency !== 'USD' || !(planCost > 0)) return null;
  return valueUsd / planCost;
}

/** What the provider tells us about a credential's plan, without a fetch of its own. */
export interface PlanEvidence {
  type: string;
  /** Profile plan (`plan_max`, …) for Claude; `plan_type` for Codex. */
  planType?: string | null;
  rateLimitTier?: string | null;
  /** Codex `x-codex-plan-type` from traffic. */
  observedPlanType?: string | null;
  /** Codex plan claim from the credential file. */
  filePlanType?: string | null;
}

/** Plan file `{provider, plan}` for a credential; null when the plan is not known. */
export function detectCredentialPlan(
  evidence: PlanEvidence
): { provider: string; plan: string } | null {
  if (evidence.type === 'claude') {
    const plan = claudePlanId(evidence.planType, evidence.rateLimitTier);
    return plan ? { provider: 'claude', plan } : null;
  }
  if (evidence.type === 'codex') {
    const plan = codexPlanId(
      evidence.planType ?? evidence.observedPlanType ?? evidence.filePlanType
    );
    return plan ? { provider: 'codex', plan } : null;
  }
  return null;
}

/** Settings with one credential's plan override set, or removed when `override` is null. */
export function withPlanOverride(
  settings: UsageLedgerSettings,
  authIndex: string,
  override: UsageLedgerSettings['planOverrides'][string] | null
): UsageLedgerSettings {
  const planOverrides = { ...settings.planOverrides };
  if (override) planOverrides[authIndex] = override;
  else delete planOverrides[authIndex];
  return { ...settings, planOverrides };
}
