# dashboard — the agent-workflows run panel

A read-only Next.js panel over the run store the CLI writes (SPEC § Storage). It never mutates
anything: no triggering runs (T22), no editing manifests.

```
npm run dev            # from dashboard/  → http://localhost:4400
npm run dashboard      # from the repo root, same thing
```

It reads `$AW_HOME` (default `~/.agent-workflows`), so pointing it at another store is one env var:

```
AW_HOME=/path/to/store npm run dev
```

## Routes

| route | what it shows |
| --- | --- |
| `/` | workspace cards (name, repoRoot, run count) + the 20 newest runs across all workspaces |
| `/ws/[ws]` | that workspace's runs; `?kind=review\|test-feature\|design-loop` filters |
| `/ws/[ws]/run/[id]` | manifest summary + `Review \| Report \| Design \| Log` tabs (`?tab=`) |
| `/api/artifact?ws=&run=&path=` | streams one file out of a run directory |

The three type-specific tabs are placeholders until T18 (Review), T19 (Report) and T20 (Design).
`Log` is the default tab and shows the last 500 lines of the run's `log.txt`.

## How it is put together

- **Server components only.** There is no `"use client"` file in `src/`. The kind filter and the
  tabs are plain links with a search param, so the panel ships no JavaScript of its own and every
  view is linkable.
- **`src/lib/store.ts` is the only module that touches the filesystem**, and it is server-only —
  it imports `node:fs`, which makes reaching it from a client component a build error rather than
  a silent leak. It re-implements the *read* half of the toolkit's `src/store.ts`; it never
  imports `src/`, which is node-only (child_process, playwright).
- **Types are not duplicated.** `@shared/schemas` (the repo-root `shared/schemas.ts`) is imported
  directly and every manifest is `safeParse`d, so a schema change reaches the panel immediately.
  See `next.config.ts` for the two settings that allow that import.
- **Light and dark come from CSS variables in `globals.css`** and a single
  `prefers-color-scheme` block. No `dark:` variants anywhere.
- **`/api/artifact` is path-confined**: workspace and run ids must be single safe segments, the
  artifact path is rejected if it is absolute or contains `..`, and containment is re-checked
  after `realpath` so a symlink cannot escape the run directory. Every failure is a plain 404.
