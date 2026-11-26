import { describe, expect, it } from 'vitest';
import { projectRetirement, summarizeRetirementCorpus, type RetirementAsset } from './retirement-engine';

const assets: RetirementAsset[] = [
  { id: 'funds', value: 1_000_000, classification: 'investable' },
  { id: 'cash', value: 200_000, classification: 'liquid' },
  { id: 'home', value: 3_000_000, classification: 'illiquid' },
  { id: 'goal', value: 500_000, classification: 'earmarked' },
  { id: 'esop', value: 400_000, classification: 'unvested' },
  { id: 'rsu', value: 300_000, classification: 'restricted' },
];

const base = {
  assets,
  liabilities: 250_000,
  currentAge: 35,
  retirementAge: 45,
  lifeExpectancy: 85,
  annualExpenses: 300_000,
  annualInflation: 0.06,
  expectedReturn: 0.1,
  withdrawalRate: 0.04,
  annualContribution: 300_000,
};

describe('retirement engine', () => {
  it('keeps ineligible classes visible and excludes them from FIRE corpus', () => {
    expect(summarizeRetirementCorpus(assets, 250_000)).toEqual({
      totalAssets: 5_400_000,
      netWorth: 5_150_000,
      investableCorpus: 1_200_000,
      fireEligibleCorpus: 1_200_000,
      restrictedAssets: 300_000,
      earmarkedAssets: 500_000,
      unvestedAssets: 400_000,
      illiquidAssets: 3_000_000,
      liabilities: 250_000,
    });
  });

  it('projects inflation-adjusted expenses and exposes assumptions', () => {
    const result = projectRetirement(base);
    expect(result.status).toBe('unreachable');
    expect(result.uncertainty).toBe('assumptions');
    expect(result.retirementExpenses).toBeCloseTo(537_254.309, 2);
    expect(result.requiredCorpusAtRetirement).toBeGreaterThan(0);
    expect(result.assumptions.annualInflation).toBe(0.06);
  });

  it('reports a zero manual target as unavailable instead of inventing a result', () => {
    const result = projectRetirement({ ...base, manualTargetCorpus: 0 });
    expect(result.status).toBe('unavailable');
    expect(result.reason).toBe('zero-target');
    expect(result.projectedCorpusAtRetirement).toBeNull();
  });

  it('includes debt in net worth but not as a negative eligible corpus', () => {
    const result = projectRetirement({ ...base, liabilities: 10_000_000 });
    expect(result.corpus.netWorth).toBe(-4_600_000);
    expect(result.corpus.fireEligibleCorpus).toBe(1_200_000);
  });

  it('marks a projection infeasible when the retirement corpus cannot cover the target', () => {
    const result = projectRetirement({ ...base, annualContribution: 0, expectedReturn: 0 });
    expect(result.status).toBe('unreachable');
    expect(result.shortfallAtRetirement).toBeGreaterThan(0);
    expect(result.sustainableThroughLifeExpectancy).toBe(false);
  });
});
