"use client";

/**
 * "The slip" — the create-task sheet (handoff § 03 / 03b).
 *
 * One form for three workflows. The fields it renders come from `FIELDS[kind]` in
 * `@/lib/trigger-args` — the same per-kind ALLOWLIST the server builds argv from — so the slip
 * cannot offer an argument `/api/trigger` would reject, and an option added to the CLI reaches
 * this sheet by being added to that one table.
 *
 * Two things are worth being explicit about, because they are the security shape of this screen:
 *
 * 1. **`WILL RUN` is not a hand-built string.** It is `displayCommand(argv)` over the argv array
 *    this form currently describes, quoted the way a shell would need it. Nothing is executed from
 *    it and nothing is sent: the route receives `{ws, kind, args}` as JSON, re-runs the same
 *    allowlist, and spawns an argv ARRAY with `shell: false`. The string exists so a human can
 *    read what will happen (SPEC § Dashboard security invariants #4).
 * 2. **The client's validation is a courtesy, never a gate.** `buildTriggerArgv` runs here so a
 *    typo is an error beside the field instead of a round trip. The route validates again.
 *
 * Modality is the handoff's (§ Accessibility): `esc` closes, `⌘↵` starts, focus is trapped while
 * it is open and returned to whatever opened it on close.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/ledger/chrome";
import {
  buildTriggerArgv,
  displayCommand,
  emptyArgs,
  fieldsFor,
  PROVIDERS,
  REFUSED_PROVIDER,
} from "@/lib/trigger-args";
import { kindMeta, type RunKind } from "./model";

export interface SlipDefaults {
  provider: string | null;
  model: string | null;
}

export interface BackendHealth {
  /** `null` when the workspace's config declares no backend at all. */
  up: boolean | null;
  label: string;
}

type Values = Record<string, string | boolean>;

/** The fields the design draws by hand; everything else in the allowlist lives in the disclosure. */
const OVERRIDE_FIELDS = new Set(["provider", "model"]);

