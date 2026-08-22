"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/confirm-dialog";

/**
 * T21 step 2 — the registry half of the settings page: register an existing repo, or forget one.
 *
 * "Forget" is the word on the button on purpose. `DELETE /api/workspaces` removes one line from
 * `$AW_HOME/workspaces.json` and does nothing else — no repo file, no run directory — and the
 * confirm dialog says exactly that, listing the repo and the run count that will still be there
 * afterwards. A button labelled "Delete" next to a repo path would promise something else
 * entirely, and the one thing a destructive-looking control must never do is surprise.
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

export function WorkspaceRegistry({ workspaces }: { workspaces: RegistryRow[] }) {
  const router = useRouter();
  const [forget, setForget] = useState<RegistryRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const [name, setName] = useState("");
  const [repoRoot, setRepoRoot] = useState("");
  const [registerError, setRegisterError] = useState<string | null>(null);
  const [registerField, setRegisterField] = useState<string | null>(null);
  const [registered, setRegistered] = useState<string | null>(null);

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

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold tracking-tight text-fg">Registered workspaces</h3>
          <p className="text-xs text-muted">
            <span className="font-mono">workspaces.json</span> is what{" "}
            <span className="font-mono">--workspace &lt;name&gt;</span> resolves against.
          </p>
        </div>

        <div className="min-w-0 overflow-x-auto rounded border border-line">
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
                <th className="px-3 py-2 font-medium">Workspace</th>
                <th className="px-3 py-2 font-medium">Repo root</th>
                <th className="px-3 py-2 text-right font-medium">Runs</th>
                <th className="px-3 py-2 text-right font-medium">Registry</th>
              </tr>
            </thead>
            <tbody>
              {workspaces.map((w) => (
                <tr key={w.name} className="border-b border-line last:border-0">
                  <td className="px-3 py-2 font-mono whitespace-nowrap">{w.name}</td>
                  <td className="px-3 py-2 font-mono text-xs break-all text-muted">
                    {w.repoRoot ?? "— not in workspaces.json"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">
                    {w.runCount}
                    {w.archivedCount > 0 ? (
                      <span className="ml-1 text-xs">(+{w.archivedCount} archived)</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {w.registered ? (
                      <button
                        type="button"
                        onClick={() => {
                          setDialogError(null);
                          setForget(w);
                        }}
                        className="rounded border border-line px-2 py-1 text-xs text-muted transition-colors hover:border-error-fg hover:text-error-fg"
                      >
                        Forget
                      </button>
                    ) : (
                      <span className="text-xs text-muted">not registered</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold tracking-tight text-fg">Register an existing repo</h3>
          <p className="text-xs text-muted">
            The repo must already have a <span className="font-mono">.git</span> and an{" "}
            <span className="font-mono">aw.config.json</span> — run{" "}
            <span className="font-mono">npx tsx src/cli.ts init</span> there first. This only adds
            the entry; it never writes into the repo.
          </p>
        </div>

        <form onSubmit={doRegister} className="flex min-w-0 flex-col gap-3" data-testid="register-form">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-[14rem_1fr]">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="register-name" className="text-xs uppercase tracking-wide text-muted">
                name
              </label>
              <input
                id="register-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-app"
                className={`w-full min-w-0 rounded border bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-link ${
                  registerField === "name" ? "border-error-fg" : "border-line"
                }`}
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor="register-root" className="text-xs uppercase tracking-wide text-muted">
                repo root (absolute path)
              </label>
              <input
                id="register-root"
                type="text"
                value={repoRoot}
                onChange={(e) => setRepoRoot(e.target.value)}
                placeholder="/Users/you/code/my-app"
                className={`w-full min-w-0 rounded border bg-surface px-2 py-1.5 font-mono text-sm text-fg outline-none focus:border-link ${
                  registerField === "repoRoot" ? "border-error-fg" : "border-line"
                }`}
              />
            </div>
          </div>

          {registerError !== null ? (
            <p
              className="rounded border border-line bg-error-bg px-3 py-2 text-sm text-error-fg"
              role="alert"
              data-testid="register-error"
            >
              {registerError}
            </p>
          ) : null}
          {registered !== null ? (
            <p className="text-sm text-done-fg" data-testid="register-ok">
              registered {registered}
            </p>
          ) : null}

          <div>
            <button
              type="submit"
              className="rounded border border-link bg-surface-2 px-4 py-1.5 text-sm font-medium text-fg transition-colors hover:brightness-105"
            >
              Register
            </button>
          </div>
        </form>
      </section>

      {forget !== null ? (
        <ConfirmDialog
          title={`Forget workspace ${forget.name}?`}
          confirmLabel="Remove the registry entry"
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
    </div>
  );
}
