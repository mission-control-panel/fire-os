import { useMemo, useState } from 'react';
import { appState } from '../../../lib/appState';
import {
  applyLedgerImport,
  createTransactionLedger,
  previewLedgerImport,
  reconcileLedger,
  transactionDedupKey,
  type LedgerTransactionType,
} from '../../../lib/transaction-ledger';
import { formatCurrency } from '../../../lib/formatters';
import { createPortfolioRepository } from '../../../core/persistence/portfolio-repository';
import { usePortfolioSaved } from '../../providers';
import { Button, Card, CardTitle, Input, Table, TableBody, TableCaption, TableCell, TableHead, TableHeaderCell, TableNumericCell, TableRow } from '../../ui';
import { showToast } from '../../../modules/ui/Toast';

const TRANSACTION_TYPES: LedgerTransactionType[] = ['purchase', 'sale', 'dividend', 'interest', 'fee', 'opening_balance'];
const MAX_ENTITY_NAME_LENGTH = 80;

function stableId(value: string, fallback: string): string {
  const trimmed = value.trim();
  let hash = 2166136261;
  for (let index = 0; index < trimmed.length; index += 1) {
    hash ^= trimmed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const normalised = trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const suffix = (hash >>> 0).toString(36);
  return `${(normalised || fallback).slice(0, 80 - suffix.length - 1)}-${suffix}`;
}

export function PortfolioWorkspace() {
  usePortfolioSaved();
  const ledger = appState.transactionLedger ?? createTransactionLedger();
  const [account, setAccount] = useState('Primary account');
  const [instrument, setInstrument] = useState('');
  const [type, setType] = useState<LedgerTransactionType>('purchase');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState('');
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<ReturnType<typeof previewLedgerImport> | null>(null);

  const holdings = useMemo(() => {
    try { return reconcileLedger(ledger); } catch { return []; }
  }, [ledger]);

  const saveLedger = (next: typeof ledger) => {
    appState.transactionLedger = next;
    createPortfolioRepository().save(appState);
  };

  const addTransaction = () => {
    const amountPaise = Math.round(Number(amount) * 100);
    const quantityMicros = quantity.trim() ? Math.round(Number(quantity) * 1_000_000) : undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(amountPaise) || amountPaise < 0) {
      setMessage('Enter a valid date and non-negative amount.'); return;
    }
    if (account.trim().length > MAX_ENTITY_NAME_LENGTH || instrument.trim().length > MAX_ENTITY_NAME_LENGTH) {
      setMessage(`Account and instrument names must be ${MAX_ENTITY_NAME_LENGTH} characters or fewer.`); return;
    }
    if (note.length > 1000) {
      setMessage('Notes must be 1,000 characters or fewer.'); return;
    }
    if (quantityMicros !== undefined && (!Number.isSafeInteger(quantityMicros) || quantityMicros < 0)) {
      setMessage('Quantity must be a non-negative finite number.'); return;
    }
    const accountId = stableId(account, 'account');
    const instrumentId = instrument.trim() ? stableId(instrument, 'instrument') : undefined;
    let transactionId = `manual-${Date.now()}-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
    while (ledger.transactions.some((transaction) => transaction.id === transactionId)) transactionId = `manual-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const transactionBase = { id: transactionId, date, type, accountId, instrumentId, amountPaise, quantityMicros, linkedTransactionId: undefined } as const;
    const transaction = { ...transactionBase, dedupKey: transactionDedupKey(transactionBase), costProvenance: 'exact' as const, ...(note.trim() ? { note: note.trim() } : {}) };
    const next = {
      ...ledger,
      accounts: { ...ledger.accounts, [accountId]: { id: accountId, name: account.trim() || 'Primary account', currency: 'INR' } },
      ...(instrumentId ? { instruments: { ...ledger.instruments, [instrumentId]: { id: instrumentId, name: instrument.trim(), assetClass: 'unspecified', currency: 'INR' } } } : {}),
      transactions: [...ledger.transactions, transaction],
      revision: ledger.revision + 1,
    };
    try {
      reconcileLedger(next); saveLedger(next); setAmount(''); setQuantity(''); setNote(''); setMessage(null); showToast('Transaction saved', 3000, 'success');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Transaction could not be reconciled.'); }
  };

  const handleImport = async (file: File | undefined) => {
    if (!file) return;
    const preview = previewLedgerImport(await file.text(), ledger);
    setImportPreview(preview);
    setMessage(preview.errors.length ? preview.errors[0] : `${preview.validRows.length} valid rows ready to import.`);
  };

  const commitImport = (mode: 'merge' | 'replace') => {
    if (!importPreview) return;
    try {
      const result = applyLedgerImport(ledger, importPreview, mode);
      reconcileLedger(result.ledger); saveLedger(result.ledger); setImportPreview(null); setMessage(null);
      showToast(`Imported ${result.imported} transaction${result.imported === 1 ? '' : 's'}`, 3000, 'success');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Import could not be applied.'); }
  };

  const sortedTransactions = [...ledger.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
  return (
    <div className="flex flex-col gap-6">
      <div><p className="text-xs font-semibold tracking-wide text-(--color-accent) uppercase">Portfolio workspace</p><h1 className="text-2xl font-semibold text-(--color-foreground)">Transactions, holdings and reconciliation</h1><p className="mt-1 max-w-3xl text-sm text-(--color-muted-foreground)">Record or import ledger events in integer paise and micro-units. Duplicate imports are rejected before they can change the portfolio.</p></div>
      {message ? <p role="status" className="rounded-md border border-(--color-border) bg-(--color-muted) p-3 text-sm text-(--color-foreground)">{message}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="flex flex-col gap-4"><CardTitle>Add transaction</CardTitle><div className="grid gap-3 sm:grid-cols-2">
          <Input id="ledger-account" label="Account" value={account} onChange={(event) => setAccount(event.target.value)} /><Input id="ledger-instrument" label="Instrument (optional)" value={instrument} onChange={(event) => setInstrument(event.target.value)} /><Input id="ledger-date" label="Date" type="date" value={date} onChange={(event) => setDate(event.target.value)} /><Input id="ledger-amount" label="Amount (₹)" type="number" min="0" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} /><Input id="ledger-quantity" label="Quantity (optional)" type="number" min="0" inputMode="decimal" value={quantity} onChange={(event) => setQuantity(event.target.value)} /><Input id="ledger-note" label="Note (optional)" value={note} onChange={(event) => setNote(event.target.value)} />
        </div><div className="flex flex-col gap-1"><label htmlFor="ledger-type" className="text-xs font-semibold text-(--color-muted-foreground)">Type</label><select id="ledger-type" value={type} onChange={(event) => setType(event.target.value as LedgerTransactionType)} className="rounded-md border border-(--color-border) bg-(--color-surface) px-3 py-2 text-sm text-(--color-foreground) focus-visible:outline-2 focus-visible:outline-(--color-ring)">{TRANSACTION_TYPES.map((option) => <option key={option} value={option}>{option.replace('_', ' ')}</option>)}</select></div><Button variant="primary" onClick={addTransaction}>Save transaction</Button></Card>
        <Card className="flex flex-col gap-4"><CardTitle>Import and reconcile</CardTitle><p className="text-sm text-(--color-muted-foreground)">Upload ledger JSON or CSV for a preview. Merge preserves current records; replace is explicit and rollback-safe in memory until saved.</p><Input id="ledger-import" label="Ledger file" type="file" accept=".csv,.json,application/json,text/csv" onChange={(event) => void handleImport(event.target.files?.[0])} />{importPreview ? <div className="flex flex-col gap-2 rounded-md border border-(--color-border) p-3 text-sm"><p><strong>{importPreview.validRows.length}</strong> valid rows · <strong>{importPreview.duplicateCount}</strong> duplicates · <strong>{importPreview.errors.length}</strong> errors</p><div className="flex flex-wrap gap-2"><Button variant="primary" onClick={() => commitImport('merge')} disabled={importPreview.errors.length > 0}>Merge valid import</Button><Button variant="secondary" onClick={() => commitImport('replace')} disabled={importPreview.errors.length > 0}>Replace ledger</Button></div></div> : null}</Card>
      </div>
      <Card><CardTitle>Reconciled holdings</CardTitle>{holdings.length === 0 ? <p className="mt-3 text-sm text-(--color-muted-foreground)">No holdings can be reconciled yet. Add a purchase or opening balance with an instrument and quantity.</p> : <Table className="mt-3"><TableCaption>FIFO ledger holdings and cost basis</TableCaption><TableHead><TableRow><TableHeaderCell>Account</TableHeaderCell><TableHeaderCell>Instrument</TableHeaderCell><TableHeaderCell>Provenance</TableHeaderCell><TableHeaderCell className="text-right">Units</TableHeaderCell><TableHeaderCell className="text-right">Cost basis</TableHeaderCell></TableRow></TableHead><TableBody>{holdings.map((holding) => <TableRow key={`${holding.accountId}-${holding.instrumentId}`}><TableCell>{ledger.accounts[holding.accountId]?.name ?? holding.accountId}</TableCell><TableCell>{ledger.instruments[holding.instrumentId]?.name ?? holding.instrumentId}</TableCell><TableCell>{holding.costProvenance}</TableCell><TableNumericCell>{(holding.quantityMicros / 1_000_000).toLocaleString('en-IN')}</TableNumericCell><TableNumericCell>{formatCurrency(holding.costPaise / 100, 0)}</TableNumericCell></TableRow>)}</TableBody></Table>}</Card>
      <Card><CardTitle>Transaction history</CardTitle>{sortedTransactions.length === 0 ? <p className="mt-3 text-sm text-(--color-muted-foreground)">No transactions recorded.</p> : <Table className="mt-3"><TableCaption>Newest ledger events first</TableCaption><TableHead><TableRow><TableHeaderCell>Date</TableHeaderCell><TableHeaderCell>Type</TableHeaderCell><TableHeaderCell>Account</TableHeaderCell><TableHeaderCell>Instrument</TableHeaderCell><TableHeaderCell className="text-right">Amount</TableHeaderCell><TableHeaderCell className="text-right">Quantity</TableHeaderCell></TableRow></TableHead><TableBody>{sortedTransactions.map((transaction) => <TableRow key={transaction.id}><TableCell>{transaction.date}</TableCell><TableCell>{transaction.type.replace('_', ' ')}</TableCell><TableCell>{ledger.accounts[transaction.accountId]?.name ?? transaction.accountId}</TableCell><TableCell>{transaction.instrumentId ? ledger.instruments[transaction.instrumentId]?.name ?? transaction.instrumentId : '—'}</TableCell><TableNumericCell>{formatCurrency(transaction.amountPaise / 100, 0)}</TableNumericCell><TableNumericCell>{transaction.quantityMicros === undefined ? '—' : (transaction.quantityMicros / 1_000_000).toLocaleString('en-IN')}</TableNumericCell></TableRow>)}</TableBody></Table>}</Card>
    </div>
  );
}

export function PortfolioWorkspaceRoute() { return <PortfolioWorkspace />; }
