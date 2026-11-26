import { addMonths, isValid, parseISO } from 'date-fns';
import { resolveFundBucket, DEFAULT_FUND_BUCKETS } from '../../lib/fundMatcher';
export { DEFAULT_FUND_BUCKETS };

export type SWPPlanStatus = 'ready' | 'blocked' | 'disabled' | 'duplicate';

export interface SWPPlan {
  status: SWPPlanStatus;
  targetAmount: number;
  actualAmount: number;
  shortfall: number;
  redemption: Record<string, number>;
  reason?: string;
  idempotencyKey?: string;
}

interface Holding {
  units: number;
  nav: number; // Net Asset Value
}

interface Holdings {
  [bucketId: string]: Holding;
}

interface RedemptionPlan {
  [bucketId: string]: number; // Units to redeem
}

/**
 * FIFO redemption across buckets, in the given order (defaults to `holdings`
 * key order). Buckets absent from `holdings` are skipped.
 */
export function calculateFIFORedemption(
  holdings: Holdings,
  withdrawalAmount: number,
  fundOrder?: string[],
): RedemptionPlan {
  const order = fundOrder ?? Object.keys(holdings);
  const redemption: RedemptionPlan = {};

  let remaining = Math.max(0, Number.isFinite(withdrawalAmount) ? withdrawalAmount : 0);

  for (const fund of order) {
    redemption[fund] = 0;
    if (remaining <= 0) continue;

    const holding = holdings[fund];
    if (!holding) continue;

    const units = Math.max(0, Number.isFinite(holding.units) ? holding.units : 0);
    const nav = Math.max(0, Number.isFinite(holding.nav) ? holding.nav : 0);
    const fundValue = units * nav;

    if (nav > 0 && fundValue >= remaining) {
      // Partial redemption from this fund
      redemption[fund] = Math.min(units, remaining / nav);
      remaining = 0;
    } else {
      // Full redemption from this fund
      redemption[fund] = units;
      remaining -= fundValue;
    }
  }

  return redemption;
}

function freshNAV(entry: any): number | null {
  if (!entry || !Number.isFinite(entry.nav) || entry.nav <= 0) return null;
  if (entry.status === 'stale') return null;
  const timestamp = Date.parse(entry.timestamp);
  const ttl = entry.ttl;
  if (!Number.isFinite(timestamp) || !Number.isFinite(ttl) || ttl < 0) return null;
  const age = Date.now() - timestamp;
  return age >= 0 && age <= ttl ? entry.nav : null;
}

function withdrawalKey(date = new Date()): string {
  return `swp:${date.toISOString().slice(0, 7)}`;
}

/** Pure SWP planning. It never changes holdings, expenses, or schedules. */
export function calculateMonthlyWithdrawal(state: any): SWPPlan {
  const schedule = state?.swpSchedule;
  const targetAmount = Number.isFinite(schedule?.monthlyAmount) ? Math.max(0, schedule.monthlyAmount) : 0;
  if (!schedule?.enabled) {
    return { status: 'disabled', targetAmount, actualAmount: 0, shortfall: targetAmount, redemption: {}, reason: 'SWP is disabled' };
  }
  if (targetAmount <= 0) {
    return { status: 'blocked', targetAmount, actualAmount: 0, shortfall: 0, redemption: {}, reason: 'Monthly withdrawal must be positive' };
  }

  const buckets = state.fundBuckets?.length ? state.fundBuckets : DEFAULT_FUND_BUCKETS;
  const fundsByBucket = new Map<string, Array<{ id: string; fund: any; nav: number }>>();
  const addFunds = (collection: Record<string, any> | undefined, prefix: string) => {
    for (const [key, fund] of Object.entries(collection || {})) {
      if (!Number.isFinite(fund.units) || fund.units < 0) {
        throw new Error(`Invalid units for ${fund.name || key}`);
      }
      if (fund.units === 0) continue;
      const nav = freshNAV(fund.schemeCode ? state.nav?.[fund.schemeCode] : undefined);
      if (nav === null) {
        throw new Error(`Fresh NAV required for ${fund.name || key}`);
      }
      const bucketId = resolveFundBucket(fund, buckets);
      const entries = fundsByBucket.get(bucketId) || [];
      entries.push({ id: `${prefix}:${key}`, fund, nav });
      fundsByBucket.set(bucketId, entries);
    }
  };

  try {
    addFunds(state.sip, 'sip');
    addFunds(state.mf, 'mf');
  } catch (error) {
    return { status: 'blocked', targetAmount, actualAmount: 0, shortfall: targetAmount, redemption: {}, reason: error instanceof Error ? error.message : 'Fresh NAV required' };
  }

  const redemption: Record<string, number> = {};
  let remaining = targetAmount;
  let actualAmount = 0;
  for (const bucket of buckets) {
    for (const entry of fundsByBucket.get(bucket.id) || []) {
      if (remaining <= 0) break;
      const units = Math.min(entry.fund.units, remaining / entry.nav);
      if (units <= 0) continue;
      redemption[entry.id] = units;
      const amount = units * entry.nav;
      actualAmount += amount;
      remaining -= amount;
    }
  }

  if (actualAmount <= 0) {
    return { status: 'blocked', targetAmount, actualAmount: 0, shortfall: targetAmount, redemption: {}, reason: 'No positively valued fund units are available' };
  }
  return {
    status: 'ready',
    targetAmount,
    actualAmount,
    shortfall: Math.max(0, targetAmount - actualAmount),
    redemption,
  };
}

