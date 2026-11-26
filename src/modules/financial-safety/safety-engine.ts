/**
 * Read-only financial-safety calculations shared by the dashboard, calculators
 * and Assistant. The engine never creates transactions or changes portfolio
 * state. Missing or stale inputs remain explicit instead of becoming zero.
 */

import type { FireOSState } from '../../types/state';
import { totalNetWorth } from '../dashboard/kpis';
import { bucketTargets, DEFAULT_FUND_BUCKETS, resolveFundBucket } from '../../lib/fundMatcher';

export type SafetyStatus = 'available' | 'insufficient-data' | 'unavailable';

export type LiquidityAssetKind = 'cash' | 'liquid-fund' | 'fixed-deposit' | 'restricted' | 'illiquid';
export type AssetValuationStatus = 'current' | 'stale' | 'missing';

export interface LiquidityAsset {
  id: string;
  kind: LiquidityAssetKind;
  value: number;
  valuation: AssetValuationStatus;
  /** Fraction unavailable due to an early-redemption penalty, 0..1. */
  penaltyRate?: number;
}

export interface LiquidityInput {
  assets: readonly LiquidityAsset[];
  monthlyEssentialExpenses: number | null;
}

export interface LiquidityAnalysis {
  status: SafetyStatus;
  reason: 'ok' | 'expenses-missing' | 'valuation-missing' | 'invalid-input' | 'no-accessible-assets';
  monthlyEssentialExpenses: number | null;
  cash: number;
  liquidFunds: number;
  fixedDepositsGross: number;
  fixedDepositPenalties: number;
  restricted: number;
  illiquid: number;
  unknownValue: number;
  accessibleValue: number | null;
  runwayMonths: number | null;
}

export interface CrashDeploymentLevel {
  drawdownTriggerPercent: number;
  deploymentPercent: number;
  amount: number | null;
  cumulativeAmount: number | null;
  eligible: boolean | null;
}

export interface CrashProtocolInput {
  liquidity: LiquidityAnalysis;
  currentDrawdownPercent: number | null;
  /** Reserve to preserve, expressed in essential-expense months. */
  reserveMonths?: number;
  /** Hard cap on total deployment as a fraction of the post-reserve crash fund. */
  cumulativeCapPercent?: number;
  levels?: readonly { drawdownTriggerPercent: number; deploymentPercent: number }[];
}

export interface CrashProtocolAnalysis {
  status: SafetyStatus;
  reason: 'ok' | 'drawdown-missing' | 'liquidity-missing' | 'invalid-input';
  reserveMonths: number;
  reserveAmount: number | null;
  crashFund: number | null;
  cumulativeCap: number | null;
  levels: CrashDeploymentLevel[];
}

export interface AllocationDriftInput {
  holdings: Record<string, number>;
  targets: Record<string, number>;
  dataComplete?: boolean;
  /** Optional legacy denominator, including assets outside target buckets. */
  totalValue?: number;
}

export interface AllocationDriftAnalysis {
  status: SafetyStatus;
  totalValue: number | null;
  current: Record<string, number>;
  target: Record<string, number>;
  driftAmount: Record<string, number>;
  recommendations: string[];
}

export interface PortfolioSafetyReport {
  liquidity: LiquidityAnalysis;
  crash: CrashProtocolAnalysis;
  allocation: AllocationDriftAnalysis;
  marketDrawdownPercent: number | null;
  marketDataFresh: boolean;
}

const DEFAULT_LEVELS = [
  { drawdownTriggerPercent: 10, deploymentPercent: 10 },
  { drawdownTriggerPercent: 15, deploymentPercent: 15 },
  { drawdownTriggerPercent: 25, deploymentPercent: 25 },
] as const;
const DEFAULT_RESERVE_MONTHS = 12;
const DRIFT_THRESHOLD = 5;

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function validAsset(asset: LiquidityAsset): boolean {
  return Boolean(asset.id) && finiteNonNegative(asset.value)
    && ['cash', 'liquid-fund', 'fixed-deposit', 'restricted', 'illiquid'].includes(asset.kind)
    && ['current', 'stale', 'missing'].includes(asset.valuation)
    && (asset.penaltyRate === undefined || (Number.isFinite(asset.penaltyRate) && asset.penaltyRate >= 0 && asset.penaltyRate <= 1));
}

