import type { FireOSState, InsurancePolicy, InsurancePolicyKind } from '../../types/state';
import { allocateGoalAssets, planGoal } from '../plan/goal-planning';

export type PolicyLifecycle = 'active' | 'expiring-soon' | 'expired' | 'no-expiry' | 'unknown';

export interface InsuranceNeedsInput {
  annualIncome: number;
  dependents: number;
  outstandingDebt: number | null;
  futureGoalShortfall: number | null;
  accessibleAssets: number | null;
  familySize: number;
  currentTermCover: number;
  currentHealthCover: number;
  legacyTermExpiryDate?: string;
  legacyHealthExpiryDate?: string;
  policies?: readonly InsurancePolicy[];
  today?: Date;
  renewalWindowDays?: number;
  healthCoverPerPerson?: number;
}

export interface InsuranceNeeds {
  status: 'available' | 'insufficient-data';
  requiredTermCover: number | null;
  currentTermCover: number;
  termGap: number | null;
  requiredHealthCover: number;
  currentHealthCover: number;
  healthGap: number;
  assumptions: string[];
}

export interface PolicyLifecycleResult {
  policy: InsurancePolicy;
  status: PolicyLifecycle;
  daysRemaining: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function validAmount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function policyLifecycle(policy: InsurancePolicy, options: { today?: Date; renewalWindowDays?: number } = {}): PolicyLifecycleResult {
  const today = options.today ?? new Date();
  const renewalWindowDays = options.renewalWindowDays ?? 60;
  if (!policy.expiryDate) return { policy, status: 'no-expiry', daysRemaining: null };
  const expiry = parseExpiry(policy.expiryDate);
  if (!Number.isFinite(expiry)) return { policy, status: 'unknown', daysRemaining: null };
  const daysRemaining = Math.ceil((expiry - today.getTime()) / DAY_MS);
  if (daysRemaining < 0) return { policy, status: 'expired', daysRemaining };
  if (daysRemaining <= renewalWindowDays) return { policy, status: 'expiring-soon', daysRemaining };
  return { policy, status: 'active', daysRemaining };
}

export function summarizePolicyCoverage(policies: readonly InsurancePolicy[] = [], options: { today?: Date } = {}): Record<InsurancePolicyKind, number> {
  const result: Record<InsurancePolicyKind, number> = { term: 0, health: 0, vehicle: 0 };
  for (const policy of policies) {
    const lifecycle = policyLifecycle(policy, options);
    if (lifecycle.status === 'expired' || lifecycle.status === 'unknown') continue;
    const topUp = policy.kind === 'health' && policy.deductible <= 0 ? validAmount(policy.topUpCover) : 0;
    result[policy.kind] += validAmount(policy.coverAmount) + topUp;
  }
  return result;
}

/**
 * Calculates a transparent protection gap from user-entered assumptions.
 * This is planning guidance, not a universal coverage recommendation.
 */
export function assessInsuranceNeeds(input: InsuranceNeedsInput): InsuranceNeeds {
  const annualIncome = validAmount(input.annualIncome);
  const debt = validAmount(input.outstandingDebt ?? 0);
  const goalShortfall = validAmount(input.futureGoalShortfall ?? 0);
  const accessibleAssets = validAmount(input.accessibleAssets ?? 0);
  const incomplete = input.outstandingDebt === null || input.futureGoalShortfall === null || input.accessibleAssets === null;
  const dependents = Math.max(0, Math.floor(input.dependents || 0));
  const familySize = Math.max(1, Math.floor(input.familySize || 1));
  const policyCoverage = summarizePolicyCoverage(input.policies, { today: input.today });
  const hasDetailedPolicies = (input.policies?.length ?? 0) > 0;
  const legacyTermActive = !input.legacyTermExpiryDate || isActiveExpiry(input.legacyTermExpiryDate, input.today);
  const legacyHealthActive = !input.legacyHealthExpiryDate || isActiveExpiry(input.legacyHealthExpiryDate, input.today);
  const currentTermCover = hasDetailedPolicies ? policyCoverage.term : legacyTermActive ? validAmount(input.currentTermCover) : 0;
  const currentHealthCover = hasDetailedPolicies ? policyCoverage.health : legacyHealthActive ? validAmount(input.currentHealthCover) : 0;
  const incomeReplacement = annualIncome * 10;
  const dependentBuffer = dependents * Math.max(annualIncome, 0) * 2;
  const requiredTermCover = annualIncome > 0
    ? Math.max(10_000_000, incomeReplacement + dependentBuffer + debt + goalShortfall - accessibleAssets)
    : Math.max(0, dependentBuffer + debt + goalShortfall - accessibleAssets);
  const perPerson = validAmount(input.healthCoverPerPerson ?? 0) || 1_000_000;
  const requiredHealthCover = familySize * perPerson;
  const hasConditionalTopUp = (input.policies ?? []).some((policy) => policy.kind === 'health' && policy.topUpCover > 0 && policy.deductible > 0);
  return {
    status: incomplete ? 'insufficient-data' : 'available',
    requiredTermCover: incomplete ? null : requiredTermCover,
    currentTermCover,
    termGap: incomplete ? null : Math.max(0, requiredTermCover - currentTermCover),
    requiredHealthCover,
    currentHealthCover,
    healthGap: Math.max(0, requiredHealthCover - currentHealthCover),
    assumptions: [
      'Term need uses ten years of income replacement plus dependents, debt and future-goal shortfall, less accessible assets.',
      `Health need uses ₹${Math.round(perPerson / 100_000)}L per family member; adjust this assumption for your household and care needs.`,
      'Employer cover is included only while its policy expiry is not past; verify portability before relying on it.',
      ...(incomplete ? ['Some debt, goal or accessible-asset values are unavailable; term-cover gap is not fully assessable.'] : []),
      ...(hasConditionalTopUp ? ['Top-up cover with a deductible is excluded from usable cover until the deductible is reviewed.'] : []),
    ],
  };
}

/** Return a bounded sum, or null when a source is unavailable/overflows. */
export function safeInsuranceSum(values: readonly number[]): number | null {
  let total = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0 || total + value > Number.MAX_SAFE_INTEGER) return null;
    total += value;
  }
  return total;
}

