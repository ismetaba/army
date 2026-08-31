import { z } from 'zod';

export const ProviderId = z.enum(['lmstudio', 'openai', 'anthropic', 'claude-cli']);
export type ProviderId = z.infer<typeof ProviderId>;
export const AgentName = z.enum(['ui-designer', 'qa-tester', 'code-reviewer']);
export type AgentName = z.infer<typeof AgentName>;
export const Severity = z.enum(['BLOCKER', 'MAJOR', 'MINOR', 'NIT']);
export type Severity = z.infer<typeof Severity>;
export const Verdict = z.enum(['APPROVE', 'APPROVE WITH NITS', 'REQUEST CHANGES']);
export type Verdict = z.infer<typeof Verdict>;

export const ModelChoice = z.object({ provider: ProviderId, model: z.string() });
export const Viewport = z.object({ width: z.number(), height: z.number() });

// ---------------------------------------------------------------------------
// Targets (T23)
// ---------------------------------------------------------------------------

/**
 * One half of the product: a repository plus how to start and reach the thing it serves.
 * A workspace carries up to two of these — `backend` and `frontend` — each with its OWN
 * `repoRoot`, because the two halves legitimately live in two different repositories.
 */
export const Target = z.object({
  repoRoot: z.string(),                 // absolute path — its own git repo
  start: z.string().optional(),         // dev-server command, run in repoRoot
  port: z.number().optional(),
  url: z.string().optional(),           // defaults to http://localhost:<port>
  healthPath: z.string().optional(),    // backend only in practice; kept on both
});
export type Target = z.infer<typeof Target>;

export const TargetName = z.enum(['backend', 'frontend']);
export type TargetName = z.infer<typeof TargetName>;

/** The base URL a target answers on: its explicit `url`, else `http://localhost:<port>`. */
export function targetUrl(target: Target | undefined): string | undefined {
  if (target === undefined) return undefined;
  const url = target.url?.trim();
  if (url) return url;
  return target.port !== undefined ? `http://localhost:${target.port}` : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Map the pre-T23 config shape onto the target shape, IN MEMORY, on read.
 *
 * Every `aw.config.json` written before T23 is `repoRoot` + a flat `app` block that assumes
 * both halves live in one repo. Those files keep working forever without being rewritten:
 * `parseAwConfig` runs this first, and nothing else in the toolkit reads the old keys.
 *
 *   - `repoRoot` + `app.backend`         → `backend:  { repoRoot, ...app.backend }`
 *   - `repoRoot` + `app.frontend`        → `frontend: { repoRoot, ...app.frontend }`
 *   - `app.baseUrl`                      → `backend.url`
 *   - `repoRoot` with no app targets and no `frontend` → `backend: { repoRoot }`
 *     (the review-only case)
 *   - `app.testAccount` / `app.stagingUrl` → top level (they are workspace-wide, not per-target)
 *
 * New-shape keys always win over what the legacy keys would produce, so a half-migrated file
 * behaves like its new half. An object with neither `app` nor a top-level `repoRoot` is handed
 * back UNTOUCHED (same reference), so callers can cheaply detect "nothing to migrate".
 */
export function migrateConfig(raw: unknown): unknown {
  if (!isPlainObject(raw)) return raw;
  const app = isPlainObject(raw.app) ? raw.app : undefined;
  const legacyRoot =
    typeof raw.repoRoot === 'string' && raw.repoRoot.trim() !== '' ? raw.repoRoot : undefined;
  if (app === undefined && legacyRoot === undefined) return raw;

  const out: Record<string, unknown> = { ...raw };
  delete out.app;
  delete out.repoRoot;

  const appBackend = app !== undefined && isPlainObject(app.backend) ? app.backend : undefined;
  const appFrontend = app !== undefined && isPlainObject(app.frontend) ? app.frontend : undefined;
  const baseUrl =
    app !== undefined && typeof app.baseUrl === 'string' && app.baseUrl.trim() !== ''
      ? app.baseUrl
      : undefined;

  if (out.frontend === undefined && appFrontend !== undefined && legacyRoot !== undefined) {
    out.frontend = { repoRoot: legacyRoot, ...appFrontend };
  }
  if (out.backend === undefined && legacyRoot !== undefined) {
    if (appBackend !== undefined || baseUrl !== undefined) {
      out.backend = {
        repoRoot: legacyRoot,
        ...(appBackend ?? {}),
        ...(baseUrl !== undefined ? { url: baseUrl } : {}),
      };
    } else if (out.frontend === undefined) {
      // A bare `repoRoot` (no app at all): the repo IS the backend — the review-only case.
      out.backend = { repoRoot: legacyRoot };
    }
  }
  if (out.testAccount === undefined && app !== undefined && isPlainObject(app.testAccount)) {
    out.testAccount = app.testAccount;
  }
  if (out.stagingUrl === undefined && app !== undefined && typeof app.stagingUrl === 'string') {
    out.stagingUrl = app.stagingUrl;
  }
  return out;
}

export const AwConfig = z
  .object({
    workspace: z.string(),                       // unique workspace name
    backend: Target.optional(),
    frontend: Target.optional(),
    defaults: ModelChoice,
    // NOTE: zod@4's z.record(<enum>, v) requires ALL enum keys to be present; the per-agent
    // overrides are partial by design, so z.partialRecord is the correct zod@4 spelling of
    // SPEC's `z.record(AgentName, ModelChoice.partial())`.
    agents: z.partialRecord(AgentName, ModelChoice.partial()).optional(),
    // Workspace-wide, not per-target. The password lives in an env var and is NEVER stored.
    testAccount: z.object({ user: z.string(), passEnv: z.string() }).optional(),
    stagingUrl: z.string().optional(),
    viewports: z.object({ mobile: Viewport, desktop: Viewport })
      .default({ mobile: { width: 375, height: 812 }, desktop: { width: 1440, height: 900 } }),
    offLimits: z.array(z.string()).optional(),
  })
  .superRefine((cfg, ctx) => {
    // Deliberately loud: an UNMIGRATED legacy config (repoRoot + app, no targets) must fail
    // here rather than parse into a config that silently lost its app block. Every reader goes
    // through `parseAwConfig`, which migrates first.
    if (cfg.backend === undefined && cfg.frontend === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['backend'],
        message:
          'no target: add "backend" and/or "frontend" (each with its own repoRoot), or a legacy top-level "repoRoot"',
      });
    }
  })
  // `repoRoot` survives as a DERIVED value because ~20 files consume it as "the repo of this
  // workspace". It is always the primary target's root: backend first, else frontend.
  .transform((cfg) => ({ ...cfg, repoRoot: (cfg.backend?.repoRoot ?? cfg.frontend?.repoRoot)! }));
