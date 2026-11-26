import { afterEach, describe, expect, it, vi } from 'vitest';
import { initializeState } from '../../types/state';
import { attributeNetWorthChange, calculatePeriodReturn, esopConcentration, sipStatus, summarizeOtherHoldings, totalNetWorth } from './kpis';
import { calculateCoastFire } from '../calculators/scenario-modeler';
import { createFeaturePorts } from '../../core/feature-ports';
import { calculateXirr } from '../../lib/calculations';

afterEach(() => {
  vi.useRealTimers();
});

describe('XIRR calculations', () => {
  it('counts the start month and current month inclusively for SIP invested value', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
    const state = initializeState();
    state.sip = {
      fund: {
        name: 'Test Fund',
        schemeCode: '123',
        units: 12,
        startDate: '2024-12',
        monthlyAmount: 1000,
      },
    };

    expect(sipStatus(state).funds[0].invested).toBe(2000);
  });

  it('calculates annualized return from dated cash flows', () => {
    const xirr = calculateXirr([
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2025-01-01'), amount: 1100 },
    ]);

    expect(xirr).not.toBeNull();
    expect(xirr!).toBeCloseTo(0.0997, 4);
  });

  it('returns null when cash flows do not contain both signs', () => {
    expect(calculateXirr([
      { date: new Date('2024-01-01'), amount: 1000 },
      { date: new Date('2025-01-01'), amount: 1100 },
    ])).toBeNull();
  });

  it('exposes calculated XIRR through SIP status', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const state = initializeState();
    state.sip = {
      fund: {
        name: 'Test Fund',
        schemeCode: '123',
        units: 12,
        startDate: '2024-01',
        monthlyAmount: 1000,
      },
    };
    state.nav = {
      '123': { schemeCode: '123', nav: 1100, timestamp: '2025-01-01T00:00:00Z', ttl: 3600000 },
    };

    const result = sipStatus(state);

    expect(result.funds[0].xirr).not.toBeNull();
    expect(result.totalXIRR).toBe(result.funds[0].xirr);
    expect(result.totalXIRRProvenance).toBe('estimated-sip');
  });

  it('uses combined dated ledger flows instead of averaging fund XIRRs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const state = initializeState();
    state.sip = { fund: { name: 'Fund', schemeCode: '123', units: 10, startDate: '2024-01', monthlyAmount: 1_000 } };
    state.nav = { '123': { schemeCode: '123', nav: 150, timestamp: '2025-01-01T00:00:00Z', ttl: 3_600_000 } };
    state.transactionLedger.transactions = [
      { id: 'buy', dedupKey: 'buy', date: '2024-01-01', type: 'purchase', accountId: 'brokerage', instrumentId: 'fund', amountPaise: 100_000, costProvenance: 'exact' },
      { id: 'dividend', dedupKey: 'dividend', date: '2024-07-01', type: 'dividend', accountId: 'brokerage', instrumentId: 'fund', amountPaise: 10_000, costProvenance: 'exact' },
    ];
    const result = sipStatus(state);
    expect(result.totalXIRRProvenance).toBe('actual-ledger');
    expect(result.totalXIRR).not.toBeNull();
  });

  it('matches a known one-fund ledger reference vector', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const state = initializeState();
    state.sip = { fund: { name: 'Fund', schemeCode: '123', units: 11, startDate: '2024-01', monthlyAmount: 1_000 } };
    state.nav = { '123': { schemeCode: '123', nav: 100, timestamp: '2025-01-01T00:00:00Z', ttl: 3_600_000 } };
    state.transactionLedger.transactions = [
      { id: 'buy', dedupKey: 'buy', date: '2024-01-01', type: 'purchase', accountId: 'brokerage', instrumentId: 'fund', amountPaise: 100_000, costProvenance: 'exact' },
    ];
    const result = sipStatus(state);
    expect(result.totalXIRR).toBeCloseTo(0.0997136, 6);
    expect(result.totalXIRRProvenance).toBe('actual-ledger');
  });

  it('does not mix unrelated or partially covered ledger holdings into actual XIRR', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const state = initializeState();
    state.sip = {
      first: { name: 'First', schemeCode: '123', units: 10, startDate: '2024-01', monthlyAmount: 1_000 },
      second: { name: 'Second', schemeCode: '456', units: 10, startDate: '2024-01', monthlyAmount: 1_000 },
    };
    state.nav = {
      '123': { schemeCode: '123', nav: 100, timestamp: '2025-01-01T00:00:00Z', ttl: 3_600_000 },
      '456': { schemeCode: '456', nav: 100, timestamp: '2025-01-01T00:00:00Z', ttl: 3_600_000 },
    };
    state.transactionLedger.transactions = [
      { id: 'first', dedupKey: 'first', date: '2024-01-01', type: 'purchase', accountId: 'brokerage', instrumentId: 'first', amountPaise: 100_000, costProvenance: 'exact' },
      { id: 'unrelated', dedupKey: 'unrelated', date: '2024-01-01', type: 'purchase', accountId: 'brokerage', instrumentId: 'fd', amountPaise: 900_000, costProvenance: 'exact' },
    ];
    expect(sipStatus(state).totalXIRRProvenance).toBe('estimated-sip');
  });

  it('marks actual XIRR unavailable for stale NAVs', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const state = initializeState();
    state.sip = { fund: { name: 'Fund', schemeCode: '123', units: 10, startDate: '2024-01', monthlyAmount: 1_000 } };
    state.nav = { '123': { schemeCode: '123', nav: 100, timestamp: '2024-12-01T00:00:00Z', ttl: 3_600_000 } };
    state.transactionLedger.transactions = [
      { id: 'buy', dedupKey: 'buy', date: '2024-01-01', type: 'purchase', accountId: 'brokerage', instrumentId: 'fund', amountPaise: 100_000, costProvenance: 'exact' },
    ];
    const result = sipStatus(state);
    expect(result.totalXIRR).toBeNull();
    expect(result.totalXIRRProvenance).toBe('unavailable');
  });
});

