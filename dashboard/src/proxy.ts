/**
 * One Host check in front of EVERYTHING the panel serves — pages, route handlers, static chunks.
 *
 * `proxy.ts` is Next 16's name for what used to be `middleware.ts` — one function in front of
 * every request, before any route handler or page runs.
 *
 * `guardHost` also runs inside each route (see `@/lib/api-guard`), and that is on purpose: this
 * file is the check that cannot be forgotten when a route is added, and the in-route calls are the
 * check that survives this file being deleted or its matcher being narrowed. Either one alone
 * closes the hole; both together mean neither edit re-opens it silently.
 *
 * Why a Host check at all: the panel binds `127.0.0.1` (SPEC § Dashboard security invariants #1),
 * which stops the network but not the browser on this machine. A page on `http://attacker.example`
 * whose DNS is re-answered as `127.0.0.1` seconds later reaches the panel with `Host` and `Origin`
 * both naming the attacker's domain and `Sec-Fetch-Site: same-origin` — every same-origin check
 * agrees, because under rebinding the attacker owns both halves of the comparison. Pinning `Host`
 * to a loopback NAME is the one check that name cannot pass.
 *
 * The matcher is deliberately everything. A rebound page must not be able to read a page's HTML
 * (it embeds run data) any more than it can call an API route, and `/_next/*` is no exception —
 * a legitimate request always carries a loopback `Host`, so nothing real is refused.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isAllowedHost } from "@/lib/api-guard";

export default function proxy(request: NextRequest): NextResponse {
  if (isAllowedHost(request.headers.get("host"))) return NextResponse.next();
  return new NextResponse("403 — this panel answers on loopback only\n", {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

export const config = {
  matcher: "/:path*",
};
