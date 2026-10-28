# AI Website QA

AI Website QA is a dependency-light TypeScript and Playwright scanner for a quick, structured first pass over a web page. It discovers common UI elements, suggests Playwright locators, surfaces likely accessibility and QA risks, validates links, and produces JSON, HTML, and screenshot artifacts.

## Quick start

```powershell
npm install
npx playwright install chromium
npm run qa -- https://example.com
```

That creates a deterministic JSON/HTML analysis in `reports/`. Add `--execute` to safely reproduce eligible findings, `--crawl` for same-origin flow discovery, and `--ci --baseline <path>` to enforce a regression gate. Targets on localhost or private IP ranges require an explicit `--allow-private-network` flag so an internal scan is always intentional.

It is designed to inform test planning; a `WARNING` is a heuristic to investigate, not a definitive defect.

**AI Website QA accepts arbitrary website URLs. NoorPlay is used only as a validation target.** No URL, page name, element id, selector, flow, or expected result is hard-coded; everything — pages, elements, navigation, forms, inputs, buttons, links, accessibility information, media, search, authentication indicators, language controls, likely user flows, and findings — is discovered dynamically from the scanned facts. A website requiring no authentication works with no credentials; HTTP Basic Auth uses the existing environment variables.

## Prerequisites

- Node.js 20 or later
- A network connection to the page being scanned

## Install

```powershell
npm install
npx playwright install chromium
```

## Scan a page

```powershell
npm run scan -- https://example.com
```

Useful options:

```powershell
npm run scan -- https://example.com --headed
npm run scan -- https://example.com --timeout 45000
npm run scan -- https://example.com --output reports/example.json
npm run scan -- https://example.com --concurrency 8
npm run scan -- --help
```

| Option | Description |
| --- | --- |
| `--headed` | Opens Chromium visibly. |
| `--timeout <ms>` | Page navigation timeout; default is `30000`. |
| `--output <path>` | JSON report location; default is `reports/qa-report.json`. The HTML report uses the same basename. |
| `--concurrency <n>` | Maximum concurrent link checks; default is `5`. |
| `--perf-budgets <path>` | JSON performance budgets (e.g. `{"lcp": 2500}`) written into the report as `perf-budget-*` findings. The same file can gate a QA run — see Phase 13. |

## Authentication

The scanner does not store credentials. For HTTP Basic Authentication, set `QA_BASIC_AUTH_USER` and `QA_BASIC_AUTH_PASSWORD` together in your shell. The legacy `QA_USERNAME` and `QA_PASSWORD` names remain supported. A partial pair is rejected before the browser starts. To send an authorization header, set `QA_AUTHORIZATION`. See [.env.example](.env.example) for safe placeholders; `.env` is ignored by Git and loaded locally when present.

```powershell
$env:QA_BASIC_AUTH_USER = "qa-user"
$env:QA_BASIC_AUTH_PASSWORD = "use-a-secret-manager"
npm run scan -- https://staging.example.com
```

Before DOM analysis, the scanner classifies access as `accessible`, `authentication-required`, `login-required`, `access-blocked`, `bot-protection`, or `unknown`. Authentication, login, and blocking responses become human-review access prerequisites and do not produce misleading findings from an error page. A public `2xx` response continues through normal scanning. When an access prerequisite stops the scan, normal QA never runs: a local run displays `REVIEW`/`BLOCKED` and exits `0`, while `--ci` exits `1` because the website was not tested (see the exit-code contract below).

## What it checks

- Buttons, links, inputs, textareas, selects, images, forms, navigation, dialogs, and media
- Visible/enabled state, basic metadata, dimensions, accessible names, and recommended locator quality
- `getByRole`, label, placeholder, text, and CSS fallback locators
- Missing title, language, viewport, alt text, labels, accessible names, hrefs, and duplicate IDs
- Disabled/hidden interactive controls and fragile locator candidates
- Browser console errors, uncaught page errors, HTTP link responses, and screenshots

The scanner intentionally avoids entering values, clicking controls, submitting forms, or saving secrets in its reports.

## Artifacts

Each scan writes:

- `reports/qa-report.json` — machine-readable data for QA workflows
- `reports/qa-report.html` — readable summary with findings and locators
- `reports/screenshots/scan-*.png` — full-page screenshot, when capture succeeds

The JSON report has `scan`, `summary`, `page`, `elements`, `issues`, `links`, `consoleErrors`, and `pageErrors` sections. Element values are metadata from the DOM; no typed input values are collected.

## Generate and run a Playwright suite

```powershell
npm run generate -- reports/qa-report.json
npm run test:generated
npm run report -- reports/qa-report.json
```

- `generate` turns a scan report into `reports/generated-tests.json` and `generated/generated-tests.spec.ts`. Scenarios are classified safe/automated (visibility, enabled state, link integrity), review (interactions that need a human decision), or high-risk (destructive actions such as submitting forms or deleting data), and conditional (controls that only exist in some states).
- `test:generated` runs the automated subset; review and high-risk scenarios are emitted as `test.fixme` and do not execute.
- `report` rewrites `reports/generated-tests.json` and `reports/generated-tests.html`.

## QA analysis

```powershell
npm run qa -- https://example.com
npm run qa -- --report reports/qa-report.json --execute
```

`qa` turns a scan report into a `QaAnalysis`: severity-rated findings with evidence, user-flow detection, intent- and priority-labeled scenarios, a release gate (`FAIL` if any critical finding, `REVIEW` if any high-severity, else `PASS`), finding lifecycle + verification sections, and a 15-section HTML report. It writes `reports/qa-analysis.json` and `reports/qa-analysis.html`. `--execute` runs the verification executor against the live page and attaches the outcomes to `analysis.verifications` and `analysis.execution`.

The analysis is fully deterministic with no API key. When `AI_API_KEY`/`AI_API_URL`/`AI_MODEL` are configured (see `.env.example`), an OpenAI-compatible provider offers bounded enhancements (recommendation wording, confidence, priority, severity at most one level from the rule-based value) — it can never add or remove findings, flows, or scenarios, and never invents evidence.

| Option | Description |
| --- | --- |
| `--crawl` | Crawl same-origin pages to build a multi-page site graph before flow discovery. |
| `--max-pages <n>` | Maximum pages discovered during a crawl; default is `8`. |
| `--max-depth <n>` | Maximum link depth from the start page; default is `3`. |
| `--max-flows <n>` | Maximum discovered user flows reported; default is `20`. |
| `--max-flow-steps <n>` | Maximum steps kept per flow; default is `6`. |
| `--perf-budgets <path>` | JSON file of performance budgets enforced during this run (Phase 13). |

## Verification (EXECUTOR)

```powershell
npm run qa -- --report reports/qa-report.json --execute      # discovery + verification
```

Every finding moves through a lifecycle: `DISCOVERED → ANALYZED → TEST_GENERATED → TEST_EXECUTED → REPRODUCED / NOT_REPRODUCED / PASS / REVIEW`, and every finding carries an **explicit disposition** at all times. Each scheduled finding gets a `SC-VER-*` task that re-checks the suspected problem on the live page with a safe Playwright strategy (accessible name, image alt, duplicate id, document title, language, viewport, empty link, input type, visibility).

Verification semantics:

- `REPRODUCED` with `REPRODUCED / WEBSITE` — the live DOM matches the scanner signal (strongest evidence).
- `NOT_REPRODUCED / LOCATOR` — the exact flagged element is absent (it may be conditional, renamed, or fixed).
- `NOT_REPRODUCED / EXPECTATION` or `PASS` — the element exists but is clean (likely a scanner false positive).
- `NOT_REPRODUCED / CONDITIONAL` — only a hidden/state-dependent instance is present (e.g. `hidden-interactive-element`, which is never claimed as a rendered-page defect).
- `REVIEW / INFRASTRUCTURE` or `AUTHENTICATION` — the check itself failed; never counted as a site defect.

Every finding — executed or not — has an explicit disposition:

- `REPRODUCED`, `PASS`, `NOT_REPRODUCED`, `REVIEW_REQUIRED`, `INFRASTRUCTURE_PROBLEM`
- `SCHEDULED` — a task exists but has not run yet
- `SKIPPED_UNSUPPORTED` — no safe strategy exists for the finding code (human review signal only)
- `SKIPPED_LOCATOR_GUARD` — the locator is ambiguous (`?` placeholder), unsafe, or too fragile to automate; the finding stays visible with the reason, it is never silently dropped

The locator guard is the safety line: only locators produced by the safe locator builder are executed. A scanner locator that is weak can still be verified when a **unique attribute-based reference** (a single `href` or stable `id`) can be derived from the scanned evidence — `page.locator("a[href=\"...\"]")` — and ambiguous references are never guessed.

The executor only performs non-interactive checks: it never clicks, types, submits, or navigates beyond the page load, and it never captures input values, cookies, or tokens. `REPRODUCED`/`REVIEW` outcomes optionally store a screenshot file path. A finding is never silently deleted — unverified findings stay visible with an `unverified` count.

Triage verdicts (`LIKELY_DEFECT`, `NOT_REPRODUCED`, `CONDITIONAL`, `INFRASTRUCTURE_PROBLEM`, `REVIEW_REQUIRED`) and dispositions are deterministic by default. When `AI_API_KEY` is configured, the provider may refine the *reason* and *confidence* of those verdicts — it can never add or remove results, change a status or disposition, or alter evidence, and any malformed output silently falls back to the deterministic value.

Run `npm run build` before `--execute` (the generated `generated/qa-verification.spec.ts` imports the compiled executor via `dist/`). Verification writes two artifacts: `reports/qa-analysis.json`/`.html` (analysis, embedded verification, and a per-finding **Verification Disposition** table with why/safety/locator/timestamp for every finding) and `reports/qa-execution.json` (execution summary, skipped tasks with causes, verdicts, and redacted evidence).

