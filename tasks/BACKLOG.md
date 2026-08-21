# BACKLOG — sequential order

Work top to bottom. Each task ends with its acceptance check passing. Do not start a task
before the previous one is done (parallelization noted where safe).

## Phase 0 — Bootstrap

- [ ] **T01 — Scaffold TypeScript project**
  `npm init` + TypeScript + AI SDK v6 deps (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`,
  `ai-sdk-provider-claude-code`, `playwright`, `commander`, `zod`), `tsx` for dev, strict tsconfig,
  `.gitignore` (node_modules, dist, `.env`, `screenshots/`, `test-reports/`).
  ✓ `npx tsx src/cli.ts --help` prints usage stub.

- [ ] **T02 — CLAUDE.md + guardrails**
  Write repo CLAUDE.md: project overview, commands, and the guardrail block from PLAN.md
  (also to be embedded in every agent prompt).
  ✓ File exists; guardrails match PLAN.md word-for-word.

## Phase 1 — Provider layer

- [ ] **T03 — Provider registry + config resolution**
  `src/providers/`: `lmstudio | openai | anthropic | claude-cli` behind one
  `getModel(provider, model)` API. `.env` loading (keys never logged). Config precedence:
  flags → per-agent `aw.config.json` → global default. Ship `aw.config.example.json`.
  ✓ Unit test: precedence resolves correctly for all 4 providers.

- [ ] **T04 — `aw ping` smoke command**
  One-prompt round-trip per provider, prints model + latency; clear error text when LM Studio
  is down or a key is missing.
  ✓ `aw ping --provider lmstudio` (and each other configured provider) returns a reply.

## Phase 2 — Tool layer

- [ ] **T05 — Core tools with per-agent permissions**
  AI SDK tools: `read_file`, `write_file`, `edit_file`, `bash` (allowlisted), `git_diff`,
  `git_log`, `grep`. Permission profiles: `designer` (all), `tester` (no source writes;
  writes only under `test-reports/tmp/`), `reviewer` (read-only).
  ✓ Test: tester writing to `src/` is rejected; reviewer write attempt is rejected.

- [ ] **T06 — Playwright toolset**
  `browser_goto`, `browser_screenshot` (viewport arg: 375x812 / 1440x900), `browser_click`,
  `browser_fill`, `browser_console_errors`. Screenshots land in
  `screenshots/<feature-slug>/<screen>-<viewport>.png`.
  ✓ Script smoke: screenshot any local URL at both viewports.

## Phase 3 — Agents

- [ ] **T07 — Agent definitions (single prompt source)**
  `agents/ui-designer.md`, `agents/qa-tester.md`, `agents/code-reviewer.md` with frontmatter
  (`name`, `description`, `tools`, `provider` default) + full system prompts per PLAN.md tool
  policy, incl. designer self-review checklist, tester plan template (happy/edge/invalid/auth),
  reviewer severity levels + verdict format. Loader parses them for the CLI.
  ✓ Loader returns 3 agents with correct tool allowlists.

## Phase 4 — Workflows (CLI)

- [ ] **T08 — `aw review [--base main]`**
  Diff `<base>...HEAD` + surrounding context → code-reviewer agent → verdict line
  (APPROVE / APPROVE WITH NITS / REQUEST CHANGES) + severity-sorted findings. Plain text,
  never asks questions (headless-safe), non-zero exit on BLOCKER.
  ✓ Run on a branch with a planted bug on 2 different providers → both flag it.

- [ ] **T09 — `aw test-feature "<desc>" [--url]`**
  Reachability check (start local target if down) → test plan first → execute via HTTP/browser
  as qa-tester → write `test-reports/<slug>-<date>.md` (PASS/FAIL per case, exact
  request+response per failure, repro steps, severity) → print report path + 3-line verdict.
  Destructive ops on non-local targets require explicit confirmation.
  ✓ Report file produced against any running local endpoint.

- [ ] **T10 — `aw design-loop "<feature|spec-path>"`**
  Read feature + touched backend code → print ≤5-line UI plan → ui-designer implements →
  start app → Playwright loop (navigate → screenshot → checklist → fix → repeat) → save final
  screenshots → checkpoint commit (never push) → present changes + screenshot paths + judgment
  calls → **stop**. `--iterate "<feedback>"` mode re-runs affected screens only.
  ✓ Loop produces screenshots at both viewports and stops for feedback.

## Phase 5 — Claude Code native layer

- [ ] **T11 — Slash commands + subagents**
  `.claude/commands/{design-loop,test-feature,review}.md` and `.claude/agents/` files that
  reuse the `agents/*.md` prompt text; commands encode the exact workflows of T08–T10.
  ✓ Each command runs inside a Claude Code session in the target repo.

- [ ] **T12 — Headless verification**
  `claude -p "/review"` works from the target repo (known risk: Keychain "Not logged in" —
  if it reproduces, document fallback `aw review --provider anthropic`).
  ✓ Headless run produces a plain-text verdict, or fallback documented in README.

## Phase 6 — Real project + acceptance

- [ ] **T13 — `aw init` onboarding**
  Interactive: asks target repo path, run commands/ports, base URL, test account, staging URL
  (optional), viewports, off-limits — writes `aw.config.json` + extends (never overwrites) the
  target repo's CLAUDE.md/.claude/.
  ✓ Running it in a scratch repo yields a valid config and merged CLAUDE.md.

- [ ] **T14 — Wire to the real project + handoff acceptance checks**
  Point at the chosen repo, then run the handoff's acceptance sequence: trivial `design-loop`
  change → one feedback round ("make the heading bigger") → `test-feature` on a health
  endpoint → `review` on the branch → show final file tree.
  ✓ All four checks behave as specified in docs/HANDOFF.md.

- [ ] **T15 — Offers (build only if requested)**
  Offer: (a) pre-push hook running headless review, blocking on BLOCKER; (b) design-loop
  video-recording variant.
  ✓ Offered to the developer; built only on request.

## Phase 7 — Dashboard (web management panel)

- [ ] **T16 — Run manifest + workspace store (retrofit T08–T10)**
  Every workflow run writes a structured JSON manifest (run id, workspace, agent,
  provider/model, timing, findings/cases/screens, artifact paths) under
  `~/.agent-workflows/<workspace>/runs/` — outside the target repo, like agent-test-env's
  `~/.agent-test-studio` pattern. A *workspace* = named target repo + its `aw.config.json`
  + run history.
  ✓ All three workflows produce a valid manifest readable by a schema test.

- [ ] **T17 — Dashboard skeleton**
  `dashboard/` Next.js app (localhost only): reads the store, workspace switcher, run list
  with status/agent/provider filters, run detail routing.
  ✓ Lists runs from ≥2 workspaces and opens a run detail page.

- [ ] **T18 — Review UI (Bitbucket-like)**
  Side-by-side/unified diff viewer with inline findings pinned to `file:line`, severity
  badges + filters (BLOCKER/MAJOR/MINOR/NIT), verdict banner, copyable proposed fixes.
  ✓ A T08 run's findings render inline on the correct diff lines.

- [ ] **T19 — Test report UI**
  PASS/FAIL case table, case detail with exact request/response, repro steps, severity;
  history of reports per feature.
  ✓ A T09 report renders fully; failures show request+response verbatim.

- [ ] **T20 — Design gallery**
  Screenshot grid per feature (viewport side-by-side, run-over-run comparison), video player
  (T15b variant), feedback box that triggers `aw design-loop --iterate "<feedback>"`.
  ✓ Screenshots of a T10 run display at both viewports; feedback round-trips to a new run.

- [ ] **T21 — Workspace & agent settings management**
  Workspace CRUD (attach repo path), per-agent provider/model editor writing
  `aw.config.json`, guardrail/viewport settings, run-history housekeeping (delete/archive).
  ✓ Provider change made in UI is picked up by the next CLI run.

- [ ] **T22 — Trigger + live logs from UI**
  Start any workflow from the dashboard (args form), stream live agent output (SSE),
  cancel a running job.
  ✓ A review run started in the UI streams logs and lands in the run list on finish.
