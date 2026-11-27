export type ScenarioKind = 'inflation' | 'debt-payoff' | 'fd-ladder' | 'rent-buy' | 'salary-growth' | 'market-stress' | 'withdrawal-sequence';

export interface SavedScenario {
  id: string;
  name: string;
  kind: ScenarioKind;
  inputs: Record<string, number>;
}

export interface ScenarioStore {
  list(): SavedScenario[];
  save(scenario: SavedScenario): void;
  remove(id: string): boolean;
}

const finite = (value: number) => Number.isFinite(value) && Math.abs(value) <= 1e15;
const valid = (values: number[]) => values.every(finite);
const MAX_YEARS = 100;
const SCENARIO_KINDS: ScenarioKind[] = ['inflation', 'debt-payoff', 'fd-ladder', 'rent-buy', 'salary-growth', 'market-stress', 'withdrawal-sequence'];

export function createScenarioStore(initial: SavedScenario[] = []): ScenarioStore {
  const scenarios = new Map<string, SavedScenario>();
  for (const scenario of initial) if (scenario && isValidScenarioRecord(scenario)) scenarios.set(scenario.id, structuredClone(scenario));
  return {
    list: () => Array.from(scenarios.values()).map((scenario) => structuredClone(scenario)),
    save: (scenario) => {
      if (!isValidScenarioRecord(scenario)) throw new Error('Invalid scenario');
      scenarios.set(scenario.id, structuredClone(scenario));
    },
    remove: (id) => scenarios.delete(id),
  };
}

function isValidScenarioRecord(scenario: SavedScenario): boolean {
  return typeof scenario.id === 'string' && scenario.id.trim().length > 0 && scenario.id.length <= 100
    && typeof scenario.name === 'string' && scenario.name.trim().length > 0 && scenario.name.length <= 200
    && SCENARIO_KINDS.includes(scenario.kind)
    && scenario.inputs !== null && typeof scenario.inputs === 'object' && !Array.isArray(scenario.inputs)
    && valid(Object.values(scenario.inputs).filter((value): value is number => typeof value === 'number'))
    && Object.values(scenario.inputs).every((value) => typeof value === 'number' && Number.isFinite(value));
}

export function projectInflation(amount: number, annualRatePercent: number, years: number): number | null {
  if (!valid([amount, annualRatePercent, years]) || amount < 0 || annualRatePercent < -100 || years < 0 || years > MAX_YEARS) return null;
  const result = amount * Math.pow(1 + annualRatePercent / 100, years);
  return Number.isFinite(result) && result <= Number.MAX_SAFE_INTEGER ? result : null;
}

export function debtPayoffMonths(balance: number, annualRatePercent: number, monthlyPayment: number): number | null {
  if (!valid([balance, annualRatePercent, monthlyPayment]) || balance < 0 || annualRatePercent < 0 || monthlyPayment <= 0) return null;
  if (balance === 0) return 0;
  const monthlyRate = annualRatePercent / 1200;
  if (monthlyPayment <= balance * monthlyRate) return null;
  const months = monthlyRate === 0 ? balance / monthlyPayment : -Math.log(1 - (balance * monthlyRate) / monthlyPayment) / Math.log(1 + monthlyRate);
  return Number.isFinite(months) && months >= 0 && months <= Number.MAX_SAFE_INTEGER ? Math.ceil(months) : null;
}

export function fdLadderValue(principal: number, annualRatePercent: number, years: number, compoundingPerYear = 4): number | null {
  if (!valid([principal, annualRatePercent, years, compoundingPerYear]) || principal < 0 || annualRatePercent < 0 || years < 0 || years > MAX_YEARS || compoundingPerYear <= 0) return null;
  const result = principal * Math.pow(1 + annualRatePercent / 100 / compoundingPerYear, compoundingPerYear * years);
  return Number.isFinite(result) && result <= Number.MAX_SAFE_INTEGER ? result : null;
}

export function rentVsBuy(params: { monthlyRent: number; annualRentIncreasePercent: number; homePrice: number; downPayment: number; annualHomeGrowthPercent: number; years: number }): { rentCost: number; homeValue: number; equity: number } | null {
  const { monthlyRent, annualRentIncreasePercent, homePrice, downPayment, annualHomeGrowthPercent, years } = params;
  if (!valid([monthlyRent, annualRentIncreasePercent, homePrice, downPayment, annualHomeGrowthPercent, years]) || monthlyRent < 0 || annualRentIncreasePercent < -100 || annualHomeGrowthPercent < -100 || homePrice <= 0 || downPayment < 0 || downPayment > homePrice || years < 0 || years > MAX_YEARS) return null;
  let rentCost = 0;
  for (let year = 0; year < Math.ceil(years); year++) rentCost += monthlyRent * 12 * Math.pow(1 + annualRentIncreasePercent / 100, year);
  const homeValue = homePrice * Math.pow(1 + annualHomeGrowthPercent / 100, years);
  const result = { rentCost, homeValue, equity: homeValue - (homePrice - downPayment) };
  return Object.values(result).every((value) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) ? result : null;
}

export function salaryGrowth(currentSalary: number, annualGrowthPercent: number, years: number): number[] | null {
  if (!valid([currentSalary, annualGrowthPercent, years]) || currentSalary < 0 || annualGrowthPercent < -100 || years < 0 || years > MAX_YEARS) return null;
  const result = Array.from({ length: Math.floor(years) + 1 }, (_, year) => currentSalary * Math.pow(1 + annualGrowthPercent / 100, year));
  return result.every((value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) ? result : null;
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 2 ** 32; };
}

export function seededMarketStress(startValue: number, annualReturnPercent: number, annualVolatilityPercent: number, years: number, seed: number): number[] | null {
  if (!valid([startValue, annualReturnPercent, annualVolatilityPercent, years, seed]) || startValue < 0 || annualReturnPercent < -100 || annualVolatilityPercent < 0 || years < 0 || years > MAX_YEARS) return null;
  const random = seededRandom(seed);
  const values = [startValue];
  for (let year = 0; year < Math.floor(years); year++) {
    const shock = (random() * 2 - 1) * annualVolatilityPercent;
    const next = values[year] * (1 + (annualReturnPercent + shock) / 100);
    if (!Number.isFinite(next) || next < 0 || next > Number.MAX_SAFE_INTEGER) return null;
    values.push(next);
  }
  return values;
}

export function withdrawalSequenceRisk(corpus: number, annualWithdrawal: number, annualReturnPercent: number, years: number, seed: number): { endingCorpus: number; depleted: boolean } | null {
  const path = seededMarketStress(corpus, annualReturnPercent, Math.abs(annualReturnPercent) / 2, years, seed);
  if (!path || !valid([annualWithdrawal]) || annualWithdrawal < 0) return null;
  let endingCorpus = corpus;
  for (let year = 1; year < path.length; year++) { endingCorpus = Math.max(0, path[year] - annualWithdrawal); if (endingCorpus === 0) return { endingCorpus, depleted: true }; }
  return { endingCorpus, depleted: false };
}
