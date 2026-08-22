/**
 * What the top bar and the slip need out of a workspace's `aw.config.json`. SERVER ONLY.
 *
 * `readConfigFile` (`@/lib/store`) is the only way in: a request names a WORKSPACE, that name is
 * looked up in `$AW_HOME/workspaces.json`, and the registered `repoRoot` is joined with the
 * constant file name. No path from this screen ever becomes part of a filesystem path.
 *
 * The config is read defensively rather than through `AwConfig.parse()`. A workspace whose config
 * is half-written or hand-edited into something the schema rejects must still render its ledger —
 * the screen degrades to "no backend configured" and an unknown provider, which is the truth,
 * instead of throwing a 500 over a field the ledger does not depend on.
 */
import { readConfigFile } from "@/lib/store";

export interface WorkspaceFacts {
  /** `null` when the config declares no provider/model to inherit. */
  provider: string | null;
  model: string | null;
  /** `null` when no backend is configured at all — which is not the same claim as "it is down". */
  backendUrl: string | null;
  backendPort: number | null;
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const str = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export function workspaceFacts(ws: string): WorkspaceFacts {
  const read = readConfigFile(ws);
  const empty: WorkspaceFacts = { provider: null, model: null, backendUrl: null, backendPort: null };
  if (!read.ok) return empty;

  const defaults = obj(read.data.defaults);
  const app = obj(read.data.app);
  const backend = app === null ? null : obj(app.backend);
  const port =
    backend !== null && typeof backend.port === "number" && Number.isFinite(backend.port)
      ? backend.port
      : null;
  const baseUrl = app === null ? null : str(app.baseUrl);

  /*
   * `healthPath` is a PATH. It is resolved against the origin below, and `new URL()` lets an
   * absolute value replace that origin outright — so an `aw.config.json` naming
   * `http://elsewhere/probe` here would send the ledger's render-time GET to `elsewhere`,
   * silently overriding the `baseUrl` the user set in Settings. Anything that is not a
   * slash-rooted path falls back to the default rather than being obeyed.
   *
   * `baseUrl` itself is deliberately NOT restricted: it is the address of the user's own backend
   * and a staging deployment is a legitimate answer (handoff § 05 lists both). This only stops one
   * field from quietly overruling another.
   */
  const declared = backend === null ? null : str(backend.healthPath);
  const healthPath = declared !== null && /^\/(?!\/)/.test(declared) ? declared : "/health";

  const origin = baseUrl ?? (port === null ? null : `http://127.0.0.1:${port}`);
  let backendUrl: string | null = null;
  if (origin !== null) {
    try {
      backendUrl = new URL(healthPath, origin).toString();
    } catch {
      backendUrl = null;
    }
  }

  return {
    provider: defaults === null ? null : str(defaults.provider),
    model: defaults === null ? null : str(defaults.model),
    backendUrl,
    backendPort: port ?? (backendUrl === null ? null : portOf(backendUrl)),
  };
}

function portOf(url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.port !== "") return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/** How long the health probe waits. A local backend answers in single-digit milliseconds. */
const PROBE_MS = 500;

export interface BackendProbe {
  up: boolean | null;
  label: string;
}

/**
 * Is the workspace's backend answering?
 *
 * Probed from the SERVER, not the browser: the panel is on 4400 and the backend on its own port,
 * so a `fetch` from the page would be cross-origin and CORS would hide the answer — a backend that
 * is perfectly up would read as down. Any HTTP response at all counts as up, including a 404: it
 * means something is listening on that port, which is the question being asked. Only a refused
 * connection or a timeout is `down`.
 */
export async function probeBackend(facts: WorkspaceFacts): Promise<BackendProbe> {
  if (facts.backendUrl === null) return { up: null, label: "no backend configured" };
  const where = facts.backendPort === null ? "" : ` · :${facts.backendPort}`;
  try {
    await fetch(facts.backendUrl, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_MS),
    });
    return { up: true, label: `backend up${where}` };
  } catch {
    return { up: false, label: `backend down${where}` };
  }
}
