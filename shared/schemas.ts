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

export const AwConfig = z.object({
  workspace: z.string(),                       // unique workspace name
  repoRoot: z.string(),                        // absolute path of the TARGET repo
  defaults: ModelChoice,
  // NOTE: zod@4's z.record(<enum>, v) requires ALL enum keys to be present; the per-agent
  // overrides are partial by design, so z.partialRecord is the correct zod@4 spelling of
  // SPEC's `z.record(AgentName, ModelChoice.partial())`.
  agents: z.partialRecord(AgentName, ModelChoice.partial()).optional(),
  app: z.object({
    backend: z.object({ start: z.string(), port: z.number(), healthPath: z.string().optional() }).optional(),
    frontend: z.object({ start: z.string(), port: z.number() }).optional(),
    baseUrl: z.string().optional(),            // default http://localhost:<backend.port>
    testAccount: z.object({ user: z.string(), passEnv: z.string() }).optional(), // password read from env var, NEVER stored
    stagingUrl: z.string().optional(),
  }).optional(),
  viewports: z.object({ mobile: Viewport, desktop: Viewport })
    .default({ mobile: { width: 375, height: 812 }, desktop: { width: 1440, height: 900 } }),
  offLimits: z.array(z.string()).optional(),
});
export type AwConfig = z.infer<typeof AwConfig>;

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

export const Workspace = z.object({ name: z.string(), repoRoot: z.string(), createdAt: z.string() });
export type Workspace = z.infer<typeof Workspace>;
export const WorkspacesFile = z.object({ workspaces: z.array(Workspace) });
export type WorkspacesFile = z.infer<typeof WorkspacesFile>;
