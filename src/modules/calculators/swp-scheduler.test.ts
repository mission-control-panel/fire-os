import { describe, expect, it } from 'vitest';
import { calculateMonthlyWithdrawal, generateSWPSchedule, getSWPWithdrawalDates, executeMonthlyWithdrawal, recordMonthlyWithdrawal, simulateMonthlyWithdrawal } from './swp-scheduler';

const FRESH_NAV = { nav: 100, timestamp: new Date().toISOString(), ttl: 60 * 60 * 1000, status: 'cache-fresh' };

describe('SWP month transition', () => {
  it('produces consecutive first-of-month dates across the December/January boundary', () => {
    expect(getSWPWithdrawalDates('2024-12').slice(0, 3)).toEqual([
      '2024-12-01',
      '2025-01-01',
      '2025-02-01',
    ]);
  });

  it('stores the configured start month and enables the schedule', () => {
    const state = { swpSchedule: { enabled: false, startDate: '', monthlyAmount: 1000, rate: 3 } };

    generateSWPSchedule(state, '2024-12');

    expect(state.swpSchedule.enabled).toBe(true);
    expect(state.swpSchedule.startDate).toBe('2024-12');
  });

  it('rejects malformed start months', () => {
    expect(() => getSWPWithdrawalDates('2024-13')).toThrow(RangeError);
    expect(() => getSWPWithdrawalDates('2024-1')).toThrow(RangeError);

    const state = { swpSchedule: { enabled: false, startDate: '', monthlyAmount: 1000, rate: 3 } };
    expect(() => generateSWPSchedule(state, '2024-13')).toThrow(RangeError);
  });
});

