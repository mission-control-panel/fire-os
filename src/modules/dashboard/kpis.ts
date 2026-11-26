/**
 * Dashboard KPI calculation functions
 * Calculates: Total Net Worth, SIP Status, FI Progress, Float Indicator
 * All functions handle NaN/Infinity safely with typed return objects
 */

import type { FireOSState } from '../../types/state';
import { addMonths, differenceInCalendarMonths, isValid, parse } from 'date-fns';
import { calculateXirr, type CashFlow } from '../../lib/calculations';

/**
 * Total Net Worth KPI - sum of all holdings at current market value
 */
export interface TotalNetWorthKPI {
  netWorth: number;
  assets: number;
  liabilities: number;
  breakdown: {
    mf: number;
    fd: number;
    epf: number;
    sip: number;
    bonds: number;
    esop: number;
    demat: number;
    otherHoldings: number;
  };
  valuation: ValuationCoverage;
}

export type ValuationStatus = 'current' | 'stale' | 'missing' | 'zero';

export interface ValuationCoverage {
  totalHoldings: number;
  pricedHoldings: number;
  unpricedHoldings: number;
  coveragePercent: number;
  staleHoldings: number;
  hasUnknownValues: boolean;
  /** Human-readable provenance for the entries contributing to the total. */
  sources: Array<{ holding: string; status: ValuationStatus; asOf?: string; source?: string }>;
}

function valuationStatus(entry: { nav: number; timestamp: string; ttl: number; status?: string } | undefined): ValuationStatus {
  if (!entry || !Number.isFinite(entry.nav)) return 'missing';
  if (entry.nav === 0) return 'zero';
  const timestamp = Date.parse(entry.timestamp);
  if (!Number.isFinite(timestamp) || !Number.isFinite(entry.ttl) || entry.ttl < 0) return 'missing';
  if (entry.status === 'stale' || Date.now() - timestamp > entry.ttl) return 'stale';
  return 'current';
}

function emptyCoverage(): ValuationCoverage {
  return { totalHoldings: 0, pricedHoldings: 0, unpricedHoldings: 0, coveragePercent: 100, staleHoldings: 0, hasUnknownValues: false, sources: [] };
}

export interface NetWorthAttribution {
  startingValue: number;
  contributions: number;
  investmentReturn: number;
  endingValue: number;
}

export function attributeNetWorthChange(
  startingValue: number,
  endingValue: number,
  contributions: number,
): NetWorthAttribution {
  const start = Math.max(0, Number.isFinite(startingValue) ? startingValue : 0);
  const end = Number.isFinite(endingValue) ? endingValue : start;
  const added = Math.max(0, Number.isFinite(contributions) ? contributions : 0);
  return { startingValue: start, contributions: added, investmentReturn: end - start - added, endingValue: end };
}

export function esopConcentration(state: FireOSState): number {
  const { assets } = totalNetWorth(state);
  const esop = Object.values(state.esop).reduce((sum, holding) => sum + Math.max(0, holding.amount || 0), 0);
  return assets > 0 ? esop / assets : 0;
}

export interface OtherHoldingsSummary {
  totalValue: number;
  weightedAnnualReturn: number;
}

export function summarizeOtherHoldings(state: FireOSState): OtherHoldingsSummary {
  const entries = Object.entries(state.otherHoldings || {})
    .filter(([key]) => !['otherHolding51', 'otherHolding52', 'otherHolding53'].includes(key))
    .map(([, holding]) => holding);
  const totalValue = entries.reduce((sum, holding) => sum + (holding.amount || 0), 0);
  const weightedReturn = entries.reduce(
    (sum, holding) => sum + (holding.amount || 0) * (holding.annualReturn || 0),
    0,
  );

  return {
    totalValue: isFinite(totalValue) ? Math.max(0, totalValue) : 0,
    weightedAnnualReturn: totalValue > 0 && isFinite(weightedReturn)
      ? Math.max(0, weightedReturn / totalValue)
      : 0,
  };
}

