import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Runs docker/gluon-update.sh against stand-ins for docker, curl, df and sleep, so the paths that
 * matter on a real server (rollback, disk space, the downloaded commit, the lock) run for real.
 */

const SCRIPT = fs.readFileSync(path.join(process.cwd(), "docker", "gluon-update.sh"), "utf8");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD_ID = "sha256:" + "a".repeat(64);
const NEW_ID = "sha256:" + "b".repeat(64);
const STALE_ID = "sha256:" + "c".repeat(64);

const DOCKER = `#!/bin/bash
S=$STUB_STATE
echo "docker $*" >> "$S/log"
san() { printf '%s' "$1" | tr '/:' '__'; }
idof() { case "$1" in sha256:*) echo "$1" ;; *) cat "$S/tags/$(san "$1")" 2>/dev/null ;; esac; }
case "$1" in
  info) echo "$S/root" ;;
  build)
    while [ $# -gt 0 ]; do [ "$1" = -t ] && t=$2; shift; done
    [ -n "$BUILD_FAIL" ] && { echo "build broke"; exit 1; }
    echo "$NEW_ID" > "$S/tags/$(san "$t")" ;;
  tag)
    id=$(idof "$2"); [ -n "$id" ] || exit 1
    echo "$id" > "$S/tags/$(san "$3")" ;;
  inspect)
    fmt=$3; c=$4
    img=$(cat "$S/container" 2>/dev/null)
    case "$fmt" in
      *'.Config.Env'*) echo "GLUON_COMMIT=x" ;;
      *'.State.StartedAt'*) if [ "$img" = "$CRASH_LOOP" ]; then date +%s%N; else echo 2026-11-28T04:00:00Z; fi ;;
      *'.State.Health'*) if [ -n "$NO_HEALTH" ]; then echo none; elif [ "$img" = "$UNHEALTHY" ]; then echo unhealthy; else echo healthy; fi ;;
      *'.State.Status'*) echo running ;;
      *'.Image'*) echo "$img" ;;
    esac ;;
  image)
    case "$2" in
      inspect) id=$(idof "$5"); [ -n "$id" ] || exit 1; echo "$id" ;;
      ls) for f in "$S"/tags/*; do n=$(basename "$f"); case "$n" in "$5"_*) id=$(cat "$f"); echo "$5:\${n#"$5"_} \${id:7:12}" ;; esac; done ;;
      rm) rm -f "$S/tags/$(san "$3")"; echo "rm $3" >> "$S/removed" ;;
      prune) ;;
    esac ;;
  compose)
    shift
    while [ $# -gt 0 ]; do case "$1" in pull) exit "\${PULL_FAIL:-0}" ;; up) break ;; esac; shift; done
    id=$(idof "$COMPOSE_IMAGE")
    [ -n "$UP_FAIL" ] && [ "$id" = "$NEW_ID" ] && exit 1
    echo "$id" > "$S/container" ;;
esac
exit 0
`;

const CURL = `#!/bin/bash
while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
[ -n "$CURL_FAIL" ] && exit 22
cp "$FIXTURE_TAR" "$out"
`;

const DF = `#!/bin/bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
case "$2" in */root) echo "stub 1 1 \${DOCKER_FREE_KB:-99999999} 1% $2" ;; *) echo "stub 1 1 99999999 1% $2" ;; esac
`;

let dir: string;
let state: string;

function stub(name: string, body: string) {
  const p = path.join(dir, "bin", name);
  fs.writeFileSync(p, body, { mode: 0o755 });
}

function tarball(top: string) {
  const src = path.join(dir, "src");
  fs.mkdirSync(path.join(src, top, "docker"), { recursive: true });
  fs.writeFileSync(path.join(src, top, "docker", "Dockerfile"), "FROM scratch\n");
  const out = path.join(dir, `${top}.tar.gz`);
  const r = spawnSync("tar", ["-czf", out, "-C", src, top]);
  if (r.status !== 0) throw new Error(String(r.stderr));
  return out;
}

function run(args: string[], env: Record<string, string> = {}, wrap: string[] = [], edit = (s: string) => s) {
  const script = path.join(dir, "gluon-update.sh");
  fs.writeFileSync(
    script,
    edit(SCRIPT.replace(/^export PATH=.*$/m, `export PATH="${path.join(dir, "bin")}:$PATH"`).replaceAll("/var/lib/gluon", path.join(dir, "lib"))),
  );
  const cmd = [...wrap, "bash", script, ...args];
  const r = spawnSync(cmd[0]!, cmd.slice(1), {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", STUB_STATE: state, NEW_ID, COMPOSE_IMAGE: "gluon:local", FIXTURE_TAR: tarball(`gluon-${SHA}`), NODE_ENV: "test", ...env },
  });
  const out = r.stdout + r.stderr;
  return { code: r.status, out, done: out.match(/^::done (ok|failed) (.*)$/m)?.slice(1) ?? null };
}

