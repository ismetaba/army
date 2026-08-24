"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AGENT_NAMES, PROVIDER_IDS, isPlainObject } from "@/lib/config-patch";
import type { FieldIssue } from "@/lib/config-patch";
import { PrimaryButton, QuietButton } from "@/components/ledger/chrome";
import {
  ACTION,
  QUIET_ACTION,
  DangerCallout,
  FieldError,
  SettingsField,
  SettingsSection,
  SubHead,
  UnderlineInput,
  UnderlineNumber,
  UnderlineSelect,
  UnderlineTextarea,
} from "@/components/settings/fields";

/**
 * T21 step 1 — the settings form for one workspace's `aw.config.json`, in the Ledger design
 * (handoff § 05: three of the four ruled sections live here, the fourth is the registry).
 *
 * The only client component that writes to a developer's repo, so three decisions are worth
 * stating out loud:
 *
 * **Every field is held as a STRING.** Not because the values are strings — ports and viewport
 * dimensions are numbers — but because a `<input type="number">` throws away what you typed the
 * moment it is not a number, and "port as text" is precisely one of the cases T21 acceptance 2
 * requires to produce a *field error*. Keeping the raw text and letting the server judge it means
 * the panel shows the CLI's own verdict ("the backend port must be a whole number between 1 and
 * 65535") instead of an empty box and a shrug.
 *
 * **The submission is a PATCH, not the document.** The form sends only the keys it owns; `null`
 * means "delete this key". Anything else in the file — `workspace`, `repoRoot`, a hand-added key
 * this schema never heard of — is merged around it server-side and survives untouched
 * (`src/lib/config-patch.ts`). A form that POSTed its own idea of the whole document would delete
 * everything it does not render, which is how a settings page eats a developer's comments-in-JSON
 * the first time it is used.
 *
 * **There is no password field, anywhere.** The test account has a user and the NAME of an
 * environment variable, and the label says so in as many words. SPEC § Dashboard security
 * invariants #5; the API rejects a password-shaped key even if one somehow reached it.
 *
 * On the design side: every input is an underline, never a box (handoff § Geometry), and the two
 * blocks the four designed sections do not name — viewports and off-limits — are sub-blocks under
 * the section they belong to rather than new 2px-ruled sections, so the section index still has
 * the four entries § 05 specifies while the form keeps every field the config has.
 */

/** Shown on any provider row set to `claude-cli` — a note about how it authenticates, not a refusal. */
const CLAUDE_CLI_NOTE =
  "runs on your local Claude Code login — no API key. Model is a CLI alias: opus, sonnet or haiku.";

interface AgentRow {
  provider: string;
  model: string;
}

interface FormState {
  defaultsProvider: string;
  defaultsModel: string;
  agents: Record<string, AgentRow>;
  backendStart: string;
  backendPort: string;
  backendHealthPath: string;
  frontendStart: string;
  frontendPort: string;
  baseUrl: string;
  stagingUrl: string;
  testUser: string;
  passEnv: string;
  mobileWidth: string;
  mobileHeight: string;
  desktopWidth: string;
  desktopHeight: string;
  offLimits: string;
}

