import { param } from "@/app/api/docker/params";
import { route } from "@/server/api";
import { voiceDetails } from "@/server/voice/service";

export const GET = route({ auth: "admin" }, ({ params }) => voiceDetails(param(params.id)));
