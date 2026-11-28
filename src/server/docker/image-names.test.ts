import { describe, expect, it, vi } from "vitest";
import { chatServerOf } from "@/lib/service-kind";

const OLD = "sha256:" + "1".repeat(64);
const calls: string[] = [];
const containers: Record<string, string | undefined> = { quark: "ghcr.io/slukedev/quark:edge", started: OLD, gone: undefined };
const images: Record<string, string[]> = { [OLD]: ["<none>:<none>", "ghcr.io/slukedev/quark:0.2"] };

vi.mock("../platform", () => ({ activePlatform: async () => "none" }));
vi.mock("../platform/umbrel", () => ({}));
vi.mock("../host/exec", () => ({ host: async () => ({ stdout: "" }) }));
vi.mock("../db", () => ({ all: () => [], one: () => undefined, run: () => undefined, now: () => 0 }));
vi.mock("../caddy/routes", () => ({}));
vi.mock("../apps/marker", () => ({ readMarker: () => null }));
vi.mock("./client", () => ({
  docker: () => ({
    getContainer: (id: string) => ({
      inspect: async () => {
        calls.push(`container:${id}`);
        if (!(id in containers) || id === "gone") throw new Error("no such container");
        return { Config: { Image: containers[id] } };
      },
    }),
    getImage: (id: string) => ({
      inspect: async () => {
        calls.push(`image:${id}`);
        if (!images[id]) throw new Error("no such image");
        return { RepoTags: images[id] };
      },
    }),
  }),
}));

const { nameImages } = await import("./apps");

describe("naming an image Docker lists by id", () => {
  it("uses what the container was started from, so a Quark whose tag moved on is still Quark", async () => {
    const list = [{ Id: "quark", Image: OLD, ImageID: OLD }];
    await nameImages(list);
    expect(list[0]!.Image).toBe("ghcr.io/slukedev/quark:edge");
    expect(chatServerOf(list[0]!.Image)).toBe("quark");
  });

  it("falls back to a tag the image still carries, skipping untagged ones", async () => {
    const list = [{ Id: "started", Image: OLD, ImageID: OLD }];
    await nameImages(list);
    expect(list[0]!.Image).toBe("ghcr.io/slukedev/quark:0.2");
  });

  it("leaves names alone, asks Docker once per container and image, and keeps the id when nothing is known", async () => {
    const named = [{ Id: "quark", Image: "jellyfin/jellyfin:latest", ImageID: OLD }];
    const unknown = [{ Id: "gone", Image: "sha256:" + "9".repeat(64), ImageID: "sha256:" + "9".repeat(64) }];
    calls.length = 0;
    await nameImages(named);
    await nameImages(unknown);
    await nameImages([{ Id: "quark", Image: OLD, ImageID: OLD }]);
    expect(named[0]!.Image).toBe("jellyfin/jellyfin:latest");
    expect(unknown[0]!.Image).toMatch(/^sha256:9/);
    expect(calls).toEqual(["container:gone", `image:${"sha256:" + "9".repeat(64)}`]);
  });
});
