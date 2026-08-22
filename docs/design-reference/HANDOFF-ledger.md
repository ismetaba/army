# Handoff: agent-workflows — local panel ("Ledger" design)

## Overview
`agent-workflows` is a local, single-user web panel that a backend developer uses to run and
review AI-agent tasks across several code repositories. It runs on `127.0.0.1:4400`, has no
login, no multi-user concepts, and is desktop-first (1440 design width; the task list is also
specified at 375).

The flow is strictly three levels deep:

1. **Entry** — select or create a workspace (= one code repository). Nothing else is reachable
   before a workspace is chosen.
2. **Workspace ledger** — start a task, or open an existing one.
3. **Task detail** — live progress while running, rich results when finished.

Three fixed task types:

| type | what it does | result shape |
|---|---|---|
| `review` | AI reviews the branch diff like a strict senior engineer | verdict + findings pinned to code lines |
| `test-feature` | AI black-box-tests the running backend | PASS/FAIL case report with request/response evidence |
| `design-loop` | AI implements UI, screenshots it at mobile + desktop, optionally records video, then stops | screenshot/video gallery + feedback box |

## About the design files
`Panel Ledger.dc.html` in this bundle is a **design reference written in HTML** — a prototype
showing intended look and behaviour, not production code to copy. The task is to **recreate
these screens in the target codebase's own environment** (React, Vue, Svelte, whatever the repo
already uses) with its established patterns, routing and state libraries. If no frontend exists
yet, pick the framework that fits the project and implement the designs there.

The file is one long canvas: every screen is an artboard laid out top to bottom, each labelled
with a small monospace caption (`01 · ENTRY`, `02 · WORKSPACE LEDGER`, …) and carrying a
`data-screen-label` attribute. Open it in a browser and scroll.

## Fidelity
**High fidelity.** Colours, type, spacing and states are final and should be reproduced closely.
Two caveats:

- Screenshot and video areas in `04c` are **placeholders** (diagonal-striped blocks with a
  monospace caption). Real artifacts replace them 1:1.
- The live run in `02` and `04d` is a **simulation** on a timer so the motion can be reviewed:
  the run ticks for 44 s, lands its verdict, stamps it, then a new run starts. In the real app
  these values come from the backend; do not port the simulation loop.

---

## Design tokens

### Colour
| token | hex | use |
|---|---|---|
| `paper` | `#f7f4ee` | screen background |
| `paper-card` | `#fffdf8` | slips (modals, drawers), diff panel |
| `paper-tint` | `#f1ece0` | command strips, log console, active ledger row |
| `paper-hover` | `#f2ede2` | row hover |
| `canvas` | `#e8e3d8` | the area *around* screens (canvas only, not app chrome) |
| `ink` | `#17150f` | primary text, 2px section rules, primary button fill |
| `ink-2` | `#5c564a` | body copy, secondary values |
| `ink-3` | `#6b6459` | field labels, quiet actions |
| `ink-4` | `#8a8378` | meta, column headers, disabled |
| `rule` | `#ddd6c8` | 1px hairlines |
| `rule-2` | `#d6cfc0` | screen border, chip border |
| `rule-dotted` | `#c9c1b0` | dotted leaders in the contents list |
| `accent` | `#b4531f` | the one live mark: running state, links, primary CTA, carets |
| `accent-hover` | `#8e3f16` | accent hover |
| `ok` | `#2f6b45` | done / pass |
| `danger` | `#a32b21` | error / fail / BLOCKER-MAJOR / destructive |
| `danger-tint` | `#f6ece9` | verdict banner, failing row background |
| `danger-deep` | `#5c1512` | BLOCKER severity dot |
| `warn` | `#96631a` | awaiting feedback / MINOR |
| `warn-tint` | `#f6f0e2` | awaiting-feedback callout |
| `diff-add` | `#e7efe6` | added diff line background |
| `diff-del` | `#f7e6e3` | removed diff line background |
| `diff-del-ink` | `#7a2d24` | removed diff line text |

