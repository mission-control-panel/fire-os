export const LEDGER_SCHEMA_VERSION = 1;
export const MAX_LEDGER_ROWS = 10_000;

export type LedgerTransactionType =
  | 'purchase'
  | 'sale'
  | 'transfer_in'
  | 'transfer_out'
  | 'dividend'
  | 'interest'
  | 'fee'
  | 'split'
  | 'opening_balance';

export type CostProvenance = 'exact' | 'estimated' | 'unknown';
export type LedgerImportMode = 'merge' | 'replace';

export interface LedgerAccount {
  id: string;
  name: string;
  currency: string;
}

export interface LedgerInstrument {
  id: string;
  name: string;
  assetClass: string;
  currency: string;
}

export interface LedgerTransaction {
  id: string;
  dedupKey: string;
  date: string;
  type: LedgerTransactionType;
  accountId: string;
  instrumentId?: string;
  linkedTransactionId?: string;
  amountPaise: number;
  quantityMicros?: number;
  costProvenance: CostProvenance;
  note?: string;
  splitRatioNumerator?: number;
  splitRatioDenominator?: number;
}

export interface LedgerLot {
  id: string;
  transactionId: string;
  accountId: string;
  instrumentId: string;
  acquiredDate: string;
  quantityMicros: number;
  costPaise: number;
  costProvenance: CostProvenance;
}

export interface LedgerLiability {
  id: string;
  name: string;
  balancePaise: number;
  currency: string;
}

export interface TransactionLedger {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  revision: number;
  accounts: Record<string, LedgerAccount>;
  instruments: Record<string, LedgerInstrument>;
  transactions: LedgerTransaction[];
  lots: LedgerLot[];
  liabilities: LedgerLiability[];
}

export interface ReconciledHolding {
  accountId: string;
  instrumentId: string;
  quantityMicros: number;
  costPaise: number;
  costProvenance: CostProvenance;
}

export interface LedgerImportRow {
  rowNumber: number;
  transaction: LedgerTransaction | null;
  errors: string[];
}

export interface LedgerImportPreview {
  schemaVersion: typeof LEDGER_SCHEMA_VERSION;
  rows: LedgerImportRow[];
  validRows: LedgerTransaction[];
  errors: string[];
  duplicateCount: number;
  metadata?: Pick<TransactionLedger, 'accounts' | 'instruments' | 'lots' | 'liabilities'>;
}

export interface LedgerImportResult {
  ledger: TransactionLedger;
  imported: number;
  skippedDuplicates: number;
  rollback: TransactionLedger;
}

const TRANSACTION_TYPES = new Set<LedgerTransactionType>([
  'purchase', 'sale', 'transfer_in', 'transfer_out', 'dividend', 'interest', 'fee', 'split', 'opening_balance',
]);
const PROVENANCE = new Set<CostProvenance>(['exact', 'estimated', 'unknown']);
const MAX_ID_LENGTH = 150;
const MAX_REFERENCE_LENGTH = 100;
const MAX_NOTE_LENGTH = 1000;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function normaliseDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

export function createTransactionLedger(): TransactionLedger {
  return { schemaVersion: LEDGER_SCHEMA_VERSION, revision: 0, accounts: {}, instruments: {}, transactions: [], lots: [], liabilities: [] };
}

export function transactionDedupKey(transaction: Pick<LedgerTransaction, 'id' | 'date' | 'type' | 'accountId' | 'instrumentId' | 'amountPaise' | 'quantityMicros' | 'linkedTransactionId'>): string {
  return [transaction.id, transaction.date, transaction.type, transaction.accountId, transaction.instrumentId || '', transaction.amountPaise, transaction.quantityMicros ?? '', transaction.linkedTransactionId || ''].join('|');
}

