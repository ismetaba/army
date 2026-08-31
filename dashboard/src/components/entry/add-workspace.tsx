"use client";

/**
 * `+ Add workspace` and the two-step slip behind it (handoff § 01c).
 *
 * **Why one component for the row and the slip.** They share exactly one piece of state — is the
 * slip open — and nothing else on the entry screen needs it. A context provider wrapped around the
 * whole page would be a second way to open a modal that only one button opens.
 *
 * **Why a native `<dialog>`.** § Accessibility asks for a modal that traps focus and returns it on
 * close, and `esc` to close it. `showModal()` is that, implemented by the browser: the rest of the
 * document goes inert (so focus physically cannot leave), `esc` fires `cancel`/`close`, and focus
 * returns on its own. A hand-rolled Tab-cycling trap would be a worse copy of this, and every
 * hand-rolled one leaks. The design's "dim the page behind to 45%" is the `::backdrop` painted in
 * paper at 55% — content at 45% over paper and paper at 55% over content are the same colour.
 *
 * **What CREATE actually does.** `POST /api/workspaces` with `{ name, repoRoot }` — the existing
 * contract, whose `{ ok:false, message }` is rendered verbatim (including its "run `init` first"
 * text when the repo has no `aw.config.json`). Step 2's provider/model are NOT part of that route's
 * body, so they are written the only real way there is: `PUT /api/config` with a
 * `{ defaults: { provider, model } }` patch, once the workspace is registered and its config is
 * therefore reachable. Untouched defaults send no patch at all, so a freshly `init`ed config keeps
 * the bytes `init` wrote.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FieldLabel, QuietButton } from "@/components/ledger/chrome";

interface Failure {
  message: string;
  /** The route tags which field a 400 belongs to; `repoRoot` sends the reader back to step 1. */
  field?: string;
}

