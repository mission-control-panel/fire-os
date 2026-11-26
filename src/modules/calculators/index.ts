/**
 * Calculators Module
 * Provides financial calculators: Crash Protocol, Emergency Runway, SIP Pause
 */

import { formatCurrency } from '../../lib/formatters';
import { createFeatureContext, type FeatureContext } from '../../core/feature-context';
import './styles.css';
import { initTaxModule } from './tax';
import { calculateMonthlyWithdrawal, recordMonthlyWithdrawal, DEFAULT_FUND_BUCKETS } from './swp-scheduler';
import { compareFIScenarios, type FIScenarioInput, type FIScenarioResult } from './scenario-modeler';
import { sipPauseImpact } from '../../lib/calculations';
import { analyzeCrashProtocol, portfolioSafetyReport } from '../financial-safety/safety-engine';

let activeContext = createFeatureContext();
let D = activeContext.state;

export function initCalculatorsModule(containerId: string, context: FeatureContext = activeContext) {
  activeContext = context;
  D = context.state;
  const container = document.getElementById(containerId);
  if (!container) return;
  renderCalculators(container, context);
  autoFetchNiftyData();
  // Add crash fund source selector handler
  setupCrashFundSelector();
}

/** Set up change listener for crash fund source dropdown. */
function setupCrashFundSelector(): void {
  const select = document.getElementById('crash-portfolio-select') as HTMLSelectElement | null;
  if (!select) return;
  select.addEventListener('change', (e) => {
    const idx = (e.target as HTMLSelectElement).selectedIndex;
    if (idx > 0) {
      const option = select.options[idx];
      const selectedValue = parseInt(option.value, 10);
      // TODO: integrate with crash protocol calculation using selected asset
      activeContext?.ports.ui.showToast(`Crash fund selected: ${option.text}`, 2000, 'info');
    }
  });
}

// Auto-fetch Nifty data on init
async function autoFetchNiftyData() {
  try {
    const niftyData = await activeContext.ports.marketData.fetchNifty();
    if (niftyData) {
      D.niftyHigh = niftyData.high52w;
      D.niftyData = niftyData;
      activeContext.portfolio.save(D, { sync: false });
      // Update form inputs if they exist
      setTimeout(() => {
        const niftyHighInput = document.getElementById('nifty-high') as HTMLInputElement;
        const niftyCurrentInput = document.getElementById('nifty-current') as HTMLInputElement;
        if (niftyHighInput) niftyHighInput.value = String(niftyData.high52w);
        if (niftyCurrentInput) niftyCurrentInput.value = String(niftyData.level);
      }, 100);
    }
  } catch {
    // Silently fail - user can click refresh button
  }
}

export function renderCalculators(container: HTMLElement, context: FeatureContext = activeContext) {
  activeContext = context;
  D = context.state;
  container.innerHTML = `
    <div class="calculators-container">
      <div class="calc-tabs">
<button class="calc-tab active" data-calc="crash">Crash Protocol</button>
        <button class="calc-tab" data-calc="emergency">Emergency Runway</button>
        <button class="calc-tab" data-calc="sip-pause">SIP Pause</button>
        <button class="calc-tab" data-calc="tax-planner">Tax Planner</button>
        <button class="calc-tab" data-calc="swp-scheduler">SWP Scheduler</button>
        <button class="calc-tab" data-calc="scenario-compare">Scenario Compare</button>
      </div>

      <div id="crash" class="calc-panel active">
        ${renderCrashProtocol()}
      </div>
      <div id="emergency" class="calc-panel">
        ${renderEmergencyRunway()}
      </div>
      <div id="sip-pause" class="calc-panel">
        ${renderSIPPause()}
      </div>
      <div id="tax-planner" class="calc-panel"></div>
      <div id="swp-scheduler" class="calc-panel">
        ${renderSWPScheduler()}
      </div>
      <div id="scenario-compare" class="calc-panel">
        ${renderScenarioCompare(context)}
      </div>
    </div>
  `;

  attachCalculatorHandlers(context);
  initTaxModule('tax-planner', context);
}

