/**
 * Insurance Module
 * Manages term life and health insurance gap analysis
 */
import { formatCurrency } from '../../lib/formatters';
import { createFeatureContext, type FeatureContext } from '../../core/feature-context';
import { assessInsuranceNeeds, policyLifecycle } from './insurance-planning';
import './styles.css';

const DEBOUNCE_MS = 500;
let debounceTimer: NodeJS.Timeout | null = null;
let activeContext = createFeatureContext();

export function initInsuranceModule(containerId: string, context: FeatureContext = activeContext) {
  activeContext = context;
  const container = document.getElementById(containerId);
  if (!container) return;
  renderInsurance(container, context);
}

export function renderInsurance(container?: HTMLElement, context: FeatureContext = activeContext) {
  const state = context.state;
  if (!container) {
    container = document.getElementById('insurance') as HTMLElement;
    if (!container) return;
  }

  const annualIncome = (state.profile.monthlyIncome || 0) * 12;
  const currentTermCover = state.insurance.termLife.currentCover || 0;

  const familySize = state.insurance.health.familySize || 1;
  const currentHealthCover = state.insurance.health.currentCover || 0;
  const needs = assessInsuranceNeeds({
    annualIncome,
    dependents: Math.max(0, familySize - 1),
    outstandingDebt: 0,
    futureGoalShortfall: 0,
    accessibleAssets: 0,
    familySize,
    currentTermCover,
    currentHealthCover,
    legacyTermExpiryDate: state.insurance.termLife.expiryDate,
    legacyHealthExpiryDate: state.insurance.health.expiryDate,
    policies: state.insurance.policies,
  });
  const termAdequate = needs.termGap === 0;
  const healthAdequate = needs.healthGap === 0;
  const policyRows = (state.insurance.policies ?? []).map((policy) => {
    const lifecycle = policyLifecycle(policy);
    const label = lifecycle.status === 'expiring-soon' ? `Renew within ${lifecycle.daysRemaining} days` : lifecycle.status.replace('-', ' ');
    return `<li><strong>${escapeHtml(policy.kind)}</strong> · ${escapeHtml(policy.provider || 'Provider not recorded')} · ${escapeHtml(label)} <button type="button" data-policy-delete="${escapeHtml(policy.id)}">Remove</button></li>`;
  }).join('');

  const successIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:24px;height:24px;color:#2e7d32;"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
  const warningIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:24px;height:24px;color:#d32f2f;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;

  container.innerHTML = `
    <div class="insurance-container">
      <h2>Insurance Gap Analyzer</h2>
      
      <div class="insurance-cards">
        <!-- Term Life Card -->
        <div class="insurance-card">
          <h3>Term Life Insurance</h3>
          <div class="adequacy-check ${termAdequate ? 'adequate' : 'inadequate'}">
            <span class="status-icon">${termAdequate ? successIcon : warningIcon}</span>
            <div class="status-text">
              <strong>${termAdequate ? 'Adequate Cover' : 'Underinsured'}</strong>
            <span>Planning need: ${formatCurrency(needs.requiredTermCover)} · Gap: ${formatCurrency(needs.termGap)}</span>
            </div>
          </div>
          
          <form id="term-form" class="insurance-form">
            <div class="form-group">
              <label for="term-cover">Current Cover Amount (₹)</label>
              <input type="number" id="term-cover" value="${state.insurance.termLife.currentCover || ''}" placeholder="e.g. 10000000">
            </div>
            <div class="form-group">
              <label for="term-premium">Annual Premium (₹)</label>
              <input type="number" id="term-premium" value="${state.insurance.termLife.annualPremium || ''}" placeholder="e.g. 15000">
            </div>
            <div class="form-group">
              <label for="term-expiry">Expiry date</label>
              <input type="date" id="term-expiry" value="${escapeHtml(state.insurance.termLife.expiryDate)}">
            </div>
            <div class="form-group">
              <label for="term-provider">Provider</label>
              <input type="text" id="term-provider" value="${escapeHtml(state.insurance.termLife.provider)}" placeholder="Optional">
            </div>
          </form>
        </div>

        <!-- Health Insurance Card -->
        <div class="insurance-card">
          <h3>Health Insurance</h3>
          <div class="adequacy-check ${healthAdequate ? 'adequate' : 'inadequate'}">
            <span class="status-icon">${healthAdequate ? successIcon : warningIcon}</span>
            <div class="status-text">
              <strong>${healthAdequate ? 'Adequate Cover' : 'Underinsured'}</strong>
            <span>Planning need: ${formatCurrency(needs.requiredHealthCover)} · Gap: ${formatCurrency(needs.healthGap)}</span>
            </div>
          </div>
          
          <form id="health-form" class="insurance-form">
            <div class="form-group">
              <label for="health-cover">Current Cover Amount (₹)</label>
              <input type="number" id="health-cover" value="${state.insurance.health.currentCover || ''}" placeholder="e.g. 2000000">
            </div>
            <div class="form-group">
              <label for="health-premium">Annual Premium (₹)</label>
              <input type="number" id="health-premium" value="${state.insurance.health.annualPremium || ''}" placeholder="e.g. 25000">
            </div>
            <div class="form-group">
              <label for="health-family">Family Size (Number of people)</label>
              <input type="number" id="health-family" value="${state.insurance.health.familySize || ''}" placeholder="e.g. 4">
            </div>
            <div class="form-group">
              <label for="health-expiry">Expiry date</label>
              <input type="date" id="health-expiry" value="${escapeHtml(state.insurance.health.expiryDate ?? '')}">
            </div>
            <div class="form-group">
              <label for="health-provider">Provider</label>
              <input type="text" id="health-provider" value="${escapeHtml(state.insurance.health.provider)}" placeholder="Optional">
            </div>
          </form>
        </div>
      </div>
      <section class="insurance-policy-lifecycle" aria-labelledby="insurance-policy-heading">
        <h3 id="insurance-policy-heading">Policy lifecycle</h3>
        ${policyRows ? `<ul>${policyRows}</ul>` : '<p>No separate policy records yet. The summary fields above remain compatible with existing data.</p>'}
        <form id="policy-form" class="insurance-form" aria-label="Add insurance policy">
          <div class="form-group"><label for="policy-kind">Policy type</label><select id="policy-kind"><option value="term">Term</option><option value="health">Health</option><option value="vehicle">Vehicle</option></select></div>
          <div class="form-group"><label for="policy-owner">Owner</label><select id="policy-owner"><option value="personal">Personal</option><option value="employer">Employer</option></select></div>
          <div class="form-group"><label for="policy-provider">Provider</label><input id="policy-provider" type="text" required maxlength="200"></div>
          <div class="form-group"><label for="policy-cover">Cover amount (₹)</label><input id="policy-cover" type="number" min="0" step="1000" required></div>
          <div class="form-group"><label for="policy-topup">Health top-up (₹)</label><input id="policy-topup" type="number" min="0" step="1000" value="0"></div>
          <div class="form-group"><label for="policy-deductible">Deductible (₹)</label><input id="policy-deductible" type="number" min="0" step="1000" value="0"></div>
          <div class="form-group"><label for="policy-expiry">Expiry date</label><input id="policy-expiry" type="date"></div>
          <div class="form-group"><label for="policy-dependents">Dependents</label><input id="policy-dependents" type="number" min="0" step="1" value="0"></div>
          <div class="form-group"><label for="policy-waiting">Waiting period (months)</label><input id="policy-waiting" type="number" min="0" step="1" value="0"></div>
          <div class="form-group"><label for="policy-exclusions">Exclusions / notes</label><input id="policy-exclusions" type="text" maxlength="2000"></div>
          <button type="submit">Add policy record</button>
        </form>
        <p class="insurance-assumptions">Planning guidance uses configurable household assumptions; it is not a universal coverage recommendation.</p>
      </section>
    </div>
  `;

  attachInsuranceHandlers(context);
}

