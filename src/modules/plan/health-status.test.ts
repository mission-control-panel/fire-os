import { describe, expect, it } from 'vitest';
import { initializeState } from '../../types/state';
import { assessHealth } from './health-status';

describe('financial health assessment', () => {
  it('keeps missing runway inputs explicit and actionable', () => {
    const assessment = assessHealth(initializeState());
    expect(assessment.dimensions.liquidity).toBe('yellow');
    expect(assessment.details).toContain('Add essential monthly expenses to calculate emergency runway.');
  });

  it('flags a short accessible runway without treating restricted assets as cash', () => {
    const state = initializeState();
    state.profile.annualExpenses = 10_000;
    state.otherHoldings = { cash: { name: 'Bank cash', amount: 20_000, annualReturn: 0 } };
    state.epf = { epf: { amount: 1_000_000, currency: 'INR' } };
    const assessment = assessHealth(state);
    expect(assessment.dimensions.liquidity).toBe('red');
    expect(assessment.details.some((detail) => detail.includes('2.0 months'))).toBe(true);
  });

  it('does not call savings rate healthy when expenses are missing', () => {
    const state = initializeState();
    state.profile.monthlyIncome = 100_000;
    state.profile.annualExpenses = 0;
    const assessment = assessHealth(state);
    expect(assessment.dimensions.savingsRate).toBe('yellow');
    expect(assessment.details).toContain('Add essential monthly expenses to calculate savings rate.');
  });

  it('does not call a configured FI target on track with an empty corpus', () => {
    const state = initializeState();
    state.profile.fiTarget = 50_000_000;
    const assessment = assessHealth(state);
    expect(assessment.dimensions.fiProgress).toBe('yellow');
    expect(assessment.details).toContain('FI progress has not started yet; add a savings plan or review your target.');
  });
});
