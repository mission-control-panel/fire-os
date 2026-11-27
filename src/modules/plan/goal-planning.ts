import type { Goal, GoalInflation } from '../../types/state';

export interface GoalPlan {
  targetAtDate: number;
  monthsRemaining: number;
  shortfallAtDate: number;
  requiredMonthlyContribution: number | null;
  contributionGap: number | null;
  status: 'missing-data' | 'overdue' | 'on-track' | 'underfunded' | 'reached';
}

export interface GoalAllocation {
  allocatedByGoal: Record<string, number>;
  unallocatedAssets: string[];
  duplicateAssetIds: string[];
  invalidAssetIds: string[];
}

const INFLATION_RATES: Record<Exclude<GoalInflation, number>, number> = {
  cpi: 0.06,
  education: 0.08,
  medical: 0.08,
};
const MAX_PLANNING_AMOUNT = Number.MAX_SAFE_INTEGER;
const ASSET_KINDS = new Set(['sip', 'mf', 'fd', 'epf', 'esop', 'bonds', 'demat', 'other']);

function missingPlan(): GoalPlan {
  return { targetAtDate: 0, monthsRemaining: 0, shortfallAtDate: 0, requiredMonthlyContribution: null, contributionGap: null, status: 'missing-data' };
}

function validMonth(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return Boolean(match && Number(match[2]) >= 1 && Number(match[2]) <= 12);
}

export function annualInflationRate(inflation: GoalInflation): number {
  const rate = typeof inflation === 'number' ? inflation > 1 ? inflation / 100 : inflation : INFLATION_RATES[inflation];
  return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : NaN;
}

function monthsUntil(targetDate: string, today: Date): number {
  const [year, month] = targetDate.split('-').map(Number);
  return (year - today.getFullYear()) * 12 + (month - (today.getMonth() + 1));
}

/** Project a goal's today's-rupees target without mutating the persisted goal. */
export function planGoal(
  goal: Goal,
  options: { today?: Date; annualReturnRate?: number } = {},
): GoalPlan {
  const today = options.today ?? new Date();
  const annualReturnRate = options.annualReturnRate ?? 0.10;
  const inflationRate = annualInflationRate(goal.inflation);
  if (!Number.isFinite(goal.targetToday) || goal.targetToday <= 0 || goal.targetToday > MAX_PLANNING_AMOUNT || !validMonth(goal.targetDate)
    || !Number.isFinite(goal.currentAmount) || goal.currentAmount < 0 || goal.currentAmount > MAX_PLANNING_AMOUNT || !Number.isFinite(inflationRate)
    || !Number.isFinite(annualReturnRate) || annualReturnRate < 0 || annualReturnRate > 1) return missingPlan();
  const months = monthsUntil(goal.targetDate, today);
  const years = Math.max(0, months) / 12;
  const targetAtDate = goal.targetToday * (1 + inflationRate) ** years;
  const monthlyRate = (1 + annualReturnRate) ** (1 / 12) - 1;
  const growth = (1 + monthlyRate) ** Math.max(0, months);
  if (!Number.isFinite(targetAtDate) || !Number.isFinite(growth)) return missingPlan();
  const futureCurrentAmount = goal.currentAmount * growth;
  const shortfallAtDate = Math.max(0, targetAtDate - futureCurrentAmount);
  if (!Number.isFinite(futureCurrentAmount) || !Number.isFinite(shortfallAtDate)) return missingPlan();
  if (shortfallAtDate === 0) return { targetAtDate, monthsRemaining: months, shortfallAtDate, requiredMonthlyContribution: 0, contributionGap: 0, status: 'reached' };
  if (months <= 0) return { targetAtDate, monthsRemaining: months, shortfallAtDate, requiredMonthlyContribution: null, contributionGap: null, status: 'overdue' };
  const requiredMonthlyContribution = monthlyRate === 0
    ? shortfallAtDate / months
    : shortfallAtDate * monthlyRate / (growth - 1);
  if (!Number.isFinite(requiredMonthlyContribution)) return missingPlan();
  const contributionGap = Math.max(0, requiredMonthlyContribution - (goal.monthlyContribution ?? 0));
  return {
    targetAtDate,
    monthsRemaining: months,
    shortfallAtDate,
    requiredMonthlyContribution,
    contributionGap,
    status: contributionGap > 0 ? 'underfunded' : 'on-track',
  };
}

/** Assign each linked asset to the highest-priority goal only once. */
export function allocateGoalAssets(goals: readonly Goal[], assetValues: Record<string, number>): GoalAllocation {
  const allocatedByGoal: Record<string, number> = Object.fromEntries(goals.map((goal) => [goal.id, 0]));
  const owners = new Map<string, Goal>();
  const duplicateAssetIds = new Set<string>();
  const invalidAssetIds = new Set<string>();
  const assetIds = Object.keys(assetValues);
  const canonicalAssetId = (assetId: string): string => {
    const prefix = assetId.split(':', 1)[0];
    if (assetValues[assetId] !== undefined && ASSET_KINDS.has(prefix)) return assetId;
    const matches = assetIds.filter((candidate) => candidate.endsWith(`:${assetId}`));
    return matches.length === 1 ? matches[0] : assetId;
  };
  const ordered = [...goals].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const goal of ordered) {
    for (const rawAssetId of goal.linkedAssetIds) {
      const assetId = canonicalAssetId(rawAssetId);
      const previous = owners.get(assetId);
      if (previous) {
        duplicateAssetIds.add(rawAssetId);
        continue;
      }
      owners.set(assetId, goal);
      const value = assetValues[assetId];
      if (Number.isFinite(value) && value > 0) {
        const nextTotal = allocatedByGoal[goal.id] + value;
        if (!Number.isFinite(nextTotal) || nextTotal > MAX_PLANNING_AMOUNT) {
          allocatedByGoal[goal.id] = 0;
          invalidAssetIds.add(rawAssetId);
        } else {
          allocatedByGoal[goal.id] = nextTotal;
        }
      }
    }
  }
  return {
    allocatedByGoal,
    unallocatedAssets: assetIds.filter((assetId) => canonicalAssetId(assetId) === assetId && !owners.has(assetId)),
    duplicateAssetIds: [...duplicateAssetIds].sort(),
    invalidAssetIds: [...invalidAssetIds].sort(),
  };
}