function validateTransaction(value: unknown, rowNumber: number): LedgerImportRow {
  if (!value || typeof value !== 'object') return { rowNumber, transaction: null, errors: ['Row must be an object'] };
  const row = value as Record<string, unknown>;
  const errors: string[] = [];
  const date = normaliseDate(row.date);
  if (!date) errors.push('date must be an ISO calendar date');
  if (typeof row.id !== 'string' || !row.id.trim() || row.id.length > MAX_ID_LENGTH) errors.push(`id is required and must be <= ${MAX_ID_LENGTH} characters`);
  if (!TRANSACTION_TYPES.has(row.type as LedgerTransactionType)) errors.push('type is invalid');
  if (typeof row.accountId !== 'string' || !row.accountId.trim() || row.accountId.length > MAX_REFERENCE_LENGTH) errors.push(`accountId is required and must be <= ${MAX_REFERENCE_LENGTH} characters`);
  if (row.instrumentId !== undefined && (typeof row.instrumentId !== 'string' || row.instrumentId.length > MAX_REFERENCE_LENGTH)) errors.push(`instrumentId must be <= ${MAX_REFERENCE_LENGTH} characters`);
  if (row.linkedTransactionId !== undefined && (typeof row.linkedTransactionId !== 'string' || row.linkedTransactionId.length > MAX_ID_LENGTH)) errors.push(`linkedTransactionId must be <= ${MAX_ID_LENGTH} characters`);
  if (typeof row.dedupKey === 'string' && row.dedupKey.length > 500) errors.push('dedupKey must be <= 500 characters');
  if (typeof row.note === 'string' && row.note.length > MAX_NOTE_LENGTH) errors.push(`note must be <= ${MAX_NOTE_LENGTH} characters`);
  if (!isSafeInteger(row.amountPaise) || (row.amountPaise as number) < 0) errors.push('amountPaise must be a non-negative safe integer');
  if (row.quantityMicros !== undefined && (!isSafeInteger(row.quantityMicros) || (row.quantityMicros as number) < 0)) errors.push('quantityMicros must be a non-negative safe integer');
  if (!PROVENANCE.has(row.costProvenance as CostProvenance)) errors.push('costProvenance is invalid');
  if (row.type === 'split' && (!isSafeInteger(row.splitRatioNumerator) || (row.splitRatioNumerator as number) <= 0 || !isSafeInteger(row.splitRatioDenominator) || (row.splitRatioDenominator as number) <= 0)) errors.push('split ratios must be positive safe integers');
  if (errors.length) return { rowNumber, transaction: null, errors };

  const transaction = {
    id: row.id as string,
    dedupKey: typeof row.dedupKey === 'string' && row.dedupKey ? row.dedupKey : transactionDedupKey({ id: row.id as string, date: date as string, type: row.type as LedgerTransactionType, accountId: row.accountId as string, instrumentId: row.instrumentId as string | undefined, amountPaise: row.amountPaise as number, quantityMicros: row.quantityMicros as number | undefined, linkedTransactionId: row.linkedTransactionId as string | undefined }),
    date: date as string,
    type: row.type as LedgerTransactionType,
    accountId: row.accountId as string,
    instrumentId: typeof row.instrumentId === 'string' && row.instrumentId ? row.instrumentId : undefined,
    linkedTransactionId: typeof row.linkedTransactionId === 'string' ? row.linkedTransactionId : undefined,
    amountPaise: row.amountPaise as number,
    quantityMicros: row.quantityMicros as number | undefined,
    costProvenance: row.costProvenance as CostProvenance,
    note: typeof row.note === 'string' ? row.note : undefined,
    splitRatioNumerator: row.splitRatioNumerator as number | undefined,
    splitRatioDenominator: row.splitRatioDenominator as number | undefined,
  } satisfies LedgerTransaction;
  return { rowNumber, transaction, errors: [] };
}

function parseCsv(input: string): Record<string, unknown>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      record.push(field); field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      record.push(field); field = '';
      if (record.some((value) => value.trim())) records.push(record);
      record = [];
    } else field += character;
  }
  if (field || record.length) { record.push(field); if (record.some((value) => value.trim())) records.push(record); }
  if (!records.length) return [];
  const headers = records[0].map((header) => header.trim());
  return records.slice(1).map((values) => {
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ''])) as Record<string, unknown>;
  });
}

function coerceCsvRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    amountPaise: row.amountPaise === '' ? undefined : Number(row.amountPaise),
    quantityMicros: row.quantityMicros === '' || row.quantityMicros === undefined ? undefined : Number(row.quantityMicros),
  };
}

function ledgerMetadata(value: Record<string, unknown>): LedgerImportPreview['metadata'] | undefined {
  if (!['accounts', 'instruments', 'lots', 'liabilities'].some((key) => key in value)) return undefined;
  if (!value.accounts || !value.instruments || !value.lots || !value.liabilities || !Array.isArray(value.lots) || !Array.isArray(value.liabilities)) return undefined;
  return {
    accounts: value.accounts as TransactionLedger['accounts'],
    instruments: value.instruments as TransactionLedger['instruments'],
    lots: value.lots as TransactionLedger['lots'],
    liabilities: value.liabilities as TransactionLedger['liabilities'],
  };
}

export function previewLedgerImport(input: string | unknown, existing: TransactionLedger = createTransactionLedger()): LedgerImportPreview {
  let rawRows: unknown[];
  let metadata: LedgerImportPreview['metadata'];
  try {
    if (typeof input === 'string') {
      const trimmed = input.trim();
      const parsed = trimmed.startsWith('[') || trimmed.startsWith('{') ? JSON.parse(trimmed) : undefined;
      if (Array.isArray(parsed)) rawRows = parsed;
      else if (parsed && typeof parsed === 'object' && Array.isArray(parsed.transactions)) {
        rawRows = parsed.transactions;
        metadata = ledgerMetadata(parsed);
      } else rawRows = parseCsv(input).map(coerceCsvRow);
    } else if (Array.isArray(input)) {
      rawRows = input;
    } else if (input && typeof input === 'object' && Array.isArray((input as { transactions?: unknown[] }).transactions)) {
      rawRows = (input as { transactions: unknown[] }).transactions;
      metadata = ledgerMetadata(input as Record<string, unknown>);
    } else {
      rawRows = [];
    }
  } catch {
    return { schemaVersion: LEDGER_SCHEMA_VERSION, rows: [], validRows: [], errors: ['Import is not valid JSON or CSV'], duplicateCount: 0 };
  }
  if (rawRows.length > MAX_LEDGER_ROWS) return { schemaVersion: LEDGER_SCHEMA_VERSION, rows: [], validRows: [], errors: [`Import exceeds ${MAX_LEDGER_ROWS} rows`], duplicateCount: 0, metadata };
  const seen = new Set(existing.transactions.map((transaction) => transaction.dedupKey));
  let duplicateCount = 0;
  const rows = rawRows.map((raw, index) => {
    const checked = validateTransaction(raw, index + 2);
    if (checked.transaction && seen.has(checked.transaction.dedupKey)) {
      duplicateCount += 1;
      checked.errors.push('Duplicate transaction');
      checked.transaction = null;
    } else if (checked.transaction) seen.add(checked.transaction.dedupKey);
    return checked;
  });
  return { schemaVersion: LEDGER_SCHEMA_VERSION, rows, validRows: rows.flatMap((row) => row.transaction ? [row.transaction] : []), errors: rows.flatMap((row) => row.errors.map((error) => `Row ${row.rowNumber}: ${error}`)), duplicateCount, metadata };
}

