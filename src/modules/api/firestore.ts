import {
  collection,
  doc,
  DocumentData,
  Firestore,
  getDoc,
  getDocs,
  onSnapshot,
  runTransaction,
  Unsubscribe,
  writeBatch,
} from 'firebase/firestore';
import type { FirebaseOptions } from 'firebase/app';
import { isPortfolioEnvelope } from '../../types/firebase';
import type { PortfolioEnvelope } from '../../types/firebase';
import { migratePortfolioEnvelope } from '../../lib/portfolioMigrations';
import { getFirebaseServices } from '../../lib/firebase';
import { measurePortfolioWrite } from '../../lib/portfolioMetrics';
import type { SIPFund } from '../../types/portfolio';

export const PORTFOLIO_COLLECTION = 'portfolio';
export const PORTFOLIO_DOCUMENT = 'state';

export type FirestoreServices = ReturnType<typeof getFirebaseServices>;

export class PortfolioWriteConflictError extends Error {
  readonly code = 'conflict';

  constructor(uid: string, revision: number) {
    super(`Portfolio write for ${uid} is stale at revision ${revision}`);
    this.name = 'PortfolioWriteConflictError';
  }
}

let services: FirestoreServices | null = null;
function portfolioRef(db: Firestore, uid: string) {
  return doc(db, 'users', uid, PORTFOLIO_COLLECTION, PORTFOLIO_DOCUMENT);
}

function holdingsRef(db: Firestore, uid: string) {
  return collection(db, 'users', uid, PORTFOLIO_COLLECTION, PORTFOLIO_DOCUMENT, 'holdings');
}

