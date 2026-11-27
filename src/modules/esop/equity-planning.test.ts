import { describe, expect, it } from 'vitest';
import { equityLifecycle, planEmployeeEquity, summarizeEquityGrant } from './equity-planning';
import type { EquityGrant } from '../../types/state';

const grant = (overrides: Partial<EquityGrant> = {}): EquityGrant => ({
  id: 'grant-1', kind: 'esop', symbol: 'ACME', currency: 'INR', grantedQuantity: 100,
  vestedQuantity: 60, exercisedQuantity: 10, soldQuantity: 5, strikePrice: 20,
  fairMarketValue: 80, valuationAsOf: '2026-11-20', taxRate: 0.3, ...overrides,
});

describe('employee equity planning', () => {
  it('separates vested, available and restricted quantities across lifecycle states', () => {
    expect(equityLifecycle(grant())).toBe('partially-vested');
    const summary = summarizeEquityGrant(grant(), new Date('2026-11-27T00:00:00Z'));
    expect(summary.vested).toBe(60);
    expect(summary.available).toBe(45);
    expect(summary.restricted).toBe(40);
    expect(summary.exerciseCostInr).toBe(900);
    expect(summary.valueInr).toBe(3600);
  });

  it('rejects inconsistent quantities rather than creating phantom value', () => {
    expect(equityLifecycle(grant({ exercisedQuantity: 70 }))).toBe('invalid');
    expect(summarizeEquityGrant(grant({ soldQuantity: 70 })).available).toBe(0);
  });

  it('fails closed for stale or missing valuation and accepts non-INR FX', () => {
    expect(summarizeEquityGrant(grant({ valuationAsOf: '2026-01-01' }), new Date('2026-11-27'))).toMatchObject({
      valuationStatus: 'stale', valueInr: null,
    });
    expect(summarizeEquityGrant(grant({ currency: 'USD', fxToInr: 83, fxAsOf: '2026-11-20' }), new Date('2026-11-27')).valueInr).toBe(298800);
    expect(summarizeEquityGrant(grant({ currency: 'USD', fxToInr: 83, fxAsOf: '2026-01-01' }), new Date('2026-11-27')).valuationStatus).toBe('stale');
    expect(summarizeEquityGrant(grant({ currency: 'USD' }), new Date('2026-11-27'))).toMatchObject({ valueInr: null, exerciseCostInr: null });
  });

  it('calculates concentration and a read-only liquidation-to-goal amount', () => {
    const result = planEmployeeEquity([grant(), grant({ id: 'grant-2', kind: 'rsu', grantedQuantity: 20, vestedQuantity: 20, exercisedQuantity: 0, soldQuantity: 0, fairMarketValue: 100 })], {
      investableAssetsInr: 100_000, goalShortfallInr: 3_000, now: new Date('2026-11-27'),
    });
    expect(result.availableValueInr).toBe(5600);
    expect(result.concentrationPercent).toBeCloseTo(5.6, 8);
    expect(result.liquidationToGoalsInr).toBe(3000);
  });

  it('does not mutate grants or invent concentration when assets are incomplete', () => {
    const input = grant();
    const before = JSON.stringify(input);
    const result = planEmployeeEquity([input], { investableAssetsInr: null, goalShortfallInr: null, now: new Date('2026-11-27') });
    expect(result.concentrationPercent).toBeNull();
    expect(result.liquidationToGoalsInr).toBeNull();
    expect(JSON.stringify(input)).toBe(before);
  });

  it('deduplicates repeated grant IDs before calculating totals', () => {
    const result = planEmployeeEquity([grant(), grant()], { investableAssetsInr: 100_000, goalShortfallInr: null, now: new Date('2026-11-27') });
    expect(result.grants).toHaveLength(1);
    expect(result.availableValueInr).toBe(3600);
  });

  it('rejects unsafe magnitudes instead of returning misleading money values', () => {
    expect(summarizeEquityGrant(grant({ grantedQuantity: 1e15 }), new Date('2026-11-27')).lifecycle).toBe('invalid');
    expect(summarizeEquityGrant(grant({ fairMarketValue: 1e15 }), new Date('2026-11-27')).valueInr).toBeNull();
  });
});
