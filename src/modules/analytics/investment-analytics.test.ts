import { describe, expect, it } from 'vitest';
import { concentration, currencyExposure, expenseRatio, fundOverlap, riskMetrics, sectorExposure } from './investment-analytics';

const holdings = [
  { id: 'a', value: 600, currency: 'INR', sector: 'equity', fundId: 'fund-a', expenseRatio: 1 },
  { id: 'b', value: 300, currency: 'USD', sector: 'debt', fundId: 'fund-b', expenseRatio: 2 },
  { id: 'c', value: 100, currency: 'INR', sector: 'equity' },
] as const;

describe('investment analytics', () => {
  it('aggregates sourced currency and sector exposures', () => {
    expect(currencyExposure(holdings).rows).toEqual([{ label: 'INR', value: 700, percentage: 70 }, { label: 'USD', value: 300, percentage: 30 }]);
    expect(sectorExposure([...holdings, { id: 'd', value: 50, currency: 'INR' }])).toMatchObject({ status: 'insufficient-data', missingCount: 1, totalValue: 1000 });
  });
  it('calculates concentration and weighted sourced expenses', () => {
    expect(concentration(holdings)).toMatchObject({ topHoldingId: 'a', topHoldingPercentage: 60 });
    expect(concentration(holdings).herfindahlIndex).toBeCloseTo(0.46);
    expect(expenseRatio(holdings)).toMatchObject({ status: 'insufficient-data', sourcedValue: 900, weightedExpenseRatio: 1.3333333333333333, missingCount: 1 });
  });
  it('reports overlap only from explicit constituent weights', () => {
    const result = fundOverlap([{ ...holdings[0], constituents: { alpha: 0.6, beta: 0.4 } }, { ...holdings[1], constituents: { alpha: 0.2, gamma: 0.8 } }, { ...holdings[2], fundId: 'fund-c' }]);
    expect(result).toMatchObject({ status: 'insufficient-data', missingCount: 1 });
    expect(result.rows).toEqual([{ leftFundId: 'fund-a', rightFundId: 'fund-b', overlap: 0.2 }]);
  });
  it('requires a real ordered series for volatility and drawdown', () => {
    expect(riskMetrics([{ date: '2026-01-01', value: 100 }, { date: '2026-01-02', value: 110 }, { date: '2026-01-03', value: 99 }])).toMatchObject({ status: 'available', observations: 3 });
    expect(riskMetrics([{ date: '2026-01-01', value: 100 }, { date: '2026-01-02', value: 110 }, { date: '2026-01-03', value: 99 }]).maxDrawdown).toBeCloseTo(-0.1);
    expect(riskMetrics([{ date: '2026-01-01', value: 100 }]).status).toBe('insufficient-data');
    expect(riskMetrics([{ date: '2026-01-02', value: 100 }, { date: '2026-01-01', value: 101 }]).status).toBe('unavailable');
  });
});
