"use client";
import * as React from "react";
import { Button } from "@/components/ui/Button";
import s from "@/components/shell/notFound.module.css";
import "./globals.css";

export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  const [pending, start] = React.useTransition();
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  return (
    <html lang="en" data-theme="system">
      <body>
        <title>Gluon</title>
        <main className={s.frame}>
          <div className={s.plate}>
            <h1 className={s.title}>Gluon didn&apos;t load</h1>
            <p className={s.text}>
              Nothing on the server was changed. If it keeps happening, the server log has the details{digest ? ` (reference ${digest})` : ""}.
            </p>
            <Button variant="primary" loading={pending} onClick={() => start(retry)}>
              Try again
            </Button>
          </div>
        </main>
      </body>
    </html>
  );
}