describe('calculatePeriodReturn', () => {
  const start = new Date('2024-01-01');
  const end = new Date('2025-01-01');

  it('annualizes contributions, withdrawals, and current value inside the period', () => {
    const result = calculatePeriodReturn(
      [
        { date: new Date('2023-06-01'), amount: -500 },
        { date: new Date('2024-01-01'), amount: -1000 },
        { date: new Date('2024-07-01'), amount: 300 },
        { date: new Date('2025-01-01'), amount: 1100 },
        { date: new Date('2025-06-01'), amount: -200 },
      ],
      start,
      end,
    );
    const expected = calculateXirr([
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2024-07-01'), amount: 300 },
      { date: new Date('2025-01-01'), amount: 1100 },
    ]);

    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(expected!, 10);
    expect(result!).toBeGreaterThan(0);
  });

  it('returns null when a period endpoint is missing', () => {
    const flows = [
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2025-01-01'), amount: 1100 },
    ];

    expect(calculatePeriodReturn(flows, new Date('not-a-date'), end)).toBeNull();
    expect(calculatePeriodReturn(flows, start, new Date('not-a-date'))).toBeNull();
    expect(calculatePeriodReturn(flows, undefined as unknown as Date, end)).toBeNull();
  });

  it('returns null when fewer than two flows fall inside the period', () => {
    expect(calculatePeriodReturn(
      [
        { date: new Date('2024-01-01'), amount: -1000 },
        { date: new Date('2025-06-01'), amount: 1100 },
      ],
      start,
      end,
    )).toBeNull();
    expect(calculatePeriodReturn(
      [{ date: new Date('2023-06-01'), amount: -1000 }, { date: new Date('2025-06-01'), amount: 1100 }],
      start,
      end,
    )).toBeNull();
  });

  it('returns null when in-period flows lack a positive/negative mix', () => {
    expect(calculatePeriodReturn(
      [
        { date: new Date('2024-01-01'), amount: 1000 },
        { date: new Date('2025-01-01'), amount: 1100 },
      ],
      start,
      end,
    )).toBeNull();
    expect(calculatePeriodReturn(
      [
        { date: new Date('2024-01-01'), amount: -1000 },
        { date: new Date('2025-01-01'), amount: -1100 },
      ],
      start,
      end,
    )).toBeNull();
  });
});

describe('SIP startDate month parsing', () => {
  it('rejects non-padded or impossible start months for invested value', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
    const state = initializeState();
    state.sip = {
      singleDigit: {
        name: 'Single Digit',
        schemeCode: '123',
        units: 12,
        startDate: '2024-1',
        monthlyAmount: 1000,
      },
      impossible: {
        name: 'Impossible',
        schemeCode: '123',
        units: 12,
        startDate: '2024-13',
        monthlyAmount: 1000,
      },
    };

    const result = sipStatus(state);

    expect(result.funds.find((f) => f.key === 'singleDigit')?.invested).toBe(0);
    expect(result.funds.find((f) => f.key === 'impossible')?.invested).toBe(0);
  });

  it('counts a full YYYY-MM-DD startDate from its month', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
    const state = initializeState();
    state.sip = {
      fund: {
        name: 'Test Fund',
        schemeCode: '123',
        units: 12,
        startDate: '2026-01-01',
        monthlyAmount: 1000,
      },
    };

    expect(sipStatus(state).funds[0].invested).toBe(3000);
  });
});

