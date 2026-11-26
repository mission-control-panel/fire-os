import { addMonths, isAfter, isValid, parseISO, startOfDay } from 'date-fns';

export type TaxAssetClass = 'equity-listed' | 'equity-mutual-fund' | 'other-financial' | 'other';
export type TaxLotDataQuality = 'exact' | 'estimated' | 'unknown';

export interface TaxRuleSet {
  version: string;
  effectiveFrom: string;
  sourceUrl: string;
  ltcgRate: number;
  stcgRate: number;
  section112aExemption: number;
  holdingPeriodMonths: Record<TaxAssetClass, number>;
}

export const CURRENT_INDIAN_CAPITAL_GAINS_RULES: TaxRuleSet = {
  version: 'finance-no-2-act-2024-v1',
  effectiveFrom: '2024-07-23',
  sourceUrl: 'https://www.incometaxindia.gov.in/en/sale-of-shares',
  ltcgRate: 0.125,
  stcgRate: 0.2,
  // Keep the statutory threshold generic in source; deployments may override it.
  section112aExemption: 125 * 1000,
  holdingPeriodMonths: {
    'equity-listed': 12,
    'equity-mutual-fund': 12,
    'other-financial': 24,
    other: 24,
  },
};

export interface TaxLot {
  id: string;
  fundKey: string;
  fundName: string;
  assetClass: TaxAssetClass;
  acquiredDate: string;
  units: number;
  costBasis: number;
  currentNAV: number;
  fees?: number;
  dataQuality?: Exclude<TaxLotDataQuality, 'unknown'>;
}

export interface TaxLotDisposal {
  lotId: string;
  saleDate: string;
  units: number;
  salePrice: number;
  fees?: number;
  assetClass?: TaxAssetClass;
}

export interface TaxLotResult {
  lot: TaxLot;
  eligible: boolean | null;
  currentValue: number | null;
  gain: number | null;
  holdingPeriodMonths: number | null;
}

export interface TaxLotHarvestPlan {
  status: 'available' | 'estimated' | 'insufficient-data' | 'unavailable';
  dataQuality: TaxLotDataQuality;
  financialYear: string | null;
  rules: Pick<TaxRuleSet, 'version' | 'effectiveFrom' | 'sourceUrl' | 'ltcgRate' | 'stcgRate' | 'section112aExemption'>;
  totalCurrentValue: number | null;
  totalLtcgGains: number | null;
  totalStcgGains: number | null;
  totalRealizedGains: number | null;
  totalRealizedLosses: number | null;
  remainingExemption: number | null;
  lots: TaxLotResult[];
  assumptions: string[];
}

const finiteNonNegative = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value >= 0;

