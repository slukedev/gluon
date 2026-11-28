import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { currentAuth, pendingAuth } from "@/server/auth/session";
import { userCount } from "@/server/auth/users";
import { clientInfo } from "@/server/net-zone";
import { getSetting } from "@/server/settings";
import { safeNext } from "@/lib/safe-next";
import { LoginForm } from "./LoginForm";
import { mfaRequired } from "@/server/auth/policy";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  if (userCount() === 0) redirect("/setup");
  const { next } = await searchParams;
  const dest = safeNext(next);
  if (await currentAuth()) redirect(dest);
  const { zone } = clientInfo(await headers());
  // A reload while the code was being asked for picks up at the code, not the password.
  const awaitingCode = (await pendingAuth())?.session.pending === "code";
  return <LoginForm next={dest} zone={zone} serverName={getSetting("serverName")} adminsNeedCode={mfaRequired("admin", "away")} awaitingCode={awaitingCode} />;
}
