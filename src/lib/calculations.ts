/**
 * Core financial calculation functions for FIRE OS
 * Includes XIRR, SIP corpus, FI metrics, and market crash simulations
 */

import xirr from 'xirr';

const MAX_PROJECTION_YEARS = 100;
const MAX_FINANCIAL_VALUE = Number.MAX_SAFE_INTEGER;

function boundedNonNegative(value: number, max = Number.MAX_SAFE_INTEGER): number {
  return Number.isFinite(value) ? Math.min(Math.max(0, value), max) : 0;
}

/**
 * SIP Corpus: Future Value of Regular Monthly Investments
 * Calculates compound growth of systematic monthly contributions
 *
 * @param monthlyAmount - Monthly SIP contribution in rupees
 * @param annualRate - Annual return rate as decimal (e.g., 0.12 for 12%)
 * @param years - Investment period in years
 * @returns Future value of all contributions + growth
 */
export function sipCorpus(
  monthlyAmount: number,
  annualRate: number,
  years: number
): number {
  const contribution = boundedNonNegative(monthlyAmount);
  const rate = Number.isFinite(annualRate) ? Math.max(-0.99, Math.min(annualRate, 10)) : 0;
  const months = boundedNonNegative(years, MAX_PROJECTION_YEARS) * 12;
  const monthlyRate = rate / 12;

  // Handle edge case: 0% return
  if (Math.abs(monthlyRate) < 1e-10) {
    return contribution * months;
  }

  // Formula: FV = P × [((1 + r)^n - 1) / r]
  // where P = monthly amount, r = monthly rate, n = number of months
  const fv = contribution * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
  return Number.isFinite(fv) ? Math.min(Math.max(0, fv), MAX_FINANCIAL_VALUE) : MAX_FINANCIAL_VALUE;
}

/**
 * SIP Cost Basis: Total Amount Invested
 * Simple calculation: monthly amount × number of months
 *
 * @param monthlyAmount - Monthly SIP contribution in rupees
 * @param monthsSinceStart - Number of months since SIP started
 * @returns Total amount invested (before any growth)
 */
export function sipCostBasis(
  monthlyAmount: number,
  monthsSinceStart: number
): number {
  return Math.min(boundedNonNegative(monthlyAmount) * boundedNonNegative(monthsSinceStart), MAX_FINANCIAL_VALUE);
}

export interface CashFlow {
  date: Date;
  amount: number;
}

/** Calculate annualized return for dated cash flows using the `xirr` package. */
export function calculateXirr(cashFlows: CashFlow[]): number | null {
  if (cashFlows.length < 2) return null;

  const validFlows = cashFlows.filter(
    flow => Number.isFinite(flow.amount) && !Number.isNaN(flow.date.getTime()),
  );
  if (validFlows.length < 2) return null;

  const hasPositive = validFlows.some(flow => flow.amount > 0);
  const hasNegative = validFlows.some(flow => flow.amount < 0);
  if (!hasPositive || !hasNegative) return null;

  try {
    const rate = xirr(validFlows.map(flow => ({ when: flow.date, amount: flow.amount })));
    return Number.isFinite(rate) ? rate : null;
  } catch {
    return null;
  }
}

/**
 * Emergency Runway: Months of Survival on Liquid Assets
 * How long can you survive on liquid assets at current expense rate?
 *
 * @param liquidAssets - Liquid assets in rupees (MF, FD, cash, etc.)
 * @param monthlyExpenses - Monthly expenses in rupees
 * @returns Number of months, or 999 if expenses are 0 (represents indefinite), or 0 if no assets
 */
export function emergencyRunway(
  liquidAssets: number,
  monthlyExpenses: number
): number {
  const assets = boundedNonNegative(liquidAssets);
  const expenses = boundedNonNegative(monthlyExpenses);
  // Edge case: no expenses
  if (expenses <= 0) {
    return assets > 0 ? 999 : 0;
  }

  // Edge case: no assets
  if (assets <= 0) {
    return 0;
  }

  return Math.min(assets / expenses, MAX_FINANCIAL_VALUE);
}

/**
 * Crash Protocol: Market Drawdown Scenarios
 * Calculates how much buffer to deploy if market crashes further
 *
 * @param portfolioValue - User's total portfolio value in rupees
 * @param niftyHigh52w - Nifty 52-week high level
 * @param niftyCurrentLevel - Current Nifty level
 * @returns Object with current drawdown % and deploy amounts for 10%, 15%, 25% additional crashes
 */
