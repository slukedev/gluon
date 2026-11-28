import { describe, expect, it } from "vitest";
import { appMark, finishedJob, isProblem, needingHand, trouble, type HealthApp } from "./app-health";

const running = { state: "running", line: "running" as const };
const job = { state: "exited", line: "stopped" as const, done: true };
const died = { state: "exited", line: "stopped" as const };
const looping = { state: "restarting", line: "unhealthy" as const };

const app = (id: string, line: HealthApp["line"], containers: HealthApp["containers"], more: Partial<HealthApp> = {}) => ({ id, line, summary: "Docker's words", containers, ...more });

describe("finishedJob", () => {
  it.each([
    ["restart: no, exit 0", { state: "exited", exitCode: 0, restartPolicy: "no", oneShot: false }, true],
    ["docker run's default policy, exit 0", { state: "exited", exitCode: 0, restartPolicy: "", oneShot: false }, true],
    ["on-failure, exit 0", { state: "exited", exitCode: 0, restartPolicy: "on-failure", oneShot: false }, true],
    ["marked one-off in compose, even with unless-stopped", { state: "exited", exitCode: 0, restartPolicy: "unless-stopped", oneShot: true }, true],
    ["unless-stopped, exit 0", { state: "exited", exitCode: 0, restartPolicy: "unless-stopped", oneShot: false }, false],
    ["always, exit 0", { state: "exited", exitCode: 0, restartPolicy: "always", oneShot: false }, false],
    ["restart: no, exit 1", { state: "exited", exitCode: 1, restartPolicy: "no", oneShot: true }, false],
    ["policy unknown", { state: "exited", exitCode: 0, restartPolicy: null, oneShot: false }, false],
    ["still running", { state: "running", exitCode: null, restartPolicy: "no", oneShot: true }, false],
  ])("%s", (_, c, want) => {
    expect(finishedJob(c)).toBe(want);
  });
});

describe("one answer for Apps and Home", () => {
  it("doesn't count a finished setup job against its app", () => {
    // What the server sends for an app whose migrate job exited 0: the app is running.
    const a = app("immich", "running", [running, job]);
    expect(isProblem(a)).toBe(false);
    expect(appMark(a)).toBeNull();
    expect(trouble(a)).toBeNull();
  });

  it("names only the parts that are wrong, never a finished job", () => {
    const a = app("immich", "unhealthy", [running, job, died]);
    expect(trouble(a)).toBe("1 of 2 parts stopped");
    expect(appMark(a)).toEqual({ state: "unhealthy", word: "1 of 2 parts stopped" });
  });

  it("marks a broken app red with its own words, ahead of a finding about it", () => {
    expect(appMark(app("x", "unhealthy", [looping]), { kind: "monitor.down", severity: "attention" })).toEqual({ state: "unhealthy", word: "Keeps restarting" });
  });

  it("marks an app Docker calls running by its finding: red for a fault, sodium for the rest", () => {
    expect(appMark(app("x", "running", [running]), { kind: "monitor.down", severity: "fault" })).toEqual({ state: "unhealthy", word: "Not answering" });
    expect(appMark(app("x", "running", [running]), { kind: "app.update", severity: "attention" })).toEqual({ state: "attention", word: "Needs you" });
  });

  it("leaves starting, stopped-on-purpose, old copies and Umbrel's busy apps alone", () => {
    expect(appMark(app("a", "starting", [running]))).toBeNull();
    expect(appMark(app("b", "stopped", [died]))).toBeNull();
    expect(appMark(app("c", "unhealthy", [looping], { copyOf: { id: "x" } }), { kind: "app.broken", severity: "fault" })).toBeNull();
    expect(appMark(app("d", "unhealthy", [looping], { umbrel: { state: "updating" } }))).toBeNull();
  });

  it("counts each app once, whether its containers, a finding or both say it's wrong", () => {
    const apps = [app("ok", "running", [running, job]), app("loop", "unhealthy", [looping]), app("web", "running", [running]), app("both", "unhealthy", [died, running])];
    const findings = new Map([
      ["web", { kind: "monitor.down", severity: "fault" }],
      ["both", { kind: "app.broken", severity: "fault" }],
    ]);
    expect(needingHand(apps, findings).map((a) => a.id)).toEqual(["loop", "web", "both"]);
  });
});
