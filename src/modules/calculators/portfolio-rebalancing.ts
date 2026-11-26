/**
 * Portfolio Rebalancing Module
 * Calculates allocation drift and generates rebalancing recommendations from
 * user-owned bucket targets (see `FundBucket.targetPercent`).
 */

import { analyzeAllocationDrift } from '../financial-safety/safety-engine';

/**
 * Holdings dictionary: bucket id → value in rupees
 */
interface Holdings {
  [bucketId: string]: number;
}

/**
 * Allocation drift analysis result
 */
export interface AllocationDrift {
  current: { [bucketId: string]: number }; // Current allocation % (0-100)
  target: { [bucketId: string]: number }; // Target allocation % (0-100)
  driftAmount: { [bucketId: string]: number }; // Difference in % (positive = over, negative = under)
  recommendations: string[]; // List of rebalancing actions
}

/**
 * Calculate allocation drift for portfolio
 * @param holdings - Bucket holdings: { bucketId: valueInRupees }
 * @param totalValue - Total portfolio value in rupees
 * @param targets - Target allocation % by bucket id
 * @returns AllocationDrift with current/target/drift and recommendations
 */
export function calculateAllocationDrift(
  holdings: Holdings,
  totalValue: number,
  targets: { [bucketId: string]: number },
): AllocationDrift {
  // Keep the legacy denominator contract while routing the calculation through
  // the validated shared engine. The denominator may include non-bucket assets.
  const result = analyzeAllocationDrift({ holdings, targets, totalValue });
  return {
    current: result.current,
    target: result.target,
    driftAmount: result.driftAmount,
    recommendations: result.recommendations,
  };
}
