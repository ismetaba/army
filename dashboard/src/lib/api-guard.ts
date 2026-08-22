/**
 * T21 — the shared front door of every MUTATING route.
 *
 * Until this task the panel was read-only, so a request that reached it could only ever produce
 * bytes it was already allowed to serve to the person sitting at the machine. `PUT /api/config`
 * and `DELETE /api/runs` change that: from here on, a request can delete a run directory or
 * rewrite a file in the developer's repo. Two things follow.
 *
 * **1. Loopback is not the same as same-origin.** SPEC § Dashboard security invariants #1 binds
 * the server to `127.0.0.1`, which stops the machine next to you. It does nothing about the page
 * you have open in another tab: any website can `fetch('http://127.0.0.1:4400/api/runs?…', {
 * method: 'DELETE', mode: 'no-cors' })` or submit a form at it, and the browser will happily send
 * that request from the user's own machine. So a mutating route requires the request to *look*
 * same-origin: an `Origin` header, if the browser sent one, must name the host the request was
 * addressed to, and `Sec-Fetch-Site` (sent by every current browser, and impossible to set from
 * script) must say `same-origin` or `none`. A request with neither header — `curl`, the probes in
 * this task's verification — is allowed through, because it did not come from a browser at all
 * and no cross-site attacker can make a browser omit them.
 *
 * **1b. …and comparing Origin to Host is not the same as loopback either.** That comparison was
 * the whole of the defence until this fix, and DNS rebinding walks straight through it: a page on
 * `http://attacker.example`, whose A record is re-answered as `127.0.0.1` a moment after the page
 * loads, sends `Host: attacker.example`, `Origin: http://attacker.example` and `Sec-Fetch-Site:
 * same-origin`. All three agree — with each other, and with nothing else. Reproduced against this
 * panel before the fix: one such request rewrote `aw.config.json`, one spawned a workflow, one
 * deleted a run directory and one streamed a run's `log.txt` back out. Since `app.backend.start`
 * is persisted config that `ensureUp()` later hands to `spawn(…, { shell: true })`, the config
 * write chains to arbitrary command execution on the developer's machine.
 *
 * So `guardHost` pins the `Host` header itself to a loopback NAME (`127.0.0.1`, `localhost`,
 * `[::1]`), which is the name a rebound page can never send: the browser puts the name it dialled
 * in `Host`, and if that name is loopback there was no rebinding to do. Both halves must now
 * agree AND both must name loopback. It applies to READ routes too — `/api/artifact` serves repo
 * diffs and `/api/logs` streams a `log.txt` that can carry test-account request bodies, and to a
 * rebound page those responses are same-origin and therefore readable. `middleware.ts` calls the
 * same helper in front of every route and every page, so a route added later cannot forget it;
 * the calls inside the routes are the second lock on the same door.
 *
 * **2. JSON bodies only.** `application/x-www-form-urlencoded`, `multipart/form-data` and
 * `text/plain` are exactly the three content types an HTML form can send without a CORS
 * preflight. Refusing them means a cross-site `<form>` cannot reach a body-taking route even if
 * the header checks above were somehow satisfied.
 *
 * Every failure here answers 403 with a one-line reason and no detail about the store.
 */

/** JSON response with the panel's standard no-store headers. */
export function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

/** `{ ok: false, message }` — the shape every client error in the panel uses. */
export function fail(message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return json({ ok: false, message, ...extra }, status);
}

/**
 * The host names the panel will answer to.
 *
 * Loopback LITERALS only — no `*.localhost`, no `.local`, no hostname that resolves to 127.0.0.1
 * — because a name is exactly what an attacker gets to choose. `AW_DASHBOARD_HOSTS` widens it
 * (comma-separated hostnames) for anyone who puts the panel behind a proxy or a tunnel; that is a
 * deliberate, local, one-off decision, which is what an env var is for.
 */