export function totalNetWorth(state: FireOSState): TotalNetWorthKPI {
  const sources: ValuationCoverage['sources'] = [];
  let totalHoldings = 0;
  let pricedHoldings = 0;
  const addSource = (holding: string, status: ValuationStatus, entry?: { timestamp?: string; source?: string }) => {
    totalHoldings++;
    if (status !== 'missing') pricedHoldings++;
    sources.push({ holding, status, ...(entry?.timestamp ? { asOf: entry.timestamp } : {}), ...(entry?.source ? { source: entry.source } : {}) });
  };

  // MF holdings: SIPFunds - units × NAV from cache
  const mf = Object.entries(state.mf).reduce((sum, [, fund]) => {
    const entry = fund.schemeCode ? state.nav[fund.schemeCode] : undefined;
    const status = fund.units === 0 ? 'zero' : valuationStatus(entry);
    addSource(fund.name, status, entry);
    return status === 'missing' ? sum : sum + (fund.units * (entry?.nav ?? 0) || 0);
  }, 0);

  // FD holdings: simple amount
  const fd = Object.values(state.fd).reduce((sum, holding) => sum + (holding.amount || 0), 0);

  // EPF holdings: simple amount
  const epf = Object.values(state.epf).reduce((sum, holding) => sum + (holding.amount || 0), 0);

  // SIP holdings: units × current NAV from cache
  const sip = Object.entries(state.sip).reduce((sum, [, fund]) => {
    // Try to get scheme code: from fund.schemeCode
    const navCacheKey = fund.schemeCode;
    const entry = navCacheKey ? state.nav[navCacheKey] : undefined;
    const status = fund.units === 0 ? 'zero' : valuationStatus(entry);
    addSource(fund.name, status, entry);
    return status === 'missing' ? sum : sum + (fund.units * (entry?.nav ?? 0) || 0);
  }, 0);

  // ESOP holdings: simple amount
  const esop = Object.values(state.esop).reduce((sum, holding) => sum + (holding.amount || 0), 0);

  // Bonds holdings: simple amount
  const bonds = Object.values(state.bonds).reduce((sum, holding) => sum + (holding.amount || 0), 0);

  // Demat holdings: currentValue already in INR
  const demat = Object.values(state.demat).reduce((sum, holding) => sum + (holding.currentValue || 0), 0);

  const otherHoldings = summarizeOtherHoldings(state).totalValue;
  const liabilities = Object.values(state.liabilities || {}).reduce((sum, liability) => sum + Math.max(0, liability.amount || 0), 0);

  const directHoldings = [
    ...Object.keys(state.fd || {}).map(key => ({ key, value: state.fd[key]?.amount })),
    ...Object.keys(state.epf || {}).map(key => ({ key, value: state.epf[key]?.amount })),
    ...Object.keys(state.esop || {}).map(key => ({ key, value: state.esop[key]?.amount })),
    ...Object.keys(state.bonds || {}).map(key => ({ key, value: state.bonds[key]?.amount })),
    ...Object.keys(state.demat || {}).map(key => ({ key, value: state.demat[key]?.currentValue })),
    ...Object.keys(state.otherHoldings || {}).filter(key => !['otherHolding51', 'otherHolding52', 'otherHolding53'].includes(key)).map(key => ({ key, value: state.otherHoldings[key]?.amount })),
  ];
  directHoldings.forEach(({ key, value }) =>
    addSource(key, Number.isFinite(value) ? (value === 0 ? 'zero' : 'current') : 'missing', { source: 'manual' }),
  );
  const assets = mf + fd + epf + sip + esop + bonds + demat + otherHoldings;
  const netWorth = assets - liabilities;

  return {
    netWorth: isFinite(netWorth) ? netWorth : 0,
    assets: isFinite(assets) ? assets : 0,
    liabilities: isFinite(liabilities) ? liabilities : 0,
    breakdown: {
      mf: isFinite(mf) ? mf : 0,
      fd: isFinite(fd) ? fd : 0,
      epf: isFinite(epf) ? epf : 0,
      sip: isFinite(sip) ? sip : 0,
      bonds: isFinite(bonds) ? bonds : 0,
      esop: isFinite(esop) ? esop : 0,
      demat: isFinite(demat) ? demat : 0,
      otherHoldings: isFinite(otherHoldings) ? otherHoldings : 0,
    },
    valuation: {
      totalHoldings,
      pricedHoldings,
      unpricedHoldings: totalHoldings - pricedHoldings,
      coveragePercent: totalHoldings > 0 ? (pricedHoldings / totalHoldings) * 100 : 100,
      staleHoldings: sources.filter(source => source.status === 'stale').length,
      hasUnknownValues: totalHoldings !== pricedHoldings || sources.some(source => source.status === 'stale'),
      sources,
    },
  };
}

