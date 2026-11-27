import type { InsurancePolicy, InsurancePolicyKind } from '../../types/state';

export type PolicyLifecycle = 'active' | 'expiring-soon' | 'expired' | 'no-expiry' | 'unknown';

export interface InsuranceNeedsInput {
  annualIncome: number;
  dependents: number;
  outstandingDebt: number;
  futureGoalShortfall: number;
  accessibleAssets: number;
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
  requiredTermCover: number;
  currentTermCover: number;
  termGap: number;
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
  const expiry = Date.parse(policy.expiryDate);
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
  const debt = validAmount(input.outstandingDebt);
  const goalShortfall = validAmount(input.futureGoalShortfall);
  const accessibleAssets = validAmount(input.accessibleAssets);
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
    requiredTermCover,
    currentTermCover,
    termGap: Math.max(0, requiredTermCover - currentTermCover),
    requiredHealthCover,
    currentHealthCover,
    healthGap: Math.max(0, requiredHealthCover - currentHealthCover),
    assumptions: [
      'Term need uses ten years of income replacement plus dependents, debt and future-goal shortfall, less accessible assets.',
      `Health need uses ₹${Math.round(perPerson / 100_000)}L per family member; adjust this assumption for your household and care needs.`,
      'Employer cover is included only while its policy expiry is not past; verify portability before relying on it.',
      ...(hasConditionalTopUp ? ['Top-up cover with a deductible is excluded from usable cover until the deductible is reviewed.'] : []),
    ],
  };
}

function isActiveExpiry(expiryDate: string, today = new Date()): boolean {
  const expiry = Date.parse(expiryDate);
  return Number.isFinite(expiry) && expiry >= today.getTime();
}
