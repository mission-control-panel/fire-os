import { expect, test } from '@playwright/test';

test.describe('portfolio workspace', () => {
  test('records a synthetic purchase and shows its reconciled holding', async ({ page }) => {
    await page.goto('/portfolio');
    await expect(
      page.getByRole('heading', { name: 'Transactions, holdings and reconciliation' }),
    ).toBeVisible();
    await page.locator('#ledger-account').fill('Demo account');
    await page.locator('#ledger-instrument').fill('Demo fund');
    await page.locator('#ledger-amount').fill('12500');
    await page.locator('#ledger-quantity').fill('10');
    await page.getByRole('button', { name: 'Save transaction' }).click();

    await expect(page.getByRole('status').filter({ hasText: 'Transaction saved' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Demo fund' }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: '₹12,500' }).first()).toBeVisible();
  });

  test('previews duplicate-safe CSV imports before applying them', async ({ page }) => {
    await page.goto('/portfolio');
    const csv = [
      'id,date,type,accountId,instrumentId,amountPaise,quantityMicros,costProvenance',
      'csv-1,2026-01-01,purchase,demo,demo-fund,1250000,10000000,exact',
    ].join('\n');
    await page.locator('#ledger-import').setInputFiles({
      name: 'ledger.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await expect(
      page.getByRole('status').filter({ hasText: '1 valid rows ready to import.' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Merge valid import' })).toBeEnabled();
  });

  test('keeps punctuation-distinct accounts separate and rejects oversized names', async ({
    page,
  }) => {
    await page.goto('/portfolio');
    await page.locator('#ledger-account').fill('HDFC Bank');
    await page.locator('#ledger-instrument').fill('Fund A');
    await page.locator('#ledger-amount').fill('100');
    await page.locator('#ledger-quantity').fill('1');
    await page.getByRole('button', { name: 'Save transaction' }).click();

    await page.locator('#ledger-account').fill('HDFC-Bank');
    await page.locator('#ledger-instrument').fill('Fund B');
    await page.locator('#ledger-amount').fill('200');
    await page.locator('#ledger-quantity').fill('1');
    await page.getByRole('button', { name: 'Save transaction' }).click();
    await expect(page.getByRole('cell', { name: 'HDFC Bank' }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'HDFC-Bank' }).first()).toBeVisible();

    await page.locator('#ledger-account').fill('A'.repeat(81));
    await page.locator('#ledger-amount').fill('300');
    await page.getByRole('button', { name: 'Save transaction' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '80 characters or fewer' }),
    ).toBeVisible();

    await page.locator('#ledger-account').fill('HDFC Bank');
    await page.locator('#ledger-note').fill('N'.repeat(1001));
    await page.getByRole('button', { name: 'Save transaction' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '1,000 characters or fewer' }),
    ).toBeVisible();
  });
});
