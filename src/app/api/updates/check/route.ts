import { route } from "@/server/api";
import { status } from "@/server/updates";

// Each forced check costs GitHub requests, and GitHub allows this server 60 an hour.
export const POST = route({ auth: "admin", burst: { limit: 6, windowMs: 60_000 } }, () => status(true));
