import { param } from "@/app/api/docker/params";
import { route } from "@/server/api";
import { readCompose } from "@/server/docker/compose";

export const GET = route({ auth: "admin" }, ({ params }) => readCompose(param(params.id)));