function renderCrashProtocol(): string {
  const safety = portfolioSafetyReport(D);
  const crashLevels = safety.crash.levels;
  // Build portfolio dropdown options: bonds, SIP, MF, other holdings, demat
  const options: { label: string; value: number }[] = [];
  for (const [key, bond] of Object.entries(D.bonds || {})) {
    options.push({ label: `Bond: ${key} (₹${(bond.amount || 0).toLocaleString('en-IN')})`, value: bond.amount || 0 });
  }
  for (const [key, sip] of Object.entries(D.sip || {})) {
    const nav = sip.schemeCode ? D.nav[sip.schemeCode]?.nav ?? 0 : 0;
    const value = (sip.units || 0) * nav;
    if (value > 0) options.push({ label: `SIP: ${sip.name || key} (₹${value.toLocaleString('en-IN')})`, value });
  }
  for (const [key, mf] of Object.entries(D.mf || {})) {
    const nav = mf.schemeCode ? D.nav[mf.schemeCode]?.nav ?? 0 : 0;
    const value = (mf.units || 0) * nav;
    if (value > 0) options.push({ label: `MF: ${mf.name || key} (₹${value.toLocaleString('en-IN')})`, value });
  }
  for (const [key, other] of Object.entries(D.otherHoldings || {})) {
    if (other.amount > 0) options.push({ label: `Other: ${other.name || key} (₹${(other.amount || 0).toLocaleString('en-IN')})`, value: other.amount || 0 });
  }
  for (const [key, demat] of Object.entries(D.demat || {})) {
    const value = demat.currentValue || 0;
    if (value > 0) options.push({ label: `Demat: ${demat.name || key} (₹${value.toLocaleString('en-IN')})`, value });
  }

  const levelAmount = (trigger: number) => crashLevels.find(level => level.drawdownTriggerPercent === trigger)?.amount;
  const deploy10 = levelAmount(10);
  const deploy15 = levelAmount(15);
  const deploy25 = levelAmount(25);
  const defaultCrashFund = safety.crash.crashFund ?? 0;
  const amountLabel = (amount: number | null | undefined) => amount === null || amount === undefined ? 'Unavailable' : formatCurrency(amount);

  return `
    <div class="calc-card">
      <h3>Market Crash Simulator</h3>
      <p class="calc-info">How much to deploy if market crashes?</p>

      <div class="calc-input-group">
        <label for="crash-portfolio-select">Crash Fund Source (₹)</label>
        <select id="crash-portfolio-select" class="form-select">
          <option value="">-- Select portfolio asset --</option>
          ${options.map((o, i) => `<option value="${i}" ${i === 0 ? 'selected' : ''}>${o.label}</option>`).join('')}
        </select>
        <input type="number" id="crash-portfolio" value="${defaultCrashFund}" style="display:none" readonly>
      </div>

      <div class="crash-scenarios">
        <div class="scenario">
          <span class="scenario-label">10% Crash</span>
          <span class="scenario-value">${amountLabel(deploy10)}</span>
          <span class="scenario-desc">Invest to average down</span>
        </div>
        <div class="scenario">
          <span class="scenario-label">15% Crash</span>
          <span class="scenario-value">${amountLabel(deploy15)}</span>
          <span class="scenario-desc">Aggressive buy</span>
        </div>
        <div class="scenario">
          <span class="scenario-label">25% Crash</span>
          <span class="scenario-value">${amountLabel(deploy25)}</span>
          <span class="scenario-desc">Max deployment</span>
        </div>
      </div>

      <div class="calc-input-group">
        <label>Nifty 52W High (₹)</label>
        <input type="number" id="nifty-high" value="${D.niftyHigh || ''}">
      </div>
      <div class="calc-input-group">
        <label>Current Nifty Level (₹)</label>
        <input type="number" id="nifty-current" value="${D.niftyData?.level || ''}">
      </div>
      <p id="nifty-status" class="calc-info">${D.niftyData ? `${D.niftyData.status ?? 'legacy'} data from ${D.niftyData.source}. Updated: ${new Date(D.niftyData.timestamp).toLocaleString()}` : 'Live Nifty data unavailable. Enter both values manually before interpreting drawdown.'} ${safety.crash.status === 'available' ? `Reserve ${formatCurrency(safety.crash.reserveAmount ?? 0)} preserved.` : 'Reserve and deployment are unavailable until expenses and fresh valuations are known.'}</p>
      <button id="refresh-nifty-btn" class="btn-primary">⚡ Refresh Nifty</button>
    </div>
  `;
}

