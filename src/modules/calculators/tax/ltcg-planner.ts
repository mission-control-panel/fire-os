import { differenceInCalendarMonths, isValid, parse } from 'date-fns';
import type { FireOSState } from '../../../types/state';
import { reconcileLedgerLots, type LedgerLot, type LedgerTransaction } from '../../../lib/transaction-ledger';
import { calculateTaxLotPlan, CURRENT_INDIAN_CAPITAL_GAINS_RULES, financialYearFor, type TaxLot, type TaxLotDisposal, type TaxLotHarvestPlan } from './tax-lot-engine';

export interface FundHarvestRecommendation {
  fundKey: string;
  fundName: string;
  totalUnits: number;
  longTermUnits: number;
  longTermValue: number;
  longTermInvested: number;
  ltcgGains: number;
  currentNAV: number;
  recommendedHarvestUnits: number;
  recommendedHarvestAmount: number;
}

export interface TaxHarvestPlan {
  totalInvested: number;
  totalCurrentValue: number;
  totalLtcgGains: number;
  remainingLimit: number;
  totalRecommendedHarvest: number;
  totalRecommendedHarvestGain: number;
  recommendations: FundHarvestRecommendation[];
  dataQuality: TaxLotHarvestPlan['dataQuality'];
  financialYear: string | null;
  taxRuleVersion: string;
  taxRuleSourceUrl: string;
  taxRuleEffectiveFrom: string;
  taxRate: number;
  taxExemption: number;
  assumptions: string[];
}

function ledgerLotsForState(state: FireOSState, asOf: Date): { lots: TaxLot[]; realizedLots: TaxLot[]; disposals: TaxLotDisposal[]; hasSource: boolean; reconciled: boolean; hasCurrentLots: boolean } {
  const ledger = state.transactionLedger;
  if (!ledger?.lots?.length && !ledger?.transactions?.length) return { lots: [], realizedLots: [], disposals: [], hasSource: false, reconciled: false, hasCurrentLots: false };
  const lots: TaxLot[] = [];
  const realizedLots: TaxLot[] = [];
  const disposals: TaxLotDisposal[] = [];
  let currentLots;
  try {
    currentLots = ledger.transactions.length > 0
      ? reconcileLedgerLots(ledger, (transaction: LedgerTransaction, consumed: LedgerLot[]) => {
        const quantity = transaction.quantityMicros ?? 0;
        const salePrice = quantity > 0 ? (transaction.amountPaise / 100) / (quantity / 1_000_000) : 0;
        for (const lot of consumed) {
          realizedLots.push({ id: lot.id, fundKey: lot.instrumentId, fundName: lot.instrumentId, assetClass: 'equity-mutual-fund', acquiredDate: lot.acquiredDate, units: lot.quantityMicros / 1_000_000, costBasis: lot.costPaise / 100, currentNAV: 0, dataQuality: lot.costProvenance === 'exact' ? 'exact' : 'estimated' });
          disposals.push({ lotId: lot.id, saleDate: transaction.date, units: lot.quantityMicros / 1_000_000, salePrice });
        }
      })
      : ledger.lots;
  } catch {
    return { lots: [], realizedLots: [], disposals: [], hasSource: true, reconciled: false, hasCurrentLots: false };
  }
  for (const [fundKey, fund] of Object.entries(state.sip || {})) {
    if (!fund) continue;
    const nav = fund.schemeCode ? state.nav[fund.schemeCode]?.nav : undefined;
    if (!Number.isFinite(nav) || (nav ?? 0) <= 0) continue;
    const navRecord = fund.schemeCode ? state.nav[fund.schemeCode] : undefined;
    const navTime = navRecord ? Date.parse(navRecord.timestamp) : Number.NaN;
    const navFresh = Boolean(navRecord && Number.isFinite(navTime) && navTime <= asOf.getTime() && asOf.getTime() - navTime <= navRecord.ttl && navRecord.status !== 'stale' && navRecord.status !== 'manual');
    for (const lot of currentLots) {
      const instrument = ledger.instruments[lot.instrumentId];
      if (!instrument || (instrument.assetClass !== 'equity-listed' && instrument.assetClass !== 'equity-mutual-fund')) continue;
      const matches = [fundKey, fund.schemeCode, fund.name].filter(Boolean).includes(lot.instrumentId)
        || instrument?.name === fund.name;
      if (!matches) continue;
      const assetClass = instrument.assetClass;
      lots.push({
        id: lot.id,
        fundKey,
        fundName: fund.name || fundKey,
        assetClass,
        acquiredDate: lot.acquiredDate,
        units: lot.quantityMicros / 1_000_000,
        costBasis: lot.costPaise / 100,
        currentNAV: nav ?? 0,
        dataQuality: lot.costProvenance === 'exact' && navFresh ? 'exact' : 'estimated',
      });
    }
  }
  return { lots, realizedLots, disposals, hasSource: true, reconciled: true, hasCurrentLots: currentLots.length > 0 };
}