**Never encode status by colour alone.** Every status pairs a colour with a word *and* a shape:

| status | mark | word |
|---|---|---|
| running | 7px solid accent square, opacity pulse | RUNNING |
| done / pass | 7px solid green square | DONE / PASS |
| error / fail | 7px square with 45° red hatch | ERROR / FAIL |
| awaiting | 7px hollow amber square (1.5px border) | AWAITING FEEDBACK |
| cancelled | 7px dashed grey square | CANCELLED |

Severity uses the same system: BLOCKER solid deep red · MAJOR solid red · MINOR hollow amber ·
NIT dashed grey — always followed by the label and a count.

### Type
Two families, loaded from Google Fonts:

- **Archivo** (400 / 500 / 600) — all human-written chrome: headings, descriptions, table cell
  names, button-free prose.
- **Martian Mono** (400 / 500) — everything machine-generated or machine-addressed: task ids,
  paths, commands, model ids, diffs, logs, field labels, column headers, status words, counts.

Martian Mono is wide; every mono run carries negative tracking. Scale as used:

| role | font | size / weight | tracking |
|---|---|---|---|
| screen title | Archivo | 46px / 600 | -0.035em |
| section head | Archivo | 19px / 600 | -0.02em |
| verdict | Archivo | 30px / 600 | -0.03em |
| big number (elapsed) | Archivo | 30px / 600 | -0.03em |
| workspace name (entry) | Archivo | 24px / 500 | -0.02em |
| body | Archivo | 13–15px / 400, line-height 1.55–1.7 | — |
| task id | Martian Mono | 10.5–15px / 400 | -0.04em … -0.05em |
| code / diff / log | Martian Mono | 9.5–10.5px / 400, line-height 1.7 | -0.045em |
| field label (small caps) | Martian Mono | 9–9.5px / 500 UPPERCASE | +0.14em |
| column header | Martian Mono | 8.5px / 500 UPPERCASE | +0.12em |
| status word | Martian Mono | 9.5px / 500 UPPERCASE | -0.02em |
| button label | Martian Mono | 10px / 500 UPPERCASE | +0.08em |

### Geometry, spacing, elevation
- **Radius: 0 everywhere.** No rounded corners, anywhere.
- **No shadows** except two docked surfaces: the add-workspace slip and the failure drawer
  (`-24px 0 48px -36px #17150f`), and the centred create-task slip
  (`0 20px 44px -34px #17150f`).
- Rules do the work boxes normally do: 2px ink under a section head, 1px `rule` between rows,
  1px dotted for softer separations.
- Spacing scale in use: 6 · 8 · 10 · 12 · 14 · 18 · 20 · 26 · 32 · 40 · 44px.
- Screen padding: 40px horizontal on task screens, 64px on the entry screen.
- Field inputs are **underlines, not boxes**: `border-bottom: 1px solid` + 8–9px bottom padding.
  Ink underline = filled, accent underline = focused, `rule` underline = empty/optional.
- Command / evidence blocks: `paper-tint` background + 3px solid ink left border, 11–15px padding.

### Motion
| animation | where | spec |
|---|---|---|
| `tick` | running square | opacity 1 → .35 → 1, 1.4s ease-in-out infinite |
| `caret` | text carets | opacity 1 → 0 step, 1s infinite |
| `rise` | new log line | opacity 0 + translateY(5px) → 0, .35s ease-out, on mount only |
| `draw` | entry top rule | scaleX 0 → 1 from left, .85s cubic-bezier(.2,.8,.3,1), once on load |
| `stamp` | verdict stamp | scale 1.7 rot -9° → scale .93 rot -2° → scale 1 rot -3°, .5s cubic-bezier(.2,1.5,.4,1) |
| `flip` | findings counter, newly filed row | opacity 0 + translateY(-5px) → 0, .35s ease-out, replays when the value changes |
| progress bar + nib | live run | `width` / `left` transition .9s linear |
| hover | rows, links, buttons | background/color/transform transition .18s |