export function analyzeLiquidity(input: LiquidityInput): LiquidityAnalysis {
  const expenses = input.monthlyEssentialExpenses;
  if (!input.assets.every(validAsset)
    || (expenses !== null && (!Number.isFinite(expenses) || expenses < 0))) {
    return {
      status: 'unavailable', reason: 'invalid-input', monthlyEssentialExpenses: null,
      cash: 0, liquidFunds: 0, fixedDepositsGross: 0, fixedDepositPenalties: 0,
      restricted: 0, illiquid: 0, unknownValue: 0, accessibleValue: null, runwayMonths: null,
    };
  }

  let cash = 0;
  let liquidFunds = 0;
  let fixedDepositsGross = 0;
  let fixedDepositPenalties = 0;
  let restricted = 0;
  let illiquid = 0;
  let unknownValue = 0;
  let unknownValuationCount = 0;

  for (const asset of input.assets) {
    if (asset.valuation !== 'current') {
      unknownValue += asset.value;
      unknownValuationCount++;
      continue;
    }
    const penalty = asset.value * (asset.penaltyRate ?? 0);
    switch (asset.kind) {
      case 'cash': cash += asset.value; break;
      case 'liquid-fund': liquidFunds += asset.value; break;
      case 'fixed-deposit':
        fixedDepositsGross += asset.value;
        fixedDepositPenalties += penalty;
        break;
      case 'restricted': restricted += asset.value; break;
      case 'illiquid': illiquid += asset.value; break;
    }
  }

  const accessibleValue = cash + liquidFunds + fixedDepositsGross - fixedDepositPenalties;
  const aggregateValues = [cash, liquidFunds, fixedDepositsGross, fixedDepositPenalties, restricted, illiquid, unknownValue, accessibleValue];
  if (aggregateValues.some(value => !finiteNonNegative(value))) {
    return {
      status: 'unavailable', reason: 'invalid-input', monthlyEssentialExpenses: expenses,
      cash: 0, liquidFunds: 0, fixedDepositsGross: 0, fixedDepositPenalties: 0,
      restricted: 0, illiquid: 0, unknownValue: 0, accessibleValue: null, runwayMonths: null,
    };
  }
  const status: SafetyStatus = expenses === null || unknownValuationCount > 0 ? 'insufficient-data' : 'available';
  const reason = expenses === null
    ? 'expenses-missing'
    : unknownValuationCount > 0
    ? 'valuation-missing'
    : accessibleValue > 0 || expenses === 0
      ? 'ok'
      : 'no-accessible-assets';
  const runwayMonths = status === 'available' && expenses !== null && expenses > 0 ? accessibleValue / expenses : null;
  if (runwayMonths !== null && !Number.isFinite(runwayMonths)) {
    return {
      status: 'unavailable', reason: 'invalid-input', monthlyEssentialExpenses: expenses,
      cash: 0, liquidFunds: 0, fixedDepositsGross: 0, fixedDepositPenalties: 0,
      restricted: 0, illiquid: 0, unknownValue: 0, accessibleValue: null, runwayMonths: null,
    };
  }
  return {
    status,
    reason,
    monthlyEssentialExpenses: expenses,
    cash,
    liquidFunds,
    fixedDepositsGross,
    fixedDepositPenalties,
    restricted,
    illiquid,
    unknownValue,
    accessibleValue: status === 'available' ? accessibleValue : accessibleValue,
    runwayMonths,
  };
}

