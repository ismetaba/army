"use client";

/**
 * The "New run" button and its modal (T22 step 3).
 *
 * One field per entry in `FIELDS[kind]` (`@/lib/trigger-args`) — the same allowlist the server
 * builds argv from, so the form cannot offer an argument the route would reject, and an argument
 * added to the CLI reaches this modal by being added to that one table. The client re-runs
 * `buildTriggerArgv` before posting purely as a courtesy: an error beside the field instead of a
 * round trip. The route validates again regardless; this half is never the gate.
 *
 * The preview under the buttons shows `displayCommand(argv)` — what the run will be, spelled the
 * way a human would type it. It is display only: the server builds its own argv from the JSON
 * body, and this string is never sent, parsed or executed. That distinction is the whole of SPEC
 * § Dashboard security invariants #4, and showing the command without blurring it is worth the
 * sentence of explanation under the box.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildTriggerArgv,
  displayCommand,
  emptyArgs,
  fieldsFor,
  PROVIDERS,
  REFUSED_PROVIDER,
  TRIGGER_KINDS,
  type FieldSpec,
  type TriggerKind,
} from "@/lib/trigger-args";

export interface NewRunModalProps {
  ws: string;
  /** Pre-open the modal on this kind — used by nothing yet, handy for a deep link. */
  defaultKind?: TriggerKind;
  /** Rendered in place of the default "New run" label. */
  label?: string;
}

type Values = Record<string, string | boolean>;

