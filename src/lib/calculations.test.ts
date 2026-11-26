import { describe, expect, it } from 'vitest';
import { calculateXirr, crashProtocol, emergencyRunway, fiGoalProgress, sipCorpus, sipCostBasis, sipPauseImpact } from './calculations';

describe('canonical SIP math', () => {
  it('matches zero-rate and one-year reference vectors', () => {
    expect(sipCorpus(1000, 0, 1)).toBe(12000);
    expect(sipCostBasis(1000, 12)).toBe(12000);
    expect(sipCorpus(1000, 0.12, 1)).toBeCloseTo(12_682.5, 1);
  });

  it('rejects negative and non-finite inputs without producing fabricated values', () => {
    expect(sipCorpus(-1000, 0.12, 1)).toBe(0);
    expect(sipCorpus(1000, 0.12, Number.NaN)).toBe(0);
    expect(sipCostBasis(1000, -12)).toBe(0);
    expect(emergencyRunway(100_000, -1)).toBe(999);
  });

  it('calculates pause cost from bounded whole-month horizons', () => {
    expect(sipPauseImpact(1000, 0, 0.12)).toEqual({ missedContributions: 0, lostGrowth: 0, totalCost: 0 });
    expect(sipPauseImpact(1000, 3.9, 0)).toEqual({ missedContributions: 3000, lostGrowth: 0, totalCost: 3000 });
    expect(sipPauseImpact(1000, 12, -0.12).totalCost).toBeGreaterThanOrEqual(12_000);
    expect(sipCorpus(1000, 10, 100)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('keeps crash and FI boundary vectors finite and non-negative', () => {
    expect(crashProtocol(-1000, 0, 100)).toEqual({ drawdownPercent: 0, deployAmount10: 0, deployAmount15: 0, deployAmount25: 0 });
    expect(fiGoalProgress(-1000, -500)).toEqual({ fiTarget: 0, progressPercent: 0, yearsRemaining: 0 });
    expect(fiGoalProgress(2500000, 100000)).toMatchObject({ fiTarget: 2500000, progressPercent: 100, yearsRemaining: 0 });
  });
});

describe('calculateXirr', () => {
  it('matches a known annualized result for irregular dated flows', () => {
    const rate = calculateXirr([
      { date: new Date('2016-01-15'), amount: -1000 },
      { date: new Date('2016-02-08'), amount: -2500 },
      { date: new Date('2016-04-17'), amount: -1000 },
      { date: new Date('2016-08-24'), amount: 5050 },
    ]);

    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(0.2504, 4);
  });

  it('annualizes a sub-year irregular interval', () => {
    const rate = calculateXirr([
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2024-07-01'), amount: 1050 },
    ]);

    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(0.1028, 3);
  });

  it('returns null for same-sign flows', () => {
    expect(
      calculateXirr([
        { date: new Date('2024-01-01'), amount: 1000 },
        { date: new Date('2025-01-01'), amount: 1100 },
      ]),
    ).toBeNull();
    expect(
      calculateXirr([
        { date: new Date('2024-01-01'), amount: -1000 },
        { date: new Date('2025-01-01'), amount: -1100 },
      ]),
    ).toBeNull();
  });

  it('returns null when a positive or negative flow is missing', () => {
    expect(
      calculateXirr([
        { date: new Date('2024-01-01'), amount: -1000 },
        { date: new Date('2025-01-01'), amount: 0 },
      ]),
    ).toBeNull();
    expect(
      calculateXirr([
        { date: new Date('2024-01-01'), amount: 1000 },
        { date: new Date('2025-01-01'), amount: 0 },
      ]),
    ).toBeNull();
  });

  it('returns null for invalid dates or non-finite amounts', () => {
    expect(
      calculateXirr([
        { date: new Date('not-a-date'), amount: -1000 },
        { date: new Date('2025-01-01'), amount: 1100 },
      ]),
    ).toBeNull();
    expect(
      calculateXirr([
        { date: new Date('2024-01-01'), amount: -1000 },
        { date: new Date('2025-01-01'), amount: NaN },
      ]),
    ).toBeNull();
    expect(
      calculateXirr([
        { date: new Date('2024-01-01'), amount: -1000 },
        { date: new Date('2025-01-01'), amount: Infinity },
      ]),
    ).toBeNull();
  });

  it('drops invalid flows but still computes when two valid flows remain', () => {
    const rate = calculateXirr([
      { date: new Date('not-a-date'), amount: -500 },
      { date: new Date('2024-01-01'), amount: -1000 },
      { date: new Date('2025-01-01'), amount: 1100 },
    ]);

    expect(rate).not.toBeNull();
    expect(rate!).toBeCloseTo(0.0997, 4);
  });

  it('returns null when all flows fall on the same day', () => {
    expect(
      calculateXirr([
        { date: new Date('2024-01-01'), amount: -1000 },
        { date: new Date('2024-01-01T12:00:00Z'), amount: 1100 },
      ]),
    ).toBeNull();
  });

  it('returns null for fewer than two flows', () => {
    expect(calculateXirr([])).toBeNull();
    expect(calculateXirr([{ date: new Date('2024-01-01'), amount: -1000 }])).toBeNull();
  });

  it('returns null instead of throwing when the rate cannot be converged', () => {
    expect(
      calculateXirr([
        { date: new Date('2024-01-01'), amount: -1000 },
        { date: new Date('2024-01-02'), amount: 1 },
      ]),
    ).toBeNull();
  });

  it('does not throw on multiple-root inputs and returns a valid root', () => {
    const rate = calculateXirr([
      { date: new Date('2024-06-01'), amount: -1000 },
      { date: new Date('2025-06-01'), amount: 3000 },
      { date: new Date('2026-06-01'), amount: -2100 },
    ]);

    expect(rate === null || Math.abs(rate - 0.1127) < 5e-3 || Math.abs(rate - 0.8873) < 5e-3).toBe(
      true,
    );
  });

  it('does not depend on input order', () => {
    const flows = [
      { date: new Date('2016-01-15'), amount: -1000 },
      { date: new Date('2016-02-08'), amount: -2500 },
      { date: new Date('2016-04-17'), amount: -1000 },
      { date: new Date('2016-08-24'), amount: 5050 },
    ];

    const forward = calculateXirr(flows);
    const reversed = calculateXirr([...flows].reverse());

    expect(forward).not.toBeNull();
    expect(reversed).not.toBeNull();
    expect(reversed!).toBeCloseTo(forward!, 3);
  });
});
