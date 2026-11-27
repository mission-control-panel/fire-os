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
}

const INFLATION_RATES: Record<Exclude<GoalInflation, number>, number> = {
  cpi: 0.06,
  education: 0.08,
  medical: 0.08,
};

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
  if (!Number.isFinite(goal.targetToday) || goal.targetToday <= 0 || !validMonth(goal.targetDate)
    || !Number.isFinite(goal.currentAmount) || goal.currentAmount < 0 || !Number.isFinite(inflationRate)
    || !Number.isFinite(annualReturnRate) || annualReturnRate < 0) {
    return { targetAtDate: 0, monthsRemaining: 0, shortfallAtDate: 0, requiredMonthlyContribution: null, contributionGap: null, status: 'missing-data' };
  }
  const months = monthsUntil(goal.targetDate, today);
  const years = Math.max(0, months) / 12;
  const targetAtDate = goal.targetToday * (1 + inflationRate) ** years;
  const monthlyRate = (1 + annualReturnRate) ** (1 / 12) - 1;
  const growth = (1 + monthlyRate) ** Math.max(0, months);
  const futureCurrentAmount = goal.currentAmount * growth;
  const shortfallAtDate = Math.max(0, targetAtDate - futureCurrentAmount);
  if (shortfallAtDate === 0) return { targetAtDate, monthsRemaining: months, shortfallAtDate, requiredMonthlyContribution: 0, contributionGap: 0, status: 'reached' };
  if (months <= 0) return { targetAtDate, monthsRemaining: months, shortfallAtDate, requiredMonthlyContribution: null, contributionGap: null, status: 'overdue' };
  const requiredMonthlyContribution = monthlyRate === 0
    ? shortfallAtDate / months
    : shortfallAtDate * monthlyRate / (growth - 1);
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
  const ordered = [...goals].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const goal of ordered) {
    for (const assetId of goal.linkedAssetIds) {
      const previous = owners.get(assetId);
      if (previous) {
        duplicateAssetIds.add(assetId);
        continue;
      }
      owners.set(assetId, goal);
      const value = assetValues[assetId];
      if (Number.isFinite(value) && value > 0) allocatedByGoal[goal.id] += value;
    }
  }
  return {
    allocatedByGoal,
    unallocatedAssets: Object.keys(assetValues).filter((assetId) => !owners.has(assetId)),
    duplicateAssetIds: [...duplicateAssetIds].sort(),
  };
}
