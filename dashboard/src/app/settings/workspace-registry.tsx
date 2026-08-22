"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CommandStrip, OutlineButton } from "@/components/ledger/chrome";
import {
  ACTION,
  DangerCallout,
  FieldError,
  SettingsField,
  SettingsSection,
  SubHead,
  UnderlineInput,
} from "@/components/settings/fields";

/**
 * The fourth ruled section of handoff § 05 — everything about the workspace as a REGISTRY ENTRY,
 * as opposed to the config file the form above edits.
 *
 * "Forget" is the word on the button on purpose. `DELETE /api/workspaces` removes one line from
 * `$AW_HOME/workspaces.json` and does nothing else — no repo file, no run directory — and the
 * confirm dialog says exactly that, listing the repo and the run count that will still be there
 * afterwards. A button labelled "Delete" next to a repo path would promise something else
 * entirely, and the one thing a destructive-looking control must never do is surprise.
 *
 * Rename is the design's other row, and it is the one control on this screen that cannot do its
 * own work: a workspace's name is its identity in three places at once (the `workspace` key in
 * `aw.config.json`, the registry entry, and the `$AW_HOME/<name>/` run directory), and the config
 * patch schema deliberately has no `workspace` key — a panel that could retarget a workspace
 * would be a way to make the CLI review the wrong repo (`src/lib/config-patch.ts`). So RENAME
 * opens the two steps that really do it, with the exact command to copy, rather than a field that
 * would either lie or half-work.
 */
export interface RegistryRow {
  name: string;
  repoRoot: string | null;
  runCount: number;
  /**
   * Runs in `archive/`. Counted apart from `runCount` because the dialog's promise is about what
   * stays in the store, and `listRuns` walks only `runs/` — a workspace whose runs have all been
   * archived read as "0 recorded runs" while its `archive/` directory sat there, full.
   */
  archivedCount: number;
  registered: boolean;
}