export function financialYearFor(date: Date | string): string | null {
  const parsed = typeof date === 'string' ? parseISO(date) : date;
  if (!isValid(parsed)) return null;
  const year = parsed.getFullYear();
  const startYear = parsed.getMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function holdingPeriodMonths(acquiredDate: string, saleDate: Date): number | null {
  const acquired = parseISO(acquiredDate);
  if (!isValid(acquired) || !isValid(saleDate) || isAfter(acquired, saleDate)) return null;
  const years = saleDate.getFullYear() - acquired.getFullYear();
  const months = saleDate.getMonth() - acquired.getMonth();
  const wholeMonths = years * 12 + months - (saleDate.getDate() < acquired.getDate() ? 1 : 0);
  return Math.max(0, wholeMonths);
}

function emptyResult(rules: TaxRuleSet, status: TaxLotHarvestPlan['status'], assumptions: string[]): TaxLotHarvestPlan {
  return {
    status,
    dataQuality: status === 'estimated' ? 'estimated' : 'unknown',
    financialYear: null,
    rules,
    totalCurrentValue: null,
    totalLtcgGains: null,
    totalStcgGains: null,
    totalRealizedGains: null,
    totalRealizedLosses: null,
    remainingExemption: null,
    lots: [],
    assumptions,
  };
}

export function calculateTaxLotPlan(input: {
  lots: TaxLot[];
  asOf: Date;
  lastHarvestedAmount?: number;
  realizedDisposals?: TaxLotDisposal[];
  realizedLots?: TaxLot[];
  rules?: TaxRuleSet;
}): TaxLotHarvestPlan {
  const rules = input.rules ?? CURRENT_INDIAN_CAPITAL_GAINS_RULES;
  const financialYear = financialYearFor(input.asOf);
  if (!isValid(input.asOf) || !financialYear) return emptyResult(rules, 'unavailable', ['The as-of date is invalid.']);
  if (!Array.isArray(input.lots) || (input.lots.length === 0 && !(input.realizedLots?.length))) return emptyResult(rules, 'insufficient-data', ['Dated acquisition lots are unavailable; the result must remain an estimate or unknown.']);

  const results: TaxLotResult[] = [];
  let totalCurrentValue = 0;
  let totalLtcgGains = 0;
  let totalStcgGains = 0;
  let exact = true;

  for (const lot of input.lots) {
    const period = holdingPeriodMonths(lot.acquiredDate, input.asOf);
    const validLot = finiteNonNegative(lot.units) && lot.units > 0 && finiteNonNegative(lot.costBasis) && finiteNonNegative(lot.currentNAV) && period !== null;
    if (!validLot) {
      results.push({ lot, eligible: null, currentValue: null, gain: null, holdingPeriodMonths: period });
      exact = false;
      continue;
    }
    const currentValue = lot.units * lot.currentNAV;
    const gain = currentValue - lot.costBasis - (lot.fees ?? 0);
    const threshold = rules.holdingPeriodMonths[lot.assetClass];
    const eligible = threshold !== undefined && isLongTermOnDate(lot.acquiredDate, input.asOf, lot.assetClass, rules) === true;
    if (lot.dataQuality !== 'exact') exact = false;
    totalCurrentValue += currentValue;
    if (eligible) totalLtcgGains += Math.max(0, gain);
    else totalStcgGains += Math.max(0, gain);
    results.push({ lot, eligible, currentValue, gain, holdingPeriodMonths: period });
  }

  const lastHarvested = input.lastHarvestedAmount ?? 0;
  const remainingExemption = finiteNonNegative(lastHarvested)
    ? Math.max(0, rules.section112aExemption - lastHarvested)
    : null;
  const realized = (input.realizedDisposals ?? []).reduce((totals, disposal) => {
    const lot = [...input.lots, ...(input.realizedLots ?? [])].find(candidate => candidate.id === disposal.lotId);
    if (!lot || !isValid(parseISO(disposal.saleDate)) || financialYearFor(disposal.saleDate) !== financialYear || !finiteNonNegative(disposal.units) || disposal.units <= 0 || disposal.units > lot.units || !finiteNonNegative(disposal.salePrice) || (disposal.fees !== undefined && !finiteNonNegative(disposal.fees))) return totals;
    const gain = disposal.units * disposal.salePrice - lot.costBasis * (disposal.units / lot.units) - (disposal.fees ?? 0);
    const longTerm = isLongTermOnDate(lot.acquiredDate, parseISO(disposal.saleDate), disposal.assetClass ?? lot.assetClass, rules) === true;
    if (gain >= 0) totals.gains += gain;
    else totals.losses += Math.abs(gain);
    if (longTerm) {
      if (gain >= 0) totals.ltcgGains += gain;
      else totals.ltcgLosses += Math.abs(gain);
    }
    return totals;
  }, { gains: 0, losses: 0, ltcgGains: 0, ltcgLosses: 0 });

  const realizedExact = (input.realizedLots ?? []).every((lot) => lot.dataQuality === 'exact');
  const planExact = exact && realizedExact;
  const netRealizedGain = Math.max(0, realized.ltcgGains - realized.ltcgLosses);

  return {
    status: planExact ? 'available' : 'estimated',
    dataQuality: planExact ? 'exact' : 'estimated',
    financialYear,
    rules,
    totalCurrentValue,
    totalLtcgGains,
    totalStcgGains,
    totalRealizedGains: realized.gains,
    totalRealizedLosses: realized.losses,
    remainingExemption: remainingExemption === null ? null : Math.max(0, remainingExemption - netRealizedGain),
    lots: results,
    assumptions: [
      'Gains are estimates before surcharge, cess, set-off rules and filing-specific exemptions.',
      'LTCG classification uses the acquisition date and the configured asset-class holding period.',
      'No trade, redemption, or tax filing is initiated by this calculation.',
    ],
  };
}

export function isLongTermOnDate(acquiredDate: string, saleDate: Date, assetClass: TaxAssetClass, rules = CURRENT_INDIAN_CAPITAL_GAINS_RULES): boolean | null {
  const period = holdingPeriodMonths(acquiredDate, saleDate);
  const threshold = rules.holdingPeriodMonths[assetClass];
  return period === null || threshold === undefined ? null : isAfter(startOfDay(saleDate), startOfDay(addMonths(parseISO(acquiredDate), threshold)));
}
