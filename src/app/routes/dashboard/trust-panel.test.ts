import { describe, expect, it } from 'vitest';
import { initializeState } from '../../../types/state';
import { totalNetWorth } from '../../../modules/dashboard/kpis';
import { hasUncertainFundValuation } from './trust-panel';

describe('dashboard valuation trust summary', () => {
  it('does not flag a zero-unit fund as an uncertain zero valuation', () => {
    const state = initializeState();
    state.sip = {
      empty: { name: 'Empty fund', schemeCode: 'empty', units: 0, startDate: '2025-01', monthlyAmount: 1000 },
    };
    state.nav.empty = {
      schemeCode: 'empty',
      nav: 0,
      timestamp: new Date().toISOString(),
      ttl: 60 * 60 * 1000,
    };

    expect(hasUncertainFundValuation(state, totalNetWorth(state).valuation)).toBe(false);
  });

  it('flags a zero NAV when positive units need pricing', () => {
    const state = initializeState();
    state.sip = {
      fund: { name: 'Fund', schemeCode: 'fund', units: 10, startDate: '2025-01', monthlyAmount: 1000 },
    };
    state.nav.fund = {
      schemeCode: 'fund',
      nav: 0,
      timestamp: new Date().toISOString(),
      ttl: 60 * 60 * 1000,
    };

    expect(hasUncertainFundValuation(state, totalNetWorth(state).valuation)).toBe(true);
  });
});
