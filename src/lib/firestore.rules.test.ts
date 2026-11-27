import { afterAll, beforeAll, describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';
import {
  RulesTestEnvironment,
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import { buildEnvelopeFromState } from './merge';
import { initializeState } from '../types/state';

const projectId = 'fire-os-rules-test';
const validEnvelope = {
  schemaVersion: 'fireOS_v3',
  lastSavedAt: '2026-01-01T00:00:00.000Z',
  data: {},
};

let testEnvironment: RulesTestEnvironment;

beforeAll(async () => {
  testEnvironment = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: readFileSync(resolve(process.cwd(), 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: Number(process.env.FIRESTORE_EMULATOR_PORT ?? 8082),
    },
  });
});

afterAll(async () => {
  await testEnvironment?.cleanup();
});

describe('portfolio Firestore rules', () => {
  it('allows an owner to create a valid envelope', async () => {
    const db = testEnvironment.authenticatedContext('owner-1').firestore();
    await assertSucceeds(setDoc(doc(db, 'users/owner-1/portfolio/state'), { ...validEnvelope, revision: 1 }));
    await assertFails(setDoc(doc(db, 'users/owner-1/portfolio/state'), { ...validEnvelope, revision: -1 }));
    await assertFails(setDoc(doc(db, 'users/owner-1/portfolio/state'), { ...validEnvelope, revision: 1.5 }));
    await assertFails(setDoc(doc(db, 'users/owner-1/portfolio/state'), { ...validEnvelope, revision: 1000000001 }));
  });

  it('allows the production default portfolio envelope', async () => {
    const db = testEnvironment.authenticatedContext('owner-default-state').firestore();
    const envelope = buildEnvelopeFromState(
      initializeState(),
      { clientId: 'browser', appVersion: '2.2.0', platform: 'web' },
      '2026-01-01T00:00:00.000Z',
    );
    const { mf: _mf, ...stateData } = envelope.data;
    const { entryUpdatedAt: _entryUpdatedAt, ...envelopeWithoutDynamicMetadata } = envelope;
    void _mf;
    void _entryUpdatedAt;
    await assertSucceeds(setDoc(doc(db, 'users/owner-default-state/portfolio/state'), {
      ...envelopeWithoutDynamicMetadata,
      schemaVersion: 'fireOS_v5',
      data: stateData,
    }));
  });

  it('allows a bounded versioned transaction ledger in the envelope', async () => {
    const db = testEnvironment.authenticatedContext('ledger-owner').firestore();
    const envelope = buildEnvelopeFromState(initializeState(), {}, '2026-01-01T00:00:00.000Z');
    const { mf: _mf, ...stateData } = envelope.data;
    const { entryUpdatedAt: _entryUpdatedAt, ...withoutDynamicMetadata } = envelope;
    void _mf;
    void _entryUpdatedAt;
    await assertSucceeds(setDoc(doc(db, 'users/ledger-owner/portfolio/state'), { ...withoutDynamicMetadata, data: stateData }));
  });

  it('denies another user access to the portfolio', async () => {
    const ownerDb = testEnvironment.authenticatedContext('owner-2').firestore();
    await assertSucceeds(setDoc(doc(ownerDb, 'users/owner-2/portfolio/state'), validEnvelope));

    const otherDb = testEnvironment.authenticatedContext('other-user').firestore();
    await assertFails(getDoc(doc(otherDb, 'users/owner-2/portfolio/state')));
  });

  it('allows owner state deletion and denies unauthenticated state access', async () => {
    const ownerDb = testEnvironment.authenticatedContext('owner-authz').firestore();
    const stateRef = doc(ownerDb, 'users/owner-authz/portfolio/state');
    await assertSucceeds(setDoc(stateRef, validEnvelope));

    const unauthenticatedDb = testEnvironment.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthenticatedDb, 'users/owner-authz/portfolio/state')));
    await assertFails(setDoc(doc(unauthenticatedDb, 'users/owner-authz/portfolio/state'), validEnvelope));
    await assertSucceeds(deleteDoc(stateRef));
  });

  it('enforces owner-only holding CRUD and allows valid owner updates', async () => {
    const ownerDb = testEnvironment.authenticatedContext('holding-owner').firestore();
    const stateRef = doc(ownerDb, 'users/holding-owner/portfolio/state');
    const holdingRef = doc(ownerDb, 'users/holding-owner/portfolio/state/holdings/fund-1');
    const holding = {
      kind: 'mf',
      value: {
        name: 'Example Fund',
        schemeCode: '12345',
        units: 10,
        startDate: '2026-01',
        monthlyAmount: 1000,
        costBasis: 9000,
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    await assertSucceeds(setDoc(stateRef, { ...validEnvelope, schemaVersion: 'fireOS_v4' }));
    await assertSucceeds(setDoc(holdingRef, holding));
    await assertSucceeds(updateDoc(holdingRef, { updatedAt: '2026-01-02T00:00:00.000Z' }));

    const otherDb = testEnvironment.authenticatedContext('holding-other').firestore();
    await assertFails(getDoc(doc(otherDb, 'users/holding-owner/portfolio/state/holdings/fund-1')));
    await assertFails(updateDoc(doc(otherDb, 'users/holding-owner/portfolio/state/holdings/fund-1'), {
      updatedAt: '2026-01-03T00:00:00.000Z',
    }));
    await assertFails(deleteDoc(doc(otherDb, 'users/holding-owner/portfolio/state/holdings/fund-1')));

    const unauthenticatedDb = testEnvironment.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(unauthenticatedDb, 'users/holding-owner/portfolio/state/holdings/fund-1')));
    await assertFails(deleteDoc(doc(unauthenticatedDb, 'users/holding-owner/portfolio/state/holdings/fund-1')));
    await assertSucceeds(deleteDoc(holdingRef));
  });

  it('denies envelopes with unknown persisted fields', async () => {
    const db = testEnvironment.authenticatedContext('owner-3').firestore();
    await assertFails(setDoc(doc(db, 'users/owner-3/portfolio/state'), {
      ...validEnvelope,
      data: { privateServerField: true },
    }));
  });

  it('denies malformed nested persisted values on create', async () => {
    const db = testEnvironment.authenticatedContext('owner-4').firestore();
    await assertFails(setDoc(doc(db, 'users/owner-4/portfolio/state'), {
      ...validEnvelope,
      data: { profile: 'not-a-profile' },
    }));
  });

  it('denies out-of-range profile and mutual-fund values at the rules boundary', async () => {
    const db = testEnvironment.authenticatedContext('owner-ranges').firestore();
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state'), {
      ...validEnvelope,
      data: { profile: { name: 'Test', age: 999, annualExpenses: 1, fiTarget: 1, monthlyIncome: 1 } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state/holdings/fund-1'), {
      kind: 'mf',
      value: { name: 'Example Fund', units: -1, startDate: '2026-01', monthlyAmount: 1000 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state/holdings/fund-2'), {
      kind: 'mf',
      value: { name: 'Example Fund', units: 1, startDate: '2026-1', monthlyAmount: 1000 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state/holdings/fund-4'), {
      kind: 'mf',
      value: { name: 'Example Fund', units: 1, startDate: '2026-13', monthlyAmount: 1000 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state'), {
      ...validEnvelope,
      data: { profile: { name: 'Test', age: 'unknown', annualExpenses: 1, fiTarget: 1, monthlyIncome: 1 } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state'), {
      ...validEnvelope,
      data: { profile: { name: 'Test', age: 30, annualExpenses: 1 } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state'), {
      ...validEnvelope,
      data: { profile: { name: 'Test', age: 30, annualExpenses: 1000000000001, fiTarget: 1, monthlyIncome: 1 } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state'), {
      ...validEnvelope,
      data: { profile: { name: 'Test', age: 30, annualExpenses: 1, fiTarget: 1000000000000001, monthlyIncome: 1 } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state'), {
      ...validEnvelope,
      data: { profile: { name: 'Test', age: 30, annualExpenses: 1, fiTarget: 1, monthlyIncome: 1, extra: true } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state'), {
      ...validEnvelope,
      data: { profile: { name: 'x'.repeat(201), age: 30, annualExpenses: 1, fiTarget: 1, monthlyIncome: 1 } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state'), {
      ...validEnvelope,
      data: { profile: { name: { nested: true }, age: 30, annualExpenses: 1, fiTarget: 1, monthlyIncome: 1 } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state'), {
      ...validEnvelope,
      lastSavedAt: `2026-01-01T${'x'.repeat(29)}Z`,
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state/holdings/fund-5'), {
      kind: 'mf',
      value: { name: 'Example Fund', units: 1, startDate: '2026-02-30', monthlyAmount: 1000 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    await assertFails(setDoc(doc(db, 'users/owner-ranges/portfolio/state/holdings/fund-6'), {
      kind: 'mf',
      value: { name: 'Example Fund', units: 1, startDate: '2023-02-29', monthlyAmount: 1000 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    await assertSucceeds(setDoc(doc(db, 'users/owner-ranges/portfolio/state/holdings/fund-3'), {
      kind: 'mf',
      value: { name: 'Example Fund', units: 1, startDate: '2026-01-15', monthlyAmount: 1000 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    await assertSucceeds(setDoc(doc(db, 'users/owner-ranges/portfolio/state/holdings/fund-leap'), {
      kind: 'mf',
      value: { name: 'Example Fund', units: 1, startDate: '2024-02-29', monthlyAmount: 1000 },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
  });

  it('denies inline dynamic map values and malformed timestamp maps', async () => {
    const db = testEnvironment.authenticatedContext('owner-dynamic').firestore();
    await assertFails(setDoc(doc(db, 'users/owner-dynamic/portfolio/state'), {
      ...validEnvelope,
      data: { mf: { badEntry: 'not-a-holding' } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-dynamic/portfolio/state'), {
      ...validEnvelope,
      entryUpdatedAt: { holdings: 'not-a-map' },
    }));
  });

  it('allows valid entry timestamps from an existing portfolio envelope', async () => {
    const db = testEnvironment.authenticatedContext('owner-entry-timestamps').firestore();
    await assertSucceeds(setDoc(doc(db, 'users/owner-entry-timestamps/portfolio/state'), {
      ...validEnvelope,
      entryUpdatedAt: { holdings: { 'fund-1': '2026-01-01T00:00:00.000Z' } },
    }));
  });

  it('allows valid dynamic entries as individually validated documents', async () => {
    const db = testEnvironment.authenticatedContext('owner-valid-dynamic').firestore();
    const stateRef = doc(db, 'users/owner-valid-dynamic/portfolio/state');
    const holdingRef = doc(db, 'users/owner-valid-dynamic/portfolio/state/holdings/fund-1');
    await assertSucceeds(setDoc(stateRef, { ...validEnvelope, schemaVersion: 'fireOS_v4' }));
    await assertSucceeds(setDoc(holdingRef, {
      kind: 'mf',
      value: {
        name: 'Example Fund',
        schemeCode: '12345',
        units: 10,
        startDate: '2026-01',
        monthlyAmount: 1000,
        costBasis: 9000,
      },
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    await assertFails(setDoc(doc(db, 'users/owner-valid-dynamic/portfolio/state/holdings/fund-2'), {
      kind: 'mf',
      value: 'not-a-holding',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
  });

  it('denies runtime-only fields inside persisted data', async () => {
    const db = testEnvironment.authenticatedContext('owner-5').firestore();
    await assertFails(setDoc(doc(db, 'users/owner-5/portfolio/state'), {
      ...validEnvelope,
      data: { _lastSavedAt: '2026-01-01T00:00:00.000Z' },
    }));
  });

  it('denies oversized metadata and unknown timestamp maps', async () => {
    const db = testEnvironment.authenticatedContext('owner-6').firestore();
    await assertFails(setDoc(doc(db, 'users/owner-6/portfolio/state'), {
      ...validEnvelope,
      client: { userAgent: 'x'.repeat(513) },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-6/portfolio/state'), {
      ...validEnvelope,
      entryUpdatedAt: { unexpected: {} },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-6/portfolio/state'), {
      ...validEnvelope,
      serverMetadata: { unexpected: true },
    }));
  });

  it('validates the optional format envelope at the rules boundary', async () => {
    const db = testEnvironment.authenticatedContext('owner-format').firestore();
    await assertSucceeds(setDoc(doc(db, 'users/owner-format/portfolio/state'), {
      ...validEnvelope,
      format: { normalizedArrays: true, backupVersion: 'fireOS-backup-v1' },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-format/portfolio/state'), {
      ...validEnvelope,
      format: { normalizedArrays: 'yes', backupVersion: 'fireOS-backup-v1' },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-format/portfolio/state'), {
      ...validEnvelope,
      format: { normalizedArrays: true, backupVersion: 'fireOS-backup-v1', extra: true },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-format/portfolio/state'), {
      ...validEnvelope,
      format: { normalizedArrays: true },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-format/portfolio/state'), {
      ...validEnvelope,
      format: { normalizedArrays: true, backupVersion: { nested: true } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-format/portfolio/state'), {
      ...validEnvelope,
      format: { normalizedArrays: true, backupVersion: 'x'.repeat(51) },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-format/portfolio/state'), {
      ...validEnvelope,
      format: 'legacy-format',
    }));
  });

  it('denies oversized persisted arrays', async () => {
    const db = testEnvironment.authenticatedContext('owner-7').firestore();
    await assertFails(setDoc(doc(db, 'users/owner-7/portfolio/state'), {
      ...validEnvelope,
      data: { achievedMilestones: Array.from({ length: 501 }, (_, index) => `milestone-${index}`) },
    }));
  });

  it('allows valid other holdings and denies an oversized collection', async () => {
    const db = testEnvironment.authenticatedContext('owner-other-holdings').firestore();
    await assertSucceeds(setDoc(doc(db, 'users/owner-other-holdings/portfolio/state'), {
      ...validEnvelope,
      data: {
        otherHoldings: {
          gold: { name: 'Gold', amount: 100000, annualReturn: 8 },
        },
      },
    }));

    const oversized = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [
        `holding-${index}`,
        { name: `Holding ${index}`, amount: 1000, annualReturn: 5 },
      ]),
    );
    await assertFails(setDoc(doc(db, 'users/owner-other-holdings/portfolio/state'), {
      ...validEnvelope,
      data: { otherHoldings: oversized },
    }));
  });

  it('allows general goals and liquidation rules and denies the legacy triggers shape', async () => {
    const db = testEnvironment.authenticatedContext('owner-goals').firestore();
    await assertSucceeds(setDoc(doc(db, 'users/owner-goals/portfolio/state'), {
      ...validEnvelope,
      data: {
        goals: [{
          id: 'goal-sample', name: 'Sample Home', kind: 'home', targetToday: 10000000,
          targetDate: '2030-06', inflation: 'cpi', linkedAssetIds: [], currentAmount: 0,
          priority: 1, riskBucket: 'medium',
        }],
        liquidationRules: [{ id: 'marriage', kind: 'marriage', label: 'Marriage Plan', active: false }],
      },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-goals/portfolio/state'), {
      ...validEnvelope,
      data: { esopDetails: { shares: 1, grantPrice: 1, vestingSchedule: [], triggers: { marriage: false } } },
    }));
  });

  it('allows bounded employee-equity grants and rejects an unbounded grants payload', async () => {
    const db = testEnvironment.authenticatedContext('owner-equity').firestore();
    await assertSucceeds(setDoc(doc(db, 'users/owner-equity/portfolio/state'), {
      ...validEnvelope,
      data: {
        esopDetails: {
          shares: 10, grantPrice: 20, vestingSchedule: [],
          grants: [{ id: 'grant-1', kind: 'rsu', symbol: 'ACME', currency: 'INR', grantedQuantity: 10, vestedQuantity: 10, exercisedQuantity: 0, soldQuantity: 0, strikePrice: 0, fairMarketValue: 100, valuationAsOf: '2026-11-27' }],
        },
      },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-equity/portfolio/state'), {
      ...validEnvelope,
      data: { esopDetails: { shares: 10, grantPrice: 20, vestingSchedule: [], grants: Array.from({ length: 101 }, (_, index) => ({ id: `grant-${index}`, kind: 'rsu', symbol: 'ACME', currency: 'INR', grantedQuantity: 1, vestedQuantity: 1, exercisedQuantity: 0, soldQuantity: 0, strikePrice: 0, fairMarketValue: 100, valuationAsOf: '2026-11-27' })) } },
    }));
    await assertFails(setDoc(doc(db, 'users/owner-equity/portfolio/state'), {
      ...validEnvelope,
      data: { esopDetails: { shares: 10, grantPrice: 20, vestingSchedule: [], grants: [{ id: 'bad', kind: 'rsu', symbol: 'ACME', currency: 'INR', grantedQuantity: -1, vestedQuantity: 1, exercisedQuantity: 0, soldQuantity: 0, strikePrice: 0, fairMarketValue: 100 }] } },
    }));
  });

  it('revalidates nested values on update', async () => {
    const db = testEnvironment.authenticatedContext('owner-8').firestore();
    const stateRef = doc(db, 'users/owner-8/portfolio/state');
    await assertSucceeds(setDoc(stateRef, validEnvelope));
    await assertFails(updateDoc(stateRef, {
      data: { insurance: 'not-insurance' },
    }));
  });
});
