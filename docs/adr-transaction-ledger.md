# ADR: Versioned transaction ledger and reconciliation

## Status

Accepted for the FIRE26-04 ledger slice.

## Decision

Use a pure, versioned ledger contract in `src/lib/transaction-ledger.ts`.
Money is represented as integer paise and quantities as integer micro-units;
imports are previewed before application, deduplicated by a deterministic key,
and applied with an explicit merge or replace mode. Every application returns a
rollback snapshot. Cost provenance is `exact`, `estimated`, or `unknown` and is
never inferred from a missing purchase lot.

## Consequences

- Reconciliation is deterministic and independent of UI or persistence.
- Invalid rows fail the complete apply operation; valid rows are not partially
  committed alongside malformed data.
- The initial slice does not mutate the existing portfolio state or connect to
  financial institutions. Persistence adapters can consume this contract in a
  later migration slice.
- CSV parsing is intentionally bounded and simple; quoted-field support belongs
  to the existing PapaParse adapter and must map into this validated contract.

## Verification

`src/lib/transaction-ledger.test.ts` covers paise reconciliation, malformed
rows, duplicate imports, CSV round-trip, replace mode, rollback, and unknown
cost provenance using synthetic data.
