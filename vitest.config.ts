import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Vitest picked up every `*.test.ts` in the repo with zero configuration until T21, because every
 * test until then imported either a relative path or `import type { … } from "@shared/schemas"` —
 * and a type-only import is erased before anything has to resolve it.
 *
 * `dashboard/src/lib/config-patch.ts` imports `AgentName` and `ProviderId` as VALUES (they are
 * zod enums: the settings form renders `.options` and the patch schema keys a record by them), so
 * the alias now has to exist at run time too. These two entries mirror `dashboard/tsconfig.json`'s
 * `paths`, which is what the Next builder and the TypeScript compiler already use — one spelling
 * of `@shared/*` and `@/*` everywhere, rather than a relative `../../../shared/schemas` that only
 * the test runner would see.
 *
 * Nothing else is configured: the default include patterns and environment are unchanged, so the
 * suite runs exactly as before.
 */
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.join(root, "shared"),
      "@": path.join(root, "dashboard/src"),
    },
  },
});
