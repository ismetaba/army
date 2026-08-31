# agent-workflows

Portable agent toolkit providing three repeatable workflows for any target repo:

| Workflow | What it does |
|---|---|
| `design-loop` | Implements UI for a feature, self-verifies in a real browser (Playwright), saves screenshots, stops for design review, iterates on feedback. |
| `test-feature` | Black-box tests a feature/bug against a running backend, writes a findings report. |
| `review` | Reviews the current branch diff like a strict senior engineer. Works headless. |

Each workflow is backed by a dedicated agent whose **LLM provider is selectable**:

- `lmstudio` — local model via LM Studio's OpenAI-compatible API (`http://localhost:1234/v1`, no key)
- `openai` — ChatGPT models via OpenAI SDK (`OPENAI_API_KEY`)
- `anthropic` — Claude models via API (`ANTHROPIC_API_KEY`)
- `claude-cli` — the developer's local Claude Code login (no API key — it bills against their
  Claude subscription). The workflow's toolset is bridged into the CLI over MCP and Claude
  Code's own built-in tools are removed, so the agent's permission profile still bounds it.
  Model is a CLI alias: `opus`, `sonnet`, `haiku`.

Two run paths, one set of agent prompts (`agents/*.md`):

1. **CLI** — `aw <workflow> --provider <p> --model <m>` (TypeScript, Vercel AI SDK v7, own tool loop with fs/bash/git/Playwright tools).
2. **Claude Code native** — `/design-loop`, `/test-feature`, `/review` slash commands + subagents in `.claude/`, incl. headless `claude -p "/review"`.
3. **Dashboard** (Phase 7) — localhost web panel: Bitbucket-like PR review with inline findings, test-report viewer, screenshot/video gallery with feedback loop, multi-workspace + per-agent provider/settings management, run triggering with live logs.

Provider/model per agent is set in the target repo's `aw.config.json` and can be overridden per run with flags.

A workspace carries up to **two target sets** — `backend` and `frontend`, each with its own
`repoRoot`, start command and port — so a product whose API and UI live in two repositories is
ONE workspace: `design-loop` acts in the frontend repo (and may read the backend for the API
contract), `test-feature` targets the backend, and `review` takes `--target backend|frontend`.
Set both with `aw init --repo <api-repo> --frontend-repo <ui-repo> …` or in the panel's
settings. Pre-T23 configs (`repoRoot` + flat `app`) keep working — they are migrated in memory
on read, never rewritten on disk.

## Headless review

Both run paths review a branch unattended, with no TTY and no questions. On this machine the
recorded run went through the **`.claude/` command path** (Outcome A — a real `VERDICT:` on the
first try, no auth problem); the CLI is a fallback, not a workaround.

**1. Native (`.claude/` command path) — verified.** `claude -p` picks the command up from the repo
it runs in, so the *target* repo needs `/review` and its subagent. `scripts/sync-claude.ts` writes
only this repo's `.claude/`, so copy the two files over once per target repo — from this repo, and
until `aw init` does it for you (T13). Reviewing this repo itself needs no copy:

```bash
# in this repo
npx tsx scripts/sync-claude.ts                       # refresh .claude/ from agents/*.md
TARGET=/path/to/target-repo
mkdir -p "$TARGET/.claude/commands" "$TARGET/.claude/agents"
cp .claude/commands/review.md "$TARGET/.claude/commands/"
cp .claude/agents/code-reviewer.md "$TARGET/.claude/agents/"

# in the target repo, on the branch to review
cd "$TARGET"
claude -p "/review main" --output-format text
```

Give it a generous timeout: the command delegates the judgement to the `code-reviewer` subagent,
and the 100-line fixture diff below took **128 s of wall clock over 8 turns** — a real branch takes
longer. No `--allowedTools` / `--permission-mode` flag is needed: the command's `allowed-tools`
frontmatter already covers the read-only git commands and the `Task` call.

Real run, `/Users/matt/Test/aw-fixture` on branch `bug/planted` against `main`, 2026-08-21 —
`exit=0`, empty stderr, 41 lines of stdout (first 10, fixture's planted fake key redacted):

```
VERDICT: REQUEST CHANGES

[BLOCKER] api/server.mjs:22 — Live-looking secret hardcoded and echoed to every client
Risk: `sk_live_…` is committed to git history and returned in the `x-search-token` response header on line 138, with `access-control-allow-origin: *` for non-localhost origins, so any page or proxy hitting `/api/search` harvests the key.
Fix: Delete lines 22 and 138, rotate the key immediately, and if a token is genuinely needed read it from `process.env.SEARCH_API_TOKEN` server-side only.

[BLOCKER] src/components/SearchPanel.tsx:39 — Stored/reflected XSS via `dangerouslySetInnerHTML` on user input
Risk: The raw query is injected as HTML, so `<img src=x onerror=...>` executes arbitrary script in the app origin for any user who types it or lands on a link that seeds it.
Fix: Render as text — `Showing matches for <span>{q}</span>` — and drop `dangerouslySetInnerHTML` entirely.

```

**2. CLI fallback — also verified.** Same reviewer prompt, own tool loop, and the only path that
gates on an exit code. Run from this repo, pointing at the target repo's config:

```bash
npx tsx src/cli.ts review --base main --config /path/to/target-repo/aw.config.json
```

Same branch, provider from that config (`lmstudio` / `qwen3-coder-30b-a3b-instruct`): `exit=0`,
`VERDICT: REQUEST CHANGES` with six findings, stderr `reviewing 3 file(s) against main —
lmstudio/qwen3-coder-30b-a3b-instruct, 4864 B of diff` / `model finished in 1 step(s)`. Add
`--provider anthropic --model claude-sonnet-5` to review with Claude instead; without a key that
run stops with `ANTHROPIC_API_KEY is not set (add it to .env)` and `exit=1`.

**Wiring it into CI or a git hook — as needed.** Mind the difference in what the exit code means:

- `claude -p "/review …"` exits `0` whenever the command *ran*, even on `REQUEST CHANGES` with
  BLOCKERs (a slash command cannot set an exit code). To gate on it, grep the text — with an
  `if`, and checking the CLI's own status, because `cmd && exit 1` as a script's **last**
  statement makes the script exit with *grep's* status, i.e. `1` on a clean review too:

  ```bash
  #!/usr/bin/env bash
  set -uo pipefail
  if ! out=$(claude -p "/review main" --output-format text); then
    echo "$out" >&2; echo "review did not run" >&2; exit 1     # the CLI itself failed
  fi
  echo "$out"
  if grep -q '^\[BLOCKER\]' <<<"$out"; then exit 1; fi
  exit 0
  ```

- `npx tsx src/cli.ts review` follows SPEC § exit codes: `0` clean, `2` a BLOCKER was reported
  *and the verdict is not `APPROVE`*, `1` the run itself failed — usable directly as a pre-push
  or CI gate. An explicit `APPROVE` suppresses the `2` (tasks/T08.md Deviation 15); the
  contradiction is only a stderr warning, which a CI gate discards, so grep the text too if you
  want to catch that case.

If a spawned `claude -p` ever answers `Not logged in` (a known macOS Keychain issue for processes
started outside a logged-in shell), do not retry in a loop: run `claude` interactively once in the
same shell, or use the CLI fallback above. It did not occur here.

Status: planning done — see [PLAN.md](PLAN.md) and [tasks/BACKLOG.md](tasks/BACKLOG.md). Original brief: [docs/HANDOFF.md](docs/HANDOFF.md).