export function reconcileLedger(ledger: TransactionLedger): ReconciledHolding[] {
  const holdings = new Map<string, ReconciledHolding>();
  const lots = new Map<string, Array<{ quantityMicros: number; costPaise: number; costProvenance: CostProvenance }>>();
  const holdingKey = (transaction: LedgerTransaction) => `${transaction.accountId}|${transaction.instrumentId || ''}`;
  const addHolding = (transaction: LedgerTransaction, quantity: number, cost: number, provenance: CostProvenance) => {
    if (!transaction.instrumentId || quantity === 0) return;
    const key = holdingKey(transaction);
    const current = holdings.get(key) || { accountId: transaction.accountId, instrumentId: transaction.instrumentId, quantityMicros: 0, costPaise: 0, costProvenance: 'exact' as CostProvenance };
    current.quantityMicros += quantity;
    current.costPaise += cost;
    if (provenance === 'unknown' || current.costProvenance === 'unknown') current.costProvenance = 'unknown';
    else if (provenance === 'estimated' || current.costProvenance === 'estimated') current.costProvenance = 'estimated';
    holdings.set(key, current);
  };
  const addLot = (transaction: LedgerTransaction, quantity: number, cost: number, provenance: CostProvenance) => {
    if (!transaction.instrumentId || quantity <= 0) return;
    const key = holdingKey(transaction);
    const current = lots.get(key) || [];
    current.push({ quantityMicros: quantity, costPaise: cost, costProvenance: provenance });
    lots.set(key, current);
    addHolding(transaction, quantity, cost, provenance);
  };
  const consumeLots = (transaction: LedgerTransaction, quantity: number) => {
    const key = holdingKey(transaction);
    const queue = lots.get(key) || [];
    let remaining = quantity;
    let consumedCost = 0;
    let provenance: CostProvenance = 'exact';
    while (remaining > 0 && queue.length) {
      const lot = queue[0];
      const originalQuantity = lot.quantityMicros;
      const originalCost = lot.costPaise;
      const consumed = Math.min(remaining, originalQuantity);
      const lotCost = originalQuantity === consumed ? originalCost : Math.round(originalCost * consumed / originalQuantity);
      consumedCost += lotCost;
      if (lot.costProvenance === 'unknown' || provenance === 'unknown') provenance = 'unknown';
      else if (lot.costProvenance === 'estimated' || provenance === 'estimated') provenance = 'estimated';
      lot.quantityMicros = originalQuantity - consumed;
      lot.costPaise = originalCost - lotCost;
      remaining -= consumed;
      if (lot.quantityMicros === 0) queue.shift();
    }
    if (remaining > 0) throw new Error(`Insufficient units for ${key}`);
    lots.set(key, queue);
    addHolding(transaction, -quantity, -consumedCost, provenance);
    return { costPaise: consumedCost, costProvenance: provenance };
  };
  const transferCosts = new Map<string, { quantityMicros: number; costPaise: number; costProvenance: CostProvenance }>();
  const transactions = [...ledger.transactions].sort((a, b) => {
    const dateOrder = a.date.localeCompare(b.date);
    if (dateOrder !== 0) return dateOrder;
    if (a.type === 'transfer_in' && a.linkedTransactionId === b.id) return 1;
    if (b.type === 'transfer_in' && b.linkedTransactionId === a.id) return -1;
    return a.id.localeCompare(b.id);
  });
  for (const transaction of transactions) {
    const quantity = transaction.quantityMicros ?? 0;
    if (transaction.type === 'purchase' || transaction.type === 'opening_balance') addLot(transaction, quantity, transaction.amountPaise, transaction.costProvenance);
    if (transaction.type === 'transfer_out') {
      const consumed = consumeLots(transaction, quantity);
      transferCosts.set(transaction.id, { quantityMicros: quantity, ...consumed });
    }
    if (transaction.type === 'transfer_in') {
      const carried = transaction.linkedTransactionId ? transferCosts.get(transaction.linkedTransactionId) : undefined;
      if (carried) {
        const incomingQuantity = transaction.quantityMicros === undefined ? carried.quantityMicros : quantity;
        if (incomingQuantity > carried.quantityMicros) throw new Error(`Transfer-in quantity exceeds linked transfer for ${transaction.id}`);
        const incomingCost = carried.quantityMicros === incomingQuantity ? carried.costPaise : Math.round(carried.costPaise * incomingQuantity / carried.quantityMicros);
        addLot(transaction, incomingQuantity, incomingCost, carried.costProvenance);
        carried.quantityMicros -= incomingQuantity;
        carried.costPaise -= incomingCost;
      } else addLot(transaction, quantity, transaction.amountPaise, transaction.costProvenance);
    }
    if (transaction.type === 'sale') consumeLots(transaction, quantity);
    if (transaction.type === 'split') {
      if (!transaction.splitRatioNumerator || !transaction.splitRatioDenominator) throw new Error(`Split ratio is required for ${transaction.id}`);
      const current = holdings.get(holdingKey(transaction));
      const before = current?.quantityMicros ?? 0;
      const ratioQuantity = Math.round(before * transaction.splitRatioNumerator / transaction.splitRatioDenominator);
      if (!current || !Number.isSafeInteger(ratioQuantity)) throw new Error(`Invalid split quantity for ${transaction.id}`);
      const delta = ratioQuantity - before;
      addHolding(transaction, delta, 0, current.costProvenance);
      const queue = lots.get(holdingKey(transaction)) || [];
      for (const lot of queue) lot.quantityMicros = Math.round(lot.quantityMicros * transaction.splitRatioNumerator / transaction.splitRatioDenominator);
    }
  }
  return [...holdings.values()].filter((holding) => holding.quantityMicros !== 0);
}