function renderEmergencyRunway(): string {
  const safety = portfolioSafetyReport(D);
  const liquidity = safety.liquidity;
  const monthlyExpenses = liquidity.monthlyEssentialExpenses;
  const annualExpenses = monthlyExpenses === null ? 0 : monthlyExpenses * 12;
  const runwayMonths = liquidity.runwayMonths === null ? null : Math.floor(liquidity.runwayMonths);
  const display = (value: number | null) => value === null ? 'Unavailable' : formatCurrency(value);

  return `
    <div class="calc-card">
      <h3>Emergency Runway Calculator</h3>
      <p class="calc-info">Months of expenses covered by liquid assets</p>

      <div class="runway-breakdown">
        <div class="runway-item">
          <span class="label">Monthly Expenses</span>
          <span class="value">${display(monthlyExpenses)}</span>
          <span class="sub">Annual: ${monthlyExpenses === null ? 'Unavailable' : formatCurrency(annualExpenses)}</span>
        </div>
        <div class="runway-item">
          <span class="label">Mutual Funds</span>
          <span class="value">${formatCurrency(liquidity.liquidFunds)}</span>
        </div>
        <div class="runway-item">
          <span class="label">Fixed Deposits</span>
          <span class="value">${formatCurrency(liquidity.fixedDepositsGross - liquidity.fixedDepositPenalties)}</span>
        </div>
        <div class="runway-item">
          <span class="label">Total Liquid</span>
          <span class="value">${display(liquidity.accessibleValue)}</span>
        </div>
      </div>

      <div class="runway-result">
        <div class="runway-months">
          <span class="number">${runwayMonths === null ? '—' : runwayMonths}</span>
          <span class="label">Months of Emergency Fund</span>
        </div>
        <span class="status ${runwayMonths === null ? 'warning' : runwayMonths >= 12 ? 'healthy' : runwayMonths >= 6 ? 'ok' : 'warning'}">
          ${runwayMonths === null ? 'Unavailable — add essential expenses and fresh valuations' : runwayMonths >= 12 ? '✓ Healthy' : runwayMonths >= 6 ? '⚠️ Moderate' : '✗ Low'}
        </span>
      </div>
    </div>
  `;
}

function renderSIPPause(): string {
  const totalSIPMonthly = Object.values(D.sip)
    .filter(sip => sip && sip.monthlyAmount)
    .reduce((sum, sip) => sum + (sip.monthlyAmount || 0), 0);

  return `
    <div class="calc-card">
      <h3>SIP Pause Impact Calculator</h3>
      <p class="calc-info">Cost of missing SIP contributions during downturns</p>

      <div class="calc-input-group">
        <label>Total Monthly SIP (₹)</label>
        <input type="number" id="sip-monthly" value="${totalSIPMonthly}" placeholder="Enter monthly SIP total">
      </div>

      <div class="calc-input-group">
        <label>Pause Duration (months)</label>
        <input type="number" id="pause-months" min="1" max="60" value="6">
      </div>

      <div class="calc-input-group">
        <label>Expected Annual Return (%)</label>
        <input type="number" id="expected-return" min="0" max="50" value="12" step="0.1">
      </div>

      <button id="calculate-sip-btn" class="btn-primary">Calculate Impact</button>

      <div id="sip-result" class="calc-result" style="display: none;">
        <div class="result-item">
          <span class="label">Missed Contributions</span>
          <span id="missed-amount" class="value">₹0</span>
        </div>
        <div class="result-item">
          <span class="label">Lost Growth (12 months)</span>
          <span id="lost-growth" class="value">₹0</span>
        </div>
        <div class="result-item">
          <span class="label">Total Cost</span>
          <span id="total-cost" class="value">₹0</span>
        </div>
      </div>
    </div>
  `;
}



