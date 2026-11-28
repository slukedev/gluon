import { describe, expect, it } from "vitest";
import { skipCounts, type CheckPlanItem, type CheckResult, type CheckupMeta } from "@/lib/diagnostics-types";
import { verdictFor } from "./runner";

const meta = { id: "ck_1", kind: "full", target: null, title: "Full checkup", layout: "sweep", origin: null, groups: [], startedAt: 0, startedBy: "ana" } as unknown as CheckupMeta;
const plan: CheckPlanItem[] = [
  { id: "a", group: "system", label: "A" },
  { id: "b", group: "system", label: "B" },
];
const result = (id: string, state: CheckResult["state"]): CheckResult => ({ id, state, title: id, detail: null, value: null, evidence: null, fix: null, ms: 1 });

describe("verdictFor", () => {
  it("says everything checks out only when something was checked", () => {
    expect(verdictFor(meta, plan, [result("a", "ok"), result("b", "skip")], "done")).toBe("Everything checks out.");
    expect(verdictFor(meta, plan, [result("a", "skip"), result("b", "skip")], "done")).toBe("Nothing could be checked.");
  });

  it("names the checks that errored instead of folding them into a clean result", () => {
    expect(verdictFor(meta, plan, [result("a", "ok"), { ...result("b", "skip"), unrun: true }], "done")).toBe("Everything that ran checks out. 1 check couldn't run.");
  });

  it("counts only errored probes as couldn't run, the same split the footer shows", () => {
    const wide: CheckPlanItem[] = ["a", "b", "c", "d", "e"].map((id) => ({ id, group: "system", label: id }));
    const results = [result("a", "warn"), { ...result("b", "skip"), unrun: true }, { ...result("c", "skip"), unrun: true }, result("d", "skip"), result("e", "skip")];
    expect(verdictFor(meta, wide, results, "done")).toBe("Nothing is broken; 1 thing to look at. 2 checks couldn't run.");
    expect(skipCounts(results)).toEqual({ unrun: 2, skipped: 2 });
  });
});
