# BACKLOG — sequential order

Work top to bottom. **Each task has a self-contained spec file** — an agent needs only
`SPEC.md` + the task's file to execute it. Do not start a task before its dependencies are done.

## How to hand a task to any agent

Paste this (fill `T##`):

> You are working in the repo root of `agent-workflows`. Read `tasks/SPEC.md` fully, then
> read `tasks/T##.md`. Execute ONLY that task's Steps, in order. Do not touch files outside
> the task's scope. When done, run every command in the Acceptance section and show the
> output. If all pass, mark the task's checkbox in `tasks/BACKLOG.md`. Never `git push`.
> If a Step conflicts with reality (an API/signature changed, a command fails), make the
> smallest fix that preserves the task's Goal and record the deviation under a
> `## Deviations` heading at the bottom of that task file — do NOT redesign or change
> SPEC.md; design changes go back to the architect.

## Phase 0 — Bootstrap
- [x] [T01](T01.md) — Scaffold TypeScript project (deps, tsconfig, CLI stub)
- [x] [T02](T02.md) — CLAUDE.md + shared guardrails file

## Phase 1 — Provider layer
- [x] [T03](T03.md) — Provider registry (lmstudio/openai/anthropic/claude-cli) + config resolution
- [x] [T04](T04.md) — `aw ping` smoke command per provider

## Phase 2 — Tool layer
- [x] [T05](T05.md) — Core tools (fs/bash/git/grep/http) + permission profiles
- [x] [T06](T06.md) — Playwright toolset + browser smoke script

## Phase 3 — Agents
- [x] [T07](T07.md) — ui-designer / qa-tester / code-reviewer definitions + loader

## Phase 4 — Workflows (CLI)
- [x] [T08](T08.md) — `aw review` (verdict + severity-sorted findings, headless-safe)
- [x] [T09](T09.md) — `aw test-feature` (plan → execute → report file)
- [x] [T10](T10.md) — `aw design-loop` (implement → browser-verify → screenshots → stop for feedback)

## Phase 5 — Claude Code native layer
- [x] [T11](T11.md) — `.claude/` commands + subagents generated from agents/*.md
- [x] [T12](T12.md) — Headless `claude -p "/review"` verification (or documented fallback)

## Phase 6 — Real project + acceptance
- [x] [T13](T13.md) — `aw init` workspace onboarding
- [x] [T14](T14.md) — Wire to the real project + handoff acceptance checks
- [x] [T15](T15.md) — Offers: pre-push hook, video variant (present only)

## Phase 7 — Dashboard (web management panel)
- [x] [T16](T16.md) — Run manifests + workspace store (retrofit T08–T10)
- [x] [T17](T17.md) — Dashboard skeleton (workspaces, run list, run detail, artifact API)
- [x] [T18](T18.md) — Review UI: diff viewer with inline file:line findings
- [x] [T19](T19.md) — Test report UI: case table + request/response evidence
- [x] [T20](T20.md) — Design gallery: screenshots/video, run compare, feedback queue
- [x] [T21](T21.md) — Workspace & agent settings management (+ run housekeeping)
- [x] [T22](T22.md) — Trigger runs + live SSE logs + cancel from the UI

## Milestones
- **M1** T01–T04 · **M2** T05–T10 · **M3** T11–T12 · **M4** T13–T15 · **M5** T16–T22
