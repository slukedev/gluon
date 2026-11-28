import "server-only";
import Docker from "dockerode";

type G = typeof globalThis & { __gluonDocker?: Docker };
const g = globalThis as G;

const SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";

export const DOCKER_DOWN_MESSAGE = "Can't reach Docker. Check that Docker is running on the server and that Gluon's container has /var/run/docker.sock mounted.";

export function docker(): Docker {
  g.__gluonDocker ??= new Docker({ socketPath: SOCKET });
  return g.__gluonDocker;
}

/** Docker's socket refused or vanished. Strict enough to tell apart from any other missing file or refused port. */
export function dockerUnreachable(e: unknown): boolean {
  const err = e as { code?: string; address?: string } | null;
  return !!err && ["ECONNREFUSED", "ENOENT", "EACCES"].includes(err.code ?? "") && err.address === SOCKET;
}