function emptyLedgerPlan(state: FireOSState): TaxHarvestPlan {
  const configuredLimit = state.taxCalendar?.harvestTarget ?? 0;
  return {
    totalInvested: 0,
    totalCurrentValue: 0,
    totalLtcgGains: 0,
    remainingLimit: Math.max(0, configuredLimit - (state.taxCalendar?.lastHarvestedAmount ?? 0)),
    totalRecommendedHarvest: 0,
    totalRecommendedHarvestGain: 0,
    recommendations: [],
    dataQuality: 'exact',
    financialYear: null,
    taxRuleVersion: CURRENT_INDIAN_CAPITAL_GAINS_RULES.version,
    taxRuleSourceUrl: CURRENT_INDIAN_CAPITAL_GAINS_RULES.sourceUrl,
    taxRuleEffectiveFrom: CURRENT_INDIAN_CAPITAL_GAINS_RULES.effectiveFrom,
    taxRate: CURRENT_INDIAN_CAPITAL_GAINS_RULES.ltcgRate,
    taxExemption: configuredLimit,
    assumptions: ['The transaction ledger reconciles to zero current holdings; no harvest is recommended.', 'No trade, redemption, or tax filing is initiated by this calculation.'],
  };
}

function unavailableLedgerPlan(state: FireOSState, reason: string): TaxHarvestPlan {
  const configuredLimit = state.taxCalendar?.harvestTarget ?? 0;
  return {
    totalInvested: 0,
    totalCurrentValue: 0,
    totalLtcgGains: 0,
    remainingLimit: Math.max(0, configuredLimit - (state.taxCalendar?.lastHarvestedAmount ?? 0)),
    totalRecommendedHarvest: 0,
    totalRecommendedHarvestGain: 0,
    recommendations: [],
    dataQuality: 'unknown',
    financialYear: null,
    taxRuleVersion: CURRENT_INDIAN_CAPITAL_GAINS_RULES.version,
    taxRuleSourceUrl: CURRENT_INDIAN_CAPITAL_GAINS_RULES.sourceUrl,
    taxRuleEffectiveFrom: CURRENT_INDIAN_CAPITAL_GAINS_RULES.effectiveFrom,
    taxRate: CURRENT_INDIAN_CAPITAL_GAINS_RULES.ltcgRate,
    taxExemption: configuredLimit,
    assumptions: [reason, 'No harvest recommendation is actionable until holdings and valuation data are complete.', 'No trade, redemption, or tax filing is initiated by this calculation.'],
  };
}

function harvestedAmountForYear(state: FireOSState, asOf: Date): number {
  const lastDate = state.taxCalendar?.lastLTCGHarvestDate;
  return lastDate && financialYearFor(lastDate) === financialYearFor(asOf)
    ? state.taxCalendar?.lastHarvestedAmount ?? 0
    : 0;
}