export function CreateTaskSlip({
  ws,
  kind,
  defaults,
  backend,
  onClose,
}: {
  ws: string;
  kind: RunKind;
  defaults: SlipDefaults;
  backend: BackendHealth;
  onClose: () => void;
}) {
  const router = useRouter();
  const meta = kindMeta(kind);
  const titleId = useId();

  const [values, setValues] = useState<Values>(() => initialValues(kind));
  const [showOverride, setShowOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [runningPid, setRunningPid] = useState<number | null>(null);

  const sheet = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  const fields = fieldsFor(kind);
  const extras = fields.filter((f) => !OVERRIDE_FIELDS.has(f.name) && !DESIGNED.has(f.name));

  /*
   * `test-feature` drives HTTP at the workspace's own backend; with nothing listening there is
   * nothing to test, and the run would burn a model call to discover it. Handoff § Empty & error
   * states: "backend down → test-feature start is disabled with the reason inline".
   */
  const blocked = kind === "test-feature" && backend.up === false ? backend.label : null;

  const built = useMemo(() => buildTriggerArgv(kind, values), [kind, values]);
  const willRun = built.ok ? displayCommand([...built.argv, "--workspace", ws]) : null;

  const set = (name: string, value: string | boolean) => {
    setValues((previous) => ({ ...previous, [name]: value }));
    if (errorField === name) {
      setError(null);
      setErrorField(null);
    }
  };

  const start = useCallback(async () => {
    if (busy || blocked !== null) return;
    setError(null);
    setErrorField(null);
    setRunningPid(null);

    const check = buildTriggerArgv(kind, values);
    if (!check.ok) {
      setError(check.error.message);
      setErrorField(check.error.field);
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/trigger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ws, kind, args: values }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; pid?: number; message?: string; field?: string; runningPid?: number }
        | null;

      if (!response.ok || body?.ok !== true || typeof body.pid !== "number") {
        // The 1-run-per-workspace guard answers 409 with the pid holding the workspace, so the
        // message can offer to watch it rather than only refusing.
        setError(body?.message ?? `the task could not be started (HTTP ${response.status})`);
        setErrorField(body?.field ?? null);
        setRunningPid(typeof body?.runningPid === "number" ? body.runningPid : null);
        return;
      }

      // Handoff § Interactions: "the run appears at the top of the ledger as the running row and
      // the left margin switches to the live entry" — so the slip closes onto the ledger rather
      // than navigating away. WATCH on the running row is how you leave for the live view.
      onClose();
      router.refresh();
    } catch {
      setError("the panel could not reach /api/trigger");
    } finally {
      setBusy(false);
    }
  }, [blocked, busy, kind, onClose, router, values, ws]);

  // ── modality: esc, ⌘↵, a focus trap and the focus returned on close ──────────────────────────
  useEffect(() => {
    opener.current = document.activeElement;
    // The first FIELD, not the first focusable — which is the ✕. Opening a form with the close
    // button focused means the accent underline (the design's focus signal) is nowhere, and the
    // first thing `⌘↵`'s neighbour `↵` would do is dismiss the sheet.
    const node = sheet.current;
    const field = node?.querySelector<HTMLElement>("[data-slip-field]");
    (field ?? node?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement) back.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) onClose();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void start();
        return;
      }
      if (event.key !== "Tab") return;

      // The trap. `document` rather than the sheet, so focus that has already escaped (the address
      // bar, an extension) is pulled back rather than allowed to walk the page behind the dim.
      const node = sheet.current;
      if (node === null) return;
      const focusable = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1,
      );
      if (focusable.length === 0) return;
      const firstEl = focusable[0]!;
      const lastEl = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === firstEl || !node.contains(active))) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && (active === lastEl || !node.contains(active))) {
        event.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose, start]);

  const inherit = `inherit — ${defaults.provider ?? "?"} / ${defaults.model ?? "?"}`;

  return (
    <div
      // The workspace stays visible under a paper wash rather than a black scrim: the slip is a
      // sheet laid on the ledger, not a lightbox (handoff § 03).
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-canvas/80 p-4 min-[900px]:p-14"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-slip={kind}
        className="shadow-slip-center flex w-[720px] max-w-full flex-col border border-rule-2 bg-surface"
      >
        <header className="flex items-center justify-between gap-4 border-b-2 border-fg px-7 py-5">
          <div className="flex min-w-0 items-baseline gap-3">
            <span className="mono text-[10px] text-accent">{meta.index}</span>
            <h2 id={titleId} className="truncate text-[22px] font-semibold tracking-[-0.025em]">
              {meta.title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            data-slip-close
            className="flex size-11 flex-none items-center justify-center text-[12px] text-muted transition-colors duration-[180ms] hover:text-fg min-[900px]:size-6"
          >
            ✕
          </button>
        </header>

        <p className="max-w-[520px] px-7 pt-[26px] pb-2 text-[13.5px] leading-[1.6] text-ink-2 text-pretty">
          {meta.description}
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
          className="flex flex-col gap-[26px] px-7 pt-5 pb-[26px]"
        >
          {kind === "review" ? (
            <BaseRefField
              value={String(values.base ?? "")}
              onChange={(v) => set("base", v)}
              error={errorField === "base" ? error : null}
            />
          ) : null}

          {kind === "test-feature" ? (
            <>
              <TextField
                name="desc"
                label="WHAT TO VERIFY"
                multiline
                placeholder="POST /api/items rejects an item with no name"
                value={String(values.desc ?? "")}
                onChange={(v) => set("desc", v)}
                error={errorField === "desc" ? error : null}
              />
              <TextField
                name="url"
                label="TARGET URL"
                aside="OPTIONAL"
                placeholder="http://127.0.0.1:3001"
                value={String(values.url ?? "")}
                onChange={(v) => set("url", v)}
                error={errorField === "url" ? error : null}
              />
            </>
          ) : null}

          {kind === "design-loop" ? (
            <>
              <TextField
                name="feature"
                label="FEATURE DESCRIPTION"
                multiline
                placeholder="Rebuild the About page header with the new nav and a compact footer"
                value={String(values.feature ?? "")}
                onChange={(v) => set("feature", v)}
                error={errorField === "feature" ? error : null}
              />
              <Segmented
                name="video"
                label="record video"
                note="adds ~40s per screen"
                on={values.video === true}
                onChange={(v) => set("video", v)}
              />
            </>
          ) : null}

          {/* The rest of this kind's allowlist. The design draws the fields above by hand; these
              are the options the CLI also accepts, kept because dropping them would quietly remove
              a capability this screen replaces. */}
          {extras.map((field) =>
            field.kind === "flag" ? (
              <Segmented
                key={field.name}
                name={field.name}
                label={field.label.toLowerCase()}
                note={field.help ?? ""}
                on={values[field.name] === true}
                onChange={(v) => set(field.name, v)}
              />
            ) : (
              <TextField
                key={field.name}
                name={field.name}
                label={field.label.toUpperCase()}
                aside="OPTIONAL"
                multiline={field.kind === "text"}
                placeholder={field.placeholder ?? ""}
                value={String(values[field.name] ?? "")}
                onChange={(v) => set(field.name, v)}
                error={errorField === field.name ? error : null}
              />
            ),
          )}

          <div className="flex flex-col gap-4">
            <button
              type="button"
              onClick={() => setShowOverride((v) => !v)}
              aria-expanded={showOverride}
              data-slip-override
              className="flex items-baseline justify-between gap-4 border-b border-line pb-2.5 text-left transition-colors duration-[180ms] hover:border-fg"
            >
              <span className="flex items-baseline gap-2.5">
                <span aria-hidden className="text-[9px] text-muted">
                  {showOverride ? "▾" : "▸"}
                </span>
                <span className="label">provider / model override</span>
              </span>
              <span className="mono truncate text-[9.5px] text-muted">{inherit}</span>
            </button>

            {showOverride ? (
              <div className="flex flex-col gap-6">
                <ProviderField
                  value={String(values.provider ?? "")}
                  inherit={defaults.provider ?? "aw.config.json"}
                  onChange={(v) => set("provider", v)}
                  error={errorField === "provider" ? error : null}
                />
                <TextField
                  name="model"
                  label="MODEL ID"
                  aside="OPTIONAL"
                  placeholder={defaults.model ?? "qwen3-coder-30b-a3b-instruct"}
                  value={String(values.model ?? "")}
                  onChange={(v) => set("model", v)}
                  error={errorField === "model" ? error : null}
                />
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-2.5">
            <span className="label">will run</span>
            {willRun === null ? (
              <p className="cmd-strip mono px-4 py-3 text-[10.5px] text-muted">
                {built.ok ? "" : built.error.message}
              </p>
            ) : (
              <div className="cmd-strip flex items-center gap-3 px-4 py-3">
                <code data-slip-will-run className="mono min-w-0 flex-1 truncate text-[10.5px]">
                  {willRun}
                </code>
                <CopyButton value={willRun} />
              </div>
            )}
          </div>

          {blocked !== null ? (
            <p data-slip-blocked className="border-l-2 border-danger bg-danger-tint px-3.5 py-2.5 text-[11px] text-danger">
              {blocked} — start the backend for this workspace, or fix its port in settings, before
              black-box-testing it.
            </p>
          ) : null}

          {error !== null && errorField === null ? (
            <p data-slip-error className="border-l-2 border-danger bg-danger-tint px-3.5 py-2.5 text-[11px] text-danger">
              {error}
              {runningPid !== null ? (
                <>
                  {" "}
                  <a
                    href={`/ws/${encodeURIComponent(ws)}/live?pid=${runningPid}`}
                    data-slip-watch
                    className="btnlabel underline"
                  >
                    watch it ↗
                  </a>
                </>
              ) : null}
            </p>
          ) : null}

          <div className="-mx-7 -mb-[26px] mt-1 flex flex-wrap items-center justify-between gap-4 border-t border-line px-7 py-[18px]">
            <span className="mono text-[9.5px] text-muted">esc to cancel · ⌘↵ to start</span>
            <div className="flex items-center gap-5">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                data-slip-cancel
                className="btnlabel flex min-h-11 items-center px-1 text-ink-3 transition-colors duration-[180ms] hover:text-fg disabled:opacity-40 min-[900px]:min-h-0"
              >
                cancel
              </button>
              <button
                type="submit"
                disabled={busy || !built.ok || blocked !== null}
                data-slip-start
                className="btnlabel min-h-11 bg-accent px-5 py-2.5 text-surface transition-colors duration-[180ms] hover:bg-accent-hover disabled:opacity-40 min-[900px]:min-h-0"
              >
                {busy ? "starting…" : "start task"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The field names the design lays out itself, so the "extras" loop does not render them twice. */
const DESIGNED = new Set(["base", "desc", "url", "feature", "video"]);

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * `main` is pre-filled rather than left empty, because the design shows it and because it is what
 * the CLI defaults to anyway — so `WILL RUN` states the ref that will actually be diffed instead
 * of hiding it behind a default.
 */
function initialValues(kind: RunKind): Values {
  const values = emptyArgs(kind);
  if (kind === "review") values.base = "main";
  return values;
}

// ---------------------------------------------------------------------------
// fields — underlines, never boxes (handoff § Geometry)
// ---------------------------------------------------------------------------

function FieldFrame({
  label,
  aside,
  error,
  children,
}: {
  label: string;
  aside?: string;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="label">{label}</span>
        {error !== null ? (
          <span className="mono text-[9.5px] text-danger">{error}</span>
        ) : aside ? (
          <span className="mono text-[9.5px] text-muted">{aside}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function BaseRefField({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  error: string | null;
}) {
  return (
    <FieldFrame label="base ref" aside="diff is taken against this ref" error={error}>
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="main"
          data-slip-field="base"
          aria-label="Base ref"
          className={`field mono caret-accent min-w-0 flex-1 text-[14px] ${error === null ? "" : "border-danger"}`}
        />
        <div className="flex gap-2">
          {["develop", "HEAD~1"].map((ref) => (
            <button
              key={ref}
              type="button"
              onClick={() => onChange(ref)}
              className="mono border border-rule-2 px-2 py-1 text-[9px] text-ink-2 transition-colors duration-[180ms] hover:border-fg hover:text-fg"
            >
              {ref}
            </button>
          ))}
        </div>
      </div>
    </FieldFrame>
  );
}

function TextField({
  name,
  label,
  aside,
  placeholder,
  value,
  onChange,
  error,
  multiline = false,
}: {
  name: string;
  label: string;
  aside?: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  multiline?: boolean;
}) {
  const shared = `field mono caret-accent text-[12px] leading-[1.7] ${error === null ? "" : "border-danger"}`;
  return (
    <FieldFrame label={label} aside={aside} error={error}>
      {multiline ? (
        <textarea
          rows={2}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          data-slip-field={name}
          aria-label={label}
          className={`${shared} resize-y`}
        />
      ) : (
        <input
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          data-slip-field={name}
          aria-label={label}
          className={shared}
        />
      )}
    </FieldFrame>
  );
}

function ProviderField({
  value,
  inherit,
  onChange,
  error,
}: {
  value: string;
  inherit: string;
  onChange: (value: string) => void;
  error: string | null;
}) {
  return (
    <FieldFrame label="provider" aside={`inherits ${inherit}`} error={error}>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        data-slip-field="provider"
        aria-label="Provider"
        className="field mono min-h-11 text-[12px] min-[900px]:min-h-0"
      >
        <option value="">inherit</option>
        {PROVIDERS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      {/* Offered rather than hidden, with the CLI's own reason attached: a config that names
          claude-cli must not make the panel look like it disagrees for no stated cause. */}
      {value === REFUSED_PROVIDER ? (
        <p data-slip-claude-cli className="mono text-[9.5px] text-danger">
          claude-cli works only via the .claude/ native path — CLI runs will refuse it.
        </p>
      ) : null}
    </FieldFrame>
  );
}

function Segmented({
  name,
  label,
  note,
  on,
  onChange,
}: {
  name: string;
  label: string;
  note: string;
  on: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
      <span className="flex items-baseline gap-3">
        <span className="mono text-[12px] tracking-[-0.03em]">{label}</span>
        {note ? <span className="mono text-[9.5px] text-muted">{note}</span> : null}
      </span>
      <div role="group" aria-label={label} className="flex border border-fg">
        {([false, true] as const).map((state) => (
          <button
            key={String(state)}
            type="button"
            aria-pressed={on === state}
            onClick={() => onChange(state)}
            data-slip-field={`${name}:${state ? "on" : "off"}`}
            className={`mono min-h-11 px-2.5 py-1.5 text-[9px] tracking-[0.04em] transition-colors duration-[180ms] min-[900px]:min-h-0 ${
              on === state ? "bg-fg text-bg" : "text-ink-3 hover:text-fg"
            }`}
          >
            {state ? "ON" : "OFF"}
          </button>
        ))}
      </div>
    </div>
  );
}
