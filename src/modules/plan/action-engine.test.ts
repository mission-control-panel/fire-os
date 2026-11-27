import { describe, expect, it } from 'vitest';
import { initializeState } from '../../types/state';
import { generateActionItems, renderActionItems } from './action-engine';

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

  it('escapes user-controlled goal names in the legacy HTML renderer', () => {
    const state = initializeState();
    state.goals = [{
      id: 'unsafe', name: '<img src=x onerror=alert(1)>', kind: 'custom', targetToday: 2_000_000,
      targetDate: '2035-06', inflation: 'cpi', linkedAssetIds: [], currentAmount: 0,
      monthlyContribution: 1_000, priority: 1, riskBucket: 'medium',
    }];
    const html = renderActionItems(state);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