function fromTaxLotPlan(plan: TaxLotHarvestPlan, state: FireOSState): TaxHarvestPlan {
  const grouped = new Map<string, TaxLot[]>();
  for (const result of plan.lots) {
    const current = grouped.get(result.lot.fundKey) ?? [];
    current.push(result.lot);
    grouped.set(result.lot.fundKey, current);
  }
  const recommendations = [...grouped.entries()].map(([fundKey, lots]) => {
    const results = plan.lots.filter(result => result.lot.fundKey === fundKey);
    const fund = state.sip[fundKey];
    const longTerm = results.filter(result => result.eligible === true);
    const totalUnits = lots.reduce((sum, lot) => sum + lot.units, 0);
    const longTermUnits = longTerm.reduce((sum, result) => sum + result.lot.units, 0);
    const longTermValue = longTerm.reduce((sum, result) => sum + (result.currentValue ?? 0), 0);
    const longTermInvested = longTerm.reduce((sum, result) => sum + result.lot.costBasis, 0);
    const ltcgGains = longTerm.reduce((sum, result) => sum + Math.max(0, result.gain ?? 0), 0);
    const currentNAV = fund?.schemeCode ? state.nav[fund.schemeCode]?.nav ?? 0 : lots[0]?.currentNAV ?? 0;
    return { fundKey, fundName: lots[0]?.fundName ?? fundKey, totalUnits, longTermUnits, longTermValue, longTermInvested, ltcgGains, currentNAV, recommendedHarvestUnits: 0, recommendedHarvestAmount: 0 };
  }).sort((a, b) => b.ltcgGains - a.ltcgGains);

  let remainingLimit = plan.remainingExemption ?? 0;
  let totalRecommendedHarvest = 0;
  let totalRecommendedHarvestGain = 0;
  for (const recommendation of recommendations) {
    const gain = Math.min(recommendation.ltcgGains, remainingLimit);
    recommendation.recommendedHarvestUnits = recommendation.ltcgGains > 0 ? recommendation.longTermUnits * (gain / recommendation.ltcgGains) : 0;
    recommendation.recommendedHarvestAmount = recommendation.recommendedHarvestUnits * recommendation.currentNAV;
    totalRecommendedHarvest += recommendation.recommendedHarvestAmount;
    totalRecommendedHarvestGain += gain;
    remainingLimit -= gain;
  }
  return {
    totalInvested: plan.lots.reduce((sum, result) => sum + result.lot.costBasis, 0),
    totalCurrentValue: plan.totalCurrentValue ?? 0,
    totalLtcgGains: plan.totalLtcgGains ?? 0,
    remainingLimit: plan.remainingExemption ?? 0,
    totalRecommendedHarvest,
    totalRecommendedHarvestGain,
    recommendations,
    dataQuality: plan.dataQuality,
    financialYear: plan.financialYear,
    taxRuleVersion: plan.rules.version,
    taxRuleSourceUrl: plan.rules.sourceUrl,
    taxRuleEffectiveFrom: plan.rules.effectiveFrom,
    taxRate: plan.rules.ltcgRate,
    taxExemption: plan.rules.section112aExemption,
    assumptions: plan.assumptions,
  };
}