/** Read-only scenario operation; use recordMonthlyWithdrawal for a real ledger entry. */
export function simulateMonthlyWithdrawal(state: any): SWPPlan {
  return calculateMonthlyWithdrawal(state);
}

export function generateSWPSchedule(
  state: any,
  fiTriggerDate: string // When corpus hits the FI target
): void {
  // Enable SWP and set start date
  state.swpSchedule.enabled = true;
  state.swpSchedule.startDate = fiTriggerDate;

  // Create monthly withdrawal tasks in Firebase; persistence is simulated.
  getSWPWithdrawalDates(fiTriggerDate);

  // Simulated: saveToFirebase("users/swpSchedule", getSWPWithdrawalDates(fiTriggerDate));
}

export function getSWPWithdrawalDates(fiTriggerDate: string): string[] {
  if (!/^\d{4}-\d{2}$/.test(fiTriggerDate)) throw new RangeError('Invalid SWP start month');
  const startDate = parseISO(`${fiTriggerDate}-01T00:00:00Z`);
  if (!isValid(startDate)) throw new RangeError('Invalid SWP start month');

  return Array.from({ length: 360 }, (_, index) =>
    addMonths(startDate, index).toISOString().split('T')[0],
  );
}

export async function recordMonthlyWithdrawal(
  state: any,
  idempotencyKey = withdrawalKey(),
  operationDate = new Date(),
): Promise<SWPPlan> {
  const monthKey = idempotencyKey.startsWith('swp:') ? idempotencyKey.slice(4) : '';
  const existing = (state.expenses || []).find(
    (expense: any) => expense.idempotencyKey === idempotencyKey
      || (monthKey && expense.category === 'SWP' && expense.date?.slice(0, 7) === monthKey),
  );
  if (existing) {
    return {
      status: 'duplicate',
      targetAmount: state.swpSchedule?.monthlyAmount || 0,
      actualAmount: existing.amount,
      shortfall: Math.max(0, (state.swpSchedule?.monthlyAmount || 0) - existing.amount),
      redemption: {},
      idempotencyKey,
      reason: 'Withdrawal already recorded for this idempotency key',
    };
  }
  const plan = calculateMonthlyWithdrawal(state);
  if (plan.status === 'disabled') return { ...plan, idempotencyKey };
  if (plan.status !== 'ready') throw new Error(plan.reason || 'SWP withdrawal is not safe to record');

  for (const [id, units] of Object.entries(plan.redemption)) {
    const [collection, key] = id.split(':');
    const fund = state[collection]?.[key];
    if (!fund || fund.units < units) throw new Error('SWP holdings changed; refresh and recalculate');
    fund.units -= units;
  }
  state.expenses ||= [];
  state.expenses.push({
    date: operationDate.toISOString().slice(0, 10),
    category: 'SWP',
    amount: plan.actualAmount,
    linkedToSWP: true,
    idempotencyKey,
  });
  return { ...plan, idempotencyKey };
}

/** Backward-compatible explicit recording API. */
export const executeMonthlyWithdrawal = recordMonthlyWithdrawal;
