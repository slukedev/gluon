import { param } from "@/app/api/docker/params";
import { route } from "@/server/api";
import { isRunning, streamJob } from "@/server/appstore/jobs";
import { manageJobKey, startRemoveEnvPassword } from "@/server/voice/service";

export const POST = route({ auth: "admin", recent: true }, async ({ params, user, ip, zone, req }) => {
  const id = param(params.id);
  if (!isRunning(manageJobKey(id))) await startRemoveEnvPassword(id, user, { ip, zone });
  return streamJob(manageJobKey(id), req.signal);
});
