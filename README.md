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
- `claude-cli` — the local Claude Code session (no key; see caveats in PLAN.md)

Two run paths, one set of agent prompts (`agents/*.md`):

1. **CLI** — `aw <workflow> --provider <p> --model <m>` (TypeScript, Vercel AI SDK v6, own tool loop with fs/bash/git/Playwright tools).
2. **Claude Code native** — `/design-loop`, `/test-feature`, `/review` slash commands + subagents in `.claude/`, incl. headless `claude -p "/review"`.

Provider/model per agent is set in the target repo's `aw.config.json` and can be overridden per run with flags.

Status: planning done — see [PLAN.md](PLAN.md) and [tasks/BACKLOG.md](tasks/BACKLOG.md). Original brief: [docs/HANDOFF.md](docs/HANDOFF.md).
