import type { EquityGrant, EquityInstrumentKind } from '../../types/state';

export type EquityLifecycle = 'available' | 'partially-vested' | 'unvested' | 'exhausted' | 'invalid';

export interface EquityGrantSummary {
  grant: EquityGrant;
  vested: number;
  unvested: number;
  available: number;
  restricted: number;
  valueInr: number | null;
  exerciseCostInr: number | null;
  taxEstimateInr: number | null;
  lifecycle: EquityLifecycle;
  valuationStatus: 'current' | 'stale' | 'missing';
}

export interface EquityPlanSummary {
  grants: EquityGrantSummary[];
  vestedValueInr: number | null;
  availableValueInr: number | null;
  restrictedValueInr: number | null;
  concentrationPercent: number | null;
  liquidationToGoalsInr: number | null;
  assumptions: string[];
}

const DAY_MS = 86_400_000;
const MAX_EQUITY_INPUT = 1_000_000_000_000;
const MAX_SAFE_MONEY = Number.MAX_SAFE_INTEGER;

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_EQUITY_INPUT;
}

function strictDate(value: string | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

function isStale(asOf: string | undefined, now: Date, maxAgeDays: number): boolean {
  const date = strictDate(asOf);
  if (!date) return true;
  const age = now.getTime() - date.getTime();
  return age < 0 || age > maxAgeDays * DAY_MS;
}

export function equityLifecycle(grant: EquityGrant): EquityLifecycle {
  const quantities = [grant.grantedQuantity, grant.vestedQuantity, grant.exercisedQuantity, grant.soldQuantity];
  if (!quantities.every(finiteNonnegative) || grant.vestedQuantity > grant.grantedQuantity
    || grant.exercisedQuantity + grant.soldQuantity > grant.vestedQuantity) return 'invalid';
  const available = grant.vestedQuantity - grant.exercisedQuantity - grant.soldQuantity;
  if (available > 0 && grant.vestedQuantity < grant.grantedQuantity) return 'partially-vested';
  if (available > 0) return 'available';
  if (grant.vestedQuantity < grant.grantedQuantity) return 'unvested';
  return 'exhausted';
}

function valueFor(grant: EquityGrant, quantity: number): number | null {
  const fx = grant.fxToInr ?? (grant.currency.toUpperCase() === 'INR' ? 1 : null);
  if (!finiteNonnegative(grant.fairMarketValue) || !fx || !Number.isFinite(fx)) return null;
  const value = quantity * grant.fairMarketValue * fx;
  return Number.isFinite(value) && Math.abs(value) <= MAX_SAFE_MONEY ? value : null;
}

export function summarizeEquityGrant(grant: EquityGrant, now = new Date(), maxAgeDays = 30): EquityGrantSummary {
  const lifecycle = equityLifecycle(grant);
  const vested = finiteNonnegative(grant.vestedQuantity) ? Math.min(grant.vestedQuantity, grant.grantedQuantity) : 0;
  const unvested = finiteNonnegative(grant.grantedQuantity) ? Math.max(0, grant.grantedQuantity - vested) : 0;
  const available = lifecycle === 'invalid' ? 0 : Math.max(0, vested - grant.exercisedQuantity - grant.soldQuantity);
  const restricted = unvested;
  const isInr = grant.currency.toUpperCase() === 'INR';
  const fxStatus = isInr ? 'current' : (!grant.fxToInr || !strictDate(grant.fxAsOf)
    ? 'missing' : (isStale(grant.fxAsOf, now, maxAgeDays) ? 'stale' : 'current'));
  const priceStatus = grant.fairMarketValue > 0 && strictDate(grant.valuationAsOf)
    ? (isStale(grant.valuationAsOf, now, maxAgeDays) ? 'stale' : 'current')
    : 'missing';
  const valuationStatus = priceStatus === 'missing' || fxStatus === 'missing'
    ? 'missing' : (priceStatus === 'stale' || fxStatus === 'stale' ? 'stale' : 'current');
  const valueInr = valuationStatus !== 'current' ? null : valueFor(grant, available);
  const exerciseCostInr = grant.kind === 'rsu' || grant.kind === 'acquired'
    ? 0
    : valuationStatus !== 'current' ? null : valueFor({ ...grant, fairMarketValue: grant.strikePrice }, available);
  const taxRate = grant.taxRate ?? null;
  const taxablePerShare = grant.kind === 'rsu' ? grant.fairMarketValue : Math.max(0, grant.fairMarketValue - grant.strikePrice);
  const taxEstimateInr = taxRate === null || !finiteNonnegative(taxRate) || valuationStatus !== 'current'
    ? null
    : valueFor({ ...grant, fairMarketValue: taxablePerShare }, available * taxRate);
  return { grant, vested, unvested, available, restricted, valueInr, exerciseCostInr, taxEstimateInr, lifecycle, valuationStatus };
}

function sumKnown(values: Array<number | null>): number | null {
  if (values.some((value) => value === null || !Number.isFinite(value))) return null;
  const total = values.reduce((sum: number, value) => sum + (value ?? 0), 0);
  return Number.isFinite(total) ? total : null;
}

export function planEmployeeEquity(
  grants: EquityGrant[],
  input: { investableAssetsInr: number | null; goalShortfallInr: number | null; now?: Date; maxAgeDays?: number },
): EquityPlanSummary {
  const uniqueGrants = Array.from(new Map(grants.map((grant) => [grant.id, grant])).values());
  const summaries = uniqueGrants.map((grant) => summarizeEquityGrant(grant, input.now, input.maxAgeDays));
  const usable = summaries.filter((summary) => summary.lifecycle !== 'invalid');
  const vestedValueInr = sumKnown(usable.map((summary) => summary.valuationStatus !== 'current' ? null : valueFor(summary.grant, summary.vested)));
  const availableValueInr = sumKnown(usable.map((summary) => summary.valueInr));
  const restrictedValueInr = sumKnown(usable.map((summary) => summary.valuationStatus !== 'current' ? null : valueFor(summary.grant, summary.restricted)));
  const concentrationPercent = input.investableAssetsInr !== null && input.investableAssetsInr > 0 && availableValueInr !== null
    ? (availableValueInr / input.investableAssetsInr) * 100 : null;
  const liquidationToGoalsInr = availableValueInr !== null && input.goalShortfallInr !== null
    && Number.isFinite(input.goalShortfallInr) && input.goalShortfallInr >= 0
    ? Math.min(availableValueInr, input.goalShortfallInr) : null;
  const assumptions = [
    'Available value excludes unvested, exercised and sold quantities.',
    'Stale or missing prices are shown as unavailable and never treated as zero.',
    'Concentration uses available employee equity divided by supplied investable assets.',
  ];
  return { grants: summaries, vestedValueInr, availableValueInr, restrictedValueInr, concentrationPercent, liquidationToGoalsInr, assumptions };
}

export const equityInstrumentLabels: Record<EquityInstrumentKind, string> = {
  esop: 'ESOP option', rsu: 'RSU', espp: 'ESPP', acquired: 'Acquired shares',
};
