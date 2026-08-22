import Link from "next/link";
import { notFound } from "next/navigation";
import { readRun, workspaceExists } from "@/lib/store";
import { getTriggeredRun } from "@/lib/runner";
import { LiveLog } from "@/components/live-log";

/**
 * `/ws/<ws>/live?pid=<pid>` — where the "New run" modal lands (T22 step 3).
 *
 * A URL rather than a modal that streams in place, for one reason: a run takes minutes, and
 * anything that lives only in a component's state is lost to a reload, a mis-click on the
 * backdrop, or a second tab. The runner's state is keyed by pid in the panel PROCESS, so this
 * page can be reopened, shared between two tabs, and reloaded without interrupting the run.
 *
 * `?run=<runId>` is the same view pointed at a finished (or terminal-started) run's `log.txt`.
 * There is no process behind it, so it has no Cancel button — it is a tail, and the run page's Log
 * tab is the static version of the same bytes.
 */
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LivePage({ params, searchParams }: PageProps<"/ws/[ws]/live">) {
  const { ws } = await params;
  if (!workspaceExists(ws)) notFound();

  const query = await searchParams;
  const pidParam = first(query.pid);
  const runParam = first(query.run);

  if (pidParam !== undefined) {
    const pid = /^[0-9]{1,10}$/.test(pidParam) ? Number(pidParam) : NaN;
    const tracked = Number.isNaN(pid) ? null : getTriggeredRun(pid);

    // A pid the panel does not know: a stale link, or the dev server was restarted while the run
    // was going. Not a 404 — the workspace is real and the answer is "start a new one", which a
    // not-found page would not say.
    if (tracked === null || tracked.ws !== ws) {
      return <Unknown ws={ws} pid={pidParam} />;
    }

    return (
      <LiveLog
        ws={ws}
        pid={tracked.pid}
        runId={tracked.runId}
        kind={tracked.kind}
        display={tracked.display}
        argv={tracked.argv}
        initiallyRunning={tracked.state === "running"}
      />
    );
  }

  if (runParam !== undefined) {
    const manifest = readRun(ws, runParam);
    if (manifest === null) notFound();
    return (
      <LiveLog
        ws={ws}
        pid={null}
        runId={manifest.runId}
        kind={manifest.kind}
        display={`npx tsx src/cli.ts ${manifest.input.args}`}
        argv={null}
        initiallyRunning={manifest.status === "running"}
      />
    );
  }

  return <Unknown ws={ws} pid={null} />;
}

function Unknown({ ws, pid }: { ws: string; pid: string | null }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-semibold tracking-tight">Nothing to watch</h1>
      <p className="max-w-prose text-sm text-muted" data-live-unknown>
        {pid === null
          ? "This page follows one running workflow. Start one from the workspace page."
          : `The panel is not tracking a process with pid ${pid} in workspace ${ws}. It has already ` +
            "been forgotten, or it was started by a different panel process — restarting the dev " +
            "server does not stop a running workflow, but it does lose the handle to it."}
      </p>
      <p className="text-sm">
        <Link href={`/ws/${encodeURIComponent(ws)}`} className="text-link hover:underline">
          back to {ws}
        </Link>
      </p>
    </div>
  );
}