describe('executeMonthlyWithdrawal', () => {
  it('records only the actual redeemed amount when holdings cover the target', async () => {
    const state: any = {
      swpSchedule: { enabled: true, startDate: '2024-12', monthlyAmount: 1000, rate: 3 },
      sip: {
        sip1: { name: 'Large Cap Fund', schemeCode: '122639', units: 10, monthlyAmount: 500 },
      },
      mf: {},
      nav: { 122639: { schemeCode: '122639', ...FRESH_NAV } },
      expenses: [],
    };

    const { actualAmount } = await executeMonthlyWithdrawal(state);

    expect(actualAmount).toBe(1000); // 10 units * 100 NAV
    expect(state.sip.sip1.units).toBe(0);
    expect(state.expenses[0]).toEqual({
      date: expect.any(String),
      category: 'SWP',
      amount: 1000,
      linkedToSWP: true,
      idempotencyKey: expect.any(String),
    });
  });

  it('records reduced amount and does not over-redeem when holdings are short', async () => {
    const state: any = {
      swpSchedule: { enabled: true, startDate: '2024-12', monthlyAmount: 5000, rate: 3 },
      sip: {
        sip1: { name: 'Large Cap Fund', schemeCode: '122639', units: 5, monthlyAmount: 500 },
      },
      mf: {},
      nav: { 122639: { schemeCode: '122639', ...FRESH_NAV } },
      expenses: [],
    };

    const { actualAmount } = await executeMonthlyWithdrawal(state);

    expect(actualAmount).toBe(500); // 5 units * 100 NAV
    expect(state.sip.sip1.units).toBe(0); // all units redeemed
    expect(state.expenses[0]).toEqual({
      date: expect.any(String),
      category: 'SWP',
      amount: 500,
      linkedToSWP: true,
      idempotencyKey: expect.any(String),
    });
  });

  it('returns without mutating when SWP is disabled', async () => {
    const state: any = {
      swpSchedule: { enabled: false, monthlyAmount: 1000, rate: 3 },
      sip: { sip1: { name: 'X', units: 10, monthlyAmount: 500 } },
      nav: {},
      expenses: [],
    };
    const copy = JSON.stringify(state);

    const res = await executeMonthlyWithdrawal(state);

    expect(res.actualAmount).toBe(0);
    expect(JSON.stringify(state)).toBe(copy);
    expect(state.expenses).toHaveLength(0);
  });

  it('simulates without changing holdings or expenses', () => {
    const state: any = {
      swpSchedule: { enabled: true, startDate: '2024-12', monthlyAmount: 1000, rate: 3 },
      sip: { sip1: { name: 'Large Cap Fund', schemeCode: '122639', units: 10, monthlyAmount: 500 } },
      mf: {},
      nav: { 122639: { schemeCode: '122639', ...FRESH_NAV } },
      expenses: [],
    };
    const before = JSON.stringify(state);
    expect(simulateMonthlyWithdrawal(state)).toMatchObject({ status: 'ready', actualAmount: 1000 });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('blocks unsafe simulation when a held fund has missing or stale NAV', async () => {
    const state: any = {
      swpSchedule: { enabled: true, startDate: '2024-12', monthlyAmount: 1000, rate: 3 },
      sip: { sip1: { name: 'Unpriced Fund', schemeCode: 'missing', units: 10, monthlyAmount: 500 } },
      mf: {},
      nav: {},
      expenses: [],
    };
    expect(calculateMonthlyWithdrawal(state)).toMatchObject({ status: 'blocked', actualAmount: 0 });
    await expect(recordMonthlyWithdrawal(state, 'swp:test')).rejects.toThrow('Fresh NAV required');
  });

  it('blocks stale, future-dated, and negative holding data', () => {
    const base: any = {
      swpSchedule: { enabled: true, startDate: '2024-12', monthlyAmount: 1000, rate: 3 },
      mf: {},
      expenses: [],
    };
    expect(calculateMonthlyWithdrawal({
      ...base,
      sip: { stale: { name: 'Stale', schemeCode: 'stale', units: 1 } },
      nav: { stale: { ...FRESH_NAV, timestamp: new Date(Date.now() - 2 * FRESH_NAV.ttl).toISOString() } },
    })).toMatchObject({ status: 'blocked', reason: expect.stringContaining('Fresh NAV required') });
    expect(calculateMonthlyWithdrawal({
      ...base,
      sip: { future: { name: 'Future', schemeCode: 'future', units: 1 } },
      nav: { future: { ...FRESH_NAV, timestamp: new Date(Date.now() + 60_000).toISOString() } },
    })).toMatchObject({ status: 'blocked', reason: expect.stringContaining('Fresh NAV required') });
    expect(calculateMonthlyWithdrawal({
      ...base,
      sip: { corrupt: { name: 'Corrupt', schemeCode: 'corrupt', units: -1 } },
      nav: { corrupt: { ...FRESH_NAV } },
    })).toMatchObject({ status: 'blocked', reason: expect.stringContaining('Invalid units') });
  });

  it('uses the captured operation date for the recorded expense', async () => {
    const state: any = {
      swpSchedule: { enabled: true, startDate: '2024-12', monthlyAmount: 1000, rate: 3 },
      sip: { sip1: { name: 'Large Cap Fund', schemeCode: '122639', units: 10 } },
      mf: {},
      nav: { 122639: { schemeCode: '122639', ...FRESH_NAV } },
      expenses: [],
    };
    await recordMonthlyWithdrawal(state, 'swp:2026-02', new Date('2026-02-28T23:59:59Z'));
    expect(state.expenses[0].date).toBe('2026-02-28');
  });

  it('is idempotent for repeated recording with the same key', async () => {
    const state: any = {
      swpSchedule: { enabled: true, startDate: '2024-12', monthlyAmount: 1000, rate: 3 },
      sip: { sip1: { name: 'Large Cap Fund', schemeCode: '122639', units: 10, monthlyAmount: 500 } },
      mf: {},
      nav: { 122639: { schemeCode: '122639', ...FRESH_NAV } },
      expenses: [],
    };
    await executeMonthlyWithdrawal(state, 'swp:2026-03');
    const second = await executeMonthlyWithdrawal(state, 'swp:2026-03');
    expect(second.status).toBe('duplicate');
    expect(state.sip.sip1.units).toBe(0);
    expect(state.expenses).toHaveLength(1);
  });
});
