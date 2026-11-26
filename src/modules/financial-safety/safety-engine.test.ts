import { describe, expect, it } from 'vitest';
import {
  analyzeAllocationDrift,
  analyzeCrashProtocol,
  analyzeLiquidity,
  portfolioSafetyReport,
} from './safety-engine';
import { initializeState } from '../../types/state';

describe('liquidity safety engine', () => {
  it('deducts FD penalties and preserves restricted assets outside accessible runway', () => {
    const result = analyzeLiquidity({
      monthlyEssentialExpenses: 50_000,
      assets: [
        { id: 'cash', kind: 'cash', value: 100_000, valuation: 'current' },
        { id: 'fund', kind: 'liquid-fund', value: 300_000, valuation: 'current' },
        { id: 'fd', kind: 'fixed-deposit', value: 500_000, penaltyRate: 0.02, valuation: 'current' },
        { id: 'epf', kind: 'restricted', value: 1_000_000, valuation: 'current' },
      ],
    });

    expect(result.status).toBe('available');
    expect(result.accessibleValue).toBe(890_000);
    expect(result.fixedDepositPenalties).toBe(10_000);
    expect(result.restricted).toBe(1_000_000);
    expect(result.runwayMonths).toBe(17.8);
  });

  it('does not convert missing expenses or stale valuations into a zero runway', () => {
    const missingExpenses = analyzeLiquidity({
      monthlyEssentialExpenses: null,
      assets: [{ id: 'cash', kind: 'cash', value: 100_000, valuation: 'current' }],
    });
    const stale = analyzeLiquidity({
      monthlyEssentialExpenses: 50_000,
      assets: [{ id: 'fund', kind: 'liquid-fund', value: 300_000, valuation: 'stale' }],
    });

    expect(missingExpenses.reason).toBe('expenses-missing');
    expect(missingExpenses.runwayMonths).toBeNull();
    expect(stale.status).toBe('insufficient-data');
    expect(stale.runwayMonths).toBeNull();
    expect(stale.unknownValue).toBe(300_000);
  });
});

describe('crash protocol', () => {
  it('keeps the reserve and caps cumulative deployment', () => {
    const liquidity = analyzeLiquidity({
      monthlyEssentialExpenses: 50_000,
      assets: [{ id: 'cash', kind: 'cash', value: 1_000_000, valuation: 'current' }],
    });
    const result = analyzeCrashProtocol({
      liquidity,
      currentDrawdownPercent: 20,
      reserveMonths: 12,
      cumulativeCapPercent: 50,
    });

    expect(result.status).toBe('available');
    expect(result.reserveAmount).toBe(600_000);
    expect(result.crashFund).toBe(400_000);
    expect(result.cumulativeCap).toBe(200_000);
    expect(result.levels.map(level => level.amount)).toEqual([40_000, 60_000, 100_000]);
    expect(result.levels[0].eligible).toBe(true);
    expect(result.levels[2].eligible).toBe(false);
  });

  it('blocks deployment amounts when fresh drawdown data is unavailable', () => {
    const liquidity = analyzeLiquidity({
      monthlyEssentialExpenses: 50_000,
      assets: [{ id: 'cash', kind: 'cash', value: 1_000_000, valuation: 'current' }],
    });
    const result = analyzeCrashProtocol({ liquidity, currentDrawdownPercent: null });
    expect(result.status).toBe('insufficient-data');
    expect(result.levels.every(level => level.amount === null)).toBe(true);
  });
});

describe('allocation drift', () => {
  it('recommends only drift above five percentage points', () => {
    const result = analyzeAllocationDrift({
      holdings: { equity: 800_000, debt: 200_000 },
      targets: { equity: 60, debt: 40 },
    });
    expect(result.status).toBe('available');
    expect(result.current).toEqual({ equity: 80, debt: 20 });
    expect(result.recommendations).toEqual([
      'Reduce equity by ₹2.0L (20.0% drift)',
      'Increase debt by ₹2.0L (20.0% drift)',
    ]);
  });

  it('returns explicit incomplete status instead of fabricating drift', () => {
    const result = analyzeAllocationDrift({
      holdings: { equity: 100 },
      targets: { equity: 100 },
      dataComplete: false,
    });
    expect(result.status).toBe('insufficient-data');
    expect(result.recommendations).toEqual([]);
  });
});

describe('portfolio adapter', () => {
  it('shares a single safety report shape for the app state', () => {
    const state = initializeState();
    state.profile.annualExpenses = 50_000;
    state.fd = { fd: { amount: 1_000_000, currency: 'INR' } };
    const report = portfolioSafetyReport(state);
    expect(report.liquidity.accessibleValue).toBe(1_000_000);
    expect(report.crash.reserveAmount).toBe(600_000);
    expect(report.allocation.status).toBe('unavailable');
  });
});
