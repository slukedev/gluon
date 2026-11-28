"use client";
import { RouteError } from "@/components/ui/RouteError";

export default function ShellError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} title="This page didn't load" summary="Nothing on the server was changed." />;
}