export const LOOPBACK_HOSTS: readonly string[] = ["127.0.0.1", "localhost", "[::1]", "::1"];

function allowedHosts(): readonly string[] {
  const extra = process.env.AW_DASHBOARD_HOSTS?.trim();
  if (!extra) return LOOPBACK_HOSTS;
  return [
    ...LOOPBACK_HOSTS,
    ...extra
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== ""),
  ];
}

/**
 * The hostname half of a `Host` header value, lowercased — or `null` when it is unparseable.
 *
 * Parsed through `URL` rather than split on `:` so that `[::1]:4400` keeps its brackets and a
 * value with a path, credentials or whitespace in it fails outright instead of matching a prefix.
 */
export function hostnameOf(host: string | null): string | null {
  if (host === null) return null;
  const trimmed = host.trim();
  if (trimmed === "" || /[\s/\\@]/.test(trimmed)) return null;
  try {
    const parsed = new URL(`http://${trimmed}`);
    if (parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/") return null;
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when this `Host` header value names loopback (see `LOOPBACK_HOSTS`). */
export function isAllowedHost(host: string | null): boolean {
  const hostname = hostnameOf(host);
  if (hostname === null) return false;
  return allowedHosts().includes(hostname);
}

/**
 * The DNS-rebinding gate: `null` when the request was addressed to loopback, or the 403 to answer.
 *
 * Called by `guardMutation`, by every read route that serves store bytes, and by `middleware.ts`
 * in front of everything — see this module's header comment for why the Origin/Host comparison
 * alone is not enough.
 */
export function guardHost(request: Request): Response | null {
  if (isAllowedHost(request.headers.get("host"))) return null;
  return fail("request refused: this panel answers on loopback only", 403);
}

/**
 * `null` when the request may mutate, or the 403 to return instead.
 *
 * `expectJson` is false for the routes whose parameters live in the query string (the two run
 * routes and `DELETE /api/workspaces`, whose URLs T21 fixes) — they have no body to type-check.
 */
export function guardMutation(request: Request, expectJson = true): Response | null {
  // First: the request must have been addressed to loopback by NAME. Everything below compares
  // the Origin against this Host, and that comparison is only worth anything once the Host is
  // pinned — otherwise both halves are a name the caller chose.
  const host = guardHost(request);
  if (host !== null) return host;

  // An absent `Origin` is a non-browser caller (curl, a script) and is allowed — no cross-site
  // attacker can make a browser omit it. `Origin: null` is a browser deliberately WITHHOLDING it:
  // a sandboxed iframe, a `file://` page, a redirected cross-origin POST. None of those is ever a
  // legitimate caller of a panel served on loopback, so it is refused with the rest. (T20 applied
  // this extra strictness in `/api/feedback` alone; it belongs to every mutating route.)
  const origin = request.headers.get("origin");
  if (origin !== null) {
    let originHost: string | null;
    try {
      originHost = origin === "null" ? null : new URL(origin).host;
    } catch {
      originHost = null;
    }
    const host = request.headers.get("host");
    if (originHost === null || host === null || originHost !== host) {
      return fail("cross-site request refused", 403);
    }
  }

  // Set by the browser, never by script. `same-origin` = our own page; `none` = typed into the
  // address bar. `cross-site` and `same-site` are refused — the panel has no other site.
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return fail("cross-site request refused", 403);
  }

  if (expectJson) {
    const type = request.headers.get("content-type") ?? "";
    if (!type.split(";")[0]!.trim().toLowerCase().endsWith("json")) {
      return fail("expected content-type: application/json", 415);
    }
  }
  return null;
}

/** Parse a JSON body without ever throwing. `undefined` means "not JSON". */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Zod issues as `{ path, message }`, for a client that places them next to fields. */
export function issuesOf(error: { issues: readonly { path: PropertyKey[]; message: string }[] }) {
  return error.issues.map((i) => ({
    path: i.path.map((p) => String(p)).join("."),
    message: i.message,
  }));
}