export function analyzeCrashProtocol(input: CrashProtocolInput): CrashProtocolAnalysis {
  const reserveMonths = input.reserveMonths ?? DEFAULT_RESERVE_MONTHS;
  const cumulativeCapPercent = input.cumulativeCapPercent ?? 100;
  const levels = input.levels ?? DEFAULT_LEVELS;
  if (!finiteNonNegative(reserveMonths) || !finiteNonNegative(cumulativeCapPercent) || cumulativeCapPercent > 100
    || !levels.length || levels.some(level => !finiteNonNegative(level.drawdownTriggerPercent) || level.drawdownTriggerPercent > 100
      || !finiteNonNegative(level.deploymentPercent) || level.deploymentPercent > 100)) {
    return { status: 'unavailable', reason: 'invalid-input', reserveMonths, reserveAmount: null, crashFund: null, cumulativeCap: null, levels: [] };
  }
  if (input.liquidity.status !== 'available' || input.liquidity.accessibleValue === null || input.liquidity.monthlyEssentialExpenses === null) {
    return { status: 'unavailable', reason: 'liquidity-missing', reserveMonths, reserveAmount: null, crashFund: null, cumulativeCap: null, levels: levels.map(level => ({ ...level, amount: null, cumulativeAmount: null, eligible: null })) };
  }
  if (!Number.isFinite(input.currentDrawdownPercent) || (input.currentDrawdownPercent ?? 0) < 0 || (input.currentDrawdownPercent ?? 0) > 100) {
    const reserveAmount = input.liquidity.monthlyEssentialExpenses * reserveMonths;
    return { status: Number.isFinite(reserveAmount) ? 'insufficient-data' : 'unavailable', reason: Number.isFinite(reserveAmount) ? 'drawdown-missing' : 'invalid-input', reserveMonths, reserveAmount: Number.isFinite(reserveAmount) ? reserveAmount : null, crashFund: null, cumulativeCap: null, levels: levels.map(level => ({ ...level, amount: null, cumulativeAmount: null, eligible: null })) };
  }

  const reserveAmount = input.liquidity.monthlyEssentialExpenses * reserveMonths;
  if (!finiteNonNegative(reserveAmount)) {
    return { status: 'unavailable', reason: 'invalid-input', reserveMonths, reserveAmount: null, crashFund: null, cumulativeCap: null, levels: [] };
  }
  const crashFund = Math.max(0, input.liquidity.accessibleValue - reserveAmount);
  const cumulativeCap = crashFund * (cumulativeCapPercent / 100);
  if (!finiteNonNegative(crashFund) || !finiteNonNegative(cumulativeCap)) {
    return { status: 'unavailable', reason: 'invalid-input', reserveMonths, reserveAmount: null, crashFund: null, cumulativeCap: null, levels: [] };
  }
  let cumulativeAmount = 0;
  const resultLevels = levels.map(level => {
    const requested = crashFund * (level.deploymentPercent / 100);
    const amount = Math.min(requested, Math.max(0, cumulativeCap - cumulativeAmount));
    if (!finiteNonNegative(requested) || !finiteNonNegative(amount)) {
      return { ...level, amount: null, cumulativeAmount: null, eligible: null };
    }
    cumulativeAmount += amount;
    return {
      ...level,
      amount,
      cumulativeAmount,
      eligible: input.currentDrawdownPercent! >= level.drawdownTriggerPercent,
    };
  });
  if (resultLevels.some(level => level.amount === null)) {
    return { status: 'unavailable', reason: 'invalid-input', reserveMonths, reserveAmount: null, crashFund: null, cumulativeCap: null, levels: resultLevels };
  }
  return { status: 'available', reason: 'ok', reserveMonths, reserveAmount, crashFund, cumulativeCap, levels: resultLevels };
}

export function analyzeAllocationDrift(input: AllocationDriftInput): AllocationDriftAnalysis {
  const targetEntries = Object.entries(input.targets);
  if (input.dataComplete === false || targetEntries.some(([, value]) => !finiteNonNegative(value))) {
    return { status: 'insufficient-data', totalValue: null, current: {}, target: { ...input.targets }, driftAmount: {}, recommendations: [] };
  }
  const totalValue = input.totalValue ?? Object.values(input.holdings).reduce((sum, value) => sum + value, 0);
  if (!finiteNonNegative(totalValue) || totalValue <= 0 || targetEntries.length === 0 || targetEntries.every(([, value]) => value === 0)) {
    return { status: 'unavailable', totalValue: null, current: {}, target: { ...input.targets }, driftAmount: {}, recommendations: [] };
  }
  const current: Record<string, number> = {};
  const driftAmount: Record<string, number> = {};
  for (const [bucket, target] of targetEntries) {
    const value = input.holdings[bucket] ?? 0;
    if (!finiteNonNegative(value)) return { status: 'unavailable', totalValue: null, current: {}, target: { ...input.targets }, driftAmount: {}, recommendations: [] };
    current[bucket] = round((value / totalValue) * 100);
    driftAmount[bucket] = round(current[bucket] - target);
  }
  const recommendations = targetEntries.flatMap(([bucket]) => {
    const drift = Math.abs(driftAmount[bucket]);
    if (drift <= DRIFT_THRESHOLD) return [];
    const amount = round((drift / 100) * totalValue / 100000, 1);
    return [`${driftAmount[bucket] > 0 ? 'Reduce' : 'Increase'} ${bucket} by ₹${Number.isInteger(amount) ? `${amount}.0` : amount}L (${Number.isInteger(drift) ? `${drift}.0` : drift}% drift)`];
  });
  return { status: 'available', totalValue, current, target: { ...input.targets }, driftAmount, recommendations };
}

function navStatus(state: FireOSState, schemeCode: string | undefined): AssetValuationStatus {
  const entry = schemeCode ? state.nav[schemeCode] : undefined;
  if (!entry || !Number.isFinite(entry.nav) || entry.nav <= 0) return 'missing';
  const timestamp = Date.parse(entry.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > Date.now() || entry.status === 'stale' || Date.now() - timestamp > entry.ttl) return 'stale';
  return 'current';
}

