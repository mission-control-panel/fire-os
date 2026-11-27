import { describe, expect, it } from 'vitest';
import { allocateGoalAssets, planGoal } from './goal-planning';
import type { Goal } from '../../types/state';

const goal = (overrides: Partial<Goal> = {}): Goal => ({
  id: 'home', name: 'Home', kind: 'home', targetToday: 1_000_000, targetDate: '2030-01', inflation: 'cpi',
  linkedAssetIds: [], currentAmount: 100_000, monthlyContribution: 10_000, priority: 1, riskBucket: 'medium', ...overrides,
});

describe('goal planning', () => {
  it('inflates a target and calculates a transparent monthly shortfall', () => {
    const plan = planGoal(goal(), { today: new Date('2026-01-01T00:00:00Z'), annualReturnRate: 0 });
    expect(plan.targetAtDate).toBeCloseTo(1_000_000 * 1.06 ** 4);
    expect(plan.monthsRemaining).toBe(48);
    expect(plan.requiredMonthlyContribution).toBeCloseTo((plan.targetAtDate - 100_000) / 48);
    expect(plan.status).toBe('underfunded');
  });

  it('grows the existing corpus before calculating the remaining contribution', () => {
    const plan = planGoal(goal({ currentAmount: 100_000 }), { today: new Date('2026-01-01T00:00:00Z'), annualReturnRate: 0.12 });
    const monthlyRate = 1.12 ** (1 / 12) - 1;
    const futureCorpus = 100_000 * (1 + monthlyRate) ** 48;
    const target = 1_000_000 * 1.06 ** 4;
    expect(plan.shortfallAtDate).toBeCloseTo(target - futureCorpus);
  });

  it('makes overdue and missing inputs explicit', () => {
    expect(planGoal(goal({ targetDate: '2025-01' }), { today: new Date('2026-01-01T00:00:00Z') }).status).toBe('overdue');
    expect(planGoal(goal({ targetDate: '2030-13' }), { today: new Date('2026-01-01T00:00:00Z') }).status).toBe('missing-data');
  });

  it('rejects numeric overflow instead of displaying a fabricated zero plan', () => {
    expect(planGoal(goal({ targetToday: Number.MAX_VALUE }), { today: new Date('2026-01-01T00:00:00Z') }).status).toBe('missing-data');
    expect(planGoal(goal({ currentAmount: Number.MAX_SAFE_INTEGER, targetDate: '9200-12' }), { today: new Date('2026-01-01T00:00:00Z') }).status).toBe('missing-data');
  });

  it('prevents double allocation by priority and reports overlap', () => {
    const result = allocateGoalAssets([
      goal({ id: 'low', priority: 2, linkedAssetIds: ['fund', 'cash'] }),
      goal({ id: 'high', priority: 1, linkedAssetIds: ['fund'] }),
    ], { fund: 500_000, cash: 100_000, bank: 50_000 });
    expect(result.allocatedByGoal).toEqual({ low: 100_000, high: 500_000 });
    expect(result.duplicateAssetIds).toEqual(['fund']);
    expect(result.unallocatedAssets).toEqual(['bank']);
    expect(result.invalidAssetIds).toEqual([]);
  });

  it('canonicalizes legacy bare asset IDs against unique namespaced holdings', () => {
    const result = allocateGoalAssets([
      goal({ id: 'high', priority: 1, linkedAssetIds: ['sip:fund', 'fund'] }),
      goal({ id: 'low', priority: 2, linkedAssetIds: ['fund'] }),
    ], { 'sip:fund': 500_000, fund: 500_000, cash: 100_000 });
    expect(result.allocatedByGoal).toEqual({ high: 500_000, low: 0 });
    expect(result.duplicateAssetIds).toEqual(['fund']);
    expect(result.unallocatedAssets).toEqual(['cash']);
    expect(result.invalidAssetIds).toEqual([]);
  });

  it('canonicalizes legacy IDs that contain colons and rejects allocation overflow', () => {
    const result = allocateGoalAssets([
      goal({ id: 'high', priority: 1, linkedAssetIds: ['sip:fund:2024', 'fund:2024'] }),
      goal({ id: 'low', priority: 2, linkedAssetIds: ['fund:2024'] }),
    ], { 'sip:fund:2024': 500_000, 'fund:2024': 500_000, cash: Number.MAX_SAFE_INTEGER });
    expect(result.allocatedByGoal).toEqual({ high: 500_000, low: 0 });
    expect(result.duplicateAssetIds).toEqual(['fund:2024']);
    expect(result.invalidAssetIds).toEqual([]);

    const overflow = allocateGoalAssets([
      goal({ id: 'overflow', linkedAssetIds: ['a', 'b'] }),
    ], { a: Number.MAX_SAFE_INTEGER, b: 1 });
    expect(overflow.allocatedByGoal.overflow).toBe(0);
    expect(overflow.invalidAssetIds).toEqual(['b']);
  });
});