## Phase 3 — Autonomous user-flow discovery

Phase 3 extends the QA pipeline with deterministic user-flow discovery and safe automated execution — no hardcoded pages, flows, selectors, or site names.

```powershell
npm run qa -- https://example.com --crawl --execute
npm run qa -- https://example.com --crawl --max-pages 12 --max-flows 30 --execute
```

### How it works

1. **Site graph construction.** Each scanned page becomes a graph node (pages, controls, edges). `--crawl` follows same-origin non-broken links up to `--max-pages` and `--max-depth` to build a multi-page graph.
2. **Flow discovery.** Controls and edges are grouped into 10 categories: `NAVIGATION`, `SEARCH`, `CONTENT_DISCOVERY`, `LANGUAGE_SWITCH`, `AUTHENTICATION`, `SIGNUP`, `FORM_INTERACTION`, `MEDIA`, `PROFILE`, `ERROR_HANDLING`. Candidates are deduplicated by destination and collapsed with occurrence counts.
3. **Deterministic step classification.** Every step is classified into one of four safety levels using a fixed rule order — the first matching rule wins:

| Safety | Automation | What runs |
| --- | --- | --- |
| `SAFE` | `AUTOMATED` | Click same-origin links, type a synthetic search term (`"quality"`), toggle language controls, observe page content |
| `REVIEW` | `MANUAL` | Follow external links, interact with auth/signup/profile/media controls, submit non-search forms |
| `HIGH_RISK` | `MANUAL` | Password fields, destructive links/text (`/delete`, `unsubscribe`, `checkout`) |
| `BLOCKED` | `MANUAL` | Auth-form submission — never automated under any circumstance |

4. **Safe executor.** `--execute` runs the contiguous `SAFE + AUTOMATED` prefix of each flow. The executor stops at the first non-executable boundary and records the stop explicitly (a `BLOCKED` outcome with a `SAFETY_BLOCK` category). Post-boundary steps are never reached, never filled, never submitted.

### Safety boundaries

| Guard | Behaviour |
| --- | --- |
| **Auth boundary** | Login is observed (open page, identify the form) and STOPPED before any credential entry or submission. The authentication flow is always `BLOCKED`. |
| **Destructive boundary** | Links/buttons matching destructive patterns (`/delete`, `unsubscribe`, `checkout`, etc.) are classified `HIGH_RISK` and never executed. |
| **Locator guard** | Only locators emitted by the safe locator builder are executable. Ambiguous locators (`?` placeholders, multi-match results) halt execution with `REVIEW_REQUIRED`. |
| **Execution budget** | A per-flow time limit (`--max-execution-ms`, default 120s) prevents runaway execution. |

### Flow execution results

Each executed flow produces a `FlowExecutionResult` with per-step outcomes:

- `PASS` — the step completed cleanly.
- `REPRODUCED` — the step failed in a way that matches the suspected problem (e.g. broken link returns HTTP 404).
- `NOT_REPRODUCED` — the expected element or content was absent.
- `REVIEW_REQUIRED` — ambiguous locator, auth gate, or unclear result.
- `INFRASTRUCTURE_PROBLEM` — network/timeout/browser failure, not a site defect.
- `BLOCKED` — safety boundary reached; step was never attempted.

Flow-level status follows: `INFRASTRUCTURE_PROBLEM > REPRODUCED > REVIEW_REQUIRED > NOT_REPRODUCED > BLOCKED (if all executable steps passed but a boundary exists) > PASS`.

### HTML report

The Phase 3 HTML report includes:

- **Flow Discovery** section with the site graph table (pages, edges, broken link counts) and per-flow cards showing steps, safety badges, automation badges, boundary markers, and execution outcomes.
- **User Flows** section (existing Phase 2 flow detection).
- Summary cards for "Flow discovery" (count) and "Flows executed" (count).
- A `.badge-blocked` CSS class for blocked-step indicators.

## Phase 4 — Intelligent test planning & coverage

Phase 4 turns scan + flow + verification evidence into an explicit coverage map and an ordered test plan. The engine is **deterministic and evidence-based**: scanning an element is a fact, never a test — `TESTED` is only ever claimed when a flow step, a verification probe, or a live scanner read ran.

```powershell
npm run qa -- https://example.com --crawl --max-pages 12 --execute
```

### Coverage statuses

| Status | Meaning |
| --- | --- |
| `TESTED` | Execution evidence exists (flow step passed, probe reproduced/cleared it, link-integrity run resolved). |
| `PARTIALLY_TESTED` | Some but not all of the item's evidence ran (e.g. 1 of 3 navigation edges executed, or an execution ended `NOT_REPRODUCED`/`INFRASTRUCTURE_PROBLEM`). |
| `NOT_TESTED` | Scanned/discovered but nothing executed yet. |
| `REVIEW_REQUIRED` | A human must decide before this can progress (ambiguous locator, label findings, unreachable destination). |
| `BLOCKED` | Safe boundary (auth/payment/destructive) — coverage is deliberately not attempted. |
| `NOT_APPLICABLE` | The site has no search box, no language control, no media, etc. |

### What is covered

- **Pages** — status per graph page from the flows that touch it.
- **Navigation / Content discovery** — one item per unique same-origin destination edge; an edge is never counted twice.
- **Flows** — per discovered flow, plus an `AUTHENTICATION_BOUNDARY` item that is always `BLOCKED`.
- **Interactions** — grouped controls (links, buttons, inputs, checkboxes, radios, selects, media, language, navigation controls). Checkbox/radio/select toggles are never automated.
- **Forms** — per form; password/destructive forms are `BLOCKED`, label-finding forms are `REVIEW_REQUIRED`, search-only forms become `TESTED` when the search flow runs; everything else is `NOT_TESTED` (never auto-submitted).
- **Search** — control, results, and empty/no-result state per search page.
- **Language / Media** — executed only on live evidence; media playback is review-only.
- **Error handling** — link-integrity, each broken destination, uncaught/console errors, start-page navigation.
- **Accessibility checks** — one item per accessibility-domain finding, verified or not.
- **Responsive check** — always `NOT_TESTED` on a desktop-only scan; the viewport meta is meta-data, not evidence.

### The test plan

Every recommendation (`REC-001`…) traces to at least one coverage item, uses the existing P0–P4 priority model, and is never generated for `TESTED`/`NOT_APPLICABLE` items. Orphan recommendations are dropped, plans are capped at 40, and blockers (auth/payment/broken navigation) rise to P1 automatically.

### AI bounds

When an AI provider is configured, it may only **reword gap headlines** and **reprioritize existing recommendation ids** (P0–P4). It can never create coverage items, flip statuses, skip `BLOCKED`, or invent evidence. Without a provider key, `npm run qa` still produces full coverage — deterministic.

### HTML report

A **Coverage Overview** section (summary cards, test-plan cards, per-category tables, AI notes) is added after Flow Discovery, and the Executive Summary gains "Coverage actions" and "Pages tested" cards. Coverage is also rebuilt after `--execute` runs, so the report reflects what actually executed.

## Phase 5 — Regression intelligence over two runs

Phase 5 compares a current `QaAnalysis` against a stored baseline and explains every change with a deterministic, evidence-based classification. It never calls a regression merely because two DOM snapshots differ: a regression is only claimed when a **previously verified or expected condition changed negatively**.

```powershell
npm run qa -- https://example.com --crawl --execute --output reports/baseline.json      # run 1 (baseline)
npm run qa -- https://example.com --crawl --execute --baseline reports/baseline.json    # run 2 (compare)
```

When `--baseline <path>` is present, the CLI compares the run, writes `analysis.regression`, and adds a **Regression Summary** section to the HTML report. Without it, `Regression comparison: not available — no baseline supplied.`

### Semantic identity, never regenerated ids

Finding, flow, coverage, scenario, and page ids are run-local and never compared directly. Entities match on **meaning**: a finding by code + normalized page + semantic element target + occurrence; a flow by category + normalized start page + meaningful step targets; a coverage item by category + location + name. A regenerated id, element id/`data-testid`, or locator change alone is never a change.

### Comparable layers

Two runs are comparable only when they share origin, schema, `--execute` layer, and coverage layer (same config digest). Comparing a scan-only run to an executed run is refused with an explanatory message.

### Classifications

`NEW` / `FIXED` / `REGRESSION` / `UNCHANGED` / `CHANGED`, flow-level `NEW_FLOW` / `REMOVED_FLOW` / `CHANGED_FLOW` / `UNCHANGED_FLOW`, coverage-level `COVERAGE_CHANGED`, plus `REVIEW_REQUIRED` and `INFRASTRUCTURE_PROBLEM`.

Rules of evidence:

- `PASS → REPRODUCED` on the same verified finding is `REGRESSION` with `HIGH_CONFIDENCE`.
- Infrastructure failures are **never regressions** — they are `INFRASTRUCTURE_PROBLEM` (flow) or `REVIEW_REQUIRED` (finding).
- Missing evidence alone is never a fix: an unverified finding that disappears is `REVIEW_REQUIRED`, only a previously reproduced defect that is gone becomes `FIXED`.
- A verified occurrence that vanishes while an identical-twin occurrence survives is `FIXED`; a same-family element that appears with different text/locator is ambiguous identity and is `REVIEW_REQUIRED`.
- Coverage lost (`TESTED → NOT_TESTED`) is `COVERAGE_CHANGED`; coverage gained is `CHANGED`, never a regression.
- Confidence is an explicit reason (`HIGH`/`MEDIUM`/`LOW_CONFIDENCE`/`INSUFFICIENT_EVIDENCE`), never a pseudo-percentage.