function attachInsuranceHandlers(context: FeatureContext) {
  const inputs = document.querySelectorAll('.insurance-form input');
  inputs.forEach(input => {
    input.addEventListener('input', () => debounceInsuranceSave(context));
  });
  document.getElementById('policy-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    addPolicy(context);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-policy-delete]').forEach((button) => {
    button.addEventListener('click', () => {
      const id = button.dataset.policyDelete;
      if (!id) return;
      context.state.insurance.policies = (context.state.insurance.policies ?? []).filter((policy) => policy.id !== id);
      context.portfolio.save(context.state);
      renderInsurance(undefined, context);
    });
  });
}

function debounceInsuranceSave(context: FeatureContext) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    saveInsurance(context);
    renderInsurance(undefined, context);
  }, DEBOUNCE_MS);
}

function saveInsurance(context: FeatureContext) {
  const state = context.state;
  const termCover = document.getElementById('term-cover') as HTMLInputElement;
  const termPremium = document.getElementById('term-premium') as HTMLInputElement;
  const healthCover = document.getElementById('health-cover') as HTMLInputElement;
  const healthPremium = document.getElementById('health-premium') as HTMLInputElement;
  const healthFamily = document.getElementById('health-family') as HTMLInputElement;
  const termExpiry = document.getElementById('term-expiry') as HTMLInputElement;
  const termProvider = document.getElementById('term-provider') as HTMLInputElement;
  const healthExpiry = document.getElementById('health-expiry') as HTMLInputElement;
  const healthProvider = document.getElementById('health-provider') as HTMLInputElement;

  state.insurance.termLife.currentCover = parseFloat(termCover.value) || 0;
  state.insurance.termLife.annualPremium = parseFloat(termPremium.value) || 0;
  state.insurance.termLife.expiryDate = termExpiry.value;
  state.insurance.termLife.provider = termProvider.value.trim();
  
  state.insurance.health.currentCover = parseFloat(healthCover.value) || 0;
  state.insurance.health.annualPremium = parseFloat(healthPremium.value) || 0;
  state.insurance.health.familySize = parseInt(healthFamily.value) || 1;
  state.insurance.health.expiryDate = healthExpiry.value;
  state.insurance.health.provider = healthProvider.value.trim();

  context.portfolio.save(state);
}

function addPolicy(context: FeatureContext) {
  const value = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
  const policy = {
    id: crypto.randomUUID?.() ?? `policy-${Date.now()}`,
    kind: value('policy-kind') as 'term' | 'health' | 'vehicle',
    ownerType: value('policy-owner') as 'employer' | 'personal',
    provider: value('policy-provider').trim(),
    coverAmount: Number(value('policy-cover')) || 0,
    annualPremium: 0,
    expiryDate: value('policy-expiry'),
    deductible: Number(value('policy-deductible')) || 0,
    topUpCover: Number(value('policy-topup')) || 0,
    dependents: Number(value('policy-dependents')) || 0,
    waitingPeriodMonths: Number(value('policy-waiting')) || 0,
    exclusions: value('policy-exclusions').trim(),
  };
  if (!policy.provider || policy.coverAmount < 0) return;
  context.state.insurance.policies = [...(context.state.insurance.policies ?? []), policy];
  context.portfolio.save(context.state);
  renderInsurance(undefined, context);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
