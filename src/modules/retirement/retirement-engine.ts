/** Pure retirement math with explicit eligibility and uncertainty states. */

export type RetirementAssetClass = 'liquid' | 'investable' | 'restricted' | 'earmarked' | 'unvested' | 'illiquid';
export type RetirementProjectionStatus = 'projected' | 'already-retired' | 'unreachable' | 'unavailable';

export interface RetirementAsset {
  id: string;
  value: number;
  classification: RetirementAssetClass;
}

export interface RetirementCorpusSummary {
  totalAssets: number;
  netWorth: number;
  investableCorpus: number;
  fireEligibleCorpus: number;
  restrictedAssets: number;
  earmarkedAssets: number;
  unvestedAssets: number;
  illiquidAssets: number;
  liabilities: number;
}

export interface RetirementProjectionInput {
  assets: RetirementAsset[];
  liabilities: number;
  currentAge: number;
  retirementAge: number;
  lifeExpectancy: number;
  annualExpenses: number;
  annualInflation: number;
  expectedReturn: number;
  withdrawalRate: number;
  annualContribution: number;
  annualContributionGrowth?: number;
  annualPensionIncome?: number;
  taxRate?: number;
  /** Positive value overrides the rule-based target; zero is explicit unavailable input. */
  manualTargetCorpus?: number | null;
}

export interface RetirementProjection {
  status: RetirementProjectionStatus;
  uncertainty: 'assumptions' | 'insufficient-data';
  reason?: 'invalid-input' | 'zero-target' | 'missing-expenses';
  corpus: RetirementCorpusSummary;
  yearsToRetirement: number | null;
  retirementExpenses: number | null;
  requiredCorpusAtRetirement: number | null;
  projectedCorpusAtRetirement: number | null;
  shortfallAtRetirement: number | null;
  sustainableThroughLifeExpectancy: boolean | null;
  assumptions: Omit<RetirementProjectionInput, 'assets' | 'liabilities'>;
}

const ELIGIBLE_CLASSES = new Set<RetirementAssetClass>(['liquid', 'investable']);

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function summarizeRetirementCorpus(assets: RetirementAsset[], liabilities: number): RetirementCorpusSummary {
  const summary: RetirementCorpusSummary = {
    totalAssets: 0,
    netWorth: 0,
    investableCorpus: 0,
    fireEligibleCorpus: 0,
    restrictedAssets: 0,
    earmarkedAssets: 0,
    unvestedAssets: 0,
    illiquidAssets: 0,
    liabilities: finiteNonNegative(liabilities) ? liabilities : 0,
  };
  for (const asset of Array.isArray(assets) ? assets : []) {
    if (!asset || !finiteNonNegative(asset.value)) continue;
    summary.totalAssets += asset.value;
    if (ELIGIBLE_CLASSES.has(asset.classification)) {
      summary.investableCorpus += asset.value;
      summary.fireEligibleCorpus += asset.value;
    } else if (asset.classification === 'restricted') summary.restrictedAssets += asset.value;
    else if (asset.classification === 'earmarked') summary.earmarkedAssets += asset.value;
    else if (asset.classification === 'unvested') summary.unvestedAssets += asset.value;
    else if (asset.classification === 'illiquid') summary.illiquidAssets += asset.value;
  }
  summary.netWorth = summary.totalAssets - summary.liabilities;
  return summary;
}

function validInput(input: RetirementProjectionInput): boolean {
  return Number.isFinite(input.currentAge) && input.currentAge >= 0
    && Number.isFinite(input.retirementAge) && input.retirementAge >= input.currentAge
    && Number.isFinite(input.lifeExpectancy) && input.lifeExpectancy >= input.retirementAge
    && finiteNonNegative(input.annualExpenses)
    && Number.isFinite(input.annualInflation) && input.annualInflation > -1
    && Number.isFinite(input.expectedReturn) && input.expectedReturn > -1
    && Number.isFinite(input.withdrawalRate) && input.withdrawalRate > 0 && input.withdrawalRate <= 1
    && finiteNonNegative(input.annualContribution)
    && finiteNonNegative(input.annualContributionGrowth ?? 0)
    && finiteNonNegative(input.annualPensionIncome ?? 0)
    && Number.isFinite(input.taxRate ?? 0) && (input.taxRate ?? 0) >= 0 && (input.taxRate ?? 0) < 1
    && (input.manualTargetCorpus === undefined || input.manualTargetCorpus === null || finiteNonNegative(input.manualTargetCorpus));
}

