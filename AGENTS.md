# Current Trello Chief/Worker development governance — fire-os (2026-11-26)

> **Current tracking/routing precedence:** Trello is the FIRE OS task-management system of record. GitHub Issues, Projects, pull requests, commits, Actions and versioned repository documents are supporting engineering evidence; they are not a competing active queue. **Product-specific architecture, quality, validation, safety and security constraints remain binding.** Preserve FIRE OS architecture, user privacy, finance math, Vitest/Playwright, Firebase deployment controls and current CI. No agent is launched automatically; the owner invokes sessions independently.

- Use the [FIRE OS Trello board](https://trello.com/b/XWDn8Lm0/fire-os) for task identity, priority, dependencies, claims and workflow status. Keep one canonical card per task, preserve source links and historical evidence, and use `Backlog`, `Ready`, `In Progress`, `Blocked`, `In Review`, `Done` and `Canceled` deliberately.
- Primary route: exactly one `chief` or `worker`; `human` only with `chief`. A card must have a verified Definition of Ready and an uncontested execution claim before implementation. Chief decides requirements and reviews; Worker implements only the scoped handoff.
- GitHub remains authoritative for source code, branches, commits, pull requests, code review, CI/CD and releases. GitHub Project membership, Status, Priority, milestone and native dependencies are **NOT VERIFIED** unless explicitly read back; never infer Trello readiness from them.
- **No automatic AI-agent invocation** from Trello events, GitHub labels/issues/Actions, webhooks or legacy orchestration rules. The human chooses and manually/schedules Chief and Worker runs in the desired tool. This policy does not disable the product's own runtime automation.
- Complete current protocol: `docs/GITHUB_AGENT_GOVERNANCE.md` (its GitHub evidence and review rules remain binding where compatible); all legacy conflicting task-routing instructions below are historical. Preserve source/testing/documentation constraints in the remainder.
- Default branch: `main`. This cutover does not change branch protections, secrets, Project fields or existing CI; its implementation changes are limited to the FIRE26-00 browser quality-gate repair and its supporting documentation.

---

## Preserved fire-os product-specific agent instructions

# FIRE OS agent instructions

## Before implementation

- Read `docs/master.md` to understand the current architecture, behavior, and relevant workflows.
- Identify the scope, then read the corresponding reference(s):
  - `docs/ui.md` for UI/features/calculations
  - `docs/backend.md` for persistence/APIs/deploy
  - `docs/ai.md` for Assistant behavior
  - `docs/README.md` for setup or operational questions
  Read more than one when the change crosses areas.
- Check the current source and tests; documentation is a map, not a substitute
  for verifying current behavior.
- Before editing, make a concise implementation plan: intended change, affected
  areas/files, and relevant validation. For small changes this can be a short
  checklist; for larger work, outline the steps before proceeding.

## Implementation and validation

- Follow existing TypeScript, Vite, ESLint, Prettier, Vitest, and Playwright conventions.
  Prefer focused changes that reuse existing helpers and module boundaries.
- Keep public types/APIs explicit, validate data at trust boundaries, and handle
  failure paths deliberately. Keep UI accessible and consistent with existing styles.
- Avoid unrelated refactors, speculative abstractions, new dependencies, and
  broad formatting churn.
- **For shared or user-facing changes:** run `npm run lint && npm run format:check && npm run build` before completing any change.
- **For test changes:** `npm test` to verify unit test impact. For Playwright specs: `npm run test:e2e` to validate selector contracts.
- **Report checks that could not be run and why; do not claim unverified results.**

## PR / MR workflow

- Make small, focused commits with descriptive Conventional Commit messages (`feat:`, `fix:`, `refactor:`).
- **Before opening a PR:** ensure `npm run lint && npm run format:check && npm run build` pass and `npm test` passes.
- **For Playwright/e2e changes:** run `npm run test:e2e` on your branch before requesting review; any selector changes must preserve existing `id` and `data-testid` attributes listed in the design spec (§8 of `docs/master.md`).
- **For Cloudflare Worker changes:** update `worker/wrangler.toml` + secrets; run `npm run test:worker` to validate worker unit tests.
- Push to a topic branch (e.g., `ao/fire-os-2/assistant-cors-allowlist`); the orchestrator will open the PR or you may use the GitHub CLI if available.
- Review invocation is owner-controlled. Do not trigger AO or any other reviewer from PR state automatically; when the owner explicitly invokes an AO review, inspect its verdict with the owner-provided session identifier. Otherwise record the independent-review gate as pending.

## Documentation after implementation

- After implementing and validating a change, update `docs/master.md` whenever behavior, architecture, data contracts, workflows, configuration, or validation/deployment paths have changed. Keep it aligned with the code and remove or correct obsolete information encountered in the affected scope.
- Update the relevant detailed reference(s) (`docs/ui.md`, `docs/backend.md`, `docs/ai.md`) with new behavior and remove superseded details. Update `docs/README.md` for setup, operations, or navigation changes and `docs/CHANGELOG.md` when the change belongs in release history.
- Keep documentation focused: edit existing references instead of duplicating the same facts in new documents. If no documentation update is warranted, state why in the final response.

## Historical AO onboarding (superseded)

The former `ao session ls` / `ao spawn` onboarding is retained only as historical context. Do not invoke it automatically. Use the Trello card claim and handoff protocol above, and preserve the user's publishing scope (local-only, review-only, do-not-publish).

## Working constraints

- Preserve unrelated user changes; modify only files needed for the task.
- In the final response, summarize the implementation, documentation updated, and validation performed.

## DECISION ESCALATION POLICY - MANDATORY

Ask the maintainer only for major and critical decisions. These include:

- Anything that changes architecture, data contracts or persisted state
- Anything that removes or replaces a public capability
- Anything touching security, privacy, authentication or secret handling
- Anything destructive or irreversible
- Anything that spends money or changes external accounts
- Anything that contradicts an explicit earlier maintainer instruction
- Anything genuinely ambiguous where the wrong choice would be expensive to undo

For everything else - small implementation choices, naming, file layout, formatting, which of two reasonable approaches to take, test ordering, minor refactors, routine dependency and tooling questions - decide yourself, pick the best option, apply it, and state briefly in your final response what you chose and why.

- Do not ask the maintainer to make small decisions
- Do not ask for confirmation of something you can verify yourself
- If a small decision turns out to be load-bearing later, say so and change it; that is expected and needs no permission
- When you are blocked on a small decision, choose, document it in the code or docs, and move on - do not stop and wait

Put this section near the other workflow policy sections in AGENTS.md. Do not duplicate the existing PR/MR workflow or documentation sections.

### Quick script reference (keep in chat)

| Goal | Command |
|------|---------|
| Fast local gate (no emulator/browser) | `npm run check` |
| Lint + format + build + unit tests | `npm run lint && npm run format:check && npm run build && npm test` |
| Run Playwright e2e | `npm run test:e2e` |
| Run worker tests | `npm run test:worker` |
| TypeScript check only | `npm run build` (tsc --noEmit) |
