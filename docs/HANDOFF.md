# HANDOFF: Local Agent Workflows (UI Design Loop, Feature Tester, PR Reviewer)

You are Claude Code, working in this repository on the developer's local machine.
Read this entire document, then execute it top to bottom. Do not skip Step 0.

## Who you're working with

- A backend developer. Strong on APIs, databases, and infrastructure. Does **not**
  want to hand-write frontend code.
- They will review your work through screenshots and reports, give feedback in
  plain language, and expect you to iterate until they approve.

## Goal

Set up three repeatable, fully local workflows in this repo, each invocable as a
slash command and backed by a dedicated subagent:

1. `/design-loop` — implement the UI for a feature on the current branch,
   visually self-verify it in a real browser (Playwright), save screenshots,
   present them for design review, and iterate on the developer's feedback.
2. `/test-feature` — black-box test a described feature or bug against a running
   backend and write a findings report.
3. `/review` — review the current branch's diff like a strict senior engineer.
   Must also work headless via `claude -p "/review"`.

Everything you create lives inside the repo (`CLAUDE.md` + `.claude/`) so it is
versioned with the code and works in any future session.

---

## Step 0 — Discovery (do this first, build nothing yet)

Explore the repository and determine:

- Frontend: framework, component library / design system, styling approach,
  dev-server command and port. If there is no frontend yet, note that — you will
  scaffold one in the first `/design-loop` run and should ask which framework.
- Backend: how to run it locally, port, where routes/endpoints live, how auth
  works, how to get a valid session/token locally.
- Package manager, test framework, lint/format commands.
- Any existing `CLAUDE.md`, `.claude/` config, or git hooks — **extend, never
  overwrite**.

Then ask the developer, in a single batch, only the questions you could not
answer from the code:

1. Design reference: match the existing app's look? A Figma link? Or free rein
   with a described style?
2. Test account: credentials for local testing, or how to seed one.
3. Should `/test-feature` also support a deployed staging URL? If yes, which?
4. Screenshot viewports (defaults: 375x812 mobile, 1440x900 desktop).
5. Anything off-limits even locally (e.g., a shared dev database).

Wait for the answers before proceeding.

## Step 1 — Prerequisites

- Verify the Playwright MCP server is available among your tools. If it is not,
  stop and tell the developer to run
  `claude mcp add playwright -- npx @playwright/mcp@latest` and restart the
  session. Do not improvise a substitute.
- Create `screenshots/` and `test-reports/` directories and add both to
  `.gitignore`.

## Step 2 — `CLAUDE.md`

Create (or extend) `CLAUDE.md` at the repo root. Keep it short — only
always-true facts:

- One-paragraph project overview.
- Exact commands: run backend, run frontend, run tests, lint. Ports and URLs.
- Frontend conventions found in Step 0: framework, component library, file
  layout, styling rules.
- Design rules: reuse existing components before creating new ones; follow
  existing spacing/color tokens; every screen must work at both agreed
  viewports.
- Testing rules: which account to use, never touch production.
- Workflow rule: design and test tasks always end by presenting file paths to
  screenshots or reports and then **stopping for feedback**. Never `git push`
  without explicit approval.

## Step 3 — Subagents (`.claude/agents/`)

Create three subagents as Markdown files with YAML frontmatter, using the
current Claude Code conventions (`name`, `description`, `tools`, ...). Write
action-oriented descriptions so delegation happens automatically.

### `ui-designer`
- Tools: file read/edit, bash, and the Playwright MCP tools.
- Prompt must include: follows `CLAUDE.md` conventions strictly; **never claims
  UI work is finished without having viewed it rendered in the browser**;
  self-review checklist before presenting — no console errors, renders
  correctly at both viewports, interactive states work (hover, click, submit,
  loading, error, empty), visually consistent with the rest of the app.

### `qa-tester`
- Tools: file read, bash, Playwright MCP. **No editing of application source.**
  May write throwaway scripts under `test-reports/tmp/`.
- Prompt must include: you verify behavior, you do not fix it; derive a test
  plan covering happy path, edge cases, invalid input, and authn/authz; prefer
  real HTTP calls, use the browser for UI-visible behavior; record the exact
  request and response for every failure.