function updateCrashScenarios() {
  const portfolioInput = document.getElementById('crash-portfolio') as HTMLInputElement;
  const portfolio = parseFloat(portfolioInput?.value || '0') || 0;

  const scenarioDiv = document.querySelector('#crash .crash-scenarios');
  if (scenarioDiv) {
    scenarioDiv.innerHTML = `
      <div class="scenario">
        <span class="scenario-label">10% Crash</span>
        <span class="scenario-value">${formatCurrency(portfolio * 0.1)}</span>
        <span class="scenario-desc">Invest to average down</span>
      </div>
      <div class="scenario">
        <span class="scenario-label">15% Crash</span>
        <span class="scenario-value">${formatCurrency(portfolio * 0.15)}</span>
        <span class="scenario-desc">Aggressive buy</span>
      </div>
      <div class="scenario">
        <span class="scenario-label">25% Crash</span>
        <span class="scenario-value">${formatCurrency(portfolio * 0.25)}</span>
        <span class="scenario-desc">Max deployment</span>
      </div>
    `;
  }
}

function attachCalculatorHandlers(context: FeatureContext) {
  // Tab switching
  document.querySelectorAll('.calc-tab').forEach((tab) => {
    tab.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).getAttribute('data-calc');
      if (!target) return;

      document.querySelectorAll('.calc-tab').forEach((t) => t.classList.remove('active'));
      (e.target as HTMLElement).classList.add('active');

      document.querySelectorAll('.calc-panel').forEach((p) => p.classList.remove('active'));
      document.getElementById(target)?.classList.add('active');
    });
  });

  // Crash Protocol
  document.getElementById('crash-portfolio')?.addEventListener('input', updateCrashScenarios);
  document.getElementById('refresh-nifty-btn')?.addEventListener('click', () => refreshNiftyData(context));

  // SIP Pause
  document.getElementById('calculate-sip-btn')?.addEventListener('click', calculateSIPPause);

  // Scenario Compare (read-only projection, never saves state)
  document.getElementById('compare-scenarios-btn')?.addEventListener('click', () => runScenarioCompare(context));
  document.getElementById('copy-scenario-a-btn')?.addEventListener('click', () => {
    copyScenarioInputs('a', 'b');
    announceScenarioStatus('Scenario A copied to Scenario B.');
  });
  document.getElementById('reset-scenarios-btn')?.addEventListener('click', () => {
    resetScenarioInputs(context);
    announceScenarioStatus('Scenario inputs reset to defaults.');
  });

  // SWP Scheduler handlers
  document.getElementById('save-swp-btn')?.addEventListener('click', () => {
    const enabledInput = document.getElementById('swp-enabled') as HTMLInputElement;
    const amountInput = document.getElementById('swp-amount') as HTMLInputElement;
    const startDateInput = document.getElementById('swp-start-date') as HTMLInputElement;

    const enabled = enabledInput?.checked ?? false;
    const amount = parseFloat(amountInput?.value || '0') || 0;
    const startDate = startDateInput?.value ? `${startDateInput.value}-01` : '';

    if (amount <= 0) {
      context.ports.ui.showToast('Please enter a valid positive monthly amount', 3000, 'warning');
      return;
    }

    if (!D.swpSchedule) {
      D.swpSchedule = { enabled: false, startDate: '', monthlyAmount: 0, rate: 3, autoExecute: false };
    }

    D.swpSchedule.enabled = enabled;
    D.swpSchedule.monthlyAmount = amount;
    D.swpSchedule.startDate = startDate;

    context.portfolio.save(D);

    context.ports.ui.showToast('✓ SWP config saved successfully', 3000, 'success');
  });

  document.getElementById('trigger-swp-btn')?.addEventListener('click', async () => {
    const triggerBtn = document.getElementById('trigger-swp-btn') as HTMLButtonElement;
    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = '⏳ Executing...';
    }
    try {
      if (!D.swpSchedule || !D.swpSchedule.enabled) {
        context.ports.ui.showToast('Please enable SWP and save config first', 3000, 'warning');
        return;
      }
      const plan = calculateMonthlyWithdrawal(D);
      if (plan.status !== 'ready') throw new Error(plan.reason || 'Withdrawal is not safe to simulate');
      const target = D.swpSchedule.monthlyAmount;
      if (plan.actualAmount > 0 && plan.actualAmount < target) {
        context.ports.ui.showToast(
          `Preview: ₹${Math.round(plan.actualAmount).toLocaleString('en-IN')} available (shortfall of ₹${Math.round(target - plan.actualAmount).toLocaleString('en-IN')})`,
          5000,
          'warning',
        );
      } else {
        context.ports.ui.showToast(`Preview only: ₹${Math.round(plan.actualAmount).toLocaleString('en-IN')} would be withdrawn`, 3000, 'success');
      }
    } catch {
      context.ports.ui.showToast('✗ Withdrawal execution failed', 3000, 'error');
    } finally {
      if (triggerBtn) {
        triggerBtn.disabled = false;
        triggerBtn.textContent = 'Simulate Withdrawal';
      }
    }
  });

  document.getElementById('record-swp-btn')?.addEventListener('click', async () => {
    const button = document.getElementById('record-swp-btn') as HTMLButtonElement;
    if (button) button.disabled = true;
    try {
      const result = await recordMonthlyWithdrawal(D);
      await context.portfolio.save(D, { awaitCloud: true });
      context.ports.ui.showToast(
        result.status === 'duplicate'
          ? 'Withdrawal already recorded; no duplicate was applied'
          : `✓ Withdrawal recorded for ₹${Math.round(result.actualAmount).toLocaleString('en-IN')}`,
        4000,
        result.status === 'duplicate' ? 'warning' : 'success',
      );
    } catch (error) {
      context.ports.ui.showToast(error instanceof Error ? error.message : 'Withdrawal could not be recorded', 4000, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  });
}

async function refreshNiftyData(context: FeatureContext = activeContext) {
  try {
    context.ports.ui.showToast('⟳ Fetching Nifty data...', 2000);

    // Fetch fresh Nifty data from API
    const niftyData = await context.ports.marketData.fetchNifty();
    if (!niftyData) {
      const status = document.getElementById('nifty-status');
      if (status) status.textContent = 'Live Nifty data unavailable. Enter both values manually before interpreting drawdown.';
      context.ports.ui.showToast('✗ Failed to fetch Nifty data. Enter manually.', 2000, 'error');
      return;
    }

    // Update D state and form inputs
    D.niftyHigh = niftyData.high52w;
    D.niftyData = niftyData;
    context.portfolio.save(D, { sync: false });

    const niftyHighInput = document.getElementById('nifty-high') as HTMLInputElement;
    const niftyCurrentInput = document.getElementById('nifty-current') as HTMLInputElement;

    if (niftyHighInput) niftyHighInput.value = String(niftyData.high52w);
    if (niftyCurrentInput) niftyCurrentInput.value = String(niftyData.level);
    const status = document.getElementById('nifty-status');
    if (status) status.textContent = `${niftyData.status ?? 'legacy'} data from ${niftyData.source}. Updated: ${new Date(niftyData.timestamp).toLocaleString()}`;

    // Recalculate crash scenarios
    const highVal = niftyData.high52w;
    const currentVal = niftyData.level;
    const drawdown = ((highVal - currentVal) / highVal) * 100;
    const safety = portfolioSafetyReport(D);
    const crash = analyzeCrashProtocol({ liquidity: safety.liquidity, currentDrawdownPercent: safety.marketDataFresh ? drawdown : null });
    const amountLabel = (amount: number | null | undefined) => amount === null || amount === undefined ? 'Unavailable' : formatCurrency(amount);
    const amountFor = (trigger: number) => crash.levels.find(level => level.drawdownTriggerPercent === trigger)?.amount;

    const crashPanel = document.getElementById('crash');
    if (crashPanel) {
      const scenarioDiv = crashPanel.querySelector('.crash-scenarios');
      if (scenarioDiv) {
        scenarioDiv.innerHTML = `
          <div class="scenario-info">
            <p><strong>Nifty: ${currentVal} | 52W High: ${highVal}</strong></p>
            <p><strong>Current Drawdown: ${drawdown.toFixed(0)}%</strong></p>
            <p style="font-size: 12px; color: #666;">${niftyData.status ?? 'legacy'} data from ${niftyData.source}. Updated: ${new Date(niftyData.timestamp).toLocaleString()}</p>
          </div>
          <div class="scenario">
            <span class="scenario-label">10% Crash Deploy</span>
            <span class="scenario-value">${amountLabel(amountFor(10))}</span>
            <span class="scenario-desc">Average down position</span>
          </div>
          <div class="scenario">
            <span class="scenario-label">15% Crash Deploy</span>
            <span class="scenario-value">${amountLabel(amountFor(15))}</span>
            <span class="scenario-desc">Aggressive buy</span>
          </div>
          <div class="scenario">
            <span class="scenario-label">25% Crash Deploy</span>
            <span class="scenario-value">${amountLabel(amountFor(25))}</span>
            <span class="scenario-desc">Max deployment</span>
          </div>
        `;
      }
    }

    context.ports.ui.showToast(`✓ Nifty fetched: ${currentVal}`, 2000, 'success');
  } catch {
    context.ports.ui.showToast('✗ Failed to fetch Nifty data', 2000, 'error');
  }
}

function calculateSIPPause() {
  const monthlyInput = document.getElementById('sip-monthly') as HTMLInputElement;
  const pauseInput = document.getElementById('pause-months') as HTMLInputElement;
  const returnInput = document.getElementById('expected-return') as HTMLInputElement;

  const monthly = parseFloat(monthlyInput?.value || '0') || 0;
  const months = parseInt(pauseInput?.value || '0') || 0;
  const annualReturn = parseFloat(returnInput?.value || '12') || 12;

  const { missedContributions: missedAmount, lostGrowth, totalCost } = sipPauseImpact(
    monthly,
    months,
    annualReturn / 100,
  );

  const resultDiv = document.getElementById('sip-result');
  if (resultDiv) {
    (document.getElementById('missed-amount') as HTMLElement).textContent = `${formatCurrency(missedAmount)}`;
    (document.getElementById('lost-growth') as HTMLElement).textContent = `${formatCurrency(lostGrowth)}`;
    (document.getElementById('total-cost') as HTMLElement).textContent = `${formatCurrency(totalCost)}`;
    resultDiv.style.display = 'block';
  }
}

function renderSWPScheduler(): string {
  const swp = D.swpSchedule || { enabled: false, startDate: '', monthlyAmount: 0, rate: 3 };
  const fundBuckets = D.fundBuckets ?? DEFAULT_FUND_BUCKETS;
  const fundOrder = fundBuckets.map((b: { id: string }) => b.id);
  const preview = calculateMonthlyWithdrawal(D);
  const previewMessage =
    preview.status === 'ready'
      ? `Fresh-NAV preview: ${formatCurrency(preview.actualAmount)}${preview.shortfall > 0 ? `; shortfall ${formatCurrency(preview.shortfall)}` : ''}.`
      : `Preview unavailable: ${preview.reason ?? 'withdrawal is not ready'}.`;

  return `
    <div class="calc-card">
      <h3>SWP Scheduler</h3>
      <p class="calc-info">Schedule your post-retirement withdrawals using FIFO redemption strategy.</p>

      <div class="form-group margin-bottom-1-5">
        <label class="flex-align-center gap-0-5 cursor-pointer">
          <input type="checkbox" id="swp-enabled" ${swp.enabled ? 'checked' : ''}>
          <span class="font-medium text-white">Enable SWP Automation</span>
        </label>
      </div>

      <div class="calc-input-group margin-bottom-1-5">
        <label for="swp-amount">Monthly Withdrawal Amount (₹)</label>
        <input type="number" id="swp-amount" value="${swp.monthlyAmount ?? 0}" min="0">
      </div>

      <div class="calc-input-group margin-bottom-1-5">
        <label for="swp-start-date">SWP Start Date (Month)</label>
        <input type="month" id="swp-start-date" value="${swp.startDate ? swp.startDate.substring(0, 7) : ''}">
      </div>

      <div class="calc-input-group margin-bottom-1-5">
        <label>Fund Redemption Order</label>
        <select id="fund-order" multiple style="height: 120px;">
          ${fundBuckets.map((b, i) => `<option value="${b.id}" ${fundOrder.indexOf(b.id) >= 0 ? 'selected' : ''}>${b.label || b.id}</option>`).join('')}
        </select>
      </div>

      <div class="calc-input-group margin-bottom-1-5">
        <label>Projected Monthly Withdrawal</label>
        <input type="number" value="${swp.monthlyAmount ?? 0}" readonly>
      </div>

      <div class="flex flex-row gap-4">
        <button id="save-swp-btn" class="btn btn-primary">Save SWP Config</button>
        <button id="trigger-swp-btn" class="btn btn-secondary">Simulate Withdrawal</button>
        <button id="record-swp-btn" class="btn btn-secondary">Record Withdrawal</button>
      </div>

      <div class="mt-4">
        <h4>Withdrawal Preview</h4>
        <p class="calc-info" role="status">${escapeHtml(previewMessage)}</p>
      </div>
    </div>
  `;
}

function renderScenarioCompare(context: FeatureContext): string {
  const { netWorth } = context.ports.calculations.totalNetWorth(D);
  const fiGoal = D.profile.fiTarget || 55_000_000;
  const currentAge = D.profile.age || 25;
  const monthlySip = Object.values(D.sip).reduce((sum, sip) => sum + (sip.monthlyAmount || 0), 0);

  const scenarioColumn = (key: 'a' | 'b', name: string, ret: number, stepUp: number): string => `
    <div class="compare-scenario">
      <div class="calc-input-group">
        <label for="cmp-${key}-label">Scenario name</label>
        <input type="text" id="cmp-${key}-label" value="${escapeHtml(name)}">
      </div>
      <div class="compare-assumptions">
        <div class="calc-input-group">
          <label for="cmp-${key}-corpus">Current corpus (₹)</label>
          <input type="number" id="cmp-${key}-corpus" min="0" value="${Math.round(netWorth)}">
        </div>
        <div class="calc-input-group">
          <label for="cmp-${key}-sip">Monthly SIP (₹)</label>
          <input type="number" id="cmp-${key}-sip" min="0" value="${monthlySip}">
        </div>
        <div class="calc-input-group">
          <label for="cmp-${key}-ret">Expected annual return (%)</label>
          <input type="number" id="cmp-${key}-ret" min="0" max="50" step="0.1" value="${ret}">
        </div>
        <div class="calc-input-group">
          <label for="cmp-${key}-stepup">Annual SIP step-up (%)</label>
          <input type="number" id="cmp-${key}-stepup" min="0" max="50" step="0.1" value="${stepUp}">
        </div>
        <div class="calc-input-group">
          <label for="cmp-${key}-goal">FI goal (₹)</label>
          <input type="number" id="cmp-${key}-goal" min="1" value="${fiGoal}">
        </div>
        <div class="calc-input-group">
          <label for="cmp-${key}-age">Current age</label>
          <input type="number" id="cmp-${key}-age" min="0" step="1" value="${currentAge}">
        </div>
      </div>
    </div>
  `;

  return `
    <div class="calc-card">
      <h3>Scenario Comparison</h3>
      <p class="calc-info">Compare two FI plans side by side. Outputs below are projections (estimates) based on the assumptions you enter — not guaranteed or actual returns.</p>

      <div class="compare-grid">
        ${scenarioColumn('a', 'Balanced', 15, 10)}
        ${scenarioColumn('b', 'Conservative', 10, 5)}
      </div>

      <button id="compare-scenarios-btn" class="btn btn-primary">Compare Scenarios</button>
      <button id="copy-scenario-a-btn" class="btn btn-secondary">Copy A to B</button>
      <button id="reset-scenarios-btn" class="btn btn-secondary">Reset scenarios</button>

      <div id="compare-result" class="calc-result" aria-live="polite">
        <p class="calc-info" style="margin-bottom: 0;" aria-live="polite">Enter assumptions and press Compare Scenarios to see projections.</p>
      </div>
    </div>
  `;
}

function copyScenarioInputs(source: 'a' | 'b', target: 'a' | 'b') {
  for (const field of ['label', 'corpus', 'sip', 'ret', 'stepup', 'goal', 'age']) {
    const from = document.getElementById(`cmp-${source}-${field}`) as HTMLInputElement | null;
    const to = document.getElementById(`cmp-${target}-${field}`) as HTMLInputElement | null;
    if (from && to) to.value = from.value;
  }
}

function resetScenarioInputs(context: FeatureContext) {
  const { netWorth } = context.ports.calculations.totalNetWorth(D);
  const fiGoal = D.profile.fiTarget || 55_000_000;
  const currentAge = D.profile.age || 25;
  const monthlySip = Object.values(D.sip).reduce((sum, sip) => sum + (sip.monthlyAmount || 0), 0);
  const defaults: Record<string, string | number> = {
    'cmp-a-label': 'Balanced', 'cmp-a-corpus': Math.round(netWorth), 'cmp-a-sip': monthlySip,
    'cmp-a-ret': 15, 'cmp-a-stepup': 10, 'cmp-a-goal': fiGoal, 'cmp-a-age': currentAge,
    'cmp-b-label': 'Conservative', 'cmp-b-corpus': Math.round(netWorth), 'cmp-b-sip': monthlySip,
    'cmp-b-ret': 10, 'cmp-b-stepup': 5, 'cmp-b-goal': fiGoal, 'cmp-b-age': currentAge,
  };
  for (const [id, value] of Object.entries(defaults)) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input) input.value = String(value);
  }
  const result = document.getElementById('compare-result');
  if (result) result.innerHTML = '<p class="calc-info" style="margin-bottom: 0;">Enter assumptions and press Compare Scenarios to see projections.</p>';
}

