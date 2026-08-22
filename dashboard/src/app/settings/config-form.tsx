"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AGENT_NAMES, PROVIDER_IDS, isPlainObject } from "@/lib/config-patch";
import type { FieldIssue } from "@/lib/config-patch";

/**
 * T21 step 1 — the settings form for one workspace's `aw.config.json`.
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
 * environment variable, and the note under it says where the password actually lives. SPEC
 * § Dashboard security invariants #5; the API rejects a password-shaped key even if one somehow
 * reached it.
 */

/** T21 step 4, verbatim. Shown on any provider row set to `claude-cli`. */
const CLAUDE_CLI_WARNING =
  "claude-cli works only via the .claude/ native path — CLI runs will refuse it.";

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

  const claudeCliRows = [
    state.defaultsProvider === "claude-cli" ? "defaults" : null,
    ...AGENT_NAMES.map((name) => (state.agents[name]?.provider === "claude-cli" ? name : null)),
  ].filter((v): v is string => v !== null);

  return (
    // `noValidate`: the browser's own constraint validation must not get a vote here. With it on,
    // a port typed as "eighty" makes the form *refuse to submit* and shows a native tooltip, so
    // the server never sees the value and the panel cannot say which field is wrong or that
    // nothing was written. One validator (the server, which owns the file) beats two that
    // disagree — and it is the same validator the CLI uses.
    <form onSubmit={save} noValidate className="flex min-w-0 flex-col gap-6" data-testid="config-form">
      <Section
        title="Defaults"
        hint="Used by every agent that has no override below (SPEC § Model resolution, level 3)."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="provider" htmlFor="defaults-provider" error={issueFor("defaults.provider")}>
            <select
              id="defaults-provider"
              value={state.defaultsProvider}
              onChange={(e) => set("defaultsProvider", e.target.value)}
              className={inputClass(issueFor("defaults.provider"))}
            >
              {PROVIDER_IDS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="model" htmlFor="defaults-model" error={issueFor("defaults.model")}>
            <input
              id="defaults-model"
              type="text"
              value={state.defaultsModel}
              onChange={(e) => set("defaultsModel", e.target.value)}
              placeholder="qwen3-coder-30b-a3b-instruct"
              className={inputClass(issueFor("defaults.model"))}
            />
          </Field>
        </div>
        {state.defaultsProvider === "claude-cli" ? <ClaudeCliWarning /> : null}
      </Section>

      <Section
        title="Agent overrides"
        hint="Per-agent provider and model. “inherit” means the default above; a provider that differs from the default needs its own model id."
      >
        <div className="flex min-w-0 flex-col gap-4">
          {AGENT_NAMES.map((name) => {
            const row = state.agents[name] ?? { provider: "", model: "" };
            return (
              <div key={name} className="flex min-w-0 flex-col gap-2" data-agent-row={name}>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-[10rem_1fr_1fr]">
                  <span className="self-center font-mono text-sm text-fg">{name}</span>
                  <Field
                    label="provider"
                    htmlFor={`agent-${name}-provider`}
                    error={issueFor(`agents.${name}.provider`)}
                  >
                    <select
                      id={`agent-${name}-provider`}
                      value={row.provider}
                      onChange={(e) => setAgent(name, "provider", e.target.value)}
                      className={inputClass(issueFor(`agents.${name}.provider`))}
                    >
                      <option value="">inherit ({state.defaultsProvider || "default"})</option>
                      {PROVIDER_IDS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label="model"
                    htmlFor={`agent-${name}-model`}
                    error={issueFor(`agents.${name}.model`)}
                  >
                    <input
                      id={`agent-${name}-model`}
                      type="text"
                      value={row.model}
                      onChange={(e) => setAgent(name, "model", e.target.value)}
                      placeholder="inherit"
                      className={inputClass(issueFor(`agents.${name}.model`))}
                    />
                  </Field>
                </div>
                {row.provider === "claude-cli" ? <ClaudeCliWarning /> : null}
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="App" hint="How the workflows start and reach the app under test.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="backend start" htmlFor="backend-start" error={issueFor("app.backend.start")}>
            <input
              id="backend-start"
              type="text"
              value={state.backendStart}
              onChange={(e) => set("backendStart", e.target.value)}
              placeholder="npm run dev:api"
              className={inputClass(issueFor("app.backend.start"))}
            />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="backend port" htmlFor="backend-port" error={issueFor("app.backend.port")}>
              <NumberInput
                id="backend-port"
                value={state.backendPort}
                onChange={(v) => set("backendPort", v)}
                placeholder="3001"
                invalid={issueFor("app.backend.port") !== undefined}
              />
            </Field>
            <Field
              label="health path"
              htmlFor="backend-health"
              error={issueFor("app.backend.healthPath")}
            >
              <input
                id="backend-health"
                type="text"
                value={state.backendHealthPath}
                onChange={(e) => set("backendHealthPath", e.target.value)}
                placeholder="/health"
                className={inputClass(issueFor("app.backend.healthPath"))}
              />
            </Field>
          </div>
          <Field label="frontend start" htmlFor="frontend-start" error={issueFor("app.frontend.start")}>
            <input
              id="frontend-start"
              type="text"
              value={state.frontendStart}
              onChange={(e) => set("frontendStart", e.target.value)}
              placeholder="npm run dev"
              className={inputClass(issueFor("app.frontend.start"))}
            />
          </Field>
          <Field label="frontend port" htmlFor="frontend-port" error={issueFor("app.frontend.port")}>
            <NumberInput
              id="frontend-port"
              value={state.frontendPort}
              onChange={(v) => set("frontendPort", v)}
              placeholder="5173"
              invalid={issueFor("app.frontend.port") !== undefined}
            />
          </Field>
          <Field label="base URL" htmlFor="base-url" error={issueFor("app.baseUrl")}>
            <input
              id="base-url"
              type="text"
              value={state.baseUrl}
              onChange={(e) => set("baseUrl", e.target.value)}
              placeholder="http://localhost:3001"
              className={inputClass(issueFor("app.baseUrl"))}
            />
          </Field>
          <Field label="staging URL" htmlFor="staging-url" error={issueFor("app.stagingUrl")}>
            <input
              id="staging-url"
              type="text"
              value={state.stagingUrl}
              onChange={(e) => set("stagingUrl", e.target.value)}
              placeholder="(none — production is never a target)"
              className={inputClass(issueFor("app.stagingUrl"))}
            />
          </Field>
          <Field label="test account user" htmlFor="test-user" error={issueFor("app.testAccount.user")}>
            <input
              id="test-user"
              type="text"
              value={state.testUser}
              onChange={(e) => set("testUser", e.target.value)}
              placeholder="test@example.com"
              className={inputClass(issueFor("app.testAccount.user"))}
            />
          </Field>
          <Field
            label="password env var NAME"
            htmlFor="pass-env"
            error={issueFor("app.testAccount.passEnv")}
          >
            <input
              id="pass-env"
              type="text"
              value={state.passEnv}
              onChange={(e) => set("passEnv", e.target.value)}
              placeholder="AW_TEST_PASSWORD"
              autoComplete="off"
              className={inputClass(issueFor("app.testAccount.passEnv"))}
            />
          </Field>
        </div>
        <p className="rounded border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
          The password itself is never asked for, never shown and never written here. Set{" "}
          <span className="font-mono">{state.passEnv.trim() || "AW_TEST_PASSWORD"}</span> in your
          shell or <span className="font-mono">.env</span>; only its NAME is stored in{" "}
          <span className="font-mono">aw.config.json</span>.
        </p>
      </Section>

      <Section title="Viewports" hint="The two sizes design-loop screenshots every screen at.">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Field label="mobile width" htmlFor="mobile-width" error={issueFor("viewports.mobile.width")}>
            <NumberInput
              id="mobile-width"
              value={state.mobileWidth}
              onChange={(v) => set("mobileWidth", v)}
              placeholder="375"
              invalid={issueFor("viewports.mobile.width") !== undefined}
            />
          </Field>
          <Field label="mobile height" htmlFor="mobile-height" error={issueFor("viewports.mobile.height")}>
            <NumberInput
              id="mobile-height"
              value={state.mobileHeight}
              onChange={(v) => set("mobileHeight", v)}
              placeholder="812"
              invalid={issueFor("viewports.mobile.height") !== undefined}
            />
          </Field>
          <Field label="desktop width" htmlFor="desktop-width" error={issueFor("viewports.desktop.width")}>
            <NumberInput
              id="desktop-width"
              value={state.desktopWidth}
              onChange={(v) => set("desktopWidth", v)}
              placeholder="1440"
              invalid={issueFor("viewports.desktop.width") !== undefined}
            />
          </Field>
          <Field
            label="desktop height"
            htmlFor="desktop-height"
            error={issueFor("viewports.desktop.height")}
          >
            <NumberInput
              id="desktop-height"
              value={state.desktopHeight}
              onChange={(v) => set("desktopHeight", v)}
              placeholder="900"
              invalid={issueFor("viewports.desktop.height") !== undefined}
            />
          </Field>
        </div>
      </Section>

      <Section title="Off limits" hint="One per line. Handed to every agent as a hard boundary.">
        <Field label="offLimits" htmlFor="off-limits" error={issueFor("offLimits")} hideLabel>
          <textarea
            id="off-limits"
            rows={3}
            value={state.offLimits}
            onChange={(e) => set("offLimits", e.target.value)}
            placeholder={"shared dev database\nthe billing service"}
            className={`${inputClass(issueFor("offLimits"))} font-mono`}
          />
        </Field>
      </Section>

      {claudeCliRows.length > 0 ? (
        <p
          className="rounded border border-line bg-error-bg px-3 py-2 text-sm text-error-fg"
          data-testid="claude-cli-summary"
        >
          {CLAUDE_CLI_WARNING} Selected for: {claudeCliRows.join(", ")}.
        </p>
      ) : null}

      {issues.length > 0 ? (
        <div
          className="rounded border border-line bg-error-bg px-3 py-2 text-sm text-error-fg"
          role="alert"
          data-testid="config-issues"
        >
          <p className="font-medium">
            {issues.length} problem{issues.length === 1 ? "" : "s"} — nothing was written.
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <span className="font-mono">{issue.path || "(root)"}</span>: {issue.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center gap-3 border-t border-line pt-4">
        <button
          type="submit"
          disabled={status.kind === "saving"}
          className="rounded border border-link bg-surface-2 px-4 py-1.5 text-sm font-medium text-fg transition-colors hover:brightness-105 disabled:opacity-50"
        >
          {status.kind === "saving" ? "saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={status.kind === "saving"}
          className="rounded border border-line bg-surface px-3 py-1.5 text-sm text-muted transition-colors hover:border-link hover:text-fg disabled:opacity-50"
        >
          Reload from disk
        </button>

        {status.kind === "saved" ? (
          <span className="text-sm text-done-fg" data-testid="save-status">
            {status.unchanged ? "no changes — file untouched" : "saved"}
          </span>
        ) : null}
        {status.kind === "error" ? (
          <span className="text-sm text-error-fg" data-testid="save-status">
            {status.message}
          </span>
        ) : null}

        <span className="min-w-0 basis-full font-mono text-xs break-all text-muted">{path}</span>
      </div>
    </form>
  );
}

function ClaudeCliWarning() {
  return (
    <p
      className="rounded border border-line bg-error-bg px-3 py-2 text-xs text-error-fg"
      data-testid="claude-cli-warning"
      role="note"
    >
      {CLAUDE_CLI_WARNING}
    </p>
  );
}

function inputClass(error?: string): string {
  return `w-full min-w-0 rounded border bg-surface px-2 py-1.5 text-sm text-fg outline-none transition-colors focus:border-link ${
    error === undefined ? "border-line" : "border-error-fg"
  }`;
}

/**
 * A numeric field that keeps what you typed. `inputMode="numeric"` gets the numeric keypad on a
 * phone; the value stays a string all the way to the server — see the component header for why
 * `type="number"` is the wrong tool here, and the `noValidate` note on the form for why there is
 * no `pattern` either.
 */
function NumberInput({
  id,
  value,
  onChange,
  placeholder,
  invalid,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  invalid: boolean;
}) {
  return (
    <input
      id={id}
      type="text"
      inputMode="numeric"
      value={value}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`${inputClass(invalid ? "x" : undefined)} tabular-nums`}
    />
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold tracking-tight text-fg">{title}</h3>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  htmlFor,
  error,
  hideLabel = false,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hideLabel?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label
        htmlFor={htmlFor}
        className={`text-xs uppercase tracking-wide text-muted ${hideLabel ? "sr-only" : ""}`}
      >
        {label}
      </label>
      {children}
      {error === undefined ? null : (
        <p className="text-xs text-error-fg" data-field-error={htmlFor}>
          {error}
        </p>
      )}
    </div>
  );
}