const tags = () => Object.fromEntries(fs.readdirSync(path.join(state, "tags")).map((f) => [f, fs.readFileSync(path.join(state, "tags", f), "utf8").trim()]));
const running = () => fs.readFileSync(path.join(state, "container"), "utf8").trim();
const compose = () => ["compose", dir, "gluon", "gluon", "gluon:local", "gluon", path.join(dir, "compose.yaml")];
const github = () => ["github", "slukedev/gluon", SHA, "1.6.0", SHA.slice(0, 12), ...compose()];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gluon-updater-"));
  state = path.join(dir, "state");
  for (const d of ["bin", "lib", "state/tags", "state/root"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  stub("docker", DOCKER);
  stub("curl", CURL);
  stub("df", DF);
  stub("sleep", "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(state, "tags", "gluon_local"), OLD_ID);
  fs.writeFileSync(path.join(state, "tags", "gluon_1.5.0"), OLD_ID);
  fs.writeFileSync(path.join(state, "tags", "gluon_1.4.0"), STALE_ID);
  fs.writeFileSync(path.join(state, "container"), OLD_ID);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("gluon-update.sh", () => {
  it("builds the checked commit, swaps it in and drops builds older than the one it replaced", () => {
    const r = run(github());
    expect(r.done).toEqual(["ok", "Gluon is running the new version."]);
    expect(running()).toBe(NEW_ID);
    const t = tags();
    expect(t["gluon_local"]).toBe(NEW_ID);
    expect(t["gluon_1.6.0"]).toBe(NEW_ID);
    // The previous build stays to go back to; the one before it goes.
    expect(t["gluon_1.5.0"]).toBe(OLD_ID);
    expect(t["gluon_1.4.0"]).toBeUndefined();
  });

  it("refuses a download that isn't the commit it was asked for", () => {
    const r = run(github(), { FIXTURE_TAR: tarball(`gluon-${"f".repeat(40)}`) });
    expect(r.done).toEqual(["failed", "The download from GitHub wasn't the version that was checked. Try again later."]);
    expect(running()).toBe(OLD_ID);
    expect(fs.readFileSync(path.join(state, "log"), "utf8")).not.toMatch(/docker build/);
  });

  it("stops before building when Docker is short of space", () => {
    const r = run(github(), { DOCKER_FREE_KB: "1000000" });
    expect(r.done?.[0]).toBe("failed");
    expect(r.done?.[1]).toMatch(/enough free space for Docker/);
    expect(tags()["gluon_local"]).toBe(OLD_ID);
  });

  it("leaves the running Gluon alone when the download fails", () => {
    const r = run(github(), { CURL_FAIL: "1" });
    expect(r.done?.[0]).toBe("failed");
    expect(running()).toBe(OLD_ID);
    expect(tags()["gluon_local"]).toBe(OLD_ID);
  });

  it("leaves the running Gluon alone when the build fails", () => {
    const r = run(github(), { BUILD_FAIL: "1" });
    expect(r.done?.[0]).toBe("failed");
    expect(running()).toBe(OLD_ID);
    expect(tags()["gluon_local"]).toBe(OLD_ID);
  });

  it("goes back to the previous image when the new one isn't healthy, and keeps every build", () => {
    const r = run(github(), { UNHEALTHY: NEW_ID });
    expect(r.done).toEqual(["failed", "The new version didn't start, so Gluon went back to the previous one."]);
    expect(running()).toBe(OLD_ID);
    expect(tags()["gluon_local"]).toBe(OLD_ID);
    expect(tags()["gluon_1.4.0"]).toBe(STALE_ID);
  });

  it("goes back when compose can't start the new one", () => {
    const r = run(github(), { UP_FAIL: "1" });
    expect(r.done).toEqual(["failed", "The new version didn't start, so Gluon went back to the previous one."]);
    expect(running()).toBe(OLD_ID);
  });

  // flock comes with util-linux, so every Linux server has it.
  it.skipIf(spawnSync("sh", ["-c", "command -v flock"]).status !== 0)("runs one updater at a time", () => {
    // Another process holds the lock for as long as this updater runs.
    const r = run(github(), {}, ["flock", path.join(dir, "lib", "update.lock")]);
    expect(r.done).toEqual(["failed", "Another update is already running."]);
    expect(running()).toBe(OLD_ID);
    expect(fs.existsSync(path.join(state, "log"))).toBe(false);
  });

  describe("without a healthcheck", () => {
    // Real time here: a second to count as up, and fewer looks so a failure is quick.
    const quick = (s: string) => s.replace("STABLE_S=60", "STABLE_S=1").replace("seq 1 90", "seq 1 8");
    beforeEach(() => stub("sleep", "#!/bin/sh\nexec /bin/sleep 0.2\n"));

    it("keeps a new version that stays up", () => {
      const r = run(github(), { NO_HEALTH: "1" }, [], quick);
      expect(r.done).toEqual(["ok", "Gluon is running the new version."]);
      expect(running()).toBe(NEW_ID);
    }, 15_000);

    it("goes back from a new version that keeps crashing and restarting", () => {
      const r = run(github(), { NO_HEALTH: "1", CRASH_LOOP: NEW_ID }, [], quick);
      expect(r.done).toEqual(["failed", "The new version didn't start, so Gluon went back to the previous one."]);
      expect(running()).toBe(OLD_ID);
    }, 15_000);
  });

  it("rejects a ref that isn't a full commit", () => {
    const r = run(["github", "slukedev/gluon", "v1.6.0", "1.6.0", "abc", ...compose()]);
    expect(r.done).toEqual(["failed", "That isn't a version Gluon can download."]);
  });
});