function announceScenarioStatus(message: string) {
  const result = document.getElementById('compare-result');
  if (result) result.setAttribute('aria-label', message);
}

function runScenarioCompare(context: FeatureContext) {
  const readNumber = (id: string): number =>
    parseFloat((document.getElementById(id) as HTMLInputElement | null)?.value ?? '');
  const readLabel = (id: string): string =>
    ((document.getElementById(id) as HTMLInputElement | null)?.value ?? '').trim();

  const scenarios: FIScenarioInput[] = (['a', 'b'] as const).map((key) => ({
    label: readLabel(`cmp-${key}-label`) || `Scenario ${key.toUpperCase()}`,
    currentCorpus: readNumber(`cmp-${key}-corpus`),
    monthlySip: readNumber(`cmp-${key}-sip`),
    annualStepUpPercent: readNumber(`cmp-${key}-stepup`),
    annualReturnPercent: readNumber(`cmp-${key}-ret`),
    fiGoal: readNumber(`cmp-${key}-goal`),
    currentAge: readNumber(`cmp-${key}-age`),
  }));

  const results = compareFIScenarios(scenarios);
  const skipped = scenarios.length - results.length;
  if (skipped > 0) {
    context.ports.ui.showToast(`${skipped} scenario(s) skipped: invalid assumptions`, 3000, 'warning');
  }
  renderCompareResults(results, skipped);
}

