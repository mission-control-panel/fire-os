/** Read-only analytics over explicitly sourced observations. */

export type AnalyticsStatus = 'available' | 'insufficient-data' | 'unavailable';

export interface AnalyticsHolding {
  id: string;
  value: number;
  currency: string;
  sector?: string;
  fundId?: string;
  expenseRatio?: number;
  constituents?: Record<string, number>;
}

export interface ExposureRow { label: string; value: number; percentage: number }
export interface ExposureAnalysis { status: AnalyticsStatus; totalValue: number | null; rows: ExposureRow[]; missingCount: number }
export interface ConcentrationAnalysis {
  status: AnalyticsStatus;
  totalValue: number | null;
  topHoldingId: string | null;
  topHoldingValue: number | null;
  topHoldingPercentage: number | null;
  herfindahlIndex: number | null;
}
export interface FundOverlapRow { leftFundId: string; rightFundId: string; overlap: number }
export interface FundOverlapAnalysis { status: AnalyticsStatus; rows: FundOverlapRow[]; missingCount: number }
export interface ExpenseRatioAnalysis { status: AnalyticsStatus; weightedExpenseRatio: number | null; sourcedValue: number; missingCount: number }
export interface HistoricalPoint { date: string; value: number }
export interface RiskAnalysis { status: AnalyticsStatus; observations: number; annualizedVolatility: number | null; maxDrawdown: number | null }

function validValue(value: number): boolean { return Number.isFinite(value) && value >= 0; }
function validHolding(holding: AnalyticsHolding): boolean { return Boolean(holding.id && holding.currency.trim()) && validValue(holding.value); }

function rowsFrom(values: Map<string, number>, totalValue: number): ExposureRow[] {
  return [...values.entries()]
    .filter(([, value]) => value > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([label, value]) => ({ label, value, percentage: (value / totalValue) * 100 }));
}

function exposureBy(holdings: readonly AnalyticsHolding[], labelOf: (holding: AnalyticsHolding) => string | undefined): ExposureAnalysis {
  if (!holdings.length || holdings.some(holding => !validHolding(holding))) return { status: 'unavailable', totalValue: null, rows: [], missingCount: 0 };
  const values = new Map<string, number>();
  let totalValue = 0;
  let missingCount = 0;
  for (const holding of holdings) {
    const label = labelOf(holding)?.trim();
    if (!label) { missingCount++; continue; }
    values.set(label, (values.get(label) ?? 0) + holding.value);
    totalValue += holding.value;
  }
  if (!Number.isFinite(totalValue) || totalValue <= 0) return { status: 'unavailable', totalValue: null, rows: [], missingCount };
  return { status: missingCount > 0 ? 'insufficient-data' : 'available', totalValue, rows: rowsFrom(values, totalValue), missingCount };
}

export function currencyExposure(holdings: readonly AnalyticsHolding[]): ExposureAnalysis { return exposureBy(holdings, holding => holding.currency.toUpperCase()); }
export function sectorExposure(holdings: readonly AnalyticsHolding[]): ExposureAnalysis { return exposureBy(holdings, holding => holding.sector); }

export function concentration(holdings: readonly AnalyticsHolding[]): ConcentrationAnalysis {
  if (!holdings.length || holdings.some(holding => !validHolding(holding))) return { status: 'unavailable', totalValue: null, topHoldingId: null, topHoldingValue: null, topHoldingPercentage: null, herfindahlIndex: null };
  const totalValue = holdings.reduce((sum, holding) => sum + holding.value, 0);
  if (!Number.isFinite(totalValue) || totalValue <= 0) return { status: 'unavailable', totalValue: null, topHoldingId: null, topHoldingValue: null, topHoldingPercentage: null, herfindahlIndex: null };
  const sorted = [...holdings].sort((left, right) => right.value - left.value || left.id.localeCompare(right.id));
  const top = sorted[0];
  const herfindahlIndex = sorted.reduce((sum, holding) => { const weight = holding.value / totalValue; return sum + weight * weight; }, 0);
  return { status: 'available', totalValue, topHoldingId: top.id, topHoldingValue: top.value, topHoldingPercentage: (top.value / totalValue) * 100, herfindahlIndex };
}

