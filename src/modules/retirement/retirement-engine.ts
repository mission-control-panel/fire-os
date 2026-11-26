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
  /** FIRE-eligible assets after liabilities; used for feasibility simulation. */
  netFireEligibleCorpus: number;
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
  /** Gross annual pension at current prices; the engine applies tax to it too. */
  annualPensionIncome?: number;
  /** Effective tax rate applied to both pension and portfolio withdrawals. */
  taxRate?: number;
  /** Positive value overrides the rule-based target; zero is explicit unavailable input. */
  manualTargetCorpus?: number | null;
}

export interface RetirementAssetValues {
  mf: number;
  sip: number;
  fd: number;
  epf: number;
  esop: number;
  bonds: number;
  demat: number;
  otherHoldings: number;
}

export interface DefaultRetirementProjectionInput extends RetirementAssetValues {
  liabilities: number;
  currentAge: number;
  annualExpenses: number;
  monthlyContribution: number;
  taxRate: number;
  dataComplete: boolean;
}

export interface RetirementProjection {
  status: RetirementProjectionStatus;
  uncertainty: 'assumptions' | 'insufficient-data';
  reason?: 'invalid-input' | 'zero-target' | 'missing-expenses' | 'missing-market-data';
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

const ASSET_CLASSES = new Set<RetirementAssetClass>(['liquid', 'investable', 'restricted', 'earmarked', 'unvested', 'illiquid']);

function validAssets(assets: RetirementAsset[]): boolean {
  return Array.isArray(assets) && assets.every((asset) =>
    Boolean(asset)
    && typeof asset.id === 'string'
    && asset.id.trim().length > 0
    && finiteNonNegative(asset.value)
    && ASSET_CLASSES.has(asset.classification),
  );
}

export function summarizeRetirementCorpus(assets: RetirementAsset[], liabilities: number): RetirementCorpusSummary {
  const summary: RetirementCorpusSummary = {
    totalAssets: 0,
    netWorth: 0,
    investableCorpus: 0,
    fireEligibleCorpus: 0,
    netFireEligibleCorpus: 0,
    restrictedAssets: 0,
    earmarkedAssets: 0,
    unvestedAssets: 0,
    illiquidAssets: 0,
    liabilities: finiteNonNegative(liabilities) ? liabilities : 0,
  };
  if (!validAssets(assets) || !finiteNonNegative(liabilities)) throw new Error('Invalid retirement asset or liability input');
  for (const asset of assets) {
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
  summary.netFireEligibleCorpus = Math.max(0, summary.fireEligibleCorpus - summary.liabilities);
  return summary;
}

export function retirementAssetsFromValues(values: RetirementAssetValues): RetirementAsset[] {
  return [
    { id: 'mf', value: values.mf, classification: 'investable' },
    { id: 'sip', value: values.sip, classification: 'investable' },
    { id: 'fd', value: values.fd, classification: 'liquid' },
    { id: 'epf', value: values.epf, classification: 'restricted' },
    { id: 'esop', value: values.esop, classification: 'restricted' },
    { id: 'bonds', value: values.bonds, classification: 'investable' },
    { id: 'demat', value: values.demat, classification: 'investable' },
    { id: 'otherHoldings', value: values.otherHoldings, classification: 'illiquid' },
  ];
}

export function projectDefaultRetirement(input: DefaultRetirementProjectionInput): RetirementProjection {
  const projection = projectRetirement({
    assets: retirementAssetsFromValues(input),
    liabilities: input.liabilities,
    currentAge: input.currentAge,
    retirementAge: Math.max(input.currentAge, input.currentAge + 10),
    lifeExpectancy: 85,
    annualExpenses: input.annualExpenses,
    annualInflation: 0.06,
    expectedReturn: 0.1,
    withdrawalRate: 0.04,
    annualContribution: input.monthlyContribution * 12,
    annualContributionGrowth: 0.1,
    taxRate: input.taxRate,
  });
  return input.dataComplete
    ? projection
    : { ...projection, status: 'unavailable', uncertainty: 'insufficient-data', reason: 'missing-market-data' };
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
    && validAssets(input.assets)
    && finiteNonNegative(input.liabilities)
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
  const assumptions = projectAssumptions(input);
  const corpus = validInput(input) ? summarizeRetirementCorpus(input.assets, input.liabilities) : {
    totalAssets: 0, netWorth: 0, investableCorpus: 0, fireEligibleCorpus: 0, netFireEligibleCorpus: 0,
    restrictedAssets: 0, earmarkedAssets: 0, unvestedAssets: 0, illiquidAssets: 0, liabilities: 0,
  };
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
  const taxFactor = Math.max(1e-9, 1 - (input.taxRate ?? 0));
  const grossPensionAtRetirement = (input.annualPensionIncome ?? 0) * inflationFactor;
  const netPensionAtRetirement = grossPensionAtRetirement * taxFactor;
  const grossSpending = Math.max(0, retirementExpenses - netPensionAtRetirement) / taxFactor;
  const requiredCorpusAtRetirement = input.manualTargetCorpus ?? grossSpending / input.withdrawalRate;

  let projectedCorpusAtRetirement = corpus.netFireEligibleCorpus;
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
    status: yearsToRetirement === 0
      ? 'already-retired'
      : projectedCorpusAtRetirement >= requiredCorpusAtRetirement && sustainable ? 'projected' : 'unreachable',
    uncertainty: 'assumptions', corpus, yearsToRetirement, retirementExpenses,
    requiredCorpusAtRetirement, projectedCorpusAtRetirement, shortfallAtRetirement,
    sustainableThroughLifeExpectancy: sustainable, assumptions,
  };
}