### AI bounds

With a provider configured, `analyzeRegression` may only reword the headline and attach notes to **existing** change ids; unknown ids are dropped and classifications, confidence, and evidence are never altered. Without a key the comparison is fully deterministic.

## Phase 6 — QA intelligence & root-cause analysis

Phase 6 turns the existing deterministic artifacts (scan, findings, verifications, flows, executions, coverage, regression) into **evidence relationships → related evidence groups → root-cause candidates → investigation queue**. It is fully deterministic and works with **no API key**. Every candidate is a *hypothesis* derived from evidence, never a confirmed cause, and the engine never invents a cause, a probability, or a score.

```text
findings + executions + flows + coverage + regression
  -> facts (semantic element keys, verification + execution outcomes)
  -> evidence relationships (SUPPORTS / CONTRADICTS / RELATED, each with an explicit reason)
  -> clusters keyed on SAME SEMANTIC TARGET + normalized page
  -> root-cause candidates (patterns A–E) with confidence + status
  -> safe, read-only investigation actions -> investigation queue -> summary
```

The HTML report gains a **QA Intelligence** section (overview counts, candidate cards with supporting *and* contradicting evidence, evidence relationships, investigation queue, and an explicit **Uncertainty** block). The JSON report gains an additive `intelligence` field; the schema stays version 1.

### Candidate patterns

- `VERIFIED_REGENERATION` — an accessibility/interaction finding and a flow stall on the same semantic target.
- `SHARED_SEMANTIC_TARGET` — two or more flows stall at the same target.
- `VERIFIED_REGRESSION` — a previously verified condition regressed: HIGH_CONFIDENCE regression + reproduced finding + flow stall on the same target.
- `INFRASTRUCTURE` — runner/network failures; **informational**, never a website defect.
- `SINGLE_OBSERVATION` — one weak signal; `INSUFFICIENT_EVIDENCE`, never actionable.

### Statuses and confidence

`ACTIONABLE` / `INVESTIGATION_REQUIRED` / `INSUFFICIENT_EVIDENCE` / `INFORMATIONAL`. Confidence is an explicit reason (`HIGH`/`MEDIUM`/`LOW`/`INSUFFICIENT`), never a percentage. `HIGH` requires independent signals to agree; any contradicting evidence downgrades confidence and forces `INVESTIGATION_REQUIRED` (or `INSUFFICIENT_EVIDENCE`). Contradictions — a clean verification, a *passing* flow through the same target, an auth boundary explaining a stall, or a target present in the snapshot but missing at runtime — are always shown, never hidden.

### Grouping is semantic only

Findings/executions join a group only on the same normalized **element identity + page** (reusing the Phase 5 identity rules). Severity, finding code, category, raw URL text, a shared word, or a regenerated DOM id/`data-testid`/locator never group anything. `REMOVED_FLOW` / `COVERAGE_CHANGED` without verification evidence become `DISCOVERY_VARIANCE` (`INSUFFICIENT_EVIDENCE`) — crawl instability, never a regression.

### Safe investigation only

Every suggested action is read-only and carries `safe: true`: inspect the live element, compare baseline attributes, re-run a SAFE navigation flow, verify the target in a second flow, re-check outside an auth boundary, or re-crawl for variance. There is no action kind that mutates state. The queue ranks candidates P1–P3 from explainable factors only (`priorityReason`), and `INSUFFICIENT_EVIDENCE`/`INFORMATIONAL` candidates are never queued.

### AI bounds

With a provider configured, `analyzeIntelligence` may only reword the title/description of **existing** candidate ids; unknown ids are dropped and evidence, confidence, statuses, investigation actions, and coverage status are never altered.

## Phase 7A — QA run history & persistence

Phase 7A adds the platform's **memory layer**: every complete QA run is persisted with a stable, deterministic **semantic identity** for the site, every finding, every flow, and every coverage item, so the *same thing* can be recognized again across runs. It writes and reads the run store only — it does **not** interpret history (no recurrence, intermittency, trends, stability scoring, or investigation over history; those are Phase 7B).

```powershell
npm run qa -- https://example.com --crawl --execute      # run 1 → persisted
npm run qa -- https://example.com --crawl --execute      # run 2 → persisted
npm run qa -- https://example.com --history-dir reports/history --reset-history   # wipe this site+dir's history, resume
```

Every run writes:

- `reports/history/index.json` — per-site bucket of run metadata (run id, site identity, timestamps, counts, headline, `identityDigest`). Never full reports.
- `reports/history/runs/<run-id>.json` — the full, redacted run artifact (the source of truth): run metadata plus semantic identities, verification outcomes, compact coverage/regression/intelligence sections.

### Identity contract (one vocabulary)

History **never** invents a second identity system. It reuses the Phase 5/6 identity primitives (`regression/identity.ts` + `intelligence/identity.ts`): findings by `code + normalized page + semantic element target`, flows by `category + normalized start page + meaningful step targets` (flow family without the step sequence), coverage by `category + location + name`. Regenerated ids (`QA-F-*`, `FLOW-*`, `COV-*`), element ids/`data-testid`, locators, and element indices are stored only as run-local references — never as identity.

- **Site identity** is `origin | normalized start page | config digest` — two runs of the same site under the same configuration land in the same bucket; a different site or config (e.g. `--execute` vs not, crawled vs not) is a different bucket and history never mixes them.
- **Run ids** (`2026-09-18T09-30-12-123Z-8f3a1c02`) are unique, filename-safe, timestamp-ordered, and never content-derived. Only semantic identities must be deterministic.
- **`identityDigest`** is a sha1 over every semantic identity in a run — identical runs produce identical digests, so "same run, different content" is cheap to detect later.

### Safety & corruption resilience

- **Secrets never persist.** Credentials/tokens are redacted from every stored string using the executor's `buildRedactor`/`redactObject` before the artifact is written.
- **Bounded, deterministic.** Titles/descriptions are clipped; no raw crawl ordering, full DOM, or input values are stored.
- **Never trusted blindly, never silently reset.** Missing index with surviving artifacts → `UNAVAILABLE`; malformed index → `UNAVAILABLE`; a newer schema version → `INCOMPATIBLE` (persistence refuses, so valid/incompatible history is never overwritten). Per-run artifacts that are missing, malformed, mismatched, or belong to a different site are excluded with warnings — all-invalid history degrades to `UNAVAILABLE`, partial corruption is reported and the rest still loads.
- **Atomic + serialized.** Writes use temp-file + rename (Windows-safe), serialized with an advisory `.lock` file (stale lock recovery) so concurrent QA runs cannot corrupt the index.
- **Additive reports.** The JSON gains an optional `history` pointer (status, site identity, current run id, run count); the HTML gains a lightweight **QA History** section. Schema version stays 1.

`--reset-history` deletes **only** the selected history directory (index + run artifacts), then resumes the run; it requires a start URL. `--history-dir` defaults to `reports/history`.

## Phase 7B — Historical intelligence & trends

Phase 7B interprets the persisted Phase 7A history for **one site** and answers "what patterns are emerging across QA runs" — deterministically, explainably, and confidence-aware. It consumes the history store read-only, uses **no second identity system** (all keys are the Phase 7A/5/6 semantic keys), and never invents claims from a single run.

```powershell
npm run qa -- https://example.com --execute      # run 3 — the QA report now adds the Historical Intelligence section
```

What the section reports:

- **Finding lifecycles** — per semantic finding, an observation timeline per ordered run plus a documented classification: `NEW`, `PERSISTING`, `UNCHANGED`, `CHANGED`, `DISAPPEARED`, `REAPPEARED`, `RECURRING`, `INTERMITTENT`, `REVIEW_REQUIRED`, `INSUFFICIENT_EVIDENCE`. Absence is **never** a fix: `DISAPPEARED` is claimed only when the area was meaningfully re-tested; an absent-but-unobserved finding stays `REVIEW_REQUIRED` (or `DISAPPEARED` with an unresolved note when it was reproduced earlier). Contradictions (reproduced then observed-clear) are preserved verbatim and downgrade confidence.
- **Flow stability** — `STABLE` / `VARIABLE` / `UNSTABLE` / `INSUFFICIENT_EVIDENCE` from carried execution outcomes (3+ ordered runs), never from infrastructure signals.
- **Coverage trends** — `NEWLY_TESTED`, `PERSISTENTLY_UNTESTED`, `COVERAGE_GAIN`, `COVERAGE_LOSS`, `COVERAGE_CHANGED`, `COVERAGE_STABLE`, `INSUFFICIENT_EVIDENCE`. Absent crawl observations are discovery variance, never a loss claim.
- **Recurring infrastructure** — aggregated per run (summary + verification + coverage infra signals) and reported only when the same signal appears in ≥ 2 runs; never becomes a product regression.
- **Investigation queue** — evidence-backed `HIQ-###` entries (`REAPPEARED_HIGH_SEVERITY`, `PERSISTENT_HIGH_SEVERITY`, `INTERMITTENT_HIGH_SEVERITY`, `RECURRING_FLOW_FAILURE`, `RECURRING_INFRASTRUCTURE`, `PERSISTENT_COVERAGE_GAP`) ranked into `P1`/`P2`/`P3` with a plain-language `priorityReason`. Speculation is never queued. There is **no overall quality/health score**.
- **Relationships** — typed, confidence-aware `REL-###` edges (persists / disappears / reappears / recurs / contradicted / supported / coverage gap / flow variance / infrastructure repeat), derived only from classifications.
- **Limitations** — always listed (e.g. ordering-unusable runs are counted but never used for pattern claims).

Guarantees:

- **Ordering** is by persisted `completedAt` (valid ISO), tie-broken by `runId`; runs without usable ordering are excluded from pattern claims, counted, and reported.
- **Bounded loading** — at most the 50 most recent ordered runs are read (`maxRuns` option); a single run is valid but yields `INSUFFICIENT_HISTORY` and `INSUFFICIENT_EVIDENCE` claims.
- **Confidence** is explainable `HIGH` / `MEDIUM` / `LOW` / `INSUFFICIENT`, chosen from ordered/observed count, contradictions, direct reproduction, and coverage — never a percentage.
- **AI is optional and bounded** — an available AI provider may only reword the digest headline (`analyzeHistoricalIntelligence`); classifications, run ids, confidence, and queue are never altered. Deterministic mode produces the full map offline.
- **Report is additive** — the JSON gains an optional `historicalIntelligence` section; the HTML gains a **Historical Intelligence** section after QA History. Schema version stays 1.

## Phase 8 — QA operations & productization

Phase 8 turns the engine into something a real user operates: one CLI surface, a local dashboard, a configurable CI exit policy (8C), and an optional `qa.config.json` (8E). The core stays a website-agnostic engine — the UI, CLI, and CI policy only *render* or *interpret* its artifacts.

### 8A — One command, one result

`npm run qa -- <url> --crawl --execute` is the single entry point (already the pipeline through Historical Intelligence). It now opens with a **QA RUN** banner and ends with a **QA RESULT** block:

```text
QA RESULT
─────────────────────
From:   https://example.com
Status: REVIEW
Run:    2026-09-21T09-30-12-123Z-8f3a1c02

Pages: 3 · Findings: 8 (310 occurrence(s)) · Verified: 5 · Reproduced: 3

Coverage: PARTIALLY_TESTED · Regression: not run (add --baseline) · Historical: AVAILABLE (3 run(s))

Investigation queue — P1: 2 · P2: 8 · P3: 29

Reports:
  ✓ JSON:    reports/qa-analysis.json
  ✓ HTML:    reports/qa-analysis.html
  ✓ History: reports/history (3 run(s))
```

Every number in the block is derived deterministically from the analysis (`src/qa/result.ts`) — no score, no invented status.

### 8B — Local QA dashboard

```powershell
npm run qa serve            # alias: npm run dash
```

Starts a zero-dependency, loopback-only server (`http://127.0.0.1:4173`) that displays the latest run: status, findings, verification, coverage, regression, history, the investigation queue, and across-run trends. The UI is a static single-file page (`src/dashboard/index.html`) that only consumes read-only API endpoints; all QA logic remains in the engine.

- `GET /` — the dashboard page
- `GET /api/state` — latest report + history index (single payload for the page)
- `GET /api/report` / `GET /report.html` — the generated JSON / HTML report
- `GET /api/history` — the history index
- `GET /api/runs/<run-id>` — one persisted run artifact
- `GET /health` — liveness

Options: `--dir <dir>` (report directory, default `reports`), `--history-dir <path>`, `--port <n>` (default 4173), `--host <host>` (default `127.0.0.1`). Run ids are validated before reads; only configured report/history directories are ever served.

### 8C — CI exit policy

`--ci` maps the **same** unified QA result to a process exit code so the one pipeline can gate a CI/CD system (GitHub Actions, GitLab CI, Jenkins, …). It never changes the analysis — it only turns the final QA status into an exit code.

Normal run (unchanged by 8C):

```powershell
npm run qa -- https://example.com --crawl --execute
```

CI run (default policy):

```powershell
npm run qa -- https://example.com --crawl --execute --ci
```

Explicit policies:

```powershell
npm run qa -- https://example.com --crawl --execute --ci --fail-on review
npm run qa -- https://example.com --crawl --execute --ci --fail-on failed
```

Exit codes:

```text
0 = acceptable result and the site was actually testable
1 = QA result violates the configured CI policy, OR the access prerequisite
    prevented normal QA (REVIEW_REQUIRED / BLOCKED) — the website was not tested
2 = infrastructure/runtime/tooling failure
```

The policy is driven by the existing status model (`PASS` < `REVIEW` < `FAIL`, where `FAIL` means critical findings and `REVIEW` means high-severity findings):

| Final status | `--fail-on review` | `--fail-on failed` (default) |
| --- | --- | --- |
| `PASS` | exit 0 | exit 0 |
| `REVIEW` | exit 1 | exit 0 |
| `FAIL` | exit 1 | exit 1 |

- **An access prerequisite always fails CI with exit `1`, independent of `--fail-on`.** When the target cannot be reached or classified (an HTTP 404, a login page, a bot challenge, an access-denied response), the analysis carries `accessPrerequisite.status` of `REVIEW_REQUIRED` or `BLOCKED`, the normal QA scan never runs, and the final status is `REVIEW`/`BLOCKED`. That is a completed QA verdict — the website was **not** tested — so CI reports `CI: policy or gate violation → exit 1` and `Failure mode: policy → exit 1` rather than `CI: acceptable → exit 0`. The run still completes and writes its artifacts, so this stays exit `1` and never borrows exit `2`. A normal local run (no `--ci`) is unchanged: it displays `REVIEW` and exits `0`.
- `--fail-on` implies `--ci`. The default policy is `failed`.
- **A performance-budget breach is an ordinary policy failure, not a new category (Phase 13).** A metric over its declared budget becomes a `CRITICAL` finding, so the status model above turns it into `FAIL` and therefore exit `1`. A budgets file that is missing, unreadable, or malformed is a configuration failure: exit `1` locally, exit `2` under `--ci`. No new exit codes.
- Invalid values (for example `--fail-on invalid`) fail loudly with a clear CLI error — there is no silent fallback.
- Exit `2` is reserved for infrastructure/runtime/tooling failures: browser launch failure, network/runtime failure, an uncaught pipeline exception, invalid usage, or a missing build/dependency. The policy itself only ever returns `0` or `1`.
- Expected **skips** (no `--baseline`, first-run history, an unavailable optional phase) are part of a completed run's result and are never turned into infrastructure failures.
- Without `--ci`, behavior is unchanged from before 8C: a completed run exits `0`, and errors exit `1`.

The decision logic is a small pure module (`src/qa/ci-policy.ts`) — `evaluateCiExit(status, policy)` / `decideCiExit(status, policy)` — with no side effects and no `process.exit()`, so any CI consumer can reuse it and it stays unit-testable.

### 8D — Evidence explorer

The dashboard's Findings card and Runs table link to a read-only evidence explorer that walks a run down to its per-occurrence evidence: **Run → Finding → Occurrence → Evidence**, plus the root-cause candidate and the cross-run history entry when the artifacts record them. It is a pure *consumer* of existing artifacts — it never re-analyzes, re-scores, or invents data, and it adds no engine behavior.

- `GET /api/runs/<run-id>/findings` — bounded, filterable finding list (`?q=`, `?severity=`, `?status=`, `?domain=`, `?code=`). Entries are bounded: they omit `description`, `evidence`, and the scan section.
- `GET /api/runs/<run-id>/findings/<finding-id>` — finding detail: resolved occurrences, the compact verification result, matching root-cause candidates, and the history record (with honest "no record" notes).

Artifact resolution: a run id equal to the current report's `history.currentRunId` is served from the full report (rich scan arrays, full verification evidence, intelligence, historical intelligence); any other validated run id is served from the archived run snapshot in `history/runs/<run-id>.json` (redacted evidence references, reduced intelligence, historical intelligence explicitly unavailable). Malformed/invalid run ids are rejected (`400`), and unknown runs or findings return `404`. Everything stays loopback-only with no new dependencies.

Both endpoints reuse the same two shapes, so the explorer renders identically for the current report and archived runs.

### 8E — User configuration

An optional `qa.config.json` at the project root pins existing QA behavior without changing the engine or re-passing flags every time. It is a **thin layer** over the one pipeline: it only supplies defaults, it never implements a second pipeline, a second CI policy engine, or a second dashboard configuration system.

Precedence (always):

```text
built-in defaults  <  qa.config.json  <  CLI arguments
```

If the file does not exist, the built-in defaults are used and behavior is unchanged. Example:

```json
{
  "crawl": { "maxPages": 100 },
  "execution": { "enabled": true },
  "coverage": { "enabled": true },
  "regression": { "enabled": true },
  "rootCause": { "enabled": true },
  "history": { "enabled": true },
  "historicalIntelligence": { "enabled": true },
  "ci": { "failOn": "failed", "gateMinSeverity": "HIGH" }
}
```

Supported settings (all optional):

| Section | Property | Default | Effect |
| --- | --- | --- | --- |
| `crawl` | `maxPages` | `8` | Crawl page budget (same contract as `--max-pages`) |
| `execution` | `enabled` | `false` | Run the verification/flow executor by default (`--execute none` still disables it) |
| `coverage` | `enabled` | `true` | Produce the coverage map + test plan; disabled leaves `coverage`/`coverageSummary` null (report + dashboard show N/A) |
| `regression` | `enabled` | `true` | Run the regression stage when a baseline is supplied (`--baseline`); disabled skips even with a baseline |
| `rootCause` | `enabled` | `true` | Build QA intelligence/root-cause candidates (Phase 6) |
| `history` | `enabled` | `true` | Persist the run to QA run history (disabled runs are never persisted; the history section reports UNAVAILABLE) |
| `historicalIntelligence` | `enabled` | `true` | Run the Phase 7B trends/intelligence stage (requires persisted history) |
| `ci` | `failOn` | `null` | Default `--fail-on` policy, used only in CI mode (`--ci`); never enables CI on its own |
| `ci` | `gateMinSeverity` | `HIGH` | Phase 9 gate threshold (`HIGH` \| `CRITICAL`): the minimum severity for a NEW finding to fail the CI gate; verified finding regressions always fail |
| `baseline` | `maxAge` | `null` | Phase 10D rotation policy: a duration string like `"30d"`/`"12h"` (see Phase 10D). With `--ci --baseline`, a baseline older than this window is a QA/policy failure (exit `1`); CLI `--baseline-max-age` overrides it |
| `baseline` | `path` | `null` | Phase 11 default baseline artifact: pins the regression comparison target so `--baseline` is not repeated on every invocation (same contract — verified on load, relative to the working directory). `--baseline` overrides it |

