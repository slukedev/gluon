import { param } from "@/app/api/docker/params";
import { z } from "zod";
import { route } from "@/server/api";
import { validateCompose } from "@/server/docker/compose";

export const POST = route({ auth: "admin", body: z.object({ content: z.string().max(512 * 1024) }) }, ({ params, body }) =>
  validateCompose(param(params.id), body.content),
);
