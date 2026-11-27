import { describe, expect, it } from 'vitest';
import { assessInsuranceNeeds, goalShortfallForInsurance, policyLifecycle, safeInsuranceSum, summarizePolicyCoverage } from './insurance-planning';
import { initializeState } from '../../types/state';
import type { InsurancePolicy } from '../../types/state';

const policy = (overrides: Partial<InsurancePolicy> = {}): InsurancePolicy => ({
  id: 'policy-1', kind: 'health', ownerType: 'personal', provider: 'Synthetic insurer', coverAmount: 2_000_000,
  annualPremium: 20_000, expiryDate: '2026-12-31', deductible: 0, topUpCover: 0, dependents: 1,
  waitingPeriodMonths: 0, exclusions: '', ...overrides,
});

describe('insurance planning', () => {
  it('classifies active, renewal and expired policies at the boundary', () => {
    const today = new Date('2026-01-01T00:00:00Z');
    expect(policyLifecycle(policy(), { today, renewalWindowDays: 60 }).status).toBe('active');
    expect(policyLifecycle(policy({ expiryDate: '2026-02-15' }), { today, renewalWindowDays: 60 }).status).toBe('expiring-soon');
    expect(policyLifecycle(policy({ expiryDate: '2025-12-31' }), { today }).status).toBe('expired');
    expect(policyLifecycle(policy({ expiryDate: 'not-a-date' }), { today }).status).toBe('unknown');
  });

  it('aggregates multiple active policies and health top-up without expired cover', () => {
    const coverage = summarizePolicyCoverage([
      policy({ id: 'base', coverAmount: 2_000_000 }),
      policy({ id: 'topup', coverAmount: 1_000_000, topUpCover: 3_000_000 }),
      policy({ id: 'expired', coverAmount: 10_000_000, expiryDate: '2025-01-01' }),
    ], { today: new Date('2026-01-01T00:00:00Z') });
    expect(coverage.health).toBe(6_000_000);
  });

  it('uses detailed policies as canonical and excludes deductible top-ups', () => {
    const result = assessInsuranceNeeds({
      annualIncome: 1_000_000, dependents: 0, outstandingDebt: 0, futureGoalShortfall: 0, accessibleAssets: 0,
      familySize: 1, currentTermCover: 10_000_000, currentHealthCover: 5_000_000,
      policies: [policy({ kind: 'term', coverAmount: 2_000_000 }), policy({ topUpCover: 10_000_000, deductible: 500_000 })],
    });
    expect(result.currentTermCover).toBe(2_000_000);
    expect(result.currentHealthCover).toBe(2_000_000);
    expect(result.assumptions.some((assumption) => assumption.includes('deductible'))).toBe(true);
  });

  it('excludes expired and malformed legacy summary cover', () => {
    const result = assessInsuranceNeeds({
      annualIncome: 1_000_000, dependents: 0, outstandingDebt: 0, futureGoalShortfall: 0, accessibleAssets: 0,
      familySize: 1, currentTermCover: 10_000_000, currentHealthCover: 2_000_000,
      legacyTermExpiryDate: '2025-01-01', legacyHealthExpiryDate: 'invalid',
    });
    expect(result.currentTermCover).toBe(0);
    expect(result.currentHealthCover).toBe(0);
  });

  it('fails closed when obligation aggregation overflows', () => {
    expect(safeInsuranceSum([Number.MAX_SAFE_INTEGER, 1])).toBeNull();
    const result = assessInsuranceNeeds({
      annualIncome: 1_000_000, dependents: 0, outstandingDebt: null, futureGoalShortfall: 0, accessibleAssets: 0,
      familySize: 1, currentTermCover: 0, currentHealthCover: 0,
    });
    expect(result.status).toBe('insufficient-data');
    expect(result.termGap).toBeNull();
  });

  it('calculates term needs from dependents, debt, goals and accessible assets', () => {
    const result = assessInsuranceNeeds({
      annualIncome: 1_200_000, dependents: 2, outstandingDebt: 2_000_000, futureGoalShortfall: 3_000_000,
      accessibleAssets: 1_000_000, familySize: 4, currentTermCover: 10_000_000, currentHealthCover: 10_000_000,
      healthCoverPerPerson: 1_000_000,
    });
    expect(result.requiredTermCover).toBe(20_800_000);
    expect(result.termGap).toBe(10_800_000);
    expect(result.requiredHealthCover).toBe(4_000_000);
    expect(result.healthGap).toBe(0);
    expect(result.assumptions.length).toBe(3);
  });

  it('fails closed when a linked goal asset has no current valuation', () => {
    const state = initializeState();
    state.goals = [{ id: 'home', name: 'Home', kind: 'home', targetToday: 1_000_000, targetDate: '2030-01', inflation: 'cpi', linkedAssetIds: ['fd:missing'], currentAmount: 0, priority: 1, riskBucket: 'medium' }];
    expect(goalShortfallForInsurance(state)).toBeNull();
  });
});