Validation is strict and happens **before** the QA pipeline starts:

- malformed JSON → `Invalid qa.config.json: …`
- invalid values (for example `maxPages: -10`, `failOn: "something"`) → configuration error naming the property
- unknown properties (for example `covergae`) → configuration error naming the property (spec §10) — a typo can never silently do nothing
- a missing file is **not** an error — defaults apply

CLI wins: `qa.config.json` with `crawl.maxPages: 100` plus `--max-pages 20` yields `20`; `ci.failOn: "review"` plus `--fail-on failed` yields `failed`. Configuration never stores secrets (the schema has no secret fields), and the CLI prints a concise startup line — `Configuration: qa.config.json` or `Configuration: defaults` — never sensitive values.

For reproducibility, the resolved configuration is attached to the run artifact (`src/ai/types.ts` → `QaConfigurationSnapshot`): `configuration.source` (file name or `defaults`), `configuration.path`, and `configuration.resolved` (effective stage toggles, crawl budget, CI policy, gate threshold, the Phase 10D rotation policy, and the Phase 11 pinned baseline path). Run id + resolved configuration + pipeline result explains how a historical run was executed. The schema stays version 1 (additive, optional).

The loader lives in `src/qa/config.ts` (`loadQaConfig` / `parseQaConfig` / `resolveQaConfig`) and is independent from every QA stage; the CLI (`src/qa-cli.ts`) is the only place that merges it with CLI arguments.

Known limitations: discovery is intentionally project-root only (spec §12 — no global/workspace/inherited/remote/YAML/JS/TS config); the dashboard from 8B is unaffected by configuration (it consumes the existing artifacts); report/history directory paths and dashboard host/port are not configurable yet.

## Phase 9 — Baseline regression gate

Phase 9 makes the baseline comparison (Phase 5) actionable in CI. It is a **deterministic, evidence-only gate**: it reads the run's own `regression` map and `findings`, so it never re-analyzes, re-scores, or invents a reason. Only two FINDING classifications can fail the gate — everything else (FIXED, UNCHANGED, CHANGED, review-required, flows, coverage, recommendations, infrastructure problems) is never a violation:

- **NEW** — a finding present now and absent from the baseline. Fails only when its severity meets the threshold (`ci.gateMinSeverity`, default `HIGH`; a `CRITICAL`-gated pipeline ignores HIGH). NEW MEDIUM/LOW findings are counted honestly but never fail by default.
- **REGRESSION** — a previously verified condition now broken. Fails regardless of severity, because the change itself (Phase 5C) already encodes a verified negative change.

The gate module (`src/qa/gate.ts`) is pure: `evaluateGate({ regression, findings }, { minSeverity })` → `{ enabled, failed, violations, evaluated, newBelowThreshold }`, with a deterministic console renderer (`formatGateVerdict`). With no `--baseline` the gate is inactive and never fails — gating CI requires an explicit comparison, exactly like 8C requires an explicit policy.

```powershell
# Publish a baseline from the run you want to compare against (once):
npm run qa -- https://example.com --crawl --execute --write-baseline reports/baseline.json

# Gate CI: the run fails (exit 1) when it introduces NEW ≥ HIGH findings
# or a verified finding regression against the baseline:
npm run qa -- https://example.com --crawl --execute --ci --baseline reports/baseline.json
```

- `--write-baseline <path>` copies the completed run's `QaAnalysis` (minus the report sections) to `<path>` and writes a `.meta.json` sidecar (`schemaVersion`, `writtenAt`, `runId`, `sourceUrl`, `generatedAt`, sha256 `digest`) for provenance. It refuses to overwrite an existing file, and it never alters the report schema.
- `--ci --baseline` evaluates the policy (8C) **and** the gate; exit code stays `1` for a policy failure, `2` for an infrastructure failure. No new exit codes.
- Without `--ci`, the gate verdict is still printed in the CI block but has no effect on a normal run's exit code.
- `ci.gateMinSeverity` is validated like every other setting (case-insensitive; `"LOW"`/`"MEDIUM"` are rejected with a clear error).
- The dashboard surfaces the live gate: a **CI gate** card on the home view (`/api/state` → `gate`) and a per-finding **CI gate (baseline)** card in the evidence explorer that shows exactly why a finding fails the gate (or that it does not). Archived snapshots carry no regression map and therefore no gate verdict.

## Phase 10 — Baseline lifecycle: verified baseline loading

Phase 10 makes `--baseline <path>` stop trusting its input blindly. Instead of a raw `JSON.parse`, the artifact is loaded through a dedicated lifecycle module (`src/qa/baseline.ts`, `loadBaseline`) that validates it and — when possible — proves it is exactly the artifact a previous run published:

- **Structural validation always.** The artifact must be a comparable `QaAnalysis` baseline: a `scan.scan.url` (string), a `findings` array, and a `generatedAt`. Passing a `qa-execution.json`, a diff, or an unrelated JSON file is a hard error, not a silent no-op comparison.
- **Integrity verification when the sidecar exists.** `--write-baseline` (Phase 9) writes `<path>.meta.json` with the exact sha256 digest of the artifact. On load, that digest is recomputed over the artifact bytes. A mismatch is a hard error — the pipeline refuses to compare against an artifact that changed after it was published (tampering, a partial download, or a re-save such as CRLF conversion). The error names both digests and the fix (re-create the baseline with `--write-baseline`, or remove the sidecar to fall back to structure-only loading).
- **Provenance reporting.** Every comparison prints which baseline was used: run id, generated timestamp, source URL, and the integrity state.
- **Backward compatible.** Phase 5-era baselines have no sidecar; they still load (structure is validated) and report `legacy artifact — no <path>.meta.json sidecar (digest not verifiable)`.

```powershell
# Publish + verify in one shot: the comparison run prints the trusted baseline.
npm run qa -- https://example.com --crawl --execute --write-baseline reports/baseline.json
npm run qa -- https://example.com --crawl --execute --ci --baseline reports/baseline.json
#   Regression baseline: <path>
#     provenance: run <run-id> · generated <timestamp> · source <url>
#     integrity: verified — sha256 861236501bb4…
#     age: 2d 3h (from writtenAt)
```

- A missing, malformed, structurally invalid, or digest-mismatched baseline aborts the pipeline with a precise message; under `--ci` that is an infrastructure failure (exit `2`), never a false regression verdict. Exit codes stay `0/1/2`.
- This is a lifecycle addition, **not** a second baseline system: `--write-baseline` remains the only writer and `--baseline` the only reader; the report schema is unchanged.

### Phase 10B — Offline baseline verification

A baseline artifact can be validated **on its own, without running a QA pipeline**:

```powershell
npm run qa verify -- reports/baseline.json
#   BASELINE VERIFY: PASS → exit 0
#     path:  reports\baseline.json
#     integrity: verified — sha256 861236501bb4…
#     provenance: run 2026-09-21T09-30-12-123Z-8f3a1c02 · generated 2026-09-21T09:30:12.000Z · source https://example.com
#     age: 2d 3h (from writtenAt)
```

`verify` is the standalone surface for the same `loadBaseline()` the pipeline uses — no scan, no comparison, no browser, no network:

- **structure validation always** — the artifact must be a comparable `QaAnalysis` baseline
- **sha256 integrity** — when `<path>.meta.json` exists (Phase 9 sidecar), the artifact bytes must match the recorded digest
- **provenance** — run id / written-at / generated-at / source url / the legacy no-sidecar note
- **age** (Phase 10D) — the elapsed baseline age from `writtenAt`, else the artifact's `generatedAt`; the block renders but takes no position (the `verify` exit contract stays strictly `0`/`2`)

Exit codes follow the same `0/1/2` model:

- `0` — the artifact is a valid baseline: verified, or a legacy no-sidecar artifact (structure validated; digest not verifiable)
- `2` — the artifact is missing, malformed, structurally invalid, or failed digest verification — a corrupt baseline is never silently acceptable and is never an exit-`1` QA/policy verdict

The same command is the recommended pre-CI check: verify the artifact before wiring `--baseline` into a gate.

### Phase 10C — Verified baseline state in the dashboard

When the current report contains a baseline-backed regression comparison, the dashboard verifies the recorded baseline through the same `loadBaseline()` path used by the CLI. `/api/state` exposes the deterministic verification result, including integrity and provenance. The home view shows whether the baseline is `VERIFIED`, a legacy no-sidecar artifact, or failed verification.

If the recorded baseline is missing, malformed, structurally invalid, or digest-mismatched, the dashboard keeps the report and regression artifact visible for diagnosis but suppresses the derived CI gate verdict. This prevents a stale dashboard from presenting a baseline-backed gate result that can no longer be trusted. No artifact is modified and no new baseline loader is introduced.

### Phase 10D — Baseline rotation & lifecycle management

A baseline describes the site **when it was written**, so it decays. Phase 10D adds staleness: `loadBaseline()` now computes the baseline **age** from the recorded timestamp — `writtenAt` (the Phase 9 sidecar) when present, else the artifact's own `generatedAt` — and the CLI can enforce a **rotation policy** so CI fails when the baseline is too old to trust, instead of silently comparing against stale expectations.

