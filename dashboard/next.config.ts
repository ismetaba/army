import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

/**
 * The dashboard lives inside the toolkit repo and reads ONE thing from it: `shared/schemas.ts`.
 * That file is the single source of truth for `RunManifest` & friends (SPEC § Types), so the
 * panel must not keep a second copy that can drift.
 *
 * Importing it means importing from outside `dashboard/`, which needs two knobs:
 *
 * - `turbopack.root` — Turbopack refuses to resolve modules above the inferred project root, and
 *   `dashboard/package-lock.json` makes it infer `dashboard/`. Pointing it at the repo root puts
 *   `shared/` (and the repo-root `node_modules/zod` that `schemas.ts` imports) back in scope.
 * - `experimental.externalDir` — the same permission for the webpack builder (`next build
 *   --webpack`), which Turbopack's `root` does not cover. T17 step 2 asks for it by name.
 *
 * Only `shared/` may be imported this way. `src/` is node-only (fs, child_process, playwright);
 * pulling it into a bundle would break the moment a client component touched it. The dashboard
 * re-implements the read side in `src/lib/store.ts` instead.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  experimental: { externalDir: true },
  // The panel is a local tool served on 4400; `x-powered-by` advertises nothing useful here.
  poweredByHeader: false,
};

export default nextConfig;