/** Convert the persisted portfolio into the engine's explicit safety inputs. */
export function portfolioSafetyReport(state: FireOSState): PortfolioSafetyReport {
  const assets: LiquidityAsset[] = [];
  const add = (asset: LiquidityAsset) => assets.push(asset);
  Object.entries(state.sip || {}).forEach(([id, fund]) => add({ id: `sip:${id}`, kind: 'liquid-fund', value: Math.max(0, fund.units * (state.nav[fund.schemeCode ?? '']?.nav ?? 0)), valuation: fund.units === 0 ? 'current' : navStatus(state, fund.schemeCode) }));
  Object.entries(state.mf || {}).forEach(([id, fund]) => add({ id: `mf:${id}`, kind: 'liquid-fund', value: Math.max(0, fund.units * (state.nav[fund.schemeCode ?? '']?.nav ?? 0)), valuation: fund.units === 0 ? 'current' : navStatus(state, fund.schemeCode) }));
  Object.entries(state.fd || {}).forEach(([id, holding]) => add({ id: `fd:${id}`, kind: 'fixed-deposit', value: Math.max(0, holding.amount), valuation: 'current', penaltyRate: holding.earlyRedemptionPenaltyRate }));
  Object.entries(state.bonds || {}).forEach(([id, holding]) => add({ id: `bond:${id}`, kind: 'illiquid', value: Math.max(0, holding.amount), valuation: 'current' }));
  Object.entries(state.epf || {}).forEach(([id, holding]) => add({ id: `epf:${id}`, kind: 'restricted', value: Math.max(0, holding.amount), valuation: 'current' }));
  Object.entries(state.esop || {}).forEach(([id, holding]) => add({ id: `esop:${id}`, kind: 'restricted', value: Math.max(0, holding.amount), valuation: 'current' }));
  Object.entries(state.demat || {}).forEach(([id, holding]) => add({ id: `demat:${id}`, kind: 'illiquid', value: Math.max(0, holding.currentValue), valuation: 'current' }));
  Object.entries(state.otherHoldings || {}).forEach(([id, holding]) => {
    const name = holding.name.toLowerCase();
    const kind: LiquidityAssetKind = /cash|bank|savings/.test(name) ? 'cash' : /liquid|money market/.test(name) ? 'liquid-fund' : /fd|fixed deposit/.test(name) ? 'fixed-deposit' : /restricted|unvested|epf|provident/.test(name) ? 'restricted' : 'illiquid';
    add({ id: `other:${id}`, kind, value: Math.max(0, holding.amount), valuation: 'current' });
  });
  const netWorth = totalNetWorth(state);
  const monthlyExpenses = Number.isFinite(state.profile.annualExpenses) && state.profile.annualExpenses > 0 ? state.profile.annualExpenses : null;
  const liquidity = analyzeLiquidity({ assets, monthlyEssentialExpenses: monthlyExpenses });
  const marketTimestamp = state.niftyData ? Date.parse(state.niftyData.timestamp) : NaN;
  const marketDataFresh = Number.isFinite(marketTimestamp)
    && marketTimestamp <= Date.now()
    && Date.now() - marketTimestamp <= 60 * 60 * 1000
    && state.niftyData?.status !== 'manual';
  const marketDrawdownPercent = state.niftyData && state.niftyData.high52w > 0 && state.niftyData.level > 0
    ? Math.max(0, ((state.niftyData.high52w - state.niftyData.level) / state.niftyData.high52w) * 100)
    : null;
  const buckets = state.fundBuckets?.length ? state.fundBuckets : DEFAULT_FUND_BUCKETS;
  const holdings: Record<string, number> = Object.fromEntries(buckets.map(bucket => [bucket.id, 0]));
  for (const fund of [...Object.values(state.sip || {}), ...Object.values(state.mf || {})]) {
    const nav = state.nav[fund.schemeCode ?? ''];
    const value = fund.units * (nav?.nav ?? 0);
    if (!Number.isFinite(value) || navStatus(state, fund.schemeCode) !== 'current') continue;
    const bucket = resolveFundBucket({ name: fund.name, bucketId: fund.bucketId }, buckets);
    holdings[bucket] = (holdings[bucket] ?? 0) + value;
  }
  const allocation = analyzeAllocationDrift({ holdings, targets: bucketTargets(buckets), dataComplete: !netWorth.valuation.hasUnknownValues });
  const crash = analyzeCrashProtocol({ liquidity, currentDrawdownPercent: marketDataFresh ? marketDrawdownPercent : null });
  return { liquidity, crash, allocation, marketDrawdownPercent, marketDataFresh };
}
