import { describe, expect, it } from "vitest";
import { guardHost, guardMutation, hostnameOf, isAllowedHost } from "./api-guard";

/**
 * The DNS-rebinding gate.
 *
 * Every case below was a live probe against a running panel first: a request carrying nothing but
 * an attacker-controlled `Host`/`Origin` pair (exactly what a browser sends after the attacker's
 * domain is re-answered as 127.0.0.1) rewrote `aw.config.json`, spawned a workflow, deleted a run
 * directory and streamed a run log. Every same-origin check agreed, because under rebinding the
 * attacker owns both halves of the comparison. These tests pin the one check that name cannot
 * pass — `Host` must BE loopback — so it cannot be softened back into an equality test.
 */
function request(headers: Record<string, string>, method = "POST"): Request {
  return new Request("http://127.0.0.1:4400/api/config", { method, headers });
}

const JSON_TYPE = { "content-type": "application/json" };

describe("hostnameOf", () => {
  it("drops the port and lowercases", () => {
    expect(hostnameOf("127.0.0.1:4400")).toBe("127.0.0.1");
    expect(hostnameOf("LocalHost:4400")).toBe("localhost");
    expect(hostnameOf("[::1]:4400")).toBe("[::1]");
    expect(hostnameOf("localhost")).toBe("localhost");
  });

  it("refuses anything that is not a bare host[:port]", () => {
    for (const value of [
      null,
      "",
      "   ",
      "127.0.0.1/../evil",
      "evil@127.0.0.1",
      "127.0.0.1 evil.example",
      "127.0.0.1:4400/path",
    ]) {
      expect(hostnameOf(value)).toBeNull();
    }
  });
});

describe("isAllowedHost", () => {
  it("accepts the loopback names the panel binds", () => {
    for (const host of ["127.0.0.1:4400", "localhost:4400", "[::1]:4400", "127.0.0.1"]) {
      expect(isAllowedHost(host)).toBe(true);
    }
  });

  it("refuses every name an attacker could point at 127.0.0.1", () => {
    for (const host of [
      "attacker.example:4400",
      "panel.evil.example:4477",
      "evil.localhost:4400", // a subdomain of localhost is NOT localhost
      "127.0.0.1.evil.example:4400", // nor is a prefix match
      "0.0.0.0:4400",
      "192.168.1.10:4400",
      null,
    ]) {
      expect(isAllowedHost(host)).toBe(false);
    }
  });
});

describe("guardHost", () => {
  it("lets a loopback Host through", () => {
    expect(guardHost(request({ host: "127.0.0.1:4400" }))).toBeNull();
  });

  it("answers 403 for a rebound Host, and names no path", async () => {
    const refusal = guardHost(request({ host: "attacker.example:4400" }));
    expect(refusal?.status).toBe(403);
    const body = (await refusal!.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toMatch(/loopback/);
  });
});

describe("guardMutation", () => {
  it("accepts a same-origin request on loopback", () => {
    expect(
      guardMutation(
        request({
          ...JSON_TYPE,
          host: "127.0.0.1:4400",
          origin: "http://127.0.0.1:4400",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBeNull();
  });

  it("accepts a header-less non-browser caller (curl) on loopback", () => {
    expect(guardMutation(request({ ...JSON_TYPE, host: "127.0.0.1:4400" }))).toBeNull();
  });

  it("refuses the DNS-rebinding header set even though Origin matches Host", () => {
    const refusal = guardMutation(
      request({
        ...JSON_TYPE,
        host: "panel.evil.example:4400",
        origin: "http://panel.evil.example:4400",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(refusal?.status).toBe(403);
  });

  it("still refuses a plain cross-site request", () => {
    expect(
      guardMutation(
        request({ ...JSON_TYPE, host: "127.0.0.1:4400", origin: "http://evil.example" }),
      )?.status,
    ).toBe(403);
    expect(
      guardMutation(
        request({ ...JSON_TYPE, host: "127.0.0.1:4400", "sec-fetch-site": "cross-site" }),
      )?.status,
    ).toBe(403);
    expect(
      guardMutation(
        request({ ...JSON_TYPE, host: "127.0.0.1:4400", "sec-fetch-site": "same-site" }),
      )?.status,
    ).toBe(403);
  });

  it("refuses `Origin: null` — a sandboxed iframe or a file:// page, never a legitimate caller", () => {
    expect(
      guardMutation(request({ ...JSON_TYPE, host: "127.0.0.1:4400", origin: "null" }))?.status,
    ).toBe(403);
  });

  it("requires a JSON content type for body-taking routes, and not for the others", () => {
    expect(
      guardMutation(request({ host: "127.0.0.1:4400", "content-type": "text/plain" }))?.status,
    ).toBe(415);
    expect(guardMutation(request({ host: "127.0.0.1:4400" }), false)).toBeNull();
  });
});