Nothing else moves. Idle rows are completely still.

---

## Screens

### 01 · Entry — select or create a workspace
**Purpose:** choose the repository to work in. Nothing else is reachable first.

Layout: a 48px top bar (`AGENT-WORKFLOWS` left, `LOCAL · 127.0.0.1:4400` right, 1px rule under),
then a two-column body with 72–80px vertical padding: a 200px left margin column holding
`CONTENTS` + a two-line note, and a max-900px main column.

Main column: 46px title "Open a workspace", a one-sentence explanation, then a **table of
contents**, not cards. The list opens with a 2px ink rule that draws in from the left on load.
Each entry is a row: index (`01`, accent when the workspace has a running task), name (Archivo
24/500) with the absolute path beneath it in mono, a **dotted leader** filling the gap, then
right-aligned meta (`1 task · 5m ago`) and a `→`. A running workspace also shows a bordered
accent chip `RUNNING 1m12s` next to its name. The last row is `+ Add workspace` in accent with
`⌘N` on the right.

Rows: 22px top / 20px bottom padding, 1px rule between, hover tints to `paper-hover` and the
arrow slides 4px right.

Content used: `gold-token` (`/Users/deniz/code/gold-token`, 1 task, running) · `fixture`
(7 tasks, 2d ago) · `scratch` (no tasks).

**01b — first launch:** same shell, "Nothing filed yet" + one sentence + the add row alone.

**01c — add workspace (2 steps):** a 420px slip docked to the right edge, dimming the page
behind it to 45%. Step 1: `REPO FOLDER` (underline field + `BROWSE`) and `NAME` (accent
underline, blinking caret, helper "taken from the folder — editable"). Step 2: `DEFAULT PROVIDER`
as four chips (`lmstudio` selected = ink fill, others outlined) and `MODEL ID`. A two-segment
progress rule under the header shows which step you are on. Footer: `CANCEL` / `NEXT →`, then
`← BACK` / `CREATE`.

### 02 · Workspace ledger
**Purpose:** start a task, watch the current one, scan the history.

Top bar (16/40px): workspace switcher (name + ▼ inside a 1px ink box), repo path, backend health
(green square + `backend up · :3000`), then `SETTINGS` and `← WORKSPACES`.

Body is a 200px left margin column + main column, 36px gap.

**Left margin — the live entry.** While a run is active: `IN PROGRESS`, the task id, elapsed time
at 30px, a 2px progress rule with a 6×8px ink nib riding its right edge, the current step, the
findings count (flips on change) and the severity line. When the run lands, the same block
becomes `JUST FILED` with the rotated `REQUEST CHANGES` stamp, the finding summary and
`OPEN RESULT ↗`. Beneath: a `LOG` block (last 4 lines, each rising in, caret at the end) and a
`THIS WEEK` list (runs 8 · last test 5/6 · last review CHANGES · design loop AWAITING).

**Main column — "Start a task".** Section head + `THREE KINDS`, then three numbered entries in a
row divided by 1px vertical rules (no cards): `01 Review`, `02 Test feature`, `03 Design loop`,
each with its one-line description and `START →` (accent on the first).

**Main column — "Ledger".** Section head with `ACTIVE` / `ARCHIVED` (active underlined 2px
accent) and kind counts (`all 8 · review 4 · test-feature 2 · design-loop 2`). Table columns:
`TIME · TASK · TYPE · STATUS · PROVIDER / MODEL · DUR · ACTIONS`
(grid `64px 1.7fr 0.9fr 1.15fr 1.5fr 0.6fr 0.8fr`, 14px gap, 14px row padding, 1px rule between).
The running row sits on `paper-tint` with a 3px accent inset left bar and shows `WATCH` instead
of row actions; finished rows show `ARCH` / `DEL` right-aligned (hover: ARCH → ink, DEL → danger).
Rows hover to `paper-hover`.