/**
 * SIP Status KPI - tracks multiple SIP funds with P&L and XIRR
 */
export interface SIPStatusKPI {
  totalInvested: number;
  totalCurrentValue: number;
  totalPL: number | null;
  totalXIRR: number | null;
  totalXIRRProvenance: 'actual-ledger' | 'estimated-sip' | 'unavailable';
  funds: Array<{
    key: string;
    name: string;
    invested: number;
    currentValue: number | null;
    pl: number | null;
    xirr: number | null;
    valuation: ValuationStatus;
  }>;
  valuation: ValuationCoverage;
}

export function sipStatus(state: FireOSState): SIPStatusKPI {
  const funds: SIPStatusKPI['funds'] = [];
  let totalInvested = 0;
  let totalCurrentValue = 0;
  const coverage = emptyCoverage();

  Object.entries(state.sip).forEach(([key, fund]) => {
    // Try to get scheme code: from fund.schemeCode
    const navCacheKey = fund.schemeCode;
    const entry = navCacheKey ? state.nav[navCacheKey] : undefined;
    const valuation = fund.units === 0 ? 'zero' : valuationStatus(entry);
    coverage.totalHoldings++;
    if (valuation !== 'missing') coverage.pricedHoldings++;
    coverage.sources.push({ holding: fund.name, status: valuation, ...(entry?.timestamp ? { asOf: entry.timestamp } : {}), ...(entry?.source ? { source: entry.source } : {}) });

    // Calculate invested: use costBasis if provided, else calculate from monthlyAmount × months elapsed
    let invested = fund.costBasis || 0;
    if (!fund.costBasis && fund.startDate) {
      const month = fund.startDate.length === 10 ? fund.startDate.slice(0, 7) : fund.startDate;
      const startDate = parse(month, 'yyyy-MM', new Date(2000, 0, 1));
      if (/^\d{4}-\d{2}$/.test(month) && isValid(startDate)) {
        const now = new Date();
        const monthsElapsed = differenceInCalendarMonths(now, startDate) + 1;
        invested = fund.monthlyAmount * Math.max(1, monthsElapsed);
      }
    }

    const currentValue = valuation === 'missing' ? null : fund.units * (entry?.nav ?? 0);
    const pl = currentValue === null ? null : currentValue - invested;
    const xirr = currentValue === null || valuation !== 'current' ? null : calculateSipXirr(fund.startDate, fund.monthlyAmount, currentValue);

    funds.push({
      key,
      name: fund.name,
      invested: isFinite(invested) ? invested : 0,
      currentValue: currentValue !== null && isFinite(currentValue) ? currentValue : null,
      pl: pl !== null && isFinite(pl) ? pl : null,
      xirr,
      valuation,
    });

    totalInvested += invested;
    if (currentValue !== null) totalCurrentValue += currentValue;

  });
  const portfolioXirr = calculatePortfolioXirr(state, funds);

  coverage.unpricedHoldings = coverage.totalHoldings - coverage.pricedHoldings;
  coverage.coveragePercent = coverage.totalHoldings > 0 ? (coverage.pricedHoldings / coverage.totalHoldings) * 100 : 100;
  coverage.staleHoldings = coverage.sources.filter(source => source.status === 'stale').length;
  coverage.hasUnknownValues = coverage.unpricedHoldings > 0 || coverage.sources.some(source => source.status === 'stale');
  const totalPL = coverage.hasUnknownValues ? null : totalCurrentValue - totalInvested;

  return {
    totalInvested: isFinite(totalInvested) ? totalInvested : 0,
    totalCurrentValue: isFinite(totalCurrentValue) ? totalCurrentValue : 0,
    totalPL: totalPL !== null && isFinite(totalPL) ? totalPL : null,
    totalXIRR: portfolioXirr.rate,
    totalXIRRProvenance: portfolioXirr.provenance,
    funds,
    valuation: coverage,
  };
}

