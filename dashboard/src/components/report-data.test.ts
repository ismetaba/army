import { describe, expect, it } from "vitest";
import type { TestCase } from "@shared/schemas";
import {
  countByKind,
  countByStatus,
  featureLabel,
  featureSlug,
  percent,
  slugify,
  sortCases,
  verdictLine,
} from "./report-data";

/**
 * `report-data.ts` is the pure half of the Report tab: the counts in the header, the order of the
 * case table and the key that decides which runs are "the same feature". It has no React and no
 * `node:` import, so it is unit-testable with the vitest the repo already has — the same way
 * `dashboard/src/lib/diff.test.ts` is, and with no new dependency.
 *
 * The slug cases are the reason this file exists: an ASCII-only slug silently deleted every
 * non-Latin feature description, and the panel then said in words that no other run covered the
 * feature. A false absence there is indistinguishable from "this feature never regressed".
 */

function tc(over: Partial<TestCase> & Pick<TestCase, "id" | "status">): TestCase {
  return { name: `case ${over.id}`, kind: "happy", ...over } as TestCase;
}

describe("sortCases", () => {
  it("orders FAIL → SKIP → PASS and keeps manifest order inside a status", () => {
    const cases = [
      tc({ id: "c1", status: "PASS" }),
      tc({ id: "c2", status: "FAIL" }),
      tc({ id: "c3", status: "SKIP" }),
      tc({ id: "c4", status: "PASS" }),
      tc({ id: "c5", status: "FAIL" }),
    ];
    expect(sortCases(cases).map((c) => c.id)).toEqual(["c2", "c5", "c3", "c1", "c4"]);
  });

  it("ties break on the original index, not the id — `c10` stays after `c2`", () => {
    const cases = [
      tc({ id: "c2", status: "FAIL" }),
      tc({ id: "c10", status: "FAIL" }),
      tc({ id: "c1", status: "FAIL" }),
    ];
    expect(sortCases(cases).map((c) => c.id)).toEqual(["c2", "c10", "c1"]);
  });

  it("does not mutate its input", () => {
    const cases = [tc({ id: "c1", status: "PASS" }), tc({ id: "c2", status: "FAIL" })];
    sortCases(cases);
    expect(cases.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});

describe("countByStatus / countByKind / percent", () => {
  it("counts every status and the total", () => {
    const cases = [
      tc({ id: "c1", status: "PASS" }),
      tc({ id: "c2", status: "FAIL" }),
      tc({ id: "c3", status: "SKIP" }),
      tc({ id: "c4", status: "PASS" }),
    ];
    expect(countByStatus(cases)).toEqual({ PASS: 2, FAIL: 1, SKIP: 1, total: 4 });
  });

  it("counts every kind, including the ones with no cases", () => {
    const cases = [
      tc({ id: "c1", status: "PASS", kind: "happy" }),
      tc({ id: "c2", status: "FAIL", kind: "invalid" }),
    ];
    expect(countByKind(cases)).toEqual({ happy: 1, edge: 0, invalid: 1, auth: 0 });
  });

  it("percent is 0 for an empty report rather than NaN", () => {
    expect(percent(0, 0)).toBe(0);
    expect(percent(5, 6)).toBeCloseTo(83.333, 3);
  });
});

describe("verdictLine", () => {
  it("names only the statuses that occurred", () => {
    expect(verdictLine({ PASS: 16, FAIL: 0, SKIP: 0, total: 16 })).toBe("PASS 16/16");
    expect(verdictLine({ PASS: 5, FAIL: 1, SKIP: 0, total: 6 })).toBe("PASS 5/6 — 1 FAIL");
    expect(verdictLine({ PASS: 3, FAIL: 2, SKIP: 1, total: 6 })).toBe("PASS 3/6 — 2 FAIL — 1 SKIP");
  });
});

describe("featureLabel", () => {
  it("prefers input.feature", () => {
    expect(featureLabel({ args: 'test-feature "something else"', feature: "the real one" })).toBe(
      "the real one",
    );
  });

  it("falls back to the first quoted span of the args line", () => {
    expect(featureLabel({ args: 'test-feature "POST /api/items rejects" --url http://x' })).toBe(
      "POST /api/items rejects",
    );
  });

  it("falls back to the args minus the command word and the flags", () => {
    expect(featureLabel({ args: "test-feature health check --url http://x --provider lmstudio" })).toBe(
      "health check",
    );
  });

  it("is empty when nothing was recorded", () => {
    expect(featureLabel({ args: "" })).toBe("");
  });
});

describe("slugify", () => {
  it("folds case and punctuation so the same sentence typed twice matches", () => {
    expect(slugify("POST /api/items rejects an item with no name.")).toBe(
      slugify("POST /api/items rejects an item with no name"),
    );
    expect(slugify("The Health Endpoint Returns 200")).toBe("the-health-endpoint-returns-200");
  });

  it("keeps the letters and digits of NON-LATIN scripts instead of deleting them", () => {
    // The ASCII-only version returned "" here, and an empty slug matches nothing.
    expect(slugify("健康检查接口返回二百")).toBe("健康检查接口返回二百");
    expect(slugify("ЛОГИН не работает")).toBe("логин-не-работает");
    expect(slugify("سجل الدخول")).not.toBe("");
  });

  it("matches two runs whose feature is the byte-identical non-Latin string", () => {
    expect(slugify("健康检查接口返回二百")).toBe(slugify("健康检查接口返回二百"));
  });

  it("folds Turkish dotted/dotless i, so case alone does not split a feature", () => {
    expect(slugify("Kullanıcı girişi başarısız olmalı")).toBe(
      slugify("KULLANICI GİRİŞİ BAŞARISIZ OLMALI"),
    );
    expect(slugify("Ürün ekleme")).toBe(slugify("ÜRÜN EKLEME"));
  });

  it("has no leading or trailing separator, and never doubles one", () => {
    expect(slugify("  --- hello   world!! ")).toBe("hello-world");
  });

  it("keeps an all-symbol name grouping with itself", () => {
    expect(slugify("→→→")).toBe(slugify("→→→"));
    expect(slugify("→→→")).not.toBe("");
  });

  it("is empty for an empty or whitespace-only label, which matches nothing", () => {
    expect(slugify("")).toBe("");
    expect(slugify("   ")).toBe("");
  });
});

describe("featureSlug", () => {
  it("groups two runs of the same Turkish feature described in different case", () => {
    const a = featureSlug({ args: "design-loop", feature: "Kullanıcı girişi başarısız olmalı" });
    const b = featureSlug({ args: "design-loop", feature: "KULLANICI GİRİŞİ BAŞARISIZ OLMALI" });
    expect(a).toBe(b);
    expect(a).not.toBe("");
  });

  it("groups two runs of the same Chinese feature", () => {
    const a = featureSlug({ args: 'test-feature "健康检查接口返回二百"' });
    const b = featureSlug({ args: "test-feature", feature: "健康检查接口返回二百" });
    expect(a).toBe(b);
    expect(a).not.toBe("");
  });

  it("is empty when the run recorded no feature at all", () => {
    expect(featureSlug({ args: "" })).toBe("");
  });
});