function validConstituents(value: Record<string, number> | undefined): value is Record<string, number> {
  if (!value || Object.keys(value).length === 0) return false;
  return Object.values(value).every(weight => Number.isFinite(weight) && weight >= 0 && weight <= 1);
}

export function fundOverlap(holdings: readonly AnalyticsHolding[]): FundOverlapAnalysis {
  const funds = holdings.filter(holding => holding.fundId);
  if (funds.some(holding => !validHolding(holding))) return { status: 'unavailable', rows: [], missingCount: 0 };
  const missingCount = funds.filter(holding => !validConstituents(holding.constituents)).length;
  const rows: FundOverlapRow[] = [];
  for (let leftIndex = 0; leftIndex < funds.length; leftIndex++) {
    const left = funds[leftIndex];
    if (!validConstituents(left.constituents)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < funds.length; rightIndex++) {
      const right = funds[rightIndex];
      if (!validConstituents(right.constituents) || left.fundId === right.fundId) continue;
      const leftConstituents = left.constituents;
      const rightConstituents = right.constituents;
      const overlap = Object.keys(leftConstituents).reduce((sum, key) => sum + Math.min(leftConstituents[key] ?? 0, rightConstituents[key] ?? 0), 0);
      rows.push({ leftFundId: left.fundId!, rightFundId: right.fundId!, overlap });
    }
  }
  return { status: missingCount > 0 ? 'insufficient-data' : 'available', rows, missingCount };
}

export function expenseRatio(holdings: readonly AnalyticsHolding[]): ExpenseRatioAnalysis {
  if (!holdings.length || holdings.some(holding => !validHolding(holding))) return { status: 'unavailable', weightedExpenseRatio: null, sourcedValue: 0, missingCount: 0 };
  let sourcedValue = 0; let weighted = 0; let missingCount = 0;
  for (const holding of holdings) {
    if (holding.expenseRatio === undefined) { missingCount++; continue; }
    if (!Number.isFinite(holding.expenseRatio) || holding.expenseRatio < 0 || holding.expenseRatio > 100) return { status: 'unavailable', weightedExpenseRatio: null, sourcedValue: 0, missingCount: 0 };
    sourcedValue += holding.value; weighted += holding.value * holding.expenseRatio;
  }
  if (sourcedValue <= 0) return { status: 'insufficient-data', weightedExpenseRatio: null, sourcedValue: 0, missingCount };
  return { status: missingCount > 0 ? 'insufficient-data' : 'available', weightedExpenseRatio: weighted / sourcedValue, sourcedValue, missingCount };
}

export function riskMetrics(points: readonly HistoricalPoint[]): RiskAnalysis {
  if (points.length < 2) return { status: 'insufficient-data', observations: points.length, annualizedVolatility: null, maxDrawdown: null };
  const parsed = points.map(point => ({ ...point, time: Date.parse(point.date) }));
  if (parsed.some(point => !Number.isFinite(point.time) || !Number.isFinite(point.value) || point.value <= 0) || parsed.some((point, index) => index > 0 && point.time <= parsed[index - 1].time)) return { status: 'unavailable', observations: 0, annualizedVolatility: null, maxDrawdown: null };
  const returns = parsed.slice(1).map((point, index) => point.value / parsed[index].value - 1);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length;
  let peak = parsed[0].value; let maxDrawdown = 0;
  for (const point of parsed) { peak = Math.max(peak, point.value); maxDrawdown = Math.min(maxDrawdown, point.value / peak - 1); }
  return { status: 'available', observations: points.length, annualizedVolatility: Math.sqrt(Math.max(0, variance) * 252), maxDrawdown };
}