/** Derive goal shortfall using the same priority allocation as the Goals route. */
export function goalShortfallForInsurance(state: FireOSState): number | null {
  const values: Record<string, number> = {};
  const add = (kind: string, id: string, value: number) => {
    if (Number.isFinite(value) && value > 0) values[`${kind}:${id}`] = value;
  };
  const navValue = (schemeCode: string | undefined): number => {
    const nav = schemeCode ? state.nav[schemeCode] : undefined;
    if (!nav || nav.status === 'stale' || !Number.isFinite(nav.nav) || nav.nav <= 0) return 0;
    const timestamp = Date.parse(nav.timestamp);
    return Number.isFinite(timestamp) && timestamp <= Date.now() && Date.now() - timestamp <= nav.ttl ? nav.nav : 0;
  };
  Object.entries(state.sip).forEach(([id, holding]) => add('sip', id, holding.units * navValue(holding.schemeCode)));
  Object.entries(state.mf).forEach(([id, holding]) => add('mf', id, holding.units * navValue(holding.schemeCode)));
  Object.entries(state.fd).forEach(([id, holding]) => add('fd', id, holding.amount));
  Object.entries(state.epf).forEach(([id, holding]) => add('epf', id, holding.amount));
  Object.entries(state.esop).forEach(([id, holding]) => add('esop', id, holding.amount));
  Object.entries(state.bonds).forEach(([id, holding]) => add('bonds', id, holding.amount));
  Object.entries(state.demat).forEach(([id, holding]) => add('demat', id, holding.currentValue));
  Object.entries(state.otherHoldings).forEach(([id, holding]) => add('other', id, holding.amount));
  for (const goal of state.goals ?? []) {
    for (const rawAssetId of goal.linkedAssetIds) {
      const exact = values[rawAssetId];
      const matches = Object.keys(values).filter((candidate) => candidate.endsWith(`:${rawAssetId}`));
      if ((Number.isFinite(exact) && exact > 0) || matches.length === 1) continue;
      return null;
    }
  }
  const allocation = allocateGoalAssets(state.goals ?? [], values);
  if (allocation.invalidAssetIds.length > 0) return null;
  const shortfalls = (state.goals ?? []).map((goal) => {
    const plan = planGoal({ ...goal, currentAmount: goal.currentAmount + (allocation.allocatedByGoal[goal.id] ?? 0) });
    return plan.status === 'missing-data' ? null : plan.shortfallAtDate;
  });
  return shortfalls.some((value) => value === null) ? null : safeInsuranceSum(shortfalls as number[]);
}

function isActiveExpiry(expiryDate: string, today = new Date()): boolean {
  const expiry = parseExpiry(expiryDate);
  return Number.isFinite(expiry) && expiry >= today.getTime();
}

function parseExpiry(expiryDate: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)) {
    const [year, month, day] = expiryDate.split('-').map(Number);
    const localDate = new Date(year, month - 1, day, 23, 59, 59, 999);
    if (localDate.getFullYear() !== year || localDate.getMonth() !== month - 1 || localDate.getDate() !== day) return NaN;
    return localDate.getTime();
  }
  return Date.parse(expiryDate);
}