describe('Other Holdings KPI calculations', () => {
  it('includes holding values and calculates value-weighted annual return', () => {
    const state = initializeState();
    state.otherHoldings = {
      gold: { name: 'Gold', amount: 100000, annualReturn: 8 },
      rental: { name: 'Rental Property', amount: 300000, annualReturn: 6 },
    };

    expect(summarizeOtherHoldings(state)).toEqual({
      totalValue: 400000,
      weightedAnnualReturn: 6.5,
    });
    expect(totalNetWorth(state).netWorth).toBe(400000);
    expect(totalNetWorth(state).breakdown.otherHoldings).toBe(400000);
  });

  it('handles missing or empty holdings safely', () => {
    const state = initializeState();
    state.otherHoldings = {};

    expect(summarizeOtherHoldings(state)).toEqual({ totalValue: 0, weightedAnnualReturn: 0 });
    expect(totalNetWorth(state).breakdown.otherHoldings).toBe(0);
  });

  it('does not count mirrored core holdings as other holdings', () => {
    const state = initializeState();
    state.fd = { fd1: { amount: 540000, currency: 'INR' } };
    state.epf = { epf1: { amount: 194000, currency: 'INR' } };
    state.bonds = { bonds1: { amount: 51270, currency: 'INR' } };
    state.otherHoldings = {
      otherHolding51: { name: 'Fixed Deposits', amount: 540000, annualReturn: 0 },
      otherHolding52: { name: 'EPF', amount: 194000, annualReturn: 0 },
      otherHolding53: { name: 'Bonds', amount: 51270, annualReturn: 0 },
      gold: { name: 'Gold', amount: 100000, annualReturn: 8 },
    };

    expect(totalNetWorth(state).breakdown.otherHoldings).toBe(100000);
    expect(totalNetWorth(state).assets).toBe(885270);
  });
});

describe('truthful valuation coverage', () => {
  it('does not turn a missing NAV into a zero-valued holding', () => {
    const state = initializeState();
    state.sip = {
      missing: { name: 'Missing NAV', schemeCode: 'missing', units: 10, startDate: '2025-01', monthlyAmount: 1000 },
    };

    const result = totalNetWorth(state);
    expect(result.netWorth).toBe(0);
    expect(result.valuation).toMatchObject({ totalHoldings: 1, pricedHoldings: 0, unpricedHoldings: 1, coveragePercent: 0, hasUnknownValues: true });
    expect(sipStatus(state).funds[0]).toMatchObject({ currentValue: null, pl: null, valuation: 'missing' });
    expect(sipStatus(state).totalPL).toBeNull();
  });

  it('retains a stale last-good NAV in the partial total and labels its provenance', () => {
    const state = initializeState();
    state.sip = {
      stale: { name: 'Stale NAV', schemeCode: 'stale', units: 10, startDate: '2025-01', monthlyAmount: 1000 },
    };
    state.nav = {
      stale: { schemeCode: 'stale', nav: 125, timestamp: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), ttl: 60 * 60 * 1000, source: 'fixture' },
    };

    const result = totalNetWorth(state);
    expect(result.netWorth).toBe(1250);
    expect(result.valuation).toMatchObject({ pricedHoldings: 1, unpricedHoldings: 0, hasUnknownValues: true });
    expect(result.valuation.sources[0]).toMatchObject({ status: 'stale', source: 'fixture' });
    expect(sipStatus(state).totalPL).toBeNull();
  });

  it('counts an explicit zero valuation as priced rather than missing', () => {
    const state = initializeState();
    state.sip = {
      zero: { name: 'Zero NAV', schemeCode: 'zero', units: 0, startDate: '2025-01', monthlyAmount: 1000 },
    };

    expect(totalNetWorth(state).valuation).toMatchObject({ pricedHoldings: 1, unpricedHoldings: 0, hasUnknownValues: false });
    expect(sipStatus(state).funds[0].valuation).toBe('zero');
  });
});

describe('roadmap calculations', () => {
  it('exposes the canonical net-worth calculator through feature ports', () => {
    expect(createFeaturePorts().calculations.totalNetWorth).toBe(totalNetWorth);
  });

  it('attributes net-worth change between contributions and investment return', () => {
    expect(attributeNetWorthChange(100000, 130000, 20000)).toEqual({
      startingValue: 100000,
      contributions: 20000,
      investmentReturn: 10000,
      endingValue: 130000,
    });
  });

  it('calculates Coast FIRE age when growth alone reaches target', () => {
    const result = calculateCoastFire(1000000, 2000000, 0.1, 30, 40);
    expect(result.coastAge).toBe(30);
    expect(result.yearsToCoast).toBe(0);
  });

  it('calculates employer-equity concentration against assets', () => {
    const state = initializeState();
    state.esop = { employer: { amount: 250000, currency: 'INR' } };
    state.otherHoldings = { savings: { name: 'Savings', amount: 750000, annualReturn: 4 } };
    expect(esopConcentration(state)).toBe(0.25);
  });
});