export function AddWorkspace({
  providers,
  /** The first-launch row (§ 01b): the entry stands alone, with no helper and no ⌘N badge. */
  bare = false,
}: {
  providers: readonly string[];
  bare?: boolean;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const repoInput = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [repoRoot, setRepoRoot] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [provider, setProvider] = useState(providers[0] ?? "lmstudio");
  const [defaultsEdited, setDefaultsEdited] = useState(false);
  const [model, setModel] = useState("");
  const [error, setError] = useState<Failure | null>(null);
  const [registered, setRegistered] = useState(false);
  const [busy, setBusy] = useState(false);

  const openSlip = useCallback(() => {
    setStep(1);
    setRepoRoot("");
    setName("");
    setNameEdited(false);
    setBrowsing(false);
    setProvider(providers[0] ?? "lmstudio");
    setDefaultsEdited(false);
    setModel("");
    setError(null);
    setRegistered(false);
    setOpen(true);
  }, [providers]);

  const closeSlip = useCallback(() => {
    setOpen(false);
    // The browser returns focus on its own when a modal dialog closes; this is the belt to that
    // brace, and it names the element the design cares about rather than "whatever had focus".
    opener.current?.focus();
  }, []);

  // The dialog element is the source of truth for "am I showing"; `open` drives it one way.
  useEffect(() => {
    const el = dialog.current;
    if (el === null) return;
    if (open && !el.open) {
      el.showModal();
      repoInput.current?.focus();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  // ⌘N opens the slip (§ Accessibility). Ctrl+N too, for a keyboard that has no ⌘.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "n") return;
      event.preventDefault();
      if (!open) openSlip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, openSlip]);

  function onRepoChange(value: string) {
    setRepoRoot(value);
    setError(null);
    if (!nameEdited) setName(basename(value));
  }

  const trimmedRepo = repoRoot.trim();
  const trimmedName = name.trim();
  const canAdvance = trimmedRepo !== "" && trimmedName !== "";

  function next() {
    if (!trimmedRepo.startsWith("/")) {
      setError({ message: "repoRoot must be an absolute path", field: "repoRoot" });
      return;
    }
    setError(null);
    setStep(2);
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      if (!registered) {
        const failure = await postJson("/api/workspaces", "POST", {
          name: trimmedName,
          repoRoot: trimmedRepo,
        });
        if (failure !== null) {
          setError(failure);
          if (failure.field === "repoRoot") setStep(1);
          return;
        }
        setRegistered(true);
      }

      // Only when the reader actually chose something. An untouched step 2 must not rewrite a
      // config that `aw init` just wrote.
      if (defaultsEdited || model.trim() !== "") {
        const patch = {
          defaults: { provider, ...(model.trim() === "" ? {} : { model: model.trim() }) },
        };
        const failure = await postJson("/api/config", "PUT", { ws: trimmedName, patch });
        if (failure !== null) {
          setError({
            message: `the workspace was registered, but aw.config.json was not updated — ${failure.message}`,
          });
          return;
        }
      }

      closeSlip();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Glass § 01: the full-width dashed add pane — a dashed gold border, a dashed circle
          with `+`, the label and helper, and the ⌘N key cap right-aligned. */}
      <button
        ref={opener}
        type="button"
        onClick={openSlip}
        className="group flex w-full items-center justify-between gap-5 rounded-[18px] border border-dashed border-accent-line px-6 py-5 text-left transition-colors duration-[180ms] hover:border-accent hover:bg-accent-tint/50 focus-visible:[outline:2px_solid_var(--accent)] focus-visible:[outline-offset:2px]"
      >
        <span className="flex min-w-0 items-center gap-4">
          <span
            aria-hidden
            className="flex size-[34px] flex-none items-center justify-center rounded-full border border-dashed border-accent-line text-[15px] text-accent"
          >
            +
          </span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[15px] leading-[1.2] font-semibold tracking-[-0.02em] text-fg">
              Add workspace
            </span>
            <span className="font-mono text-[9.5px] tracking-[-0.03em] text-muted">
              point at a repo folder · two steps
            </span>
          </span>
        </span>
        {!bare && (
          <kbd
            aria-hidden
            className="chip hidden flex-none px-2 py-1 font-mono text-[9.5px] tracking-[-0.02em] text-ink-2 sm:block"
          >
            ⌘N
          </kbd>
        )}
      </button>

      {/*
        No `display` utility on the dialog itself: an author `display:flex` would beat the UA's
        `dialog:not([open]) { display:none }` and leave the slip painted over a closed page.
        The flex column lives one level in.
      */}
      <dialog
        ref={dialog}
        aria-label="Add workspace"
        onClose={() => setOpen(false)}
        onCancel={(event) => {
          // Esc while `create()` is in flight: the POST keeps going, the slip vanishes looking
          // like a cancellation, and its error would render into an unmounted dialog. The Create
          // button already disables itself; Esc and the backdrop follow the same rule.
          if (busy) event.preventDefault();
        }}
        onClick={(event) => {
          if (event.target === dialog.current && !busy) closeSlip();
        }}
        className="shadow-slip-right fixed top-0 right-0 bottom-0 left-auto m-0 h-dvh max-h-dvh w-[420px] max-w-full border-l border-rule-2 bg-drawer p-0 text-fg backdrop:bg-canvas backdrop:opacity-60"
      >
        <div className="flex h-full flex-col">
          <div className="flex flex-none items-center justify-between gap-4 border-b border-line px-6 py-[18px]">
            <span className="font-mono text-[10px] font-medium tracking-[0.14em] text-fg uppercase">
              Add workspace
            </span>
            <span className="font-mono text-[11px] text-muted">STEP {step}/2</span>
          </div>

          {/* Two-segment progress rule (§ 01c) — which step you are on, in the design's own idiom. */}
          <div className="flex flex-none gap-1 px-6 pt-3" aria-hidden>
            <span className="h-0.5 flex-1 bg-fg" />
            <span className={`h-0.5 flex-1 ${step === 2 ? "bg-fg" : "bg-line"}`} />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto px-6 py-[26px]">
            {step === 1 ? (
              <>
                <div className="flex flex-col gap-[9px]">
                  <FieldLabel>Repo folder</FieldLabel>
                  <div
                    className={`field-row flex items-center justify-between gap-3 ${
                      trimmedRepo === "" ? "" : ""
                    }`}
                  >
                    <input
                      ref={repoInput}
                      value={repoRoot}
                      onChange={(event) => onRepoChange(event.target.value)}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="/Users/you/code/your-repo"
                      aria-label="Repo folder"
                      className="field-bare min-w-0 flex-1 font-mono text-[11px] tracking-[-0.03em] placeholder:text-muted"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setBrowsing(true);
                        repoInput.current?.focus();
                      }}
                      className="flex-none font-mono text-[9.5px] tracking-[0.04em] text-accent uppercase transition-colors duration-[180ms] hover:text-accent-hover"
                    >
                      Browse
                    </button>
                  </div>
                  {browsing && (
                    <p className="font-mono text-[10px] leading-[1.6] tracking-[-0.03em] text-muted">
                      a browser cannot read an absolute path out of a folder picker — paste it, or
                      drag the folder onto a terminal to print it
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-[9px]">
                  <FieldLabel>Name</FieldLabel>
                  <div className="field-row flex items-center gap-0.5">
                    {/* Sized in `ch` so the caret sits immediately after the last character, the
                        way the artboard draws it. Mono makes `ch` exact. */}
                    <input
                      value={name}
                      onChange={(event) => {
                        setNameEdited(true);
                        setName(event.target.value);
                        setError(null);
                      }}
                      onFocus={() => setNameFocused(true)}
                      onBlur={() => setNameFocused(false)}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="workspace-name"
                      aria-label="Name"
                      style={{ width: `${name.length || 15}ch` }}
                      className="field-bare max-w-full font-mono text-[13px] tracking-[-0.03em] placeholder:text-muted"
                    />
                    {/* The design's blinking caret marks NAME as the live field at rest; while the
                        field IS focused the browser draws the real one, so this stands down rather
                        than blinking beside it. */}
                    {!nameFocused && name !== "" && (
                      <span aria-hidden className="anim-caret h-[15px] w-px flex-none bg-accent" />
                    )}
                  </div>
                  <p className="font-mono text-[10px] tracking-[-0.03em] text-muted">
                    taken from the folder — editable
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-[11px]">
                  <FieldLabel>Default provider</FieldLabel>
                  <div role="radiogroup" aria-label="Default provider" className="flex flex-wrap gap-2">
                    {providers.map((id) => {
                      const selected = id === provider;
                      return (
                        <button
                          key={id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => {
                            setProvider(id);
                            setDefaultsEdited(true);
                          }}
                          className={`rounded-[11px] font-mono text-[10px] tracking-[-0.02em] transition-colors duration-[180ms] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
                            selected
                              ? "bg-accent px-[10px] py-1.5 text-accent-ink"
                              : "border border-rule-dotted px-[10px] py-1.5 text-ink-2 hover:border-accent-line hover:text-fg"
                          }`}
                        >
                          {id}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="flex flex-col gap-[9px]">
                  <FieldLabel>Model id</FieldLabel>
                  <input
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="qwen3-coder-30b-a3b-instruct"
                    aria-label="Model id"
                    className="field mono text-[11px] placeholder:text-muted"
                  />
                  <p className="font-mono text-[10px] leading-[1.6] tracking-[-0.03em] text-muted">
                    used unless a task overrides it — saved to the repo&apos;s aw.config.json
                  </p>
                </div>
              </>
            )}

            {error !== null && (
              <p
                role="alert"
                className="border-l-[3px] border-danger bg-danger-tint px-3 py-2.5 font-mono text-[10.5px] leading-[1.7] tracking-[-0.03em] text-danger [overflow-wrap:anywhere]"
              >
                {error.message}
              </p>
            )}
          </div>

          <div className="flex flex-none items-center justify-between gap-4 border-t border-line px-6 py-[18px]">
            {step === 1 ? (
              <>
                <QuietButton type="button" onClick={closeSlip}>
                  Cancel
                </QuietButton>
                <SlipPrimary type="button" onClick={next} disabled={!canAdvance}>
                  Next →
                </SlipPrimary>
              </>
            ) : (
              <>
                <QuietButton type="button" onClick={() => setStep(1)}>
                  ← Back
                </QuietButton>
                {registered && error !== null ? (
                  <SlipPrimary
                    type="button"
                    onClick={() => {
                      closeSlip();
                      router.refresh();
                    }}
                  >
                    Done
                  </SlipPrimary>
                ) : (
                  <SlipPrimary type="button" onClick={() => void create()} disabled={busy}>
                    {busy ? "Creating…" : "Create"}
                  </SlipPrimary>
                )}
              </>
            )}
          </div>
        </div>
      </dialog>
    </>
  );
}

/**
 * The slip's primary action: ink fill that warms to accent on hover (§ 01c shows exactly this
 * hover). The shared `PrimaryButton` hovers to `ink-2` and carries the task screens' padding, and
 * overriding either from a `className` is a coin toss between two utilities of equal weight — so
 * the slip states its own rather than fighting the shared one.
 */
function SlipPrimary(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="btnlabel rounded-[13px] bg-accent px-4 py-2.5 text-accent-ink transition-all duration-[180ms] hover:-translate-y-px hover:bg-accent-hover hover:shadow-[0_14px_28px_-14px_#e8b04b] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:translate-y-0 disabled:opacity-40 disabled:shadow-none"
    />
  );
}

/** The last path segment, which is what the design prefills NAME with. */
function basename(value: string): string {
  const trimmed = value.trim().replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * A mutating request to one of the panel's own routes. Returns `null` on success, or the route's
 * own `{ message, field }` — never a message of this component's invention, so what the reader
 * sees is what the server actually decided.
 */
async function postJson(
  url: string,
  method: "POST" | "PUT",
  body: unknown,
): Promise<Failure | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { message: "the panel could not be reached — is it still running?" };
  }
  let parsed: unknown;
  try {
    parsed = (await response.json()) as unknown;
  } catch {
    parsed = null;
  }
  const payload = (parsed ?? {}) as { ok?: unknown; message?: unknown; field?: unknown };
  if (response.ok && payload.ok === true) return null;
  return {
    message:
      typeof payload.message === "string"
        ? payload.message
        : `the request failed (${response.status})`,
    field: typeof payload.field === "string" ? payload.field : undefined,
  };
}
