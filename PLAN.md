# PLAN — agent-workflows

Adapted from [docs/HANDOFF.md](docs/HANDOFF.md) with one added requirement: every agent's
LLM backend must be selectable between a **local LLM (LM Studio)**, the **Claude SDK**, and
the **ChatGPT (OpenAI) SDK**. Target app: none bundled — the toolkit is pointed at a real
project later via `aw init`.

## Architecture

```
agent-workflows/
├── agents/                  # single source of truth: prompts + tool policy per agent
│   ├── ui-designer.md       #   frontmatter: name, description, tools, default provider
│   ├── qa-tester.md
│   └── code-reviewer.md
├── src/
│   ├── providers/           # AI SDK v6 registry: lmstudio | openai | anthropic | claude-cli
│   ├── tools/               # fs, bash, git, playwright — one implementation, per-agent allowlists
│   ├── workflows/           # design-loop, test-feature, review orchestration
│   └── cli.ts               # `aw` entrypoint
├── .claude/
│   ├── commands/            # /design-loop /test-feature /review — reuse agents/*.md prompts
│   └── agents/              # Claude Code subagents (native path)
├── dashboard/               # Next.js web panel (Phase 7): review UI, reports, gallery, settings
├── CLAUDE.md                # conventions + guardrails (handoff Step 2)
├── docs/HANDOFF.md          # original brief
└── tasks/BACKLOG.md         # sequential task list
```

### Dashboard & workspaces (Phase 7)

Runs write JSON manifests to `~/.agent-workflows/<workspace>/runs/` (outside target repos).
A **workspace** binds one target repo to its config + run history, so many projects can be
managed side by side. The localhost dashboard renders: Bitbucket-like diff review with inline
`file:line` findings, test-report viewer (exact request/response per failure), design gallery
(screenshots/videos per viewport, feedback box → `--iterate`), per-agent provider/model and
guardrail settings, and workflow triggering with live logs (SSE).

### Provider selection (core requirement)

- Registry maps `ProviderId` → AI SDK model instance:
  - `lmstudio`: `createOpenAI({ baseURL: "http://localhost:1234/v1" })` — no key, model name from LM Studio.
  - `openai`: official provider, `OPENAI_API_KEY` from `.env` (never committed).
  - `anthropic`: official provider, `ANTHROPIC_API_KEY`.
  - `claude-cli`: `ai-sdk-provider-claude-code` — uses the local Claude Code login.
- Selection precedence: CLI flags `--provider/--model` → per-agent entry in target repo's
  `aw.config.json` → global default in the same file.
- `aw.config.json` (written by `aw init` into the target repo) also holds: backend/frontend
  run commands + ports, base URL, test account, viewports (default 375x812, 1440x900),
  off-limits notes.

### Two run paths, one prompt source

- **CLI path** (`aw`): full tool loop via AI SDK `tool({execute})` — works for lmstudio,
  openai, anthropic.
- **Claude Code path** (`.claude/`): slash commands + subagents for interactive sessions and
  headless `claude -p "/review"`. Command/agent files embed or reference the same
  `agents/*.md` prompt text so behavior stays identical.

### Tool policy per agent (enforced in the tool layer, stated in prompts)

- `ui-designer`: fs read/edit, bash, Playwright. Never claims done without viewing rendered UI;
  self-review checklist (no console errors, both viewports, hover/click/submit/loading/error/empty
  states, visual consistency).
- `qa-tester`: fs read, bash, HTTP, Playwright. **No source edits**; throwaway scripts only under
  `test-reports/tmp/`. Verifies, never fixes; records exact request/response per failure.
- `code-reviewer`: read-only fs + grep/glob + read-only git. Findings as `file:line` + risk +
  concrete fix; severity BLOCKER/MAJOR/MINOR/NIT; verdict line; no filler praise.

### Guardrails (into CLAUDE.md and every agent prompt)

Never `git push` / create PRs · never target production (staging only with explicit URL) ·
never commit secrets, `.env`, or screenshots with real user data · ask before adding
dependencies · destructive ops against non-local targets require explicit confirmation ·
design/test runs end by presenting artifact paths, then **stop for feedback**.

## Known risks (from prior local experience)

1. ~~`ai-sdk-provider-claude-code` does not support AI SDK `tool({execute})`~~ — **resolved
   2026-08-24.** It still cannot take `tools` directly, but `src/providers/claude-cli.ts`
   bridges the workflow's toolset into the CLI as an in-process MCP server, so `claude-cli`
   runs all three workflows on the developer's Claude subscription with no API key. The
   lockdown that makes it safe (`disallowedTools`, not `allowedTools`) is in SPEC § Agent
   session loop and measured in the module header.
2. Headless `claude -p` previously returned "Not logged in" on this machine (Keychain not
   reaching spawned process) — verify in T12; fallback is the `anthropic` provider.
3. Small local models can be weak at tool-calling — pick a tool-capable model in LM Studio
   (Qwen3-class); `aw ping` (T04) validates each provider before real runs.

## Milestones

- **M1** (T01–T04): repo + provider layer proven — every provider answers a ping.
- **M2** (T05–T10): CLI workflows complete.
- **M3** (T11–T12): Claude Code native layer complete.
- **M4** (T13–T15): wired to a real project, handoff acceptance checks pass.
- **M5** (T16–T22): dashboard — review UI, test reports, design gallery, workspace/settings
  management, trigger + live logs.
