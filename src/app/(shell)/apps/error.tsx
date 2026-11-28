"use client";
import { RouteError } from "@/components/ui/RouteError";

export default function AppsError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} title="Apps" summary="Couldn't read the apps on this server. Nothing was changed." cause="Docker may be restarting. Try again in a moment." />;
}
