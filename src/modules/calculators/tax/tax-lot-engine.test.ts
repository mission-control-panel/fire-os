import { describe, expect, it } from 'vitest';
import {
  calculateTaxLotPlan,
  CURRENT_INDIAN_CAPITAL_GAINS_RULES,
  financialYearFor,
  isLongTermOnDate,
} from './tax-lot-engine';

describe('tax lot engine', () => {
  it('uses official versioned defaults and Indian financial-year boundaries', () => {
    expect(CURRENT_INDIAN_CAPITAL_GAINS_RULES.ltcgRate).toBe(0.125);
    expect(CURRENT_INDIAN_CAPITAL_GAINS_RULES.section112aExemption).toBe(125_000);
    expect(financialYearFor('2026-03-31')).toBe('2025-26');
    expect(financialYearFor('2026-04-01')).toBe('2026-27');
  });

  it('classifies a unit only after its configured holding period', () => {
    expect(isLongTermOnDate('2025-01-31', new Date('2026-01-30T00:00:00Z'), 'equity-mutual-fund')).toBe(false);
    expect(isLongTermOnDate('2025-01-31', new Date('2026-01-31T00:00:00Z'), 'equity-mutual-fund')).toBe(false);
    expect(isLongTermOnDate('2025-01-31', new Date('2026-02-01T00:00:00Z'), 'equity-mutual-fund')).toBe(true);
  });

  it('computes exact lots, realized losses, and capped harvest allowance', () => {
    const plan = calculateTaxLotPlan({
      asOf: new Date('2026-04-01T00:00:00Z'),
      lastHarvestedAmount: 25_000,
      lots: [{
        id: 'lot-1', fundKey: 'fund', fundName: 'Fund', assetClass: 'equity-mutual-fund',
        acquiredDate: '2024-01-01', units: 100, costBasis: 100_000, currentNAV: 1_500, dataQuality: 'exact',
      }],
      realizedDisposals: [{ lotId: 'lot-1', saleDate: '2025-05-01', units: 20, salePrice: 900 }],
    });

    expect(plan.status).toBe('available');
    expect(plan.dataQuality).toBe('exact');
    expect(plan.financialYear).toBe('2026-27');
    expect(plan.totalLtcgGains).toBe(50_000);
    expect(plan.totalRealizedLosses).toBe(2_000);
    expect(plan.remainingExemption).toBe(100_000);
    expect(plan.lots[0].eligible).toBe(true);
  });

  it('refuses to invent a lot result when dated lots are absent', () => {
    const plan = calculateTaxLotPlan({ lots: [], asOf: new Date('2026-04-01T00:00:00Z') });
    expect(plan.status).toBe('insufficient-data');
    expect(plan.totalCurrentValue).toBeNull();
    expect(plan.lots).toEqual([]);
  });
});