export type AwConfig = z.infer<typeof AwConfig>;

/**
 * THE way to parse an `aw.config.json`: silent legacy migration, then validation.
 * `AwConfig.safeParse` alone rejects the pre-T23 shape on purpose — use this instead.
 */
export function parseAwConfig(raw: unknown): ReturnType<typeof AwConfig.safeParse> {
  return AwConfig.safeParse(migrateConfig(raw));
}

export const Finding = z.object({
  severity: Severity, file: z.string(), line: z.number(),
  title: z.string(), risk: z.string(), fix: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const TestCase = z.object({
  id: z.string(), name: z.string(),
  kind: z.enum(['happy', 'edge', 'invalid', 'auth']),
  status: z.enum(['PASS', 'FAIL', 'SKIP']),
  request: z.string().optional(), response: z.string().optional(),
  reproSteps: z.array(z.string()).optional(), severity: Severity.optional(),
});
export type TestCase = z.infer<typeof TestCase>;

export const ScreenShot = z.object({
  screen: z.string(), viewport: z.enum(['mobile', 'desktop']), path: z.string(),
});
export type ScreenShot = z.infer<typeof ScreenShot>;

export const RunManifest = z.object({
  runId: z.string(),                            // "<kind>-<YYYYMMDD-HHmmss>"
  kind: z.enum(['review', 'test-feature', 'design-loop']),
  workspace: z.string(),
  createdAt: z.string(),                        // ISO 8601
  agent: AgentName,
  provider: ProviderId, model: z.string(),
  status: z.enum(['running', 'done', 'error', 'cancelled']),
  durationMs: z.number().optional(),
  input: z.object({
    args: z.string(), base: z.string().optional(),
    feature: z.string().optional(), targetUrl: z.string().optional(),
    // T23: which target set the run acted on, and the repo root it resolved to. Optional —
    // manifests written before T23 lack both, and readers render "—" rather than failing.
    target: TargetName.optional(), repoRoot: z.string().optional(),
  }),
  review: z.object({ verdict: Verdict, findings: z.array(Finding), diffArtifact: z.string() }).optional(),
  test: z.object({ reportArtifact: z.string(), cases: z.array(TestCase), summary: z.string() }).optional(),
  design: z.object({
    screens: z.array(ScreenShot), video: z.string().optional(),
    judgmentCalls: z.array(z.string()), feedbackHistory: z.array(z.string()),
  }).optional(),
  error: z.string().optional(),
});
export type RunManifest = z.infer<typeof RunManifest>;

export const Workspace = z.object({
  name: z.string(),
  /** Kept for every existing consumer: `= backendRepo ?? frontendRepo`. */
  repoRoot: z.string(),
  // T23: both roots, so the panel can render a two-repo workspace and spawn with the right
  // cwd. Optional — entries written before T23 carry only `repoRoot`.
  backendRepo: z.string().optional(),
  frontendRepo: z.string().optional(),
  createdAt: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;
export const WorkspacesFile = z.object({ workspaces: z.array(Workspace) });
export type WorkspacesFile = z.infer<typeof WorkspacesFile>;