/**
 * Return the current FIFO lots after applying the append-only transaction
 * stream. Consumers that need acquisition dates must use this rather than
 * trusting an imported snapshot of `ledger.lots`, which may still contain
 * units consumed by later sales or transfers.
 */
export function reconcileLedgerLots(ledger: TransactionLedger): LedgerLot[] {
  const queues = new Map<string, LedgerLot[]>();
  const transferred = new Map<string, LedgerLot[]>();
  const key = (transaction: LedgerTransaction) => `${transaction.accountId}|${transaction.instrumentId || ''}`;
  const add = (transaction: LedgerTransaction, quantityMicros: number, costPaise: number, costProvenance: CostProvenance, acquiredDate = transaction.date, suffix = '') => {
    if (!transaction.instrumentId || quantityMicros <= 0) return;
    const queue = queues.get(key(transaction)) ?? [];
    queue.push({ id: `${transaction.id}:lot${suffix}`, transactionId: transaction.id, accountId: transaction.accountId, instrumentId: transaction.instrumentId, acquiredDate, quantityMicros, costPaise, costProvenance });
    queues.set(key(transaction), queue);
  };
  const consume = (transaction: LedgerTransaction): LedgerLot[] => {
    const queue = queues.get(key(transaction)) ?? [];
    let remaining = transaction.quantityMicros ?? 0;
    const consumedLots: LedgerLot[] = [];
    while (remaining > 0 && queue.length) {
      const lot = queue[0];
      const consumed = Math.min(remaining, lot.quantityMicros);
      const cost = lot.quantityMicros === consumed ? lot.costPaise : Math.round(lot.costPaise * consumed / lot.quantityMicros);
      consumedLots.push({ ...lot, id: `${lot.id}:consumed`, quantityMicros: consumed, costPaise: cost });
      lot.quantityMicros -= consumed;
      lot.costPaise -= cost;
      remaining -= consumed;
      if (lot.quantityMicros === 0) queue.shift();
    }
    if (remaining > 0) throw new Error(`Insufficient units for ${key(transaction)}`);
    queues.set(key(transaction), queue);
    return consumedLots;
  };
  const transactions = [...ledger.transactions].sort((a, b) => {
    const dateOrder = a.date.localeCompare(b.date);
    if (dateOrder !== 0) return dateOrder;
    if (a.type === 'transfer_in' && a.linkedTransactionId === b.id) return 1;
    if (b.type === 'transfer_in' && b.linkedTransactionId === a.id) return -1;
    return a.id.localeCompare(b.id);
  });
  for (const transaction of transactions) {
    const quantity = transaction.quantityMicros ?? 0;
    if (transaction.type === 'purchase' || transaction.type === 'opening_balance') add(transaction, quantity, transaction.amountPaise, transaction.costProvenance);
    if (transaction.type === 'sale') consume(transaction);
    if (transaction.type === 'transfer_out') transferred.set(transaction.id, consume(transaction));
    if (transaction.type === 'transfer_in') {
      const carried = transaction.linkedTransactionId ? transferred.get(transaction.linkedTransactionId) : undefined;
      if (transaction.linkedTransactionId && transferred.has(transaction.linkedTransactionId)) {
        const linkedLots = carried ?? [];
        let remaining = transaction.quantityMicros === undefined
          ? linkedLots.reduce((sum, lot) => sum + lot.quantityMicros, 0)
          : quantity;
        for (const [index, lot] of linkedLots.entries()) {
          if (remaining <= 0) break;
          const carriedQuantity = Math.min(remaining, lot.quantityMicros);
          const carriedCost = lot.quantityMicros === carriedQuantity ? lot.costPaise : Math.round(lot.costPaise * carriedQuantity / lot.quantityMicros);
          add(transaction, carriedQuantity, carriedCost, lot.costProvenance, lot.acquiredDate, `:transfer-${index}`);
          lot.quantityMicros -= carriedQuantity;
          lot.costPaise -= carriedCost;
          remaining -= carriedQuantity;
        }
        if (remaining > 0) throw new Error(`Transfer-in quantity exceeds linked transfer for ${transaction.id}`);
        transferred.set(transaction.linkedTransactionId!, linkedLots.filter((lot) => lot.quantityMicros > 0));
      } else add(transaction, quantity, transaction.amountPaise, transaction.costProvenance);
    }
    if (transaction.type === 'split') {
      if (!transaction.splitRatioNumerator || !transaction.splitRatioDenominator) throw new Error(`Split ratio is required for ${transaction.id}`);
      const queue = queues.get(key(transaction)) ?? [];
      for (const lot of queue) {
        const splitQuantity = Math.round(lot.quantityMicros * transaction.splitRatioNumerator / transaction.splitRatioDenominator);
        if (!Number.isSafeInteger(splitQuantity)) throw new Error(`Invalid split quantity for ${transaction.id}`);
        lot.quantityMicros = splitQuantity;
      }
    }
  }
  return [...queues.values()].flat().filter(lot => lot.quantityMicros > 0);
}