function calculatePortfolioXirr(
  state: FireOSState,
  funds: SIPStatusKPI['funds'],
): { rate: number | null; provenance: SIPStatusKPI['totalXIRRProvenance'] } {
  const ledgerFlows: CashFlow[] = [];
  for (const transaction of state.transactionLedger?.transactions ?? []) {
    const date = new Date(`${transaction.date}T00:00:00Z`);
    if (!isValid(date)) continue;
    const amount = transaction.amountPaise / 100;
    if (!Number.isFinite(amount) || amount === 0) continue;
    if (transaction.type === 'purchase' || transaction.type === 'opening_balance' || transaction.type === 'fee') ledgerFlows.push({ date, amount: -amount });
    if (transaction.type === 'sale' || transaction.type === 'dividend' || transaction.type === 'interest') ledgerFlows.push({ date, amount });
  }

  if (ledgerFlows.length > 0) {
    const currentValue = funds.reduce((sum, fund) => sum + (fund.currentValue ?? 0), 0);
    if (funds.some((fund) => fund.currentValue === null) || currentValue <= 0) return { rate: null, provenance: 'unavailable' };
    ledgerFlows.push({ date: new Date(), amount: currentValue });
    return { rate: calculateXirr(ledgerFlows), provenance: 'actual-ledger' };
  }

  const estimatedFlows: CashFlow[] = [];
  for (const fund of funds) {
    const source = state.sip[fund.key];
    if (!source || source.monthlyAmount <= 0 || fund.currentValue === null || !/^\d{4}-\d{2}/.test(source.startDate)) continue;
    const start = parse(source.startDate.slice(0, 7), 'yyyy-MM', new Date(2000, 0, 1));
    if (!isValid(start)) continue;
    const months = Math.max(1, differenceInCalendarMonths(new Date(), start) + 1);
    for (let index = 0; index < months; index += 1) estimatedFlows.push({ date: addMonths(start, index), amount: -source.monthlyAmount });
  }
  const currentValue = funds.reduce((sum, fund) => sum + (fund.currentValue ?? 0), 0);
  if (currentValue <= 0 || funds.length === 0 || funds.some((fund) => fund.currentValue === null)) return { rate: null, provenance: 'unavailable' };
  estimatedFlows.push({ date: new Date(), amount: currentValue });
  return { rate: calculateXirr(estimatedFlows), provenance: 'estimated-sip' };
}

function calculateSipXirr(startDate: string, monthlyAmount: number, currentValue: number): number | null {
  if (!/^\d{4}-\d{2}$/.test(startDate) || monthlyAmount <= 0 || currentValue <= 0) return null;
  const start = parse(startDate, 'yyyy-MM', new Date(2000, 0, 1));
  if (!isValid(start)) return null;

  const now = new Date();
  const months = Math.max(1, differenceInCalendarMonths(now, start) + 1);
  const cashFlows = Array.from({ length: months }, (_, index) => ({
    date: addMonths(start, index),
    amount: -monthlyAmount,
  }));
  cashFlows.push({ date: now, amount: currentValue });
  return calculateXirr(cashFlows);
}

/**
 * Annualized return for cash flows within [start, end] (inclusive).
 * Filters to the period and delegates solving to calculateXirr; never
 * synthesizes historical holding values that are absent from the flows.
 * Null when an endpoint is missing or the in-period flows cannot be solved.
 */
export function calculatePeriodReturn(cashFlows: CashFlow[], start: Date, end: Date): number | null {
  if (!isValid(start) || !isValid(end)) return null;
  const inPeriod = cashFlows.filter(
    flow => flow.date.getTime() >= start.getTime() && flow.date.getTime() <= end.getTime(),
  );
  return calculateXirr(inPeriod);
}

/**
 * FI Progress KPI - financial independence goal tracking
 */
export interface FIProgressKPI {
  fiTarget: number | null; // null = never entered, 0 = explicitly set to ₹0, positive = explicit target
  currentCorpus: number;
  progressPercent: number;
  yearsRemaining: number | null;
  targetSet: boolean; // true when a FI target was explicitly set (even if 0)
}