function projectAssumptions(input: RetirementProjectionInput): RetirementProjection['assumptions'] {
  return {
    currentAge: input.currentAge,
    retirementAge: input.retirementAge,
    lifeExpectancy: input.lifeExpectancy,
    annualExpenses: input.annualExpenses,
    annualInflation: input.annualInflation,
    expectedReturn: input.expectedReturn,
    withdrawalRate: input.withdrawalRate,
    annualContribution: input.annualContribution,
    annualContributionGrowth: input.annualContributionGrowth ?? 0,
    annualPensionIncome: input.annualPensionIncome ?? 0,
    taxRate: input.taxRate ?? 0,
    manualTargetCorpus: input.manualTargetCorpus ?? null,
  };
}

export function projectRetirement(input: RetirementProjectionInput): RetirementProjection {
  const corpus = summarizeRetirementCorpus(input.assets, input.liabilities);
  const assumptions = projectAssumptions(input);
  const unavailable = (reason: RetirementProjection['reason']): RetirementProjection => ({
    status: 'unavailable', uncertainty: 'insufficient-data', reason, corpus,
    yearsToRetirement: null, retirementExpenses: null, requiredCorpusAtRetirement: null,
    projectedCorpusAtRetirement: null, shortfallAtRetirement: null,
    sustainableThroughLifeExpectancy: null, assumptions,
  });
  if (!validInput(input)) return unavailable('invalid-input');
  if (input.annualExpenses <= 0) return unavailable('missing-expenses');
  if (input.manualTargetCorpus === 0) return unavailable('zero-target');

  const yearsToRetirement = input.retirementAge - input.currentAge;
  const inflationFactor = Math.pow(1 + input.annualInflation, yearsToRetirement);
  const retirementExpenses = input.annualExpenses * inflationFactor;
  const pensionAtRetirement = (input.annualPensionIncome ?? 0) * inflationFactor;
  const grossSpending = Math.max(0, retirementExpenses - pensionAtRetirement) / Math.max(1e-9, 1 - (input.taxRate ?? 0));
  const requiredCorpusAtRetirement = input.manualTargetCorpus ?? grossSpending / input.withdrawalRate;

  let projectedCorpusAtRetirement = corpus.fireEligibleCorpus;
  let contribution = input.annualContribution;
  for (let year = 0; year < yearsToRetirement; year += 1) {
    projectedCorpusAtRetirement = projectedCorpusAtRetirement * (1 + input.expectedReturn) + contribution;
    contribution *= 1 + (input.annualContributionGrowth ?? 0);
  }

  let retirementCorpus = projectedCorpusAtRetirement;
  let spending = grossSpending;
  let sustainable = true;
  for (let year = 0; year < input.lifeExpectancy - input.retirementAge; year += 1) {
    retirementCorpus = retirementCorpus * (1 + input.expectedReturn) - spending;
    if (retirementCorpus < 0) sustainable = false;
    spending *= 1 + input.annualInflation;
  }
  const shortfallAtRetirement = Math.max(0, requiredCorpusAtRetirement - projectedCorpusAtRetirement);
  return {
    status: yearsToRetirement === 0 ? 'already-retired' : projectedCorpusAtRetirement >= requiredCorpusAtRetirement ? 'projected' : 'unreachable',
    uncertainty: 'assumptions', corpus, yearsToRetirement, retirementExpenses,
    requiredCorpusAtRetirement, projectedCorpusAtRetirement, shortfallAtRetirement,
    sustainableThroughLifeExpectancy: sustainable, assumptions,
  };
}