export function crashProtocol(
  portfolioValue: number,
  niftyHigh52w: number,
  niftyCurrentLevel: number
): {
  drawdownPercent: number;
  deployAmount10: number;
  deployAmount15: number;
  deployAmount25: number;
} {
  // Calculate current drawdown from 52W high
  const portfolio = boundedNonNegative(portfolioValue);
  const high = boundedNonNegative(niftyHigh52w);
  const current = boundedNonNegative(niftyCurrentLevel);
  const drawdownPercent = high > 0 ? ((high - current) / high) * 100 : 0;

  // Buffer is 10% of actual portfolio value
  const bufferPercentage = 0.1;
  const buffer = portfolio * bufferPercentage;

  // Calculate deploy amounts for additional crashes
  // Each deploy amount represents how much to deploy for 10%, 15%, 25% additional crashes
  const deployAmount10 = buffer * (10 / 100); // Deploy for 10% more crash
  const deployAmount15 = buffer * (15 / 100); // Deploy for 15% more crash
  const deployAmount25 = buffer * (25 / 100); // Deploy for 25% more crash

  return {
    drawdownPercent: Math.max(0, drawdownPercent), // Never negative
    deployAmount10,
    deployAmount15,
    deployAmount25,
  };
}

/**
 * FI Goal Progress: Retirement Timeline
 * Calculates progress towards Financial Independence target
 *
 * @param currentCorpus - Current investment corpus in rupees
 * @param annualExpenses - Annual living expenses in rupees
 * @returns FI target, progress %, and years remaining (0 if already achieved, null if not yet achieved)
 */
export function fiGoalProgress(
  currentCorpus: number,
  annualExpenses: number
): {
  fiTarget: number;
  progressPercent: number;
  yearsRemaining: number | null;
} {
  // FI target = 25 × annual expenses (safe withdrawal rule: 4% per year)
  const corpus = boundedNonNegative(currentCorpus);
  const expenses = boundedNonNegative(annualExpenses);
  const fiTarget = Math.min(expenses * 25, MAX_FINANCIAL_VALUE);

  // Handle edge case: 0 expenses
  if (expenses === 0) {
    return {
      fiTarget: 0,
      progressPercent: 0,
      yearsRemaining: 0,
    };
  }

  // Calculate progress percentage
  const progressPercent = (corpus / fiTarget) * 100;

  // If already achieved FI, years remaining = 0; otherwise null (not yet achieved)
  let yearsRemaining: number | null = null;
  if (corpus >= fiTarget) {
    yearsRemaining = 0;
  }

  return {
    fiTarget,
    progressPercent,
    yearsRemaining,
  };
}

/**
 * SIP Pause Impact: Cost of Missing Contributions
 * Calculates total cost of pausing SIP for N months
 *
 * @param monthlyAmount - Monthly SIP contribution in rupees
 * @param pauseMonths - Number of months to pause
 * @param annualRate - Annual return rate as decimal (e.g., 0.12 for 12%)
 * @returns Missed contributions, lost growth, and total cost
 */
export function sipPauseImpact(
  monthlyAmount: number,
  pauseMonths: number,
  annualRate: number
): {
  missedContributions: number;
  lostGrowth: number;
  totalCost: number;
} {
  const contribution = boundedNonNegative(monthlyAmount);
  const months = Math.floor(boundedNonNegative(pauseMonths, MAX_PROJECTION_YEARS * 12));
  const rate = Number.isFinite(annualRate) ? Math.max(-0.99, Math.min(annualRate, 10)) : 0;
  // Missed contributions: simple product
  const missedContributions = Math.min(contribution * months, MAX_FINANCIAL_VALUE);

  // If 0 pause months, no cost
  if (months === 0) {
    return {
      missedContributions: 0,
      lostGrowth: 0,
      totalCost: 0,
    };
  }

  // Lost growth: what those contributions would have earned over the pause period
  const monthlyRate = rate / 12;

  let lostGrowth = 0;

  if (Math.abs(monthlyRate) < 1e-10) {
    // No growth if rate is 0
    lostGrowth = 0;
  } else {
    // Future value of missed contributions if they had been invested
    // SIP contributions made at different times: some at start, some at end
    // Calculate FV of SIP for pauseMonths, then subtract the principal
    const fvOfMissedSIP = sipCorpus(contribution, rate, months / 12);
    lostGrowth = fvOfMissedSIP - missedContributions;
  }

  lostGrowth = Math.max(0, Math.min(lostGrowth, MAX_FINANCIAL_VALUE));
  const totalCost = Math.min(missedContributions + lostGrowth, MAX_FINANCIAL_VALUE);

  return {
    missedContributions,
    lostGrowth,
    totalCost,
  };
}
