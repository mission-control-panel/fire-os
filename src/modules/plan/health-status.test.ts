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
});