**02b — empty ledger:** section head + centred "No entries yet" / "start a task above — the first
run is filed here".

**02c — 375:** same content stacked. 48px header, a tinted in-progress card (elapsed + findings +
progress rule + step), a single-line filter row, then one block per run (id + status right,
meta line, provider line, `ARCHIVE` / `DELETE`), and a sticky bottom bar `new task…` + `START`.

### 03 · Create task — "the slip"
A 720px sheet centred over the dimmed workspace. Header: index + type name (Archivo 22/600) and
`✕`, under a 2px ink rule. Then the type's description, then per-type fields:

- **Review** — `BASE REF` (accent underline, value `main`, caret, quick chips `develop`
  `HEAD~1`), helper "diff is taken against this ref".
- **Test feature** — `WHAT TO VERIFY` (multiline underline field) + optional `TARGET URL`.
- **Design loop** — `FEATURE DESCRIPTION` + a `record video` OFF/ON segmented control with
  "adds ~40s per screen".

All three then show a collapsed `PROVIDER / MODEL OVERRIDE` row (right side reads
`inherit — lmstudio / qwen3-coder-30b-a3b-instruct`) and a read-only **WILL RUN** strip:
`npx tsx src/cli.ts <type> --workspace gold-token` with `COPY`.
Footer: `esc to cancel · ⌘↵ to start` on the left, `CANCEL` and the accent `START TASK` on the right.

### 04 · Task detail (shared header)
Identical across all four result types — only the body under the tabs changes:

2px ink rule, then task id (mono 15px) + status mark/word, a meta row
(`TYPE · AGENT · PROVIDER · BASE · CREATED · DURATION`), the exact command in a tinted strip with
`COPY`, and on the right `ARTIFACTS` links (`diff`, or `shots` / `video` for design-loop).
Tabs `RESULT · LOG` sit under the header, active underlined 2px accent.

**04a — Review (flagship).** Verdict banner: 4px danger left bar on `danger-tint`,
`REQUEST CHANGES` at 30px with "6 findings (3 MAJOR, 1 MINOR, 2 NIT) across 3 changed files";
the other two verdict states (`APPROVE`, `APPROVE WITH NITS`) are shown beside it for reference.
Severity filter row: `BLOCKER 0 · MAJOR 3 · MINOR 1 · NIT 2`, active one underlined.
Then a `320px 1fr` split: left a findings jump-list (index, severity mark + label, title, file:line;
first item active on tint), right the unified diff in a bordered `paper-card` panel with its own
`max-height:520px; overflow:auto` — **the page never scrolls sideways**. Diff rows are
`44px 1fr` grids, line numbers right-aligned in `#a8a094`, added lines on `diff-add`, removed on
`diff-del`. The finding card is inserted **inline under the offending line** (line 22,
`const SEARCH_API_TOKEN = "sk_live_…"`): severity mark + `MAJOR` + `api/server.mjs:22`, title at
16/600, a `RISK` paragraph, a `FIX` paragraph, and a copyable one-line fix.

**04b — Test feature.** Title = the verification sentence. `PASS 5/6` at 26px with `— 1 FAIL`,
a six-segment bar (five solid green, one red-hatched) and the kind mix. Case table columns
`CASE · NAME · KIND · STATUS · SEVERITY`, FAIL row first on `danger-tint` with a 3px danger inset
bar; KIND is an outlined chip (happy / edge / invalid / auth).
**04b-2 — failure drawer:** 560px panel docked right. Case id + `FAIL · MAJOR`, the case name,
then `REQUEST` and `RESPONSE` as separate mono blocks (request tinted with ink bar, response
tinted with danger bar), each with `COPY`, a one-line explanation of the expectation, and
numbered `REPRO` steps. Footer pages through cases (`case 2 of 6`, `← PREV` / `NEXT →`).