export function calculateLTCGHarvestPlan(
  state: FireOSState,
  now: Date = new Date()
): TaxHarvestPlan {
  const ledgerState = ledgerLotsForState(state, now);
  if (ledgerState.hasSource && !ledgerState.reconciled) return unavailableLedgerPlan(state, 'The transaction ledger could not be reconciled; the result is unavailable.');
  if (ledgerState.disposals.some((disposal) => disposal.saleDate < CURRENT_INDIAN_CAPITAL_GAINS_RULES.effectiveFrom)) {
    return unavailableLedgerPlan(state, 'Historical disposals predate the versioned tax rules available to this planner.');
  }
  if (ledgerState.reconciled && ledgerState.hasSource && ledgerState.lots.length === 0) {
    return ledgerState.hasCurrentLots
      ? unavailableLedgerPlan(state, 'Current ledger holdings could not be matched to complete, fresh valuations.')
      : emptyLedgerPlan(state);
  }
  if (ledgerState.lots.length > 0) {
    const configuredLimit = state.taxCalendar?.harvestTarget ?? 0;
    const rules = { ...CURRENT_INDIAN_CAPITAL_GAINS_RULES, section112aExemption: configuredLimit };
    return fromTaxLotPlan(calculateTaxLotPlan({
      lots: ledgerState.lots,
      asOf: now,
      lastHarvestedAmount: harvestedAmountForYear(state, now),
      realizedDisposals: ledgerState.disposals,
      realizedLots: ledgerState.realizedLots,
      rules,
    }), state);
  }

  const sip = state?.sip || {};
  const nav = state?.nav || {};
  
  let totalInvested = 0;
  let totalCurrentValue = 0;
  let totalLtcgGains = 0;

  const tempRecs: FundHarvestRecommendation[] = [];

  for (const [key, fund] of Object.entries(sip)) {
    if (!fund) continue;

    // 1. monthsElapsed
    let monthsElapsed = 0;
    if (fund.startDate) {
      const month = fund.startDate.length === 10 ? fund.startDate.slice(0, 7) : fund.startDate;
      const startDate = parse(month, 'yyyy-MM', new Date(2000, 0, 1));
      if (/^\d{4}-\d{2}$/.test(month) && isValid(startDate)) {
        monthsElapsed = differenceInCalendarMonths(now, startDate) + 1;
        monthsElapsed = Math.max(0, monthsElapsed);
      }
    }

    // 2. longTermMonths
    const longTermMonths = Math.max(0, monthsElapsed - 12);

    // 3. totalInvested
    const fundInvested = (fund.costBasis !== undefined && fund.costBasis !== null && fund.costBasis > 0)
      ? fund.costBasis
      : (fund.monthlyAmount || 0) * monthsElapsed;

    // 4. averageMonthlyInvestment
    const averageMonthlyInvestment = fundInvested / Math.max(1, monthsElapsed);

    // 5. longTermInvested
    const longTermInvested = averageMonthlyInvestment * longTermMonths;

    // 6. longTermUnits
    const units = fund.units || 0;
    let longTermUnits = fundInvested > 0 ? units * (longTermInvested / fundInvested) : 0;
    longTermUnits = Math.max(0, Math.min(units, longTermUnits));

    // 7. currentNAV
    const schemeCode = fund.schemeCode || '';
    const currentNAV = (schemeCode && nav[schemeCode]) ? nav[schemeCode].nav ?? 0 : 0;

    // 8. currentValue
    const currentValue = units * currentNAV;

    // 9. longTermValue
    const longTermValue = longTermUnits * currentNAV;

    // 10. ltcgGains
    const ltcgGains = Math.max(0, longTermValue - longTermInvested);

    // Update totals
    totalInvested += fundInvested;
    totalCurrentValue += currentValue;
    totalLtcgGains += ltcgGains;

    tempRecs.push({
      fundKey: key,
      fundName: fund.name || '',
      totalUnits: units,
      longTermUnits: longTermUnits,
      longTermValue: longTermValue,
      longTermInvested: longTermInvested,
      ltcgGains: ltcgGains,
      currentNAV: currentNAV,
      recommendedHarvestUnits: 0,
      recommendedHarvestAmount: 0,
    });
  }

  // Calculate remaining limit from the user-configured annual harvest target.
  const lastHarvested = harvestedAmountForYear(state, now);
  const harvestTarget = state?.taxCalendar?.harvestTarget ?? 0;
  const remainingLimit = Math.max(0, harvestTarget - lastHarvested);

  // Sort funds by ltcgGains descending
  const recommendations = tempRecs.sort((a, b) => b.ltcgGains - a.ltcgGains);

  let currentRemainingLimit = remainingLimit;
  let totalRecommendedHarvest = 0;
  let totalRecommendedHarvestGain = 0;

  for (const rec of recommendations) {
    if (currentRemainingLimit <= 0 || rec.ltcgGains <= 0) {
      rec.recommendedHarvestAmount = 0;
      rec.recommendedHarvestUnits = 0;
      continue;
    }

    // Allocate recommended gain up to remaining limit
    const A = Math.min(rec.ltcgGains, currentRemainingLimit);

    // Correct units calculation
    rec.recommendedHarvestUnits = rec.ltcgGains > 0 ? rec.longTermUnits * (A / rec.ltcgGains) : 0;

    // Correct harvest amount
    rec.recommendedHarvestAmount = rec.recommendedHarvestUnits * rec.currentNAV;

    totalRecommendedHarvest += rec.recommendedHarvestAmount;
    totalRecommendedHarvestGain += A;
    currentRemainingLimit -= A;
  }

  return {
    totalInvested,
    totalCurrentValue,
    totalLtcgGains,
    remainingLimit,
    totalRecommendedHarvest,
    totalRecommendedHarvestGain,
    recommendations,
    dataQuality: 'estimated',
    financialYear: null,
    taxRuleVersion: CURRENT_INDIAN_CAPITAL_GAINS_RULES.version,
    taxRuleSourceUrl: CURRENT_INDIAN_CAPITAL_GAINS_RULES.sourceUrl,
    taxRuleEffectiveFrom: CURRENT_INDIAN_CAPITAL_GAINS_RULES.effectiveFrom,
    taxRate: CURRENT_INDIAN_CAPITAL_GAINS_RULES.ltcgRate,
    taxExemption: harvestTarget,
    assumptions: ['Dated acquisition lots are unavailable; the legacy SIP-age estimate is shown.', 'No trade, redemption, or tax filing is initiated by this calculation.'],
  };
}