/** Single-quote a path for the copyable command — repo roots have spaces in them. */
function shellQuote(value: string): string {
  return /^[A-Za-z0-9._\-/]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function WorkspaceRegistry({
  current,
  workspaces,
  registryPath,
}: {
  /** The workspace the form above is bound to, or `null` when none is registered yet. */
  current: RegistryRow | null;
  workspaces: RegistryRow[];
  /** `$AW_HOME/workspaces.json` — the file every button in this section edits. */
  registryPath: string;
}) {
  const router = useRouter();
  const [forget, setForget] = useState<RegistryRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const [name, setName] = useState("");
  const [repoRoot, setRepoRoot] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerField, setRegisterField] = useState<string | null>(null);
  const [registered, setRegistered] = useState<string | null>(null);

  const others = workspaces.filter((w) => w.name !== current?.name);

  async function doForget() {
    if (forget === null) return;
    setBusy(true);
    setDialogError(null);
    try {
      const res = await fetch(`/api/workspaces?name=${encodeURIComponent(forget.name)}`, {
        method: "DELETE",
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) {
        setDialogError(body?.message ?? `request failed (${res.status})`);
        return;
      }
      setForget(null);
      startTransition(() => router.refresh());
    } catch {
      setDialogError("the panel could not reach the server");
    } finally {
      setBusy(false);
    }
  }

  async function doRegister(event: React.FormEvent) {
    event.preventDefault();
    setRegisterError(null);
    setRegisterField(null);
    setRegistered(null);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, repoRoot }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; message?: string; field?: string }
        | null;
      if (!res.ok || body?.ok !== true) {
        setRegisterError(body?.message ?? `registration failed (${res.status})`);
        setRegisterField(body?.field ?? null);
        return;
      }
      setRegistered(name);
      setName("");
      setRepoRoot("");
      router.refresh();
    } catch {
      setRegisterError("the panel could not reach the server");
    }
  }

  const renameTarget = newName.trim() === "" ? "<new-name>" : newName.trim();
  const renameCommand =
    current?.repoRoot === null || current === null
      ? null
      : `npx tsx src/cli.ts init --repo ${shellQuote(current.repoRoot)} --name ${renameTarget} --yes`;

  return (
    <SettingsSection id="workspace" title="Workspace" aside="registry only — the repo is never touched">
      {current === null ? (
        <p className="max-w-[62ch] text-[13px] leading-[1.6] text-ink-2">
          No workspace is registered yet. Register a repo below, or run{" "}
          <span className="mono text-[11px] text-fg">npx tsx src/cli.ts init</span> inside one.
        </p>
      ) : (
        <>
          {/* rename ------------------------------------------------------------------ */}
          <div className="flex min-w-0 flex-col gap-4 border-b border-dotted border-line pb-5">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div className="flex min-w-0 max-w-[52ch] flex-col gap-1.5">
                <h3 className="text-[14px] font-medium tracking-[-0.01em] text-fg">
                  Rename workspace
                </h3>
                <p className="text-[12px] leading-[1.6] text-ink-2">
                  The name is the identity{" "}
                  <span className="mono text-[10.5px] text-fg">--workspace</span> resolves against,
                  so it lives in the config, the registry and the run store at once. The panel
                  cannot rewrite it for you — it shows you the two steps that do.
                </p>
              </div>
              <OutlineButton
                type="button"
                aria-expanded={renameOpen}
                aria-controls="rename-steps"
                onClick={() => setRenameOpen((open) => !open)}
                className={`${ACTION} border-fg! text-fg! hover:bg-fg! hover:text-bg!`}
              >
                {renameOpen ? "close" : "rename"}
              </OutlineButton>
            </div>

            {renameOpen ? (
              <div id="rename-steps" className="flex min-w-0 flex-col gap-4">
                <SettingsField label="new name" htmlFor="rename-name">
                  <UnderlineInput
                    id="rename-name"
                    value={newName}
                    onChange={setNewName}
                    placeholder={current.name}
                  />
                </SettingsField>
                {renameCommand === null ? null : (
                  <div className="flex min-w-0 flex-col gap-2.5">
                    <span className="label">1 · re-run init under the new name</span>
                    <CommandStrip command={renameCommand} />
                    <span className="label">2 · forget the old entry</span>
                    <p className="max-w-[62ch] text-[12px] leading-[1.6] text-ink-2">
                      Init rewrites the <span className="mono text-[10.5px] text-fg">workspace</span>{" "}
                      key in <span className="mono text-[10.5px] text-fg">aw.config.json</span> and
                      adds the new registry entry; the old one is still there. Forget{" "}
                      <span className="mono text-[10.5px] text-fg">{current.name}</span> below once
                      the new name shows up. Runs filed under the old name stay in{" "}
                      <span className="mono text-[10.5px] text-fg">$AW_HOME/{current.name}/</span>.
                    </p>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          {/* forget ------------------------------------------------------------------ */}
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-dotted border-line pb-5">
            <div className="flex min-w-0 max-w-[52ch] flex-col gap-1.5">
              <h3 className="text-[14px] font-medium tracking-[-0.01em] text-fg">
                Forget workspace
              </h3>
              <p className="text-[12px] leading-[1.6] text-ink-2">
                Removes the registry entry, and with it this workspace and its run history from the
                panel. The repository on disk stays exactly as it is — no file in it is read,
                written or deleted — and the recorded runs stay in the store.
              </p>
            </div>
            <OutlineButton
              type="button"
              danger
              className={ACTION}
              onClick={() => {
                setDialogError(null);
                setForget(current);
              }}
            >
              forget
            </OutlineButton>
          </div>
        </>
      )}

      {/* the rest of the registry -------------------------------------------------- */}
      {others.length === 0 ? null : (
        <>
          <SubHead aside={`${others.length} more in workspaces.json`}>other workspaces</SubHead>
          <ul className="flex min-w-0 flex-col">
            {others.map((w) => (
              <li
                key={w.name}
                data-registry-row={w.name}
                // A grid, not a wrapping flex row: repo paths are long enough to consume the whole
                // line, which pushed the run count and FORGET onto a second row and left-aligned
                // them. The path now breaks inside its own column and the action stays on the right.
                className="grid min-w-0 grid-cols-1 items-center gap-x-5 gap-y-2 border-b border-line py-3.5 last:border-b-0 sm:grid-cols-[1fr_auto]"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="mono text-[12px] text-fg">{w.name}</span>
                  <span className="mono text-[10px] break-all text-muted">
                    {w.repoRoot ?? "— not in workspaces.json"}
                  </span>
                </div>
                <div className="flex flex-none items-center gap-5 justify-self-start sm:justify-self-end">
                  <span className="mono text-[9.5px] text-muted">
                    {w.runCount} run{w.runCount === 1 ? "" : "s"}
                    {w.archivedCount > 0 ? ` · ${w.archivedCount} archived` : ""}
                  </span>
                  {w.registered ? (
                    <OutlineButton
                      type="button"
                      danger
                      className={ACTION}
                      onClick={() => {
                        setDialogError(null);
                        setForget(w);
                      }}
                    >
                      forget
                    </OutlineButton>
                  ) : (
                    <span className="mono text-[9.5px] text-muted">not registered</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* register ------------------------------------------------------------------ */}
      <SubHead aside="adds an entry — nothing is written into the repo">register an existing repo</SubHead>
      <form onSubmit={doRegister} className="flex min-w-0 flex-col gap-5" data-testid="register-form">
        <div className="grid min-w-0 grid-cols-1 gap-6 sm:grid-cols-[1.6fr_1fr] sm:gap-8">
          <SettingsField label="repo folder" htmlFor="register-root">
            <UnderlineInput
              id="register-root"
              value={repoRoot}
              onChange={setRepoRoot}
              placeholder="/Users/you/code/my-app"
              invalid={registerField === "repoRoot"}
            />
          </SettingsField>
          <SettingsField label="name" htmlFor="register-name">
            <UnderlineInput
              id="register-name"
              value={name}
              onChange={setName}
              placeholder="my-app"
              invalid={registerField === "name"}
            />
          </SettingsField>
        </div>

        <div className="flex min-w-0 flex-col gap-2.5">
          <p className="max-w-[62ch] text-[12px] leading-[1.6] text-ink-2">
            The repo needs a <span className="mono text-[10.5px] text-fg">.git</span> and an{" "}
            <span className="mono text-[10.5px] text-fg">aw.config.json</span> declaring this name.
            If it has never been initialised, run this there first:
          </p>
          <CommandStrip
            command={`npx tsx src/cli.ts init --repo ${
              repoRoot.trim() === "" ? "<repo-folder>" : shellQuote(repoRoot.trim())
            }`}
          />
        </div>

        {/* The route answers with the field it blames, so its message lands under that field —
            including the "run aw init first" one for a repo that has never been initialised. */}
        {registerError !== null ? (
          registerField === null ? (
            <DangerCallout role="alert" testId="register-error">
              {registerError}
            </DangerCallout>
          ) : (
            <div data-testid="register-error">
              <FieldError htmlFor={registerField === "name" ? "register-name" : "register-root"}>
                {registerError}
              </FieldError>
            </div>
          )
        ) : null}
        {registered !== null ? (
          <span className="inline-flex items-center gap-2 text-ok" role="status" data-testid="register-ok">
            <span className="mark mark-done" aria-hidden />
            <span className="statusword">registered {registered}</span>
          </span>
        ) : null}

        <div className="flex min-w-0 flex-col gap-3 border-t border-line pt-5">
          <div>
            <OutlineButton type="submit" className={`${ACTION} border-fg! text-fg! hover:bg-fg! hover:text-bg!`}>
              register
            </OutlineButton>
          </div>
          <span className="mono min-w-0 text-[9.5px] break-all text-muted">{registryPath}</span>
        </div>
      </form>

      {forget !== null ? (
        <ConfirmDialog
          title={`Forget workspace ${forget.name}?`}
          confirmLabel="Remove the registry entry"
          danger
          busy={busy}
          error={dialogError}
          onCancel={() => {
            if (!busy) setForget(null);
          }}
          onConfirm={() => void doForget()}
        >
          <p>
            This removes the entry from <span className="font-mono">workspaces.json</span> ONLY.
          </p>
          <p>
            The repo at{" "}
            <span className="font-mono break-all text-fg">{forget.repoRoot ?? "(unknown)"}</span> is
            not touched — no file in it is read, written or deleted — and its{" "}
            <span className="text-fg">
              {forget.runCount} recorded run{forget.runCount === 1 ? "" : "s"}
              {forget.archivedCount > 0 ? ` (plus ${forget.archivedCount} archived)` : ""}
            </span>{" "}
            stay in the store exactly as they are.
          </p>
          <p>
            Afterwards <span className="font-mono">--workspace {forget.name}</span> will not
            resolve until you register it again.
          </p>
        </ConfirmDialog>
      ) : null}
    </SettingsSection>
  );
}
