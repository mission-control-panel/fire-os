import { describe, expect, it } from 'vitest';
import { initializeState } from '../../../types/state';
import { calculateLTCGHarvestPlan } from './ltcg-planner';

describe('calculateLTCGHarvestPlan month boundaries', () => {
  it('does not mark units long-term at 12 inclusive months, but does at 13', () => {
    const state = initializeState();
    state.sip = {
      fund: {
        name: 'Test Fund',
        schemeCode: '123',
        units: 130,
        startDate: '2024-01',
        monthlyAmount: 100,
      },
    };
    state.nav = {
      '123': { schemeCode: '123', nav: 100, timestamp: '2025-01-01T00:00:00Z', ttl: 3600000 },
    };

    const at12Months = calculateLTCGHarvestPlan(state, new Date(2024, 11, 15));
    const at13Months = calculateLTCGHarvestPlan(state, new Date(2025, 0, 15));

    expect(at12Months.recommendations[0].longTermUnits).toBe(0);
    expect(at13Months.recommendations[0].longTermUnits).toBe(10);
  });

  it('rejects non-padded or impossible start months', () => {
    const state = initializeState();
    state.sip = {
      singleDigit: {
        name: 'Single Digit',
        schemeCode: '123',
        units: 130,
        startDate: '2024-1',
        monthlyAmount: 100,
      },
      impossible: {
        name: 'Impossible',
        schemeCode: '123',
        units: 130,
        startDate: '2024-13',
        monthlyAmount: 100,
      },
    };

    const plan = calculateLTCGHarvestPlan(state, new Date(2025, 0, 15));

    expect(plan.recommendations.map((r) => r.longTermUnits)).toEqual([0, 0]);
    expect(plan.totalInvested).toBe(0);
  });

  it('counts a full YYYY-MM-DD startDate from its month', () => {
    const state = initializeState();
    state.sip = {
      fund: {
        name: 'Test Fund',
        schemeCode: '123',
        units: 130,
        startDate: '2026-01-01',
        monthlyAmount: 100,
      },
    };

    const plan = calculateLTCGHarvestPlan(state, new Date(2026, 2, 15));

    expect(plan.totalInvested).toBe(300);
    expect(plan.recommendations[0].longTermUnits).toBe(0);
  });

  it('uses dated transaction lots when the ledger has exact acquisition data', () => {
    const state = initializeState();
    state.sip = { fund: { name: 'Fund', schemeCode: '123', units: 100, startDate: '2024-01', monthlyAmount: 100 } };
    state.nav = { '123': { schemeCode: '123', nav: 1_500, timestamp: '2026-04-01T00:00:00Z', ttl: 3600000 } };
    state.taxCalendar.harvestTarget = 125_000;
    state.transactionLedger.instruments = { '123': { id: '123', name: 'Fund', assetClass: 'equity-mutual-fund', currency: 'INR' } };
    state.transactionLedger.lots = [{ id: 'lot-1', transactionId: 'buy-1', accountId: 'account', instrumentId: '123', acquiredDate: '2024-01-01', quantityMicros: 100_000_000, costPaise: 10_000_000, costProvenance: 'exact' }];

    const plan = calculateLTCGHarvestPlan(state, new Date('2026-04-01T00:00:00Z'));

    expect(plan.dataQuality).toBe('exact');
    expect(plan.financialYear).toBe('2026-27');
    expect(plan.taxRuleVersion).toBe('finance-no-2-act-2024-v1');
    expect(plan.recommendations[0].longTermUnits).toBe(100);
    expect(plan.recommendations[0].ltcgGains).toBe(50_000);
  });

  it('reconciles transaction-only lots and honors an explicit zero harvest target', () => {
    const state = initializeState();
    state.sip = { fund: { name: 'Fund', schemeCode: '123', units: 60, startDate: '2024-01', monthlyAmount: 100 } };
    state.nav = { '123': { schemeCode: '123', nav: 1_500, timestamp: '2026-04-01T00:00:00Z', ttl: 3600000 } };
    state.taxCalendar.harvestTarget = 0;
    state.transactionLedger.instruments = { '123': { id: '123', name: 'Fund', assetClass: 'equity-mutual-fund', currency: 'INR' } };
    state.transactionLedger.transactions = [
      { id: 'buy-1', dedupKey: 'buy-1', date: '2024-01-01', type: 'purchase', accountId: 'account', instrumentId: '123', amountPaise: 10_000_000, quantityMicros: 100_000_000, costProvenance: 'exact' },
      { id: 'sale-1', dedupKey: 'sale-1', date: '2025-01-02', type: 'sale', accountId: 'account', instrumentId: '123', amountPaise: 4_000_000, quantityMicros: 40_000_000, costProvenance: 'exact' },
    ];

    const plan = calculateLTCGHarvestPlan(state, new Date('2026-04-01T00:00:00Z'));

    expect(plan.dataQuality).toBe('exact');
    expect(plan.recommendations[0].totalUnits).toBe(60);
    expect(plan.totalRecommendedHarvest).toBe(0);
    expect(plan.remainingLimit).toBe(0);
  });

  it('labels exact lots estimated when the cached NAV is stale', () => {
    const state = initializeState();
    state.sip = { fund: { name: 'Fund', schemeCode: '123', units: 100, startDate: '2024-01', monthlyAmount: 100 } };
    state.nav = { '123': { schemeCode: '123', nav: 1_500, timestamp: '2026-01-01T00:00:00Z', ttl: 3600000, status: 'stale' } };
    state.transactionLedger.instruments = { '123': { id: '123', name: 'Fund', assetClass: 'equity-mutual-fund', currency: 'INR' } };
    state.transactionLedger.lots = [{ id: 'lot-1', transactionId: 'buy-1', accountId: 'account', instrumentId: '123', acquiredDate: '2024-01-01', quantityMicros: 100_000_000, costPaise: 10_000_000, costProvenance: 'exact' }];

    const plan = calculateLTCGHarvestPlan(state, new Date('2026-04-01T00:00:00Z'));

    expect(plan.dataQuality).toBe('estimated');
  });
});
