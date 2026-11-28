import { param } from "@/app/api/docker/params";
import { route } from "@/server/api";
import { voiceLive } from "@/server/voice/service";

export const GET = route({ auth: "admin" }, ({ params }) => voiceLive(param(params.id)));
