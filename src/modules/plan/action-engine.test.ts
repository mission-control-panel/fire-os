import { describe, expect, it } from 'vitest';
import { initializeState } from '../../types/state';
import { generateActionItems } from './action-engine';

describe('plan action engine', () => {
  it('turns an underfunded goal into an actionable contribution item', () => {
    const state = initializeState();
    state.goals = [{
      id: 'education', name: 'Education', kind: 'education', targetToday: 2_000_000,
      targetDate: '2035-06', inflation: 'education', linkedAssetIds: [], currentAmount: 0,
      monthlyContribution: 1_000, priority: 1, riskBucket: 'medium',
    }];
    const action = generateActionItems(state).find((item) => item.id === 'goal-funding-gap-education');
    expect(action?.description).toContain('Plan');
    expect(action?.description).toContain('gap');
  });
});