**04c — Design loop.** Header status is `AWAITING FEEDBACK` (hollow amber square) and the right
side carries a `COMPARE WITH` dropdown (then/now against an older task id). Body is `1fr 340px`.
Left: galleries grouped by screen (`home`, `about`), each a 2px-ruled section head with the
desktop shot (520×300) and mobile shot (150×300) side by side under `DESKTOP · 1440` /
`MOBILE · 375` labels, then a `recording` section with a 690×300 player, square play button and
a scrub bar (`00:00 / 00:42`). Right column: an amber "AWAITING FEEDBACK" callout explaining the
loop stopped on purpose, `JUDGMENT CALLS` (numbered), `FEEDBACK HISTORY` (timestamped iterations),
and `YOUR FEEDBACK` — an underlined textarea with a caret, a copyable
`… design-loop --iterate 20260821-173002` chip, and `DISCARD` / `SEND & ITERATE`.

**04d — Running.** Same header with the pulsing accent square, `ELAPSED` in the meta row, and a
`CANCEL RUN` outline button (hover fills danger) on the right; `LOG` is the active tab. Body:
a summary row (elapsed 22px, findings counter, severity line, `AUTO-SCROLL` indicator), the 3px
progress rule with the nib, and a 300px `overflow:auto` console on `paper-tint` with a 3px ink
left bar. Earlier lines are muted `#a19a8d`, new lines arrive in ink with the rise animation, a
caret sits at the tail. Footer note: "the result tab fills in the moment the verdict lands".
**04d-2** shows the finished state: `DONE` + duration, `ARCHIVE` / `OPEN RESULT`, the verdict
banner, and the last three log lines including `verdict: REQUEST CHANGES`.

### 05 · Workspace settings
180px section index on the left, max-860px content. Four ruled sections:

1. **Defaults** — `PROVIDER` (select) + `MODEL ID` (text).
2. **Agent overrides** — three rows `ui-designer` / `qa-tester` / `code-reviewer`, each with a
   provider select defaulting to `inherit (lmstudio)` and a model field. When `claude-cli` is
   chosen the row's underlines turn danger and an inline callout appears:
   *"claude-cli works only via the .claude/ native path — CLI runs will refuse it."*
