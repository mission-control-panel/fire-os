import { describe, expect, it } from 'vitest';
import { createScenarioStore, debtPayoffMonths, fdLadderValue, projectInflation, rentVsBuy, salaryGrowth, seededMarketStress, withdrawalSequenceRisk } from './scenario-lab';

describe('scenario lab calculators', () => {
  it('matches deterministic inflation, debt, FD, rent/buy and salary vectors', () => {
    expect(projectInflation(100_000, 6, 2)).toBeCloseTo(112_360, 8);
    expect(debtPayoffMonths(100_000, 0, 10_000)).toBe(10);
    expect(fdLadderValue(100_000, 8, 2)).toBeCloseTo(117_165.94, 1);
    expect(rentVsBuy({ monthlyRent: 20_000, annualRentIncreasePercent: 5, homePrice: 5_000_000, downPayment: 1_000_000, annualHomeGrowthPercent: 6, years: 2 })).toMatchObject({ rentCost: 492000, equity: expect.closeTo(1_618_000, 0) });
    expect(salaryGrowth(100_000, 10, 2)).toEqual([100_000, expect.closeTo(110_000, 8), expect.closeTo(121_000, 8)]);
  });

  it('is seeded and does not mutate scenario inputs', () => {
    const first = seededMarketStress(100_000, 8, 20, 3, 42);
    expect(seededMarketStress(100_000, 8, 20, 3, 42)).toEqual(first);
    expect(withdrawalSequenceRisk(1_000_000, 100_000, 8, 3, 42)).toEqual(expect.objectContaining({ depleted: false }));
  });

  it('supports isolated CRUD and rejects invalid saved assumptions', () => {
    const store = createScenarioStore();
    const scenario = { id: 's1', name: 'Base', kind: 'inflation' as const, inputs: { amount: 100_000, rate: 6, years: 10 } };
    store.save(scenario);
    const listed = store.list();
    listed[0].inputs.amount = 0;
    expect(store.list()[0].inputs.amount).toBe(100_000);
    expect(store.remove('s1')).toBe(true);
    expect(store.list()).toEqual([]);
    expect(() => store.save({ ...scenario, inputs: { amount: Number.NaN } })).toThrow('Invalid scenario');
    expect(() => store.save({ ...scenario, name: '   ' })).toThrow('Invalid scenario');
    expect(() => store.save({ ...scenario, kind: 'unknown' as never })).toThrow('Invalid scenario');
  });

  it('fails closed for impossible rates, withdrawals and impractical horizons', () => {
    expect(rentVsBuy({ monthlyRent: 1, annualRentIncreasePercent: -101, homePrice: 1, downPayment: 0, annualHomeGrowthPercent: 5, years: 1 })).toBeNull();
    expect(withdrawalSequenceRisk(1000, -1, 5, 1, 1)).toBeNull();
    expect(salaryGrowth(1000, 5, 101)).toBeNull();
    expect(seededMarketStress(1000, 5, 10, 101, 1)).toBeNull();
    expect(salaryGrowth(1000, 1e15, 1)).toBeNull();
    expect(seededMarketStress(1000, 1e15, 1, 1, 1)).toBeNull();
    expect(fdLadderValue(1e15, 8, 100)).toBeNull();
    expect(debtPayoffMonths(1e15, 0, 0.1)).toBeNull();
    expect(rentVsBuy({ monthlyRent: 1e15, annualRentIncreasePercent: 5, homePrice: 1e15, downPayment: 0, annualHomeGrowthPercent: 5, years: 100 })).toBeNull();
    expect(withdrawalSequenceRisk(1000, 100, -5, 1, 1)).not.toBeNull();
  });
});