function at(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** A config value as form text. Numbers become their decimal form; anything else becomes "". */
function text(root: unknown, path: readonly string[]): string {
  const value = at(root, path);
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function toFormState(config: Record<string, unknown>): FormState {
  const agents: Record<string, AgentRow> = {};
  for (const name of AGENT_NAMES) {
    agents[name] = {
      provider: text(config, ["agents", name, "provider"]),
      model: text(config, ["agents", name, "model"]),
    };
  }
  const offLimits = at(config, ["offLimits"]);
  return {
    defaultsProvider: text(config, ["defaults", "provider"]),
    defaultsModel: text(config, ["defaults", "model"]),
    agents,
    backendStart: text(config, ["app", "backend", "start"]),
    backendPort: text(config, ["app", "backend", "port"]),
    backendHealthPath: text(config, ["app", "backend", "healthPath"]),
    frontendStart: text(config, ["app", "frontend", "start"]),
    frontendPort: text(config, ["app", "frontend", "port"]),
    baseUrl: text(config, ["app", "baseUrl"]),
    stagingUrl: text(config, ["app", "stagingUrl"]),
    testUser: text(config, ["app", "testAccount", "user"]),
    passEnv: text(config, ["app", "testAccount", "passEnv"]),
    mobileWidth: text(config, ["viewports", "mobile", "width"]),
    mobileHeight: text(config, ["viewports", "mobile", "height"]),
    desktopWidth: text(config, ["viewports", "desktop", "width"]),
    desktopHeight: text(config, ["viewports", "desktop", "height"]),
    offLimits: Array.isArray(offLimits) ? offLimits.map((v) => String(v)).join("\n") : "",
  };
}

/** `""` → `null` (delete the key); anything else keeps the trimmed text. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A number if it is written as one, `null` if the box is empty, and the RAW TEXT otherwise — so
 * `"eighty"` reaches the server and comes back as a field error rather than being swallowed here.
 */
function numberOrRaw(value: string): number | string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function toPatch(state: FormState): Record<string, unknown> {
  const agents: Record<string, unknown> = {};
  let anyAgent = false;
  for (const name of AGENT_NAMES) {
    const row = state.agents[name] ?? { provider: "", model: "" };
    const provider = orNull(row.provider);
    const model = orNull(row.model);
    if (provider === null && model === null) {
      agents[name] = null; // no override for this agent
      continue;
    }
    anyAgent = true;
    agents[name] = { provider, model };
  }

  const backend =
    orNull(state.backendStart) === null
      ? null
      : {
          start: state.backendStart.trim(),
          port: numberOrRaw(state.backendPort),
          healthPath: orNull(state.backendHealthPath),
        };
  const frontend =
    orNull(state.frontendStart) === null
      ? null
      : { start: state.frontendStart.trim(), port: numberOrRaw(state.frontendPort) };
  const testAccount =
    orNull(state.testUser) === null && orNull(state.passEnv) === null
      ? null
      : { user: state.testUser.trim(), passEnv: state.passEnv.trim() };
  const baseUrl = orNull(state.baseUrl);
  const stagingUrl = orNull(state.stagingUrl);
  const app =
    backend === null && frontend === null && testAccount === null && baseUrl === null && stagingUrl === null
      ? null
      : { backend, frontend, baseUrl, stagingUrl, testAccount };

  const offLimits = state.offLimits
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  return {
    defaults: { provider: state.defaultsProvider, model: state.defaultsModel.trim() },
    agents: anyAgent ? agents : null,
    app,
    viewports: {
      mobile: { width: numberOrRaw(state.mobileWidth), height: numberOrRaw(state.mobileHeight) },
      desktop: { width: numberOrRaw(state.desktopWidth), height: numberOrRaw(state.desktopHeight) },
    },
    offLimits: offLimits.length > 0 ? offLimits : null,
  };
}

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; unchanged: boolean }
  | { kind: "error"; message: string };

export function ConfigForm({
  ws,
  path,
  config,
  issues: initialIssues,
}: {
  ws: string;
  path: string;
  config: Record<string, unknown>;
  /** Problems the server found in the file as it stands, shown before anything is edited. */
  issues: FieldIssue[];
}) {
  const router = useRouter();
  const [state, setState] = useState<FormState>(() => toFormState(config));
  const [issues, setIssues] = useState<FieldIssue[]>(initialIssues);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
    setStatus({ kind: "idle" });
  };
  const setAgent = (name: string, field: keyof AgentRow, value: string) => {
    setState((prev) => ({
      ...prev,
      agents: { ...prev.agents, [name]: { ...prev.agents[name]!, [field]: value } },
    }));
    setStatus({ kind: "idle" });
  };

  const issueFor = (field: string): string | undefined =>
    issues.find((i) => i.path === field)?.message;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/config", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ws, patch: toPatch(state) }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; issues?: FieldIssue[]; unchanged?: boolean }
        | null;
      if (!res.ok || body?.ok !== true) {
        setIssues(body?.issues ?? []);
        setStatus({ kind: "error", message: body?.message ?? `save failed (${res.status})` });
        return;
      }
      setIssues([]);
      setStatus({ kind: "saved", unchanged: body.unchanged === true });
      // The page's server render also shows this config (and the run pages read it), so pull the
      // whole route back from the server rather than trusting the copy in this component.
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: "the panel could not reach the server" });
    }
  }

  async function reload() {
    setStatus({ kind: "saving" });
    try {
      const res = await fetch(`/api/config?ws=${encodeURIComponent(ws)}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; config?: Record<string, unknown>; issues?: FieldIssue[]; message?: string }
        | null;
      if (!res.ok || body?.ok !== true || body.config === undefined) {
        setStatus({ kind: "error", message: body?.message ?? `reload failed (${res.status})` });
        return;
      }
      setState(toFormState(body.config));
      setIssues(body.issues ?? []);
      setStatus({ kind: "idle" });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: "the panel could not reach the server" });
    }
  }

  const inheritProvider = state.defaultsProvider || "default";
  const inheritModel = state.defaultsModel.trim() || "default";

  /** Agent rows set to a provider the CLI's tool-using workflows refuse — SAVE is blocked. */
  // No longer a blocker: the MCP bridge (src/providers/claude-cli.ts) runs the workflows on the
  // local Claude login, so a row set to claude-cli saves like any other provider.

  return (
    // `noValidate`: the browser's own constraint validation must not get a vote here. With it on,
    // a port typed as "eighty" makes the form *refuse to submit* and shows a native tooltip, so
    // the server never sees the value and the panel cannot say which field is wrong or that
    // nothing was written. One validator (the server, which owns the file) beats two that
    // disagree — and it is the same validator the CLI uses.
    <form
      onSubmit={save}
      noValidate
      className="flex min-w-0 flex-col gap-10"
      data-testid="config-form"
    >
      <SettingsSection id="defaults" title="Defaults" aside="used by every task unless overridden">
        <div className="grid min-w-0 grid-cols-1 gap-6 sm:grid-cols-[1fr_1.4fr] sm:gap-8">
          <SettingsField label="provider" htmlFor="defaults-provider" error={issueFor("defaults.provider")}>
            <UnderlineSelect
              id="defaults-provider"
              scale="lg"
              value={state.defaultsProvider}
              onChange={(v) => set("defaultsProvider", v)}
              options={PROVIDER_IDS}
              invalid={issueFor("defaults.provider") !== undefined}
            />
          </SettingsField>
          <SettingsField label="model id" htmlFor="defaults-model" error={issueFor("defaults.model")}>
            <UnderlineInput
              id="defaults-model"
              scale="lg"
              value={state.defaultsModel}
              onChange={(v) => set("defaultsModel", v)}
              placeholder="qwen3-coder-30b-a3b-instruct"
              invalid={issueFor("defaults.model") !== undefined}
            />
          </SettingsField>
        </div>
        {state.defaultsProvider === "claude-cli" ? <ClaudeCliNote /> : null}
      </SettingsSection>

      <SettingsSection
        id="agents"
        title="Agent overrides"
        aside="per-agent, falls back to the defaults above"
      >
        <div className="flex min-w-0 flex-col gap-4">
          {AGENT_NAMES.map((name) => {
            const row = state.agents[name] ?? { provider: "", model: "" };
            const isLocalLogin = row.provider === "claude-cli";
            const providerIssue = issueFor(`agents.${name}.provider`);
            const modelIssue = issueFor(`agents.${name}.model`);
            return (
              <div
                key={name}
                data-agent-row={name}
                className="flex min-w-0 flex-col gap-3 border-b border-dotted border-line pb-4 last:border-b-0 last:pb-0"
              >
                <div className="grid min-w-0 grid-cols-1 items-start gap-4 sm:grid-cols-[180px_1fr_1.3fr] sm:gap-6">
                  <span className="mono text-[12px] text-fg sm:pt-px">{name}</span>
                  <div className="flex min-w-0 flex-col gap-2">
                    <UnderlineSelect
                      id={`agent-${name}-provider`}
                      ariaLabel={`${name} provider`}
                      value={row.provider}
                      onChange={(v) => setAgent(name, "provider", v)}
                      options={PROVIDER_IDS}
                      inheritLabel={`inherit (${inheritProvider})`}
                      invalid={providerIssue !== undefined}
                    />
                    {providerIssue === undefined ? null : (
                      <FieldError htmlFor={`agent-${name}-provider`}>{providerIssue}</FieldError>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-2">
                    <UnderlineInput
                      id={`agent-${name}-model`}
                      ariaLabel={`${name} model id`}
                      value={row.model}
                      onChange={(v) => setAgent(name, "model", v)}
                      placeholder={`inherit (${inheritModel})`}
                      invalid={modelIssue !== undefined}
                    />
                    {modelIssue === undefined ? null : (
                      <FieldError htmlFor={`agent-${name}-model`}>{modelIssue}</FieldError>
                    )}
                  </div>
                </div>
                {isLocalLogin ? <ClaudeCliNote /> : null}
              </div>
            );
          })}
        </div>

        <SubHead aside="one per line · handed to every agent as a hard boundary">
          off limits
        </SubHead>
        <SettingsField label="off limits" htmlFor="off-limits" hideLabel error={issueFor("offLimits")}>
          <UnderlineTextarea
            id="off-limits"
            value={state.offLimits}
            onChange={(v) => set("offLimits", v)}
            placeholder={"shared dev database\nthe billing service"}
            invalid={issueFor("offLimits") !== undefined}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection id="app" title="App" aside="how the panel starts and reaches your app">
        <div className="grid min-w-0 grid-cols-1 gap-7 sm:grid-cols-2 sm:gap-x-8">
          <SettingsField label="backend start" htmlFor="backend-start" error={issueFor("app.backend.start")}>
            <UnderlineInput
              id="backend-start"
              value={state.backendStart}
              onChange={(v) => set("backendStart", v)}
              placeholder="npm run dev:api"
              invalid={issueFor("app.backend.start") !== undefined}
            />
          </SettingsField>
          <SettingsField label="backend port" htmlFor="backend-port" error={issueFor("app.backend.port")}>
            <UnderlineNumber
              id="backend-port"
              value={state.backendPort}
              onChange={(v) => set("backendPort", v)}
              placeholder="3001"
              invalid={issueFor("app.backend.port") !== undefined}
            />
          </SettingsField>
          <SettingsField label="frontend start" htmlFor="frontend-start" error={issueFor("app.frontend.start")}>
            <UnderlineInput
              id="frontend-start"
              value={state.frontendStart}
              onChange={(v) => set("frontendStart", v)}
              placeholder="npm run dev"
              invalid={issueFor("app.frontend.start") !== undefined}
            />
          </SettingsField>
          <SettingsField label="frontend port" htmlFor="frontend-port" error={issueFor("app.frontend.port")}>
            <UnderlineNumber
              id="frontend-port"
              value={state.frontendPort}
              onChange={(v) => set("frontendPort", v)}
              placeholder="5173"
              invalid={issueFor("app.frontend.port") !== undefined}
            />
          </SettingsField>
          <SettingsField label="base url" htmlFor="base-url" error={issueFor("app.baseUrl")}>
            <UnderlineInput
              id="base-url"
              value={state.baseUrl}
              onChange={(v) => set("baseUrl", v)}
              placeholder="http://localhost:3001"
              invalid={issueFor("app.baseUrl") !== undefined}
            />
          </SettingsField>
          <SettingsField label="health path" htmlFor="backend-health" error={issueFor("app.backend.healthPath")}>
            <UnderlineInput
              id="backend-health"
              value={state.backendHealthPath}
              onChange={(v) => set("backendHealthPath", v)}
              placeholder="/health"
              invalid={issueFor("app.backend.healthPath") !== undefined}
            />
          </SettingsField>
          <SettingsField label="staging url" htmlFor="staging-url" error={issueFor("app.stagingUrl")}>
            <UnderlineInput
              id="staging-url"
              value={state.stagingUrl}
              onChange={(v) => set("stagingUrl", v)}
              placeholder="(none — production is never a target)"
              invalid={issueFor("app.stagingUrl") !== undefined}
            />
          </SettingsField>
          <SettingsField label="test account user" htmlFor="test-user" error={issueFor("app.testAccount.user")}>
            <UnderlineInput
              id="test-user"
              value={state.testUser}
              onChange={(v) => set("testUser", v)}
              placeholder="test@example.com"
              invalid={issueFor("app.testAccount.user") !== undefined}
            />
          </SettingsField>
          <SettingsField
            label="password env var"
            note="name only, never the value"
            htmlFor="pass-env"
            error={issueFor("app.testAccount.passEnv")}
          >
            <UnderlineInput
              id="pass-env"
              value={state.passEnv}
              onChange={(v) => set("passEnv", v)}
              placeholder="AW_TEST_PASSWORD"
              autoComplete="off"
              describedBy="pass-env-note"
              invalid={issueFor("app.testAccount.passEnv") !== undefined}
            />
          </SettingsField>
        </div>

        <p id="pass-env-note" className="max-w-[62ch] min-w-0 text-[12px] leading-[1.6] text-ink-2">
          The password itself is never asked for, never shown and never written here. Set{" "}
          {/* `break-all` because this echoes a value out of `aw.config.json` and an env-var name
              contains no spaces — with no break opportunity a long one pushed the whole settings
              page sideways, the one violation of handoff § Interactions' hard overflow rule. */}
          <span className="mono text-[11px] break-all text-fg">
            {state.passEnv.trim() || "AW_TEST_PASSWORD"}
          </span>{" "}
          in your shell or <span className="mono text-[11px] text-fg">.env</span>; only its name is
          stored in <span className="mono text-[11px] text-fg">aw.config.json</span>.
        </p>

        <SubHead aside="the two sizes design-loop shoots every screen at">viewports</SubHead>
        <div className="grid min-w-0 grid-cols-2 gap-6 sm:grid-cols-4 sm:gap-x-8">
          <SettingsField label="mobile w" htmlFor="mobile-width" error={issueFor("viewports.mobile.width")}>
            <UnderlineNumber
              id="mobile-width"
              value={state.mobileWidth}
              onChange={(v) => set("mobileWidth", v)}
              placeholder="375"
              invalid={issueFor("viewports.mobile.width") !== undefined}
            />
          </SettingsField>
          <SettingsField label="mobile h" htmlFor="mobile-height" error={issueFor("viewports.mobile.height")}>
            <UnderlineNumber
              id="mobile-height"
              value={state.mobileHeight}
              onChange={(v) => set("mobileHeight", v)}
              placeholder="812"
              invalid={issueFor("viewports.mobile.height") !== undefined}
            />
          </SettingsField>
          <SettingsField label="desktop w" htmlFor="desktop-width" error={issueFor("viewports.desktop.width")}>
            <UnderlineNumber
              id="desktop-width"
              value={state.desktopWidth}
              onChange={(v) => set("desktopWidth", v)}
              placeholder="1440"
              invalid={issueFor("viewports.desktop.width") !== undefined}
            />
          </SettingsField>
          <SettingsField label="desktop h" htmlFor="desktop-height" error={issueFor("viewports.desktop.height")}>
            <UnderlineNumber
              id="desktop-height"
              value={state.desktopHeight}
              onChange={(v) => set("desktopHeight", v)}
              placeholder="900"
              invalid={issueFor("viewports.desktop.height") !== undefined}
            />
          </SettingsField>
        </div>
      </SettingsSection>

      {issues.length > 0 ? (
        <DangerCallout role="alert" testId="config-issues">
          <p className="font-medium">
            {issues.length} problem{issues.length === 1 ? "" : "s"} — nothing was written.
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`} className="min-w-0">
                <span className="mono text-[10.5px]">{issue.path || "(root)"}</span> — {issue.message}
              </li>
            ))}
          </ul>
        </DangerCallout>
      ) : null}

      <div className="flex min-w-0 flex-col gap-3 border-t border-line pt-5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3">
          <PrimaryButton
            type="submit"
            disabled={status.kind === "saving"}
            className={ACTION}
          >
            {status.kind === "saving" ? "saving…" : "save"}
          </PrimaryButton>
          <QuietButton
            type="button"
            onClick={() => void reload()}
            disabled={status.kind === "saving"}
            className={QUIET_ACTION}
          >
            reload from disk
          </QuietButton>

          {/* A result is never colour alone: mark shape + word, as everywhere else in the panel. */}
          {status.kind === "saved" ? (
            <span
              className="inline-flex min-w-0 items-center gap-2 text-ok"
              role="status"
              data-testid="save-status"
            >
              <span className="mark mark-done" aria-hidden />
              <span className="statusword">{status.unchanged ? "unchanged" : "saved"}</span>
              {status.unchanged ? (
                <span className="text-[12px] text-ink-2">nothing to write — the file is untouched</span>
              ) : null}
            </span>
          ) : null}
          {status.kind === "error" ? (
            <span
              className="inline-flex min-w-0 items-center gap-2 text-danger"
              role="alert"
              data-testid="save-status"
            >
              <span className="mark mark-error" aria-hidden />
              <span className="statusword">error</span>
              <span className="min-w-0 text-[12px] leading-[1.5]">{status.message}</span>
            </span>
          ) : null}
        </div>
        <span className="mono min-w-0 text-[9.5px] break-all text-muted">{path}</span>
      </div>
    </form>
  );
}

function ClaudeCliNote() {
  return (
    <p data-testid="claude-cli-warning" className="mono text-[9.5px] text-ink-3">
      {CLAUDE_CLI_NOTE}
    </p>
  );
}