export function fiProgress(state: FireOSState): FIProgressKPI {
  // FI target: user-entered value in profile
  // fiTarget is null when never entered, 0 when explicitly set to ₹0, positive when set to a value > 0
  const fiTargetValue = state.profile.fiTarget;
  const fiTarget: number | null = fiTargetValue !== undefined && fiTargetValue !== null ? fiTargetValue : null;
  const targetSet: boolean = fiTargetValue !== null; // true when a target was explicitly set (even if 0)

  // Current corpus from totalNetWorth
  const netWorthData = totalNetWorth(state);
  const currentCorpus = netWorthData.netWorth;

  // Progress percentage
  const effectiveFiTarget = fiTarget ?? 0;
  const progressPercent = effectiveFiTarget > 0 ? (currentCorpus / effectiveFiTarget) * 100 : 0;

  // Years remaining: null while not achieved. With no positive target set,
  // nothing has been achieved, so report null rather than a false zero.
  let yearsRemaining: number | null = null;
  if (effectiveFiTarget > 0 && currentCorpus >= effectiveFiTarget) {
    yearsRemaining = 0;
  }

  return {
    fiTarget,
    currentCorpus: isFinite(currentCorpus) ? currentCorpus : 0,
    progressPercent: isFinite(progressPercent) ? Math.max(0, progressPercent) : 0,
    yearsRemaining,
    targetSet,
  };
}

/**
 * Float Indicator KPI - market drawdown indicator
 * Shows how much market has fallen from 52-week high
 */
export interface FloatIndicatorKPI {
  niftyLevel: number;
  niftyHigh52w: number;
  drawdownPercent: number;
  drawdownAmount: number;
}

export function floatIndicator(state: FireOSState): FloatIndicatorKPI {
  // Use niftyData if available, otherwise niftyHigh as fallback
  const niftyLevel = state.niftyData?.level ?? state.niftyHigh ?? 0;
  const niftyHigh52w = state.niftyHigh ?? niftyLevel;

  // Calculate drawdown
  const drawdownAmount = niftyHigh52w - niftyLevel;
  const drawdownPercent = niftyHigh52w > 0 ? (drawdownAmount / niftyHigh52w) * 100 : 0;

  return {
    niftyLevel: isFinite(niftyLevel) ? niftyLevel : 0,
    niftyHigh52w: isFinite(niftyHigh52w) ? niftyHigh52w : 0,
    drawdownPercent: isFinite(drawdownPercent) ? Math.max(0, drawdownPercent) : 0,
    drawdownAmount: isFinite(drawdownAmount) ? drawdownAmount : 0,
  };
}

/**
 * Portfolio composition for pie chart
 */
export interface PortfolioCompositionKPI {
  categories: Array<{
    name: string;
    value: number;
    percentage: number;
  }>;
}

export function portfolioComposition(state: FireOSState): PortfolioCompositionKPI {
  const breakdown = totalNetWorth(state).breakdown;
  const total = breakdown.mf + breakdown.fd + breakdown.epf + breakdown.sip + breakdown.esop + breakdown.bonds + breakdown.demat + breakdown.otherHoldings;

  const categories: PortfolioCompositionKPI['categories'] = [
    { name: 'Mutual Funds', value: breakdown.mf, percentage: total > 0 ? (breakdown.mf / total) * 100 : 0 },
    { name: 'SIPs', value: breakdown.sip, percentage: total > 0 ? (breakdown.sip / total) * 100 : 0 },
    { name: 'Fixed Deposits', value: breakdown.fd, percentage: total > 0 ? (breakdown.fd / total) * 100 : 0 },
    { name: 'EPF', value: breakdown.epf, percentage: total > 0 ? (breakdown.epf / total) * 100 : 0 },
    { name: 'Bonds', value: breakdown.bonds, percentage: total > 0 ? (breakdown.bonds / total) * 100 : 0 },
    { name: 'ESOP', value: breakdown.esop, percentage: total > 0 ? (breakdown.esop / total) * 100 : 0 },
    { name: 'Equity (Demat)', value: breakdown.demat, percentage: total > 0 ? (breakdown.demat / total) * 100 : 0 },
    { name: 'Other Holdings', value: breakdown.otherHoldings, percentage: total > 0 ? (breakdown.otherHoldings / total) * 100 : 0 },
  ].filter(cat => cat.value > 0); // Only show non-zero categories

  return {
    categories: categories.map(cat => ({
      ...cat,
      percentage: isFinite(cat.percentage) ? cat.percentage : 0,
    })),
  };
}