type StoredMfEntry = {
  kind: 'mf';
  value: SIPFund;
  updatedAt: string;
  revision?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredMfEntry(value: unknown): value is StoredMfEntry {
  if (!isRecord(value) || value.kind !== 'mf' || typeof value.updatedAt !== 'string' || !isRecord(value.value)) return false;
  const entry = value.value;
  return typeof entry.name === 'string'
    && (entry.schemeCode === undefined || typeof entry.schemeCode === 'string')
    && typeof entry.units === 'number'
    && typeof entry.startDate === 'string'
    && typeof entry.monthlyAmount === 'number'
    && (entry.costBasis === undefined || typeof entry.costBasis === 'number')
    && (value.revision === undefined
      || (typeof value.revision === 'number'
        && Number.isSafeInteger(value.revision)
        && value.revision >= 0
        && value.revision <= 1_000_000_000));
}

async function readMfEntries(db: Firestore, uid: string, expectedRevision?: number): Promise<{ mf: Record<string, SIPFund>; timestamps: Record<string, string> }> {
  const mf: Record<string, SIPFund> = {};
  const timestamps: Record<string, string> = {};
  const snapshot = await getDocs(holdingsRef(db, uid));
  for (const holding of snapshot.docs) {
    const value = holding.data();
    if (!isStoredMfEntry(value)) throw new Error(`Firestore holding document ${holding.id} has an invalid entry`);
    if (expectedRevision !== undefined && value.revision !== expectedRevision) continue;
    mf[holding.id] = value.value;
    timestamps[holding.id] = value.updatedAt;
  }
  return { mf, timestamps };
}

function attachMfEntries(
  envelope: PortfolioEnvelope,
  entries: { mf: Record<string, SIPFund>; timestamps: Record<string, string> },
): PortfolioEnvelope {
  if ('mf' in envelope.data) return envelope;
  const entryUpdatedAt = Object.keys(entries.timestamps).length > 0
    ? { ...envelope.entryUpdatedAt, holdings: entries.timestamps }
    : envelope.entryUpdatedAt;
  return {
    ...envelope,
    data: { ...envelope.data, mf: entries.mf },
    ...(entryUpdatedAt ? { entryUpdatedAt } : {}),
  };
}

export async function initFirestore(config: FirebaseOptions): Promise<FirestoreServices> {
  if (!services) {
    services = getFirebaseServices(config);
  }

  if (!services) throw new Error('Firestore services failed to initialize');
  const initializedServices = services;

  return initializedServices;
}

export async function loadPortfolio(uid: string): Promise<PortfolioEnvelope | null> {
  if (!services) throw new Error('Firestore has not been initialized');
  const initializedServices = services;
  const snapshot = await getDoc(portfolioRef(initializedServices.db, uid));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  const migrated = migratePortfolioEnvelope(data);
  if (!isPortfolioEnvelope(migrated)) {
    throw new Error('Firestore portfolio document has an invalid envelope');
  }
  return attachMfEntries(migrated, await readMfEntries(initializedServices.db, uid, migrated.revision));
}

export async function savePortfolio(uid: string, envelope: PortfolioEnvelope): Promise<void> {
  if (!services) throw new Error('Firestore has not been initialized');
  const initializedServices = services;
  const { data, entryUpdatedAt: _entryUpdatedAt, ...envelopeWithoutDynamicMetadata } = envelope;
  const { mf, ...stateData } = data;
  void _entryUpdatedAt;
  const revision = envelope.revision ?? 1;
  const stateDocument = {
    ...envelopeWithoutDynamicMetadata,
    schemaVersion: 'fireOS_v5',
    revision,
    data: stateData,
  };
  const metrics = measurePortfolioWrite(stateDocument, mf ?? {}, envelope.lastSavedAt);
  if (import.meta.env.DEV) {
    console.debug('[Firestore] Portfolio write metrics', metrics);
  }
  if (metrics.stateDocumentBytes > 750_000) {
    console.warn('[Firestore] Portfolio state document is approaching Firestore size limits', {
      stateDocumentBytes: metrics.stateDocumentBytes,
      holdingCount: metrics.holdingCount,
    });
  }
  const currentEntries = mf ?? {};
  const holdingsSnapshot = await getDocs(holdingsRef(initializedServices.db, uid));
  const holdingCollection = holdingsRef(initializedServices.db, uid);
  const knownHoldingRefs = new Map<string, ReturnType<typeof doc>>();
  holdingsSnapshot.docs.forEach((holding) => knownHoldingRefs.set(holding.id, holding.ref));
  Object.keys(currentEntries).forEach((id) => knownHoldingRefs.set(id, doc(holdingCollection, id)));

  await runTransaction(initializedServices.db, async (transaction) => {
    const stateRef = portfolioRef(initializedServices.db, uid);
    const stateSnapshot = await transaction.get(stateRef);
    const existingState = stateSnapshot.exists() ? stateSnapshot.data() : undefined;
    const incomingWriteId = envelope.client?.lastWriteId;
    const existingWriteId = isRecord(existingState?.client) && typeof existingState.client.lastWriteId === 'string'
      ? existingState.client.lastWriteId
      : undefined;
    const existingRevision = typeof existingState?.revision === 'number' && Number.isFinite(existingState.revision)
      ? existingState.revision
      : 0;

    // Firestore may retry a transaction after a network response is lost. A
    // repeated write id is a true no-op; all child writes are in this same
    // transaction, so there is no partial batch left to repair.
    if (incomingWriteId && existingWriteId === incomingWriteId) return;
    if (existingState && existingRevision >= revision) {
      throw new PortfolioWriteConflictError(uid, existingRevision);
    }

    const existingHoldingSnapshots = await Promise.all(
      [...knownHoldingRefs.values()].map((holdingRef) => transaction.get(holdingRef)),
    );
    transaction.set(stateRef, stateDocument);
    existingHoldingSnapshots.forEach((holdingSnapshot, index) => {
      const id = [...knownHoldingRefs.keys()][index];
      const holdingRef = knownHoldingRefs.get(id);
      if (!holdingRef) return;
      if (!(id in currentEntries)) {
        if (holdingSnapshot.exists()) transaction.delete(holdingRef);
        return;
      }
      const value = currentEntries[id];
      transaction.set(holdingRef, {
        kind: 'mf',
        value,
        updatedAt: envelope.lastSavedAt,
        revision,
      });
    });
  });
}

export function onPortfolioChange(
  uid: string,
  callback: (envelope: PortfolioEnvelope) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  if (!services) throw new Error('Firestore has not been initialized');
  const initializedServices = services;
  let stateEnvelope: PortfolioEnvelope | null = null;
  const entriesByRevision = new Map<number | undefined, { mf: Record<string, SIPFund>; timestamps: Record<string, string> }>();
  const emit = (): void => {
    if (stateEnvelope) {
      const visibleEntries = entriesByRevision.get(stateEnvelope.revision) ?? { mf: {}, timestamps: {} };
      callback(attachMfEntries(stateEnvelope, visibleEntries));
    }
  };
  const stateUnsubscribe = onSnapshot(
    portfolioRef(initializedServices.db, uid),
    (snapshot) => {
      if (!snapshot.exists()) return;
      const data = migratePortfolioEnvelope(snapshot.data());
      if (isPortfolioEnvelope(data)) {
        stateEnvelope = data;
        emit();
      } else onError?.(new Error('Firestore snapshot has an invalid portfolio envelope'));
    },
    (error) => onError?.(error),
  );
  const holdingsUnsubscribe = onSnapshot(
    holdingsRef(initializedServices.db, uid),
    (snapshot) => {
      try {
        const groupedEntries = new Map<number | undefined, { mf: Record<string, SIPFund>; timestamps: Record<string, string> }>();
        for (const holding of snapshot.docs) {
          const value = holding.data();
          if (!isStoredMfEntry(value)) throw new Error(`Firestore holding document ${holding.id} has an invalid entry`);
          const entries = groupedEntries.get(value.revision) ?? { mf: {}, timestamps: {} };
          entries.mf[holding.id] = value.value;
          entries.timestamps[holding.id] = value.updatedAt;
          groupedEntries.set(value.revision, entries);
        }
        entriesByRevision.clear();
        groupedEntries.forEach((entries, revision) => entriesByRevision.set(revision, entries));
        emit();
      } catch (error) {
        onError?.(error instanceof Error ? error : new Error('Firestore holding snapshot is invalid'));
      }
    },
    (error) => onError?.(error),
  );
  return () => {
    stateUnsubscribe();
    holdingsUnsubscribe();
  };
}

export async function runPortfolioTransaction<T>(
  uid: string,
  operation: (data: DocumentData | undefined) => T,
): Promise<T> {
  if (!services) throw new Error('Firestore has not been initialized');
  const initializedServices = services;
  return runTransaction(initializedServices.db, async (transaction) => {
    const snapshot = await transaction.get(portfolioRef(initializedServices.db, uid));
    return operation(snapshot.exists() ? snapshot.data() : undefined);
  });
}

export async function commitBatch(
  uid: string,
  updates: Record<string, unknown>,
): Promise<void> {
  if (!services) throw new Error('Firestore has not been initialized');
  const initializedServices = services;
  const batch = writeBatch(initializedServices.db);
  batch.set(portfolioRef(initializedServices.db, uid), updates, { merge: true });
  await batch.commit();
}

export async function deletePortfolio(uid: string): Promise<void> {
  if (!services) throw new Error('Firestore has not been initialized');
  const initializedServices = services;
  const holdings = await getDocs(holdingsRef(initializedServices.db, uid));
  const batch = writeBatch(initializedServices.db);
  holdings.docs.forEach((holding) => batch.delete(holding.ref));
  batch.delete(portfolioRef(initializedServices.db, uid));
  await batch.commit();
}
