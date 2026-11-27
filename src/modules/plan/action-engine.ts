import type { FireOSState } from '../../types/state';
import { checkWatchdogRules, floatIndicator } from '../../core/feature-ports';
import { portfolioSafetyReport } from '../financial-safety/safety-engine';
import { planGoal } from './goal-planning';
import { assessInsuranceNeeds } from '../insurance/insurance-planning';
import { formatCurrency } from '../../lib/formatters';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}

export interface ActionItem {
  id: string;              // Unique key for checkbox persistence
  priority: 'urgent' | 'this-month' | 'upcoming' | 'future';
  title: string;
  description: string;
  category: 'invest' | 'protect' | 'tax' | 'review';
  completed: boolean;      // From D.completedActions[id]
}

export function generateActionItems(state: FireOSState): ActionItem[] {
  const actions: ActionItem[] = [];
  const now = new Date();
  const currentMonth = now.getMonth(); // 0 = Jan, 3 = Apr
  const currentYear = now.getFullYear();
  const harvestTarget = state.taxCalendar?.harvestTarget ?? 0;
  const harvestLabel = harvestTarget > 0 ? `₹${harvestTarget.toLocaleString('en-IN')}` : '';

  // Helper to add actions
  const addAction = (item: Omit<ActionItem, 'completed'>) => {
    const completedRecord = state.completedActions[item.id];
    let completed = false;
    if (completedRecord) {
      const completedAt = new Date(completedRecord.completedAt);
      const daysSince = (now.getTime() - completedAt.getTime()) / (1000 * 3600 * 24);
      // Reset after 30 days for recurring actions, otherwise keep completed
      if (daysSince < 30) {
        completed = true;
      }
    }
    actions.push({ ...item, completed });
  };

  // 1. Watchdog alerts (urgent)
  const alerts = checkWatchdogRules(state.watchdogRules ?? []);

  alerts.forEach(alert => {
    addAction({
      id: `watchdog-${alert.fund}-${alert.type}`,
      priority: 'urgent',
      category: 'review',
      title: 'Address Fund Health Alert',
      description: alert.message + ' - ' + alert.action,
    });
  });

  // 2. Drawdown > 10% (urgent)
  const float = floatIndicator(state);
  if (float.drawdownPercent > 10) {
    addAction({
      id: `drawdown-crash-${currentYear}-${currentMonth}`,
      priority: 'urgent',
      category: 'invest',
      title: 'Market Drawdown > 10%',
      description: 'Deploy crash protocol. Check Calculators tab for exact deployment amounts.',
    });
  }

  // 3 & 4. Insurance (urgent / this-month)
  const ins = state.insurance;
  const annualIncome = state.profile.monthlyIncome ? state.profile.monthlyIncome * 12 : 0;
  const insuranceNeeds = ins ? assessInsuranceNeeds({
    annualIncome,
    dependents: Math.max(0, ins.health.familySize - 1),
    outstandingDebt: Object.values(state.liabilities ?? {}).reduce((sum, liability) => sum + Math.max(0, liability.amount || 0), 0),
    futureGoalShortfall: (state.goals ?? []).reduce((sum, goal) => sum + Math.max(0, planGoal(goal).shortfallAtDate), 0),
    accessibleAssets: portfolioSafetyReport(state).liquidity.accessibleValue ?? 0,
    familySize: ins.health.familySize,
    currentTermCover: ins.termLife.currentCover,
    currentHealthCover: ins.health.currentCover,
    legacyTermExpiryDate: ins.termLife.expiryDate,
    legacyHealthExpiryDate: ins.health.expiryDate,
    policies: ins.policies,
  }) : null;
  if (!ins || (insuranceNeeds?.currentTermCover === 0 && insuranceNeeds.currentHealthCover === 0)) {
    addAction({
      id: 'insurance-missing',
      priority: 'urgent',
      category: 'protect',
      title: 'Configure Insurance Data',
      description: 'Set up your insurance data in the Insurance tab to evaluate your protection.',
    });
  } else {
    let gaps = [];
    if (insuranceNeeds?.termGap && insuranceNeeds.termGap > 0) gaps.push(`term gap ₹${Math.round(insuranceNeeds.termGap / 100000)}L`);
    if (insuranceNeeds?.healthGap && insuranceNeeds.healthGap > 0) gaps.push(`health gap ₹${Math.round(insuranceNeeds.healthGap / 100000)}L`);
    
    if (gaps.length > 0) {
      addAction({
        id: 'insurance-gap',
        priority: 'this-month',
        category: 'protect',
        title: 'Review Insurance Coverage',
        description: `You have an insurance gap: ${gaps.join(', ')}. Review and consider top-up plans.`,
      });
    }
  }

  // 5. Portfolio drift > 5% (this-month)
  const drift = portfolioSafetyReport(state).allocation;
  if (drift.recommendations.length > 0) {
    addAction({
      id: `portfolio-drift-${currentYear}-${currentMonth}`,
      priority: 'this-month',
      category: 'invest',
      title: 'Rebalance Portfolio',
      description: 'Your asset allocation has drifted >5% from targets. ' + drift.recommendations.join(', '),
    });
  }

  // 6. Tax harvest overdue (>11 months since last) (this-month)
  const lastHarvestStr = state.taxCalendar?.lastLTCGHarvestDate;
  if (harvestTarget > 0 && lastHarvestStr) {
    const lastHarvest = new Date(lastHarvestStr);
    const monthsSince = (now.getTime() - lastHarvest.getTime()) / (1000 * 3600 * 24 * 30);
    if (monthsSince > 11) {
      addAction({
        id: `tax-harvest-${currentYear}`,
        priority: 'this-month',
        category: 'tax',
        title: 'Harvest LTCG Tax Free Exemption',
        description: `It has been >11 months since your last LTCG harvest. Harvest up to ${harvestLabel} tax-free.`,
      });
    }
  } else if (harvestTarget > 0 && state.profile.age > 25) {
     // If no harvest recorded, remind to do it.
     addAction({
        id: `tax-harvest-initial`,
        priority: 'this-month',
        category: 'tax',
        title: 'Plan First LTCG Harvest',
        description: `You haven't recorded any LTCG harvests. Use the tax planner to harvest up to ${harvestLabel} tax-free.`,
      });
  }

  // 7. Current month = April (this-month)
  if (currentMonth === 3) {
    addAction({
      id: `step-up-sip-${currentYear}`,
      priority: 'this-month',
      category: 'invest',
      title: 'Step Up SIP',
      description: 'It\'s April! Time to step up your SIP amounts by at least 10%.',
    });
  }

  // 8. FD maturity within 30 days (this-month)
  /*
  Object.entries(state.fd).forEach(([key, fd]) => {
    if (fd.date) {
      const maturityDate = new Date(fd.date);
      const daysToMaturity = (maturityDate.getTime() - now.getTime()) / (1000 * 3600 * 24);
      if (daysToMaturity > 0 && daysToMaturity <= 30) {
        addAction({
          id: `fd-maturity-${key}`,
          priority: 'this-month',
          category: 'review',
          title: 'FD Maturing Soon',
          description: `FD matures on ${fd.date}. Plan for reinvestment.`,
        });
      }
    }
  });
  */

  // 9. Goal SIP start approaching (< 6 months) (upcoming)
  for (const goal of state.goals ?? []) {
    const plan = planGoal(goal, { today: now });
    if (plan.status === 'overdue') {
      addAction({
        id: `goal-overdue-${goal.id}`,
        priority: 'urgent',
        category: 'review',
        title: `Replan ${goal.name}`,
        description: `This goal is overdue by ${Math.abs(plan.monthsRemaining)} month${Math.abs(plan.monthsRemaining) === 1 ? '' : 's'}. Update the target date or funding assumptions.`,
      });
    } else if (plan.status === 'underfunded' && plan.requiredMonthlyContribution !== null) {
      addAction({
        id: `goal-funding-gap-${goal.id}`,
        priority: 'this-month',
        category: 'invest',
        title: `Close ${goal.name} funding gap`,
        description: `Plan ${formatCurrency(plan.requiredMonthlyContribution, 0)}/mo; current contribution leaves a ${formatCurrency(plan.contributionGap ?? 0, 0)}/mo gap after inflation.`,
      });
    }
    if (plan.monthsRemaining > 0 && plan.monthsRemaining < 6 && goal.monthlyContribution) {
      addAction({
        id: `goal-sip-approaching-${goal.id}`,
        priority: 'upcoming',
        category: 'invest',
        title: `Prepare for ${goal.name} SIP`,
        description: `${goal.name} SIP (₹${goal.monthlyContribution}/mo) starts in ${Math.ceil(plan.monthsRemaining)} months (${goal.targetDate}). Ensure cashflow.`,
      });
    }
  }

  // 10. Fiscal year end approaching (Feb/Mar): annual LTCG harvest (future)
  if (harvestTarget > 0 && (currentMonth === 1 || currentMonth === 2)) {
    addAction({
      id: `future-harvest-${currentYear}`,
      priority: 'future',
      category: 'tax',
      title: 'Annual LTCG Harvest',
      description: `Plan your annual LTCG harvest before the fiscal year ends. The ${harvestLabel} exemption resets every fiscal year.`,
    });
  }

  // 11. Monthly SWP due but not auto-executing (this-month)
  const swp = state.swpSchedule;
  if (swp?.enabled && swp.autoExecute !== true) {
    const swpStart = swp.startDate ? swp.startDate.substring(0, 7) : '';
    const currentYearMonth = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}`;
    const isDueMonth = swpStart ? currentYearMonth >= swpStart : true;
    if (isDueMonth) {
      const hasSwpThisMonth = state.expenses?.some(
        (e) => e.category === 'SWP' && e.date.substring(0, 7) === currentYearMonth,
      );
      if (!hasSwpThisMonth) {
        addAction({
          id: `swp-due-${currentYearMonth}`,
          priority: 'this-month',
          category: 'invest',
          title: 'Monthly SWP is due',
          description: `Automatic withdrawal is off. Execute your ₹${Math.round(swp.monthlyAmount).toLocaleString('en-IN')} monthly SWP in the Calculators tab, then mark this action complete.`,
        });
      }
    }
  }

  // Sort by priority
  const priorityScore = {
    'urgent': 4,
    'this-month': 3,
    'upcoming': 2,
    'future': 1
  };
  
  return actions.sort((a, b) => {
    // Uncompleted first
    if (a.completed !== b.completed) return a.completed ? 1 : -1;
    // Then by priority
    return priorityScore[b.priority] - priorityScore[a.priority];
  });
}

export function renderActionItems(state: FireOSState): string {
  const items = generateActionItems(state);
  
  if (items.length === 0) {
    return `
      <div class="empty-state">
        <p>No pending actions. You're completely up to date!</p>
      </div>
    `;
  }
  
  return items.map(item => `
    <label class="action-item action-item--${escapeHtml(item.priority)} ${item.completed ? 'action-item--completed' : ''}">
      <input type="checkbox" data-action-id="${escapeHtml(item.id)}" ${item.completed ? 'checked' : ''} class="cursor-pointer action-checkbox">
      <div class="action-content">
        <div class="action-header">
          <span class="action-category-badge">${escapeHtml(item.category)}</span>
          <span class="action-title" style="font-weight: 500;">${escapeHtml(item.title)}</span>
        </div>
        <span class="action-desc" style="display: block; font-size: 0.9rem; opacity: 0.8; margin-top: 0.25rem;">${escapeHtml(item.description)}</span>
      </div>
    </label>
  `).join('');
}