export function NewRunButton({ ws, defaultKind = "review", label = "New run" }: NewRunModalProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-new-run-open
        className="rounded border border-link bg-surface-2 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:brightness-105"
      >
        {label}
      </button>
      {open ? <NewRunModal ws={ws} defaultKind={defaultKind} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function NewRunModal({
  ws,
  defaultKind,
  onClose,
}: {
  ws: string;
  defaultKind: TriggerKind;
  onClose: () => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<TriggerKind>(defaultKind);
  const [values, setValues] = useState<Values>(() => emptyArgs(defaultKind));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<string | null>(null);
  const [runningPid, setRunningPid] = useState<number | null>(null);
  const firstField = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  const fields = fieldsFor(kind);

  // Switching kind resets the values: the two kinds share only `provider`/`model`, and carrying a
  // half-typed `feature` into `test-feature` as a `desc` would be a surprise, not a convenience.
  const chooseKind = (next: TriggerKind) => {
    setKind(next);
    setValues(emptyArgs(next));
    setError(null);
    setErrorField(null);
    setRunningPid(null);
  };

  useEffect(() => {
    firstField.current?.focus();
  }, [kind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  /** The argv this form currently describes — or the reason it does not describe one yet. */
  const built = useMemo(() => buildTriggerArgv(kind, values), [kind, values]);
  const preview = built.ok ? displayCommand([...built.argv, "--workspace", ws]) : null;

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
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
          setError(body?.message ?? `the run could not be started (HTTP ${response.status})`);
          setErrorField(body?.field ?? null);
          setRunningPid(typeof body?.runningPid === "number" ? body.runningPid : null);
          return;
        }
        // Straight to the live view. The modal unmounts with the navigation.
        router.push(`/ws/${encodeURIComponent(ws)}/live?pid=${body.pid}`);
      } catch {
        setError("the panel could not reach /api/trigger");
      } finally {
        setBusy(false);
      }
    },
    [kind, router, values, ws],
  );

  const set = (name: string, value: string | boolean) => {
    setValues((previous) => ({ ...previous, [name]: value }));
    if (errorField === name) {
      setError(null);
      setErrorField(null);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-run-title"
        data-new-run-modal
        className="flex w-full max-w-xl flex-col gap-4 rounded-lg border border-line bg-surface p-4 whitespace-normal shadow-lg"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="new-run-title" className="text-sm font-semibold text-fg">
            New run in <span className="font-mono">{ws}</span>
          </h2>
          <span className="text-xs text-muted">one run per workspace at a time</span>
        </div>

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-xs uppercase tracking-wide text-muted">Workflow</legend>
          <div className="flex flex-wrap gap-2">
            {TRIGGER_KINDS.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => chooseKind(k)}
                aria-pressed={kind === k}
                data-new-run-kind={k}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  kind === k
                    ? "border-link bg-surface-2 font-medium text-fg"
                    : "border-line bg-surface text-muted hover:border-link hover:text-fg"
                }`}
              >
                {k}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex min-w-0 flex-col gap-3">
          {fields.map((field, index) => (
            <Field
              key={`${kind}:${field.name}`}
              field={field}
              value={values[field.name] ?? (field.kind === "flag" ? false : "")}
              onChange={(value) => set(field.name, value)}
              error={errorField === field.name ? error : null}
              inputRef={index === 0 ? firstField : undefined}
            />
          ))}
        </div>

        {preview !== null ? (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted">will run</span>
            <code
              data-new-run-preview
              className="min-w-0 overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-xs whitespace-pre"
            >
              {preview}
            </code>
            <p className="text-xs text-muted">
              Shown for reading. The panel spawns an argv array with no shell, so every value above
              is one literal argument.
            </p>
          </div>
        ) : null}

        {error !== null && errorField === null ? (
          <p
            data-new-run-error
            className="rounded border border-line bg-error-bg px-3 py-2 text-xs break-words text-error-fg"
          >
            {error}
            {runningPid !== null ? (
              <>
                {" "}
                <a
                  href={`/ws/${encodeURIComponent(ws)}/live?pid=${runningPid}`}
                  data-new-run-watch
                  className="font-medium underline"
                >
                  Watch that run
                </a>
                .
              </>
            ) : null}
          </p>
        ) : null}

        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded border border-line bg-surface-2 px-3 py-1.5 text-sm text-fg transition-colors hover:border-link disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !built.ok}
            data-new-run-submit
            className="rounded border border-link bg-surface-2 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Starting…" : "Start run"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
  error,
  inputRef,
}: {
  field: FieldSpec;
  value: string | boolean;
  onChange: (value: string | boolean) => void;
  error: string | null;
  inputRef?: React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>;
}) {
  const id = `new-run-${field.name}`;
  const invalid = error !== null;
  const border = invalid ? "border-error-fg" : "border-line";

  if (field.kind === "flag") {
    return (
      <label className="flex min-w-0 items-start gap-2 text-sm" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          data-new-run-field={field.name}
          className="mt-0.5"
        />
        <span className="min-w-0">
          <span className="text-fg">{field.label}</span>
          {field.help ? <span className="block text-xs text-muted">{field.help}</span> : null}
        </span>
      </label>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-sm text-fg">
        {field.label}
        {field.required === true ? <span className="ml-1 text-error-fg">*</span> : null}
      </label>

      {field.kind === "provider" ? (
        <select
          id={id}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          data-new-run-field={field.name}
          className={`min-w-0 rounded border ${border} bg-surface-2 px-2 py-1.5 text-sm text-fg`}
        >
          <option value="">(from aw.config.json)</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {p}
              {p === REFUSED_PROVIDER ? " — refused by CLI workflows" : ""}
            </option>
          ))}
        </select>
      ) : field.kind === "text" ? (
        <textarea
          id={id}
          ref={inputRef as React.RefObject<HTMLTextAreaElement | null> | undefined}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          placeholder={field.placeholder}
          data-new-run-field={field.name}
          className={`min-w-0 resize-y rounded border ${border} bg-surface-2 px-2 py-1.5 font-sans text-sm text-fg placeholder:text-muted`}
        />
      ) : (
        <input
          id={id}
          ref={inputRef as React.RefObject<HTMLInputElement | null> | undefined}
          type="text"
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          data-new-run-field={field.name}
          className={`min-w-0 rounded border ${border} bg-surface-2 px-2 py-1.5 font-mono text-sm text-fg placeholder:text-muted`}
        />
      )}

      {/* `claude-cli` is selectable so the panel does not silently disagree with a config that
          names it — with the CLI's own reason attached (SPEC § Agent session loop). */}
      {field.kind === "provider" && value === REFUSED_PROVIDER ? (
        <p data-new-run-claude-cli className="text-xs font-medium text-error-fg">
          claude-cli works only via the .claude/ native path — CLI runs will refuse it.
        </p>
      ) : null}

      {error !== null ? (
        <p data-new-run-field-error={field.name} className="text-xs font-medium text-error-fg">
          {error}
        </p>
      ) : field.help ? (
        <p className="text-xs text-muted">{field.help}</p>
      ) : null}
    </div>
  );
}