3. **App** — backend start command + port, frontend start command + port, base URL, health path,
   staging URL, test account user, and `PASSWORD ENV VAR` (label spells out "name only, never the
   value"). **There is no password field anywhere in this product.**
4. **Workspace** — rename (outline ink button) and forget (outline danger button) with the
   explanation that forgetting removes only the registry entry and run history; the repository
   on disk is untouched.

---

## Interactions & behaviour
- **Navigation:** entry → workspace → task detail. The workspace switcher in the top bar jumps
  between workspaces without going back to entry. `← LEDGER` / `← WORKSPACES` walk back up.
- **Starting a task:** card `START →` opens the slip with that type pre-selected; `⌘↵` starts,
  `esc` cancels. On start, the run appears at the top of the ledger as the running row and the
  left margin switches to the live entry.
- **Watching:** `WATCH` on the running row opens 04d. The result tab becomes available the moment
  the verdict lands — no refresh, no navigation.
- **Cancelling:** `CANCEL RUN` in 04d sets the run to `CANCELLED` (dashed grey mark) and freezes
  the elapsed clock.
- **Filtering:** `ACTIVE` / `ARCHIVED` and the kind chips are independent; counts reflect the
  active filter. `ARCH` moves a run to the archived bucket, `DEL` removes it permanently
  (confirm before deleting).
- **Copy affordances:** every `COPY` copies the exact monospace string next to it.
- **Feedback loop:** `SEND & ITERATE` posts the note and starts a new design-loop run linked to
  the previous task id; history gains an entry.
- **Overflow rule (hard):** diffs, logs, request/response blocks and the case table scroll inside
  their own containers. The page itself never scrolls horizontally at any width.
- **Responsive:** below ~900px the ledger becomes the 375 layout — stacked run blocks, in-progress
  card at the top, sticky new-task bar at the bottom. Task-detail two-column bodies stack, with
  the diff and log panels keeping their internal scroll.

## Empty & error states
| where | state |
|---|---|
| entry | "Nothing filed yet" + one sentence + the add row |
| ledger | "No entries yet — start a task above — the first run is filed here" |
| ledger, archived | same treatment, "No archived runs" |
| run failure | row status `ERROR` + one-line reason (`provider refused — rate limited after 9s`); the detail's LOG tab holds the trace |
| review with no findings | verdict `APPROVE`, findings list replaced by "No findings — 3 files reviewed" |
| test with no cases | "The agent produced no cases" + the raw log link |
| design-loop with no shots | "No screenshots captured" + the log link; feedback box stays available |
| backend down | health mark turns danger with the word `backend down`; test-feature start is disabled with the reason inline |
| claude-cli on a CLI agent | inline danger callout in settings, save blocked for that row |

## State
Per workspace: `id, name, path, defaultProvider, defaultModel, agentOverrides{ui-designer,qa-tester,code-reviewer}, app{backendCmd, backendPort, frontendCmd, frontendPort, baseUrl, healthPath, stagingUrl, testUser, passwordEnvVar}`.

Per task: `id (`<type>-YYYYMMDD-HHMMSS`), workspaceId, type, status (running|done|error|cancelled|awaiting), provider, model, agent, createdAt, duration, archived`, plus a type-specific result:

- review → `baseRef, verdict (APPROVE|APPROVE_WITH_NITS|REQUEST_CHANGES), findings[{severity, title, file, line, risk, fix, fixSnippet}], changedFiles, diff`
- test-feature → `target, cases[{id, name, kind, status, severity, request, response, repro[]}], passed, total`
- design-loop → `screens[{name, shots[{viewport, url}]}], video, judgmentCalls[], feedbackHistory[{at, iteration, text}], awaitingFeedback`

UI state: active workspace, ledger filters (`active|archived`, kind), selected task, active tab
(`result|log`), open slip + its draft, open failure drawer + selected case, feedback draft.

Data: the panel polls or streams run status (the design shows `auto-refresh 2s`); the log tab
streams append-only lines; elapsed time is computed client-side from `startedAt`.

## Accessibility
- Status and severity are never colour-only — always mark shape + word. Keep that pairing when
  you re-implement; do not "simplify" to a coloured dot.
- Body copy sits at 4.5:1 or better on paper; the muted `#8a8378` is used only for meta text at
  9–10px and should not carry information that appears nowhere else.
- Focus: the accent underline is the focus signal for fields; give every interactive element a
  visible focus ring or underline in your framework (never remove outlines without replacing them).
- Keyboard: `⌘K` command palette, `⌘N` add workspace, `⌘↵` start task, `esc` closes slips and
  drawers. Docked slips and drawers are modal — trap focus, return it on close.
- Live regions: the running log and elapsed timer should be `aria-live="polite"` but throttled;
  announce the verdict once when it lands rather than every line.
- Motion: honour `prefers-reduced-motion` — drop the pulse, stamp, rise and draw animations and
  keep the value updates.
- Targets: mobile rows and actions must stay ≥44px tall on the 375 layout.

## Assets
None. No logos, no icon font, no images. Every mark is a CSS square, hatch or border; the two
fonts come from Google Fonts:
`https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600&family=Martian+Mono:wght@400;500&display=swap`

## Files
- `Panel Ledger.dc.html` — the design reference, all screens in one canvas.
  Screens in order: intro note · 01 entry · 01b first launch · 01c step 2 · 02 workspace ledger ·
  02b empty ledger · 02c 375 · 03 create task · 03b other types · 04a review result ·
  04b test result · 04b-2 failure drawer · 04c design loop · 04d running · 04d-2 finished ·
  05 settings.
- `support.js` — the runtime that renders the reference file. Not part of the design; do not port it.