function renderCompareResults(results: FIScenarioResult[], skipped: number) {
  const resultDiv = document.getElementById('compare-result');
  if (!resultDiv) return;

  if (results.length === 0) {
    resultDiv.innerHTML =
      '<p class="calc-info" style="margin-bottom: 0;">No valid scenarios. Assumptions must be non-negative and the FI goal must be above zero.</p>';
    return;
  }

  const row = (metric: string, cells: string[]): string =>
    `<tr><td>${metric}</td>${cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`;

  resultDiv.innerHTML = `
    <table class="compare-table">
      <thead>
        <tr><th>Projection (estimate)</th>${results.map((r) => `<th>${escapeHtml(r.label)}</th>`).join('')}</tr>
      </thead>
      <tbody>
        ${row('Estimated months to goal', results.map((r) => (r.unreachable ? 'Not reachable' : String(r.monthsToGoal))))}
        ${row('Estimated age at goal', results.map((r) => (r.unreachable ? 'Not reachable' : r.ageAtGoal!.toFixed(1))))}
        ${row('Projected corpus (estimate)', results.map((r) => formatCurrency(r.projectedCorpus)))}
        ${row(
          'Assumptions used',
          results.map(
            (r) =>
              `${r.assumptions.annualReturnPercent}% p.a. • ${r.assumptions.annualStepUpPercent}% step-up • ${formatCurrency(r.assumptions.monthlySip)}/mo SIP`,
          ),
        )}
      </tbody>
    </table>
    <p class="compare-disclaimer">Estimates only: projections assume the constant annual return and step-up shown above. Actual market returns will differ; these are not guaranteed or actual returns.${skipped > 0 ? ` ${skipped} scenario(s) skipped due to invalid assumptions.` : ''}</p>
  `;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] || character);
}


