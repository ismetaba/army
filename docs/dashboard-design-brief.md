# Claude Design prompt — agent-workflows dashboard (v2, workspace-first flow)

Paste everything below the line into Claude Design.

---

Design the UI for **agent-workflows** — a local, single-user web panel a backend developer
uses to run and review AI-agent tasks across several code repositories. It runs on
`127.0.0.1:4400`, has no login, desktop-first (1440 wide; also show the task list at 375).
Deliver **dark (primary) and light** versions.

## Core flow (this exact information architecture)

1. **Entry screen — select or create a workspace.** Nothing else is reachable before a
   workspace (= one code repository) is chosen.
2. **Workspace dashboard — create a task, or open an existing task.** A *task* is one run of
   one of the three task types.
3. **Task detail — live progress while running; rich results when finished.**

## The three task types (fixed)

- **Review** — an AI reviews the branch diff like a strict senior engineer; result: a verdict
  (APPROVE / APPROVE WITH NITS / REQUEST CHANGES) + findings pinned to code lines.
- **Test Feature** — an AI black-box-tests the running backend; result: a PASS/FAIL case
  report with exact request/response evidence.
- **Design Loop** — an AI implements UI, screenshots it in a real browser at mobile+desktop,
  optionally records a video, then stops for feedback; result: a screenshot/video gallery
  with a feedback box.

## Who it's for / tone
A backend developer who dislikes raw terminal output. Information-dense, calm, scannable —
Linear / GitHub / good CI dashboard energy. Engineering aesthetic: quiet layered surfaces,
one restrained accent, monospace for everything machine-generated (task ids, code, diffs,
logs, commands, model ids), clean sans for chrome. No hero art, no marketing.

## Tokens to establish (show a small style tile)
- **Status pills:** running (blue + subtle spinner), done (green), error (red), cancelled (grey).
- **Severity tags:** BLOCKER (deep red), MAJOR (red-orange), MINOR (amber), NIT (grey).
- **Task-type identity:** review / test-feature / design-loop — each a quiet icon + label,
  usable on cards, chips and table rows.
- **Provider chips:** lmstudio, openai, anthropic, claude-cli.

## Screens (one artboard each, dark; plus light variants of 1, 2, 4a)

**1. Entry — workspace select/create.**
A centered launcher, product name "agent-workflows" on top. A grid of workspace cards:
`gold-token` (/Users/…/gold-token, 1 task, "last task 5m ago"), `fixture` (7 tasks),
`scratch` (0). Plus an **"Add workspace"** card opening a compact 2-step wizard: step 1 pick
the repo folder + name it; step 2 default provider (select) + model id (input). Also design
the **first-launch empty state** (no workspaces yet: one friendly line + the Add card).

**2. Workspace dashboard.**
Top bar: workspace name + repo path, a **compact workspace switcher dropdown** (jump between
projects without returning to entry), a settings icon, and "back to workspaces".
Body, in order:
- **"New task" creation row** — the three task types as horizontal cards, each with its icon,
  name and a one-line description (from the list above) and a "Start" affordance.
- **Stats strip** (small): tasks total, last review verdict chip, last test pass-rate, last
  design-loop "awaiting feedback" indicator.
- **Task list**: filters `active | archived` and kind chips `all · review · test-feature ·
  design-loop` with counts; table columns TASK (monospace id `review-20260822-095830`), TYPE,
  STATUS pill, PROVIDER / MODEL (`lmstudio / qwen3-coder-30b-a3b-instruct`), CREATED,
  DURATION, row actions Archive / Delete. A `running` row shows the spinner pill and a
  "watch live" link. Include the empty state ("no tasks yet — start one above").

**3. Create task.**
The Review card opens a focused modal/panel: type already chosen (shown as its icon+name),
per-type fields (Review: "Base ref" defaulting to `main`; Test Feature: "What to verify"
textarea + optional target URL; Design Loop: feature description + optional video toggle),
an optional provider/model override, and a read-only monospace **"WILL RUN"** command preview
(`npx tsx src/cli.ts review --workspace gold-token`). Cancel / Start task.

**4a. Task detail — Review (flagship).**
Header card: task id + status pill, type, agent (`code-reviewer`), provider/model, created,
duration, BASE `main`, the exact command in a monospace strip, artifact links (`diff`).
Tabs: **Result · Log** (Result renders per-type). Review result:
- verdict banner `REQUEST CHANGES` — "6 findings (3 MAJOR, 1 MINOR, 2 NIT) across 3 changed
  files" (design all three verdict states),
- severity filter chips `BLOCKER 0 · MAJOR 3 · MINOR 1 · NIT 2`,
- two columns: left a findings jump-list, right a unified diff (red/green tints, line
  numbers) with the **finding card inline under the offending line** — example: file
  `api/server.mjs`, line 22 `const SEARCH_API_TOKEN = "sk_live_…"` highlighted, card beneath:
  MAJOR, "Hardcoded API token in source code", a **Risk:** line and a **Fix:** line with copy.

**4b. Task detail — Test Feature result.**
"POST /api/items rejects an item with no name" — pass bar `PASS 5/6 — 1 FAIL`, counts, case
table (CASE `c2`, NAME, KIND badge happy/edge/invalid/auth, STATUS, SEVERITY; FAIL first),
and the slide-in **failure drawer**: exact REQUEST and RESPONSE in separate monospace copy
blocks (`POST /api/items … {"qty":5}` → `201 Created`) + numbered repro steps.

**4c. Task detail — Design Loop result.**
Gallery grouped by screen (`home`, `about`): mobile and desktop screenshots side by side with
viewport labels; a "Compare with" dropdown showing then/now pairs against an older task; a
video player when recorded. "Judgment calls" and "Feedback history" lists, and a **feedback
box** (textarea + a copyable `--iterate` command chip) — this task type ends "awaiting
feedback", make that state visible.

**4d. Task detail — running (live).**
Same header with `running` pill and a **Cancel** button; body is a full-height streaming
monospace log console (auto-scroll), last lines showing the verdict forming. Also show the
just-finished state: `done` pill + an "open result" affordance.

**5. Workspace settings.**
Sections: Defaults (provider select + model input); **Agent overrides** — three rows
ui-designer / qa-tester / code-reviewer, provider dropdown (default "inherit (lmstudio)") +
model field, with the inline error-coloured warning when `claude-cli` is chosen ("claude-cli
works only via the .claude/ native path — CLI runs will refuse it"); App (backend/frontend
start command + port, base URL, health path, test account user + env-var NAME — never a
password field, staging URL); and workspace admin (rename/forget — forget removes only the
registry entry, never the repo).

## Hard constraints
- Machine-generated text is monospace; wide diffs/logs/code scroll inside their own container
  — the page never scrolls sideways.
- Status and severity colours must stay distinguishable in both themes and for red-green
  colour-blind users: always pair colour with a label or icon.
- Private local tool: no avatars, share, notifications, billing.
- Task-detail header and tab structure identical across all types; only the Result body
  changes per type.

## Deliver
A multi-artboard canvas: style tile; screens 1, 2, 3, 4a, 4b, 4c, 4d, 5 in dark; light
variants of 1, 2, 4a. Annotate token choices briefly.