### `code-reviewer`
- Tools: read-only (file reading, grep/glob, read-only git via bash). No edit
  or write tools.
- Prompt must include: strict but practical senior reviewer; every finding
  references `file:line`, explains the actual risk, and proposes a concrete
  fix; severity levels BLOCKER / MAJOR / MINOR / NIT; ends with a verdict; no
  filler praise.

## Step 4 — Slash commands (`.claude/commands/`)

### `/design-loop` (`design-loop.md`)
Argument: feature description, or a path to a spec file. The command prompt
must encode this exact workflow:

1. Read the feature description and the backend code it touches (endpoints,
   models) to understand the data contract.
2. Print a UI plan (screens, components, states) in at most 5 lines, then
   proceed without waiting.
3. Delegate implementation to the `ui-designer` subagent.
4. Start the backend and frontend locally.
5. Playwright loop: navigate to every touched screen -> screenshot -> check
   against the self-review checklist -> fix -> repeat until clean.
6. Save final screenshots to `screenshots/<feature-slug>/` named
   `<screen>-<viewport>.png`.
7. Commit a checkpoint on the current branch. Never push.
8. Present for review: short list of changes, the screenshot file paths, and
   any judgment calls you made. Then **stop and wait for feedback**.
9. On feedback: apply it, re-run the Playwright loop for affected screens only,
   re-present. Repeat until the developer approves.

### `/test-feature` (`test-feature.md`)
Arguments: feature/bug description; optional target base URL (default: local).

1. Ensure the target is reachable; if it is local and down, start it.
2. Write the test plan first: happy path, edge cases, invalid inputs, auth
   checks — and the exact reproduction steps if this is a bug report.
3. Execute via HTTP and/or the browser, using only the designated test account.
4. Delegate execution to the `qa-tester` subagent.
5. Write `test-reports/<slug>-<date>.md` containing: what was tested, PASS/FAIL
   per case, exact request + response for each failure, repro steps, severity,
   and (bonus, not required) a suspected cause with file references.
6. Present the report path plus a 3-line verdict summary. Fix nothing unless
   asked.

Rule: never run destructive operations (deletes, migrations, bulk writes)
against any non-local target without explicit confirmation.

### `/review` (`review.md`)
Argument: base branch (default `main`).

1. Diff `<base>...HEAD` and read enough surrounding context of changed files.
2. Delegate to the `code-reviewer` subagent.
3. Check: correctness and logic, error handling, security (input validation,
   authorization on every new endpoint, secrets, injection), API contract
   consistency, obvious performance traps (e.g., N+1 queries), missing tests,
   and `CLAUDE.md` convention violations.
4. Output: one verdict line (APPROVE / APPROVE WITH NITS / REQUEST CHANGES),
   then findings sorted by severity.

Must work non-interactively: when run via `claude -p "/review"`, produce plain
text and never ask questions back.

## Step 5 — Offer, but do not build unprompted

- A git pre-push hook that runs `/review` headless and blocks the push on any
  BLOCKER finding.
- A `/design-loop` variant that records a Playwright video instead of
  screenshots.

## Guardrails (bake into `CLAUDE.md` and every agent)

- Never `git push`, never create or comment on PRs — the human does that.
- Never point tests at production. Staging only with an explicit URL.
- Never commit secrets, `.env` files, or screenshots containing real user data.
- Ask before adding dependencies.
- When uncertain about a product decision, present options instead of silently
  guessing.

## Acceptance check (run this before declaring the setup done)

1. Run `/design-loop` on a trivial change (e.g., add a simple placeholder
   page). It must produce screenshots and a summary, then stop for feedback.
2. Give it one round of test feedback ("make the heading bigger"). It must
   revise, re-screenshot, and re-present.
3. Run `/test-feature "the health endpoint returns 200 with build info"` (or
   the closest real endpoint). It must produce a report file.
4. Run `/review` on the resulting branch. It must produce a verdict with
   severity-sorted findings.
5. Show the developer the final tree of every file you created or modified.
