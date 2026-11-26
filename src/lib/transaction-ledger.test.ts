import { describe, expect, it } from 'vitest';
import { applyLedgerImport, createTransactionLedger, previewLedgerImport, reconcileLedger, reconcileLedgerLots, rollbackLedgerImport } from './transaction-ledger';

const purchase = (id: string, amountPaise = 125_000, quantityMicros = 10_000): Record<string, unknown> => ({
  id, date: '2026-04-01', type: 'purchase', accountId: 'brokerage', instrumentId: 'fund-a', amountPaise, quantityMicros, costProvenance: 'exact',
});

describe('transaction ledger', () => {
  it('uses deterministic paise quantities and reconciles holdings', () => {
    const ledger = createTransactionLedger();
    const preview = previewLedgerImport([purchase('buy-1')]);
    const applied = applyLedgerImport(ledger, preview, 'merge');
    expect(reconcileLedger(applied.ledger)).toEqual([{ accountId: 'brokerage', instrumentId: 'fund-a', quantityMicros: 10_000, costPaise: 125_000, costProvenance: 'exact' }]);
  });

  it('rejects malformed rows and never partially applies them', () => {
    const preview = previewLedgerImport([purchase('good'), { ...purchase('bad'), amountPaise: -1 }]);
    expect(preview.validRows).toHaveLength(1);
    expect(preview.errors).toContain('Row 3: amountPaise must be a non-negative safe integer');
    expect(() => applyLedgerImport(createTransactionLedger(), preview, 'merge')).toThrow('Cannot apply invalid import');
  });

  it('deduplicates repeated imports and supports rollback', () => {
    const ledger = createTransactionLedger();
    const first = applyLedgerImport(ledger, previewLedgerImport([purchase('buy-1')]), 'merge');
    const secondPreview = previewLedgerImport([purchase('buy-1')], first.ledger);
    expect(secondPreview.duplicateCount).toBe(1);
    expect(secondPreview.validRows).toHaveLength(0);
    expect(rollbackLedgerImport(first.rollback)).toEqual(ledger);
  });

  it('keeps same-day transactions distinct and consumes FIFO cost on sale', () => {
    const ledger = createTransactionLedger();
    const preview = previewLedgerImport([
      purchase('buy-1', 100_000, 10_000),
      purchase('buy-2', 200_000, 20_000),
      { id: 'sale-1', date: '2026-04-02', type: 'sale', accountId: 'brokerage', instrumentId: 'fund-a', amountPaise: 150_000, quantityMicros: 15_000, costProvenance: 'exact' },
    ]);
    const { ledger: applied } = applyLedgerImport(ledger, preview, 'merge');
    expect(applied.transactions).toHaveLength(3);
    expect(reconcileLedger(applied)).toEqual([{ accountId: 'brokerage', instrumentId: 'fund-a', quantityMicros: 15_000, costPaise: 150_000, costProvenance: 'exact' }]);
    const oversale = { ...applied.transactions[0], id: 'sale-2', dedupKey: 'sale-2', type: 'sale' as const, amountPaise: 1, quantityMicros: 20_000 };
    expect(() => reconcileLedger({ ...applied, transactions: [...applied.transactions, oversale] })).toThrow('Insufficient units');
  });

  it('round-trips CSV and supports explicit replace semantics', () => {
    const csv = 'id,date,type,accountId,instrumentId,amountPaise,quantityMicros,costProvenance,note\nbuy-1,2026-04-01,purchase,brokerage,fund-a,125000,10000,exact,"Imported, synthetic"';
    const preview = previewLedgerImport(csv);
    const replaced = applyLedgerImport({ ...createTransactionLedger(), revision: 3 }, preview, 'replace');
    expect(replaced.ledger.revision).toBe(4);
    expect(replaced.ledger.transactions[0].amountPaise).toBe(125_000);
    expect(replaced.ledger.transactions[0].note).toBe('Imported, synthetic');
  });

  it('preserves metadata in a JSON replacement import', () => {
    const preview = previewLedgerImport({
      schemaVersion: 1,
      accounts: { brokerage: { id: 'brokerage', name: 'Brokerage', currency: 'INR' } },
      instruments: { 'fund-a': { id: 'fund-a', name: 'Fund A', assetClass: 'mutual-fund', currency: 'INR' } },
      lots: [],
      liabilities: [],
      transactions: [purchase('buy-1')],
    });
    const { ledger } = applyLedgerImport(createTransactionLedger(), preview, 'replace');
    expect(ledger.accounts.brokerage.name).toBe('Brokerage');
    expect(ledger.instruments['fund-a'].assetClass).toBe('mutual-fund');
  });

  it('keeps unknown cost provenance explicit', () => {
    const preview = previewLedgerImport([{ ...purchase('opening'), type: 'opening_balance', amountPaise: 0, costProvenance: 'unknown' }]);
    const { ledger } = applyLedgerImport(createTransactionLedger(), preview, 'merge');
    expect(reconcileLedger(ledger)[0].costProvenance).toBe('unknown');
  });

  it('carries transfer provenance through to the destination lot', () => {
    const ledger = {
      ...createTransactionLedger(),
      transactions: [
        { ...purchase('buy-old', 100_000, 10_000), date: '2024-01-01' },
        { id: 'move-out', dedupKey: 'move-out', date: '2025-01-02', type: 'transfer_out' as const, accountId: 'brokerage', instrumentId: 'fund-a', amountPaise: 100_000, quantityMicros: 10_000, costProvenance: 'exact' as const },
        { id: 'move-in', dedupKey: 'move-in', date: '2025-01-03', type: 'transfer_in' as const, accountId: 'new-brokerage', instrumentId: 'fund-a', linkedTransactionId: 'move-out', amountPaise: 0, quantityMicros: 10_000, costProvenance: 'unknown' as const },
      ],
    };

    expect(reconcileLedgerLots(ledger)).toEqual([{ id: 'move-in:lot:transfer-0', transactionId: 'move-in', accountId: 'new-brokerage', instrumentId: 'fund-a', acquiredDate: '2024-01-01', quantityMicros: 10_000, costPaise: 100_000, costProvenance: 'exact' }]);
  });

  it('applies stock splits without resetting acquisition cost or date', () => {
    const ledger = {
      ...createTransactionLedger(),
      transactions: [
        { ...purchase('buy-split', 100_000, 10_000), date: '2024-01-01' },
        { id: 'split-1', dedupKey: 'split-1', date: '2025-01-02', type: 'split' as const, accountId: 'brokerage', instrumentId: 'fund-a', amountPaise: 0, costProvenance: 'unknown' as const, splitRatioNumerator: 2, splitRatioDenominator: 1 },
      ],
    };

    expect(reconcileLedgerLots(ledger)[0]).toMatchObject({ acquiredDate: '2024-01-01', quantityMicros: 20_000, costPaise: 100_000 });
  });
});