- **Age every run.** The comparison block prints `age:` (e.g. `2d 3h (from writtenAt)`) regardless of policy; the offline `verify` subcommand and the dashboard's Baseline trust card show the same age.
- **Rotate via policy.** `--baseline-max-age <dur>` (or `baseline.maxAge` in `qa.config.json`) takes `<number>m|h|d|w` (e.g. `30d`, `12h`, `90m`). With `--ci --baseline`, a baseline older than the window is a **QA/policy failure → exit `1`** that tells the team to re-publish with `--write-baseline`. Without `--ci`, the rotation verdict is printed but has no exit effect — same pattern as the Phase 9 gate. No new exit codes.
- **Fail-safe, never false-positive.** A baseline with no usable timestamp (no sidecar field and an unparseable `generatedAt`) reports age `unknown` and is **not** failed — legacy baselines keep working and the policy simply cannot be evaluated for them. Only *known* staleness fails CI.
- **One writer, one reader.** Rotation reuses the exact `loadBaseline` artifact + sidecar; the age always comes from the artifact, never from reconstructed history. `verify` keeps its documented `0`/`2` exit contract (it prints the age and shows the rotation position when a policy is supplied, but evaluates nothing by default).

```powershell
# Publish a baseline (once), then gate CI with rotation:
npm run qa -- https://example.com --crawl --execute --write-baseline reports/baseline.json
#   Regression baseline: <path>
#     provenance: run <run-id> · generated <timestamp> · source <url>
#     integrity: verified — sha256 861236501bb4…
#     age: 0s (from writtenAt)          # fresh: within the 30d policy
#     rotation: fresh — within the 30d rotation policy.

npm run qa -- https://example.com --crawl --execute --ci --baseline reports/baseline.json --baseline-max-age 30d
#   Regression baseline: reports\baseline.json
#     age: 41d 3h (from writtenAt)
#     rotation: STALE — baseline exceeds the 30d rotation policy; re-publish with --write-baseline.
#   ...
#   CI rotation: FAIL — baseline reports\baseline.json is stale … Re-publish it with --write-baseline.
#   CI: policy or gate violation → exit 1 (QA policy failure).
```

- The rotation verdict composes with the existing 8C policy and 9 gate: any one failing the CI returns exit `1`.
- The dashboard accepts the same policy: `serve|dash --baseline-max-age 30d` renders `STALE`/`FRESH`/`unknown` on the home-view Baseline trust card (`/api/state` → `baselineVerification.staleness` + `baselineMaxAge`).
- `--baseline-max-age` and `baseline.maxAge` are validated the same strict way as every other duration/flag — an invalid value is a hard error before any pipeline work.

### Phase 11 — Config-pinned baseline

A project pins *which* baseline its QA gates trust in `qa.config.json`, so CI and local runs compare against the same artifact without repeating `--baseline` on every invocation:

```json
{
  "baseline": {
    "path": "reports/qa-baseline.json",
    "maxAge": "30d"
  }
}
```

- `baseline.path` is the default regression comparison target. `--baseline <path>` overrides it; the CLI flag stays the highest-precedence source (defaults < config < CLI).
- Loaded, verified, aged, and rotated **exactly** like a `--baseline` argument: same `loadBaseline()` verification (structure, sha256 integrity, provenance), same Phase 9 gate, same Phase 10D rotation position.
- `baseline.maxAge` and `baseline.path` combine: one config section expresses both "compare against this artifact" and "fail CI when it decays".
- The resolved `baselinePath` is recorded in the run's `configuration.resolved` snapshot, so a historical run records exactly which baseline the gate compared against.
- The `verify` subcommand and `serve|dash` are unaffected: `verify` takes the artifact path explicitly, and the dashboard reads the baseline from the report artifact.

### Phase 11A — CI contract

The canonical CI command and its exit-code contract are named in one place (`src/qa/ci-contract.ts`) and enforced by a checked-in GitHub Actions workflow (`.github/workflows/qa-ci.yml`):

```
npm run qa -- <url> --execute --ci --baseline <baseline-path> [--baseline-max-age <duration>]
```

| Exit | Meaning | CI result |
| --- | --- | --- |
| `0` | QA completed; the configured CI policy is satisfied, the Phase 9 gate found no NEW ≥ threshold or verified REGRESSION, and no baseline is STALE under the rotation policy | pass |
| `1` | QA completed but violates a QA policy: status threshold (8C), gate (9), rotation (10D), **or the access prerequisite blocked/needs review so normal QA never ran** (`REVIEW_REQUIRED` / `BLOCKED`) | fail |
| `2` | Baseline verification/integrity failure (missing, malformed, structurally invalid, or digest mismatch) or any infrastructure/runtime failure — never collapsed into the exit-1 verdict | fail |

- **Access prerequisite → exit `1`, never `0`.** When the target returns an unclassifiable or denied response (HTTP 404, login wall, bot challenge, access denied), the run completes with `accessPrerequisite.status` `REVIEW_REQUIRED`/`BLOCKED`, the normal QA scan does not run, and the report status is `REVIEW`/`BLOCKED`. Under `--ci` that is a policy failure: the CLI prints `CI: access prerequisite … → normal QA did not run → exit 1 (the website was not tested).` plus `CI: policy or gate violation → exit 1` and `Failure mode: policy → exit 1`. It is a *completed* QA verdict, so it does not become an exit `2` (which stays reserved for baseline/integrity/infrastructure). The status table above still decides `0`/`1` for **finding-based** statuses; this rule is about an untested website. Without `--ci` the behavior is unchanged (display `REVIEW`, exit `0`).

- The baseline is **loaded and verified before the Phase 9 gate and Phase 10D rotation evaluation** (structure always; sha256 integrity whenever the sidecar exists). A verification failure aborts to exit `2` — there is no silent fallback to an unverified comparison.
- The `--ci` gate (Phase 8C), the regression gate (Phase 9), rotation (Phase 10D), and the access prerequisite all fail with exit `1`; the final code is decided by `classifyRunOutcome` (used by `decideCiContractExit`) in `src/qa/failure-mode.ts` / `src/qa/ci-contract.ts`.
- `--baseline` overrides `baseline.path` in `qa.config.json`, which overrides the default (same precedence as Phase 11). Configuration errors still abort before the pipeline (exit `1` locally, exit `2` in CI mode).
- The workflow (`qa-ci.yml`) runs the canonical command with dependencies from `npm ci` + Playwright Chromium, feeds Noor basic-auth and optional AI variables from repository secrets, and lets the command's own exit code drive the job result (never masked or converted). `reports/` (analysis JSON/HTML, execution outcomes) uploads as an artifact even when the gate fails.
- Deterministic contract tests in `src/tests/ci-contract.test.ts` spawn the built CLI exactly as CI would and assert the 0/1/2 surface: clean run `0`, NEW HIGH regression `1`, malformed/structurally-invalid/tampered/missing baseline `2`, stale rotation `1`, UNKNOWN-age legacy baseline safe (`0`), config-pinned baseline auto-use, `--baseline` override, invalid `baseline.path` config error (local `1` / CI `2`), an access prerequisite that prevents normal QA (`REVIEW_REQUIRED` after an HTTP 404, and `BLOCKED`) `1` with no `CI: acceptable → exit 0` line, the same access state exiting `0` without `--ci`, and artifact safety (baseline + sidecar byte-for-byte unchanged by CI runs).
- The standalone `verify` subcommand keeps its dedicated 0/2 contract (2 = baseline verification/integrity failure) — unchanged from Phase 10.

### Phase 11B — Deterministic artifacts

QA artifacts are deterministic where it matters, isolated, and safe to reproduce:

- **Artifact boundaries.** A run writes only where it is told to: its report goes to `--output` (default `<cwd>/qa-analysis.json`), history to `--history-dir` (default `<cwd>/reports/history`), and a published baseline to `--write-baseline <path>` + `<path>.meta.json`. A run started in a temp or CI working directory never touches the committed `reports/` tree.
- **Artifact-collision guards** (validate pure usage, fire before any write). Value-taking options (`--report`, `--suite`, `--output`, `--baseline`, `--write-baseline`, `--baseline-max-age`, `--history-dir`) reject dash-prefixed values, so `--write-baseline --execute …` is a usage error instead of silently creating a stray `--execute` file. `--output` can no longer be the loaded baseline, the `--write-baseline` target, or that target's `.meta.json` sidecar; and `--write-baseline` can no longer target the very artifact being compared against. All guards fail with the normal usage-error exit (`1` locally, `2` with `--ci`) and leave every artifact byte-identical.
- **Deterministic normalization** (`src/qa/determinism.ts`, pure). Given a report/baseline, `normalizeArtifact` masks only the documented runtime-specific fields and returns a canonical key-stable snapshot: ISO-8601 timestamps → `<runtime-timestamp>`, `durationMs` counts → `<runtime-duration-ms>`, run ids (the timed history `runId`, hashed regression `runId`, `runIds` arrays, and any bare run-id-shaped string) → `<runtime-run-id>`, and machine-specific absolute paths → `<machine-path>`. Everything meaningful — findings, severities, URLs, site identity, config digest, counts — is preserved verbatim. `deterministicArtifactKey(a) === deterministicArtifactKey(b)` means two runs carried the same evidence apart from the wall clock; `normalizedArtifactsEqual` is the `deepEqual` variant. The normalizer never mutates its input and is idempotent.
- **Repeated-run equivalence.** Two equivalent runs of the same report produce byte-different raw JSON (timestamps, durations, regression run ids) but identical normalized artifacts — this is what makes CI baselines and cached reports reproducible across machines.
- **Baseline/sidecar consistency.** A published baseline gets a sha256-detectable `.meta.json` sidecar whose digest matches the artifact bytes; the digest differs per run, the existing `verify` subcommand stays authoritative (0 ok / 2 unverifiable), and a rewritten baseline must be re-published so its sidecar matches the new bytes.
- **History vs regression separation.** History snapshots (`reports/history/runs/<runId>.json`) carry run identity but structurally lack `scan.scan` / `generatedAt`, so they fail baseline structure verification (`verify` → 2) and can never be mistaken for a regression baseline.
- **Append-only history; immutable prior artifacts.** Re-running the same fixture in the same directory does not mutate the first run's report or history snapshot byte-for-byte; the history index only ever grows.
- **Artifact inventory block.** Every analysis run prints a compact `Artifacts (n):` diagnostic block listing what it produced — report JSON/HTML, execution artifact, baseline + sidecar, history index/runs — with **relative paths only** (never machine-local absolute paths), stable kind-then-path ordering, and a summary line. It is pure output for CI logs and has no behavioral effect.
- **Tests** in `src/tests/determinism.test.ts` (masking, idempotence, no mutation, key-order independence, equivalence), `src/tests/artifacts.test.ts` (inventory: relative-only, ordering, dedup, deterministic rendering), and `src/tests/phase11b.test.ts` (spawned-CLI: raw-differs/normalized-equal across dirs, no path/timestamp/run-id leaks, committed-artifact immutability, guard exit codes, baseline digest + rewrite + tamper, history-vs-baseline distinction, append-only history, inventory block).
- **Intentionally non-deterministic and preserved by design:** wall-clock metadata (timestamps, durations, generatedAt-driven run ids) and machine paths. Semantics are never normalized away — only content changes (a new finding, an edited title, a changed domain verdict) change the normalized artifact.