export function applyLedgerImport(ledger: TransactionLedger, preview: LedgerImportPreview, mode: LedgerImportMode): LedgerImportResult {
  if (preview.errors.length) throw new Error(`Cannot apply invalid import: ${preview.errors[0]}`);
  const revalidated = preview.validRows.map((row, index) => validateTransaction(row, index + 2));
  if (revalidated.some((row) => row.errors.length || !row.transaction)) throw new Error('Cannot apply invalid import: preview failed revalidation');
  const rollback = clone(ledger);
  const next = mode === 'replace' ? createTransactionLedger() : clone(ledger);
  if (mode === 'replace' && preview.metadata) {
    next.accounts = clone(preview.metadata.accounts);
    next.instruments = clone(preview.metadata.instruments);
    next.lots = clone(preview.metadata.lots);
    next.liabilities = clone(preview.metadata.liabilities);
  }
  const existing = new Set(next.transactions.map((transaction) => transaction.dedupKey));
  let imported = 0;
  let skippedDuplicates = 0;
  for (const transaction of preview.validRows) {
    if (existing.has(transaction.dedupKey)) { skippedDuplicates += 1; continue; }
    existing.add(transaction.dedupKey);
    next.transactions.push(clone(transaction));
    imported += 1;
  }
  next.revision = rollback.revision + 1;
  return { ledger: next, imported, skippedDuplicates, rollback };
}

export function rollbackLedgerImport(snapshot: TransactionLedger): TransactionLedger {
  return clone(snapshot);
}