### Phase 11C — Failure-mode matrix

Every way a QA/CI run can end is classified into one stable failure-mode **category**, and each category maps to exactly one exit code. The classifier lives in `src/qa/failure-mode.ts` as pure, table-driven logic with no I/O; the CLI prints a machine-readable `Failure mode: <category> → exit <n>.` line on CI runs and on aborts. **The public report schema is unchanged** — classification is internal and written to the terminal only.

- **Categories.** `success`, `configuration`, `baseline-verification`, `policy`, `gate`, `rotation`, `infrastructure`. The project's *regression* decision (Phase 9 NEW/REGRESSION findings) is the `gate` category; the non-blocking status-only finding is the `policy` category; stale-gate rotations from `--baseline-max-age` are `rotation`; a phase that threw before completing (load, execute, compare, verdict, report) is `infrastructure`. An access prerequisite that prevented normal QA (`REVIEW_REQUIRED`, `BLOCKED`) reuses the existing `policy` category — no new category was introduced for it, and neither was one for a performance-budget breach (Phase 13), which is an ordinary critical finding.
- **Exit-code contract** (consistent with Phase 11A). `success` → **0**; `gate`/`policy`/`rotation` → **1**; `configuration` → **1 locally, 2 with `--ci`** (pre-existing behavior preserved); `baseline-verification` and `infrastructure` → **2**. The standalone `verify` subcommand keeps its dedicated 0/2 contract. Access prerequisite states map to `policy`/**1** in CI and are ignored for the exit code outside `--ci`.
- **Precedence (first match wins).** `infrastructure` > `configuration` > `baseline-verification` > **access prerequisite** > `gate` > `policy` > `rotation` > `success`. Consequences: a baseline check never downgrades to a gate/regression call even when findings are NEW (it keeps the hard exit 2); infrastructure errors are never masked by a regression, gate, or rotation; access always outranks the gate — because `evaluateGate` reports `enabled: false` when the regression is `null` (an access-blocked run has no regression to compare), the two never disagree; and a completed run that passes the gate can never read as success if an earlier phase already signalled a hard failure. Combined config+baseline locally resolves to `configuration`/1 by precedence, matching the top-level catch's 1/2-by-ciMode behavior.
- **Abort classification.** `classifyThrownError` buckets thrown messages by stable patterns: configuration messages (invalid `qa.config.json`, missing required option values, invalid `--fail-on`/gate severity/`--baseline-max-age`, an invalid performance budgets file, artifact-collision guards, missing required start URL/report path, non-positive numbers, non-integer `--port`), baseline-verification messages (`Invalid baseline …`, failed digest verification, changed-after-publish), and everything else falls through to `infrastructure`. The same classification drives the exit code (0 never exits on an aborted run; `1` locally, `2` with `--ci`).
- **UNKNOWN-safe rotation.** A legacy baseline that superseded the gate (findings kept `UNKNOWN` without context) continues to pass in CI (`success`/0) as long as nothing else failed, and `UNKNOWN` findings never flip a run to `gate`/regression — only genuine NEW/REGRESSION findings do.
- **Single source of truth.** `decideCiContractExit` (Phase 11A) now delegates to `classifyRunOutcome`, so the completed-run CI verdict, the local verdict, the printed categories, and the tests all agree on one table rather than parallel copies.
- **Tests** in `src/tests/failure-mode.test.ts`: a pure `PURE_MATRIX` (every category plus the precedence collisions: baseline+regression, baseline+gate, infrastructure+regression, regression+rotation, gate+rotation, combined config+baseline locally, and the access-prerequisite rows where `REVIEW_REQUIRED`/`BLOCKED` beat a would-be-clean gate and clean access stays `0` while hard failures still beat access to exit `2`), an agreement sweep against `decideCiContractExit`, an exhaustive no-accidental-0 / mapping-consistency sweep over all flag combinations + ciMode + the four access states, a `THROWN_MATRIX` for abort classification, and a spawned CLI matrix covering clean, NEW-HIGH regression, gate-disabled-with-failures, rotation-fresh/stale (CI and local), missing/malformed/structurally-invalid/tampered baselines, malformed config, invalid baseline/max-age, infrastructure, an access-prerequisite 404 (exit `1`, run still completes and writes its report), BE-colocated `--baseline`+`--output`, and UNKNOWN+cases — each asserting exit code, the `Failure mode:` line, continuation, and artifact output. Configuration local-exit-1/CI-exit-2 and report-configuration-snapshot stability are asserted separately.

### Phase 11D — CI Integration

`.github/workflows/qa-ci.yml` runs the same Phase 11A command used locally:

```text
npm run qa -- <url> --execute --ci --baseline <baseline-path> [--baseline-max-age <duration>]
```

The workflow passes the optional `baseline` and `baseline-max-age` dispatch inputs to the CLI; when no baseline input is supplied, the CLI may resolve `baseline.path` from `qa.config.json`. The CLI remains authoritative for baseline verification, regression/gate evaluation, rotation, failure classification, and exit codes:

- `0` means the QA run completed successfully;
- `1` means a QA policy, regression gate, or rotation-policy failure;
- `2` means baseline verification or infrastructure failure.

The QA step does not use `continue-on-error` or `if: always()`, so its exit code determines the job result. A separate `if: always()` upload step preserves `reports/qa-analysis.json`, `reports/qa-analysis.html`, `reports/qa-execution.json`, and Playwright diagnostic directories when available. The configured regression baseline is not uploaded as a generated report artifact.

No baseline is created or overwritten in CI. Noor credentials and optional AI settings come only from GitHub Secrets through environment variables; they are not hardcoded, printed, or included in the artifact inventory. Static workflow checks live in `src/tests/ci-integration.test.ts`.

### Phase 13 — Performance budgets in the QA/CI path

```powershell
npm run qa -- https://example.com --execute --perf-budgets perf.budgets.json --ci
npm run qa -- --report reports/qa-report.json --perf-budgets perf.budgets.json
```

The scanner has always been able to record Web Vitals, and `npm run scan` has had its own `--perf-budgets` flag, but neither could stop a release: the budgets never reached the QA analysis, the HTML report, or the CI exit decision. Phase 13 closes that gap with the existing architecture — no new exit code, no new failure category, no new severity level.

- **One budgets file, six metrics.** `ttfb`, `fcp`, `lcp`, `cls`, `domContentLoaded`, `loadEvent` (milliseconds, except `cls` which is a unitless ratio). Any subset may be declared; unknown keys, negative values, malformed JSON, and unreadable/missing files are rejected.

  ```json
  { "ttfb": 600, "fcp": 1800, "lcp": 2500, "cls": 0.1 }
  ```
- **Loud configuration, never a silent pass.** A budgets file that cannot be loaded raises `Invalid performance budgets file "<path>": …`, which the Phase 11C classifier maps to `configuration` — exit `1` locally, exit `2` under `--ci`, the same contract every other configuration problem already has. A UTF-8 BOM written by Windows tooling is tolerated rather than reported as broken JSON.
- **Applied once, in the pipeline.** Budgets are evaluated after the scan (and before analysis) rather than inside the scanner, so the same file also gates a reused `--report` artifact and stays unit-testable without a browser. The scanner itself is unchanged apart from one bug fix: Chromium does not publish Largest Contentful Paint entries to the passive timeline, so `getEntriesByType` never returned them and every LCP value was `null`. A buffered `PerformanceObserver` now captures them (with an honest fallback to `null` if the page produced no LCP candidate).
- **A breach is just a finding.** Each breach adds a `FAIL` issue coded `perf-budget-<metric>` in the new `performance` finding domain, with a `Performance budget exceeded: <METRIC>` title and `CRITICAL` severity — so the existing rubric makes the status `FAIL`, the Phase 8C gate exits `1`, and the Phase 11C line reads `Failure mode: policy → exit 1.`. Re-applying budgets is idempotent, and `summary` counters are recomputed so the artifact never claims 0 failures while carrying a FAIL issue.
- **Untested means unjudged.** When an access prerequisite stopped the normal scan, budgets are not evaluated (`Performance budgets: not evaluated — normal QA scan did not run (…)`) and no finding is invented, preserving the rule that an untested target never increases the finding count. Metrics the scan could not measure are likewise not judged.
- **Report.** The HTML report is now 15 sections, with a `Performance` section showing every measured metric plus a `Declared budgets exceeded` table when there is a breach.

Tests in `src/tests/perf-budgets.test.ts` cover loud loading (missing/malformed/unknown key/negative/BOM), application and idempotence, honest summary counters, unavailable metrics, classification and domain/title mapping, the rendered Performance section, and spawned-CLI behavior exactly as CI runs it: breach + `--ci` → `1` with `Failure mode: policy → exit 1.`, satisfied budgets → `0`, a missing budgets file → `2` with `--ci` and `1` without, no budgets file at all → byte-for-byte the pre-Phase-13 verdict, and an access-blocked report → not evaluated with zero findings. `perf.budgets` config parsing and CLI precedence live in `src/tests/config.test.ts`.

## Development

```powershell
npm run lint          # TypeScript checks
npm run format:check  # Prettier verification
npm test
npm run test:coverage # Node's built-in coverage summary
npm run audit         # Fail on high/critical dependency advisories
```

GitHub Actions runs the build and unit suite for every push and pull request. The existing manual QA gate remains available for an explicit URL and baseline. To enable weekday smoke scans, set the repository variable `QA_SMOKE_TARGET` to an approved public test URL.

## Project layout

```text
src/
  cli.ts                 command-line parsing and entry point (scan)
  scanner.ts             browser orchestration and collection
  locators.ts            recommended Playwright locators
  checks.ts              QA and accessibility heuristics
  reporter.ts            JSON and HTML artifact generation
  test-generator.ts      scenario generation (safe/review/high-risk split)
  playwright-generator.ts  Playwright spec generation for generated-tests.ts
  qa-cli.ts              QA analysis orchestrator (qa command; --baseline-max-age rotation & CI verdict; Phase 11A contract wiring; Phase 11B artifact-boundary guards + inventory block; Phase 11C failure-mode classification lines; Phase 13 --perf-budgets load + apply)
  ai/
    severity.ts          deterministic severity/confidence rubric
    analysis.ts          finding builder with evidence refs
    flows.ts             user-flow detection
    scenarios.ts         intent and priority decoration
    summary.ts           summary + release gate (no arbitrary score)
    provider.ts          deterministic + OpenAI-compatible providers
    report.ts            QA HTML report (incl. Finding Status, Verification Disposition, Verification Results, Flow Discovery, Regression Summary, QA Intelligence, QA History, Historical Intelligence)
    lifecycle.ts         finding lifecycle + dispositions + finding↔scenario links (EXECUTOR side)
    triage.ts            aggregation of explainable verification verdicts
    index.ts             analyzeScan orchestrator
  executor/
    tasks.ts             verification task scheduling + safety/locator guards + unique-reference locators
    verify.ts            safe Playwright verification strategies + triage rules
    spec.ts              verification spec renderer
    parse.ts             outcome file collector (OUTCOME_MISSING fallback)
    runner.ts            Playwright runner + JSON reporter parser
    redact.ts            credential/token redaction for evidence
    index.ts             executor exports
  flow/
    types.ts             FlowCategory, FlowSafety, FlowStep, DiscoveredFlow, SiteGraph, FlowSummary, FlowDiscovery
    classify.ts          deterministic step classification (SAFE/REVIEW/HIGH_RISK/BLOCKED), priorities, failure mapping
    graph.ts             site graph construction from scan reports
    discover.ts          flow candidate discovery from the site graph (10 categories), deduplication
    analysis.ts          flowDiscovery summary builder, AI refinement hooks
    execute.ts           safe flow executor (runs only the SAFE + AUTOMATED prefix)
    spec.ts              Playwright spec renderer for discovered flows
    parse.ts             flow execution outcome collector
    crawl.ts             bounded same-origin site crawl
    index.ts             flow module exports
  coverage/
    types.ts             CoverageCategory, CoverageStatus, CoverageItem, CoverageMap, TestPlanRecommendation, CoverageDigest, CoverageEnhancement
    engine.ts            deterministic coverage engine: buildCoverage, coverageDigest, gapHeadlines, applyCoverageNotes
    test-plan.ts         evidence-traced recommendations (P0–P4, capped at 40)
    index.ts             coverage module exports
  regression/
    types.ts             RegressionConfidence, ChangeCategory, ChangeClassification, RegressionChange, RegressionMap, RegressionEnhancement
    identity.ts          semantic identity (finding/flow/coverage/recommendation signatures), config digest, run identity, comparability
    compare.ts           deterministic two-run compareRuns + applyRegressionNotes (bounded AI)
    index.ts             regression module exports
intelligence/
     types.ts             IntelligenceStatus, RootCauseCandidate, EvidenceRelationship, InvestigationAction, IntelligenceMap/Digest/Enhancement
     identity.ts          semantic element/execution identity helpers for the intelligence layer
     evidence.ts          fact extraction + SUPPORTS/CONTRADICTS/RELATED relationship building
     related.ts           deterministic SAME-SEMANTIC-TARGET / infra / discovery-variance clustering
     root-cause.ts        candidate synthesis (patterns A–E), confidence + status + contradictions
     investigation.ts     safe, read-only investigation actions + whitelist
     priority.ts          explainable P1–P3 investigation queue
     summary.ts           direct counts + uncertainty notes (no percentages)
     index.ts             buildIntelligence + applyIntelligenceNotes + digest/validation
   history/
     types.ts             HISTORY_SCHEMA_VERSION, HistoryRunSnapshot, QaRunRecord, HistoryReportSection, load/persist/reset result types
     identity.ts          semantic identity facade (site/run/finding/flow/coverage history keys)
     snapshot.ts          buildRunSnapshot + qaRunRecordOf (bounded, redacted, deterministic artifact builder)
     validate.ts          validateSiteKey / validateRunRecord / validateHistoryIndex / validateRunSnapshot
     store.ts             persistRun, loadSiteHistory, loadIndex, resetHistory, atomic writes + .lock (DEFAULT_HISTORY_DIR = reports/history)
     index.ts             history public API (incl. loadHistory convenience)
   history-intelligence/
     types.ts             HISTORICAL_INTELLIGENCE_SCHEMA_VERSION, HistoricalIntelligenceMap/ReportSection/Digest/Enhancement, lifecycle classes
     matching.ts          loadOrderedRuns (completedAt ordering + bounded reading), identity maps, coverage-aware helpers
     findings.ts          observation timelines + documented lifecycle classifier + same-family ambiguity fish
     flows.ts             flow history, outcome precedence, classifyFlowStability (STABLE/VARIABLE/UNSTABLE)
     coverage.ts          coverage trend universe + classifyCoverageTrend (loss-by-absence never claimed)
     infrastructure.ts    per-run infra aggregation + recurrence (>= 2 runs), runInfraProblemCount
     relationships.ts     typed, confidence-aware relationship edges (derived only from classifications)
     queue.ts             evidence-backed investigation queue (P1/P2/P3, HIQ-###)
     confidence.ts        deriveConfidence from explainable factors (no percentages)
     summary.ts           buildSummary + buildLimitations
     index.ts             historicalIntelligenceForRuns + applyHistoricalIntelligenceNotes + digest
qa/
      result.ts            Phase 8A: deterministic QA RESULT block + coverage label + queue counts
      ci-policy.ts         Phase 8C: pure CI exit policy (status ranks, --fail-on parsing, exit decision)
      config.ts            Phase 8E/10D/11/13: optional qa.config.json loader + validation + resolved defaults (incl. baseline.maxAge, baseline.path, perf.budgets)
      gate.ts              Phase 9: pure baseline regression gate (evidence → deterministic policy → verdict)
baseline.ts          Phase 10: verified baseline loading (structure validation + sha256 integrity + provenance + age) + offline `verify` baseline verification + rotation policy (&max-age) helpers
      ci-contract.ts        Phase 11A: canonical CI command + 0/1/2 exit-code contract + decideCiContractExit
      determinism.ts        Phase 11B: pure deterministic normalization (mask runtime timestamps/durations/run ids/machine paths; canonical key-stable artifact keys)
      artifacts.ts          Phase 11B: pure artifact inventory for a run (relative-only paths, kind order, summary, renderer)
      perf.ts               Phase 13: loud performance-budgets loader + apply to report (issues + summary counters) + budget description
    dashboard/
    server.ts            Phase 8B/10C/10D: zero-dependency loopback-only dashboard server (read-only artifact API + verified baseline state + rotation staleness)
      evidence.ts          Phase 8D: evidence views (occurrence resolution, verification, root cause, history) over report|snapshot artifacts
      index.html           static single-file dashboard UI (dashboard + evidence explorer; traverses /api/state and /api/runs/*/findings)
    tests/                 unit tests for pure behavior (incl. ci-contract.test.ts — Phase 11A spawned-CLI 0/1/2 contract; determinism.test.ts + artifacts.test.ts + phase11b.test.ts — Phase 11B; failure-mode.test.ts — Phase 11C; ci-integration.test.ts — Phase 11D workflow checks; perf-budgets.test.ts — Phase 13 budgets + spawned-CLI breach/exit matrix)
.github/
     workflows/qa-ci.yml    Phase 11D: canonical QA gate workflow (exit code drives the job, reports uploaded after failures)
```

## Troubleshooting

- **Browser executable missing:** run `npx playwright install chromium`.
- **Navigation times out:** increase `--timeout`, check VPN/proxy access, or scan a public URL first.
- **403 links:** these are reported as restricted; a public scanner may be blocked by the destination server.
- **Warnings on component libraries:** inspect the element and locator in the HTML report. Some controls intentionally have no visible text and need an `aria-label` or a project-specific `data-testid`.
