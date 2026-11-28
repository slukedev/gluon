"use client";
import * as React from "react";
import { Page, PageHeader, Notice } from "./Surface";
import { Button } from "./Button";

/** What an error.tsx shows: the page's own title, what happened, and a retry that asks the server again. */
export function RouteError({ error, retry, title, summary, cause }: { error: unknown; retry: () => void; title: string; summary: string; cause?: string }) {
  const [pending, start] = React.useTransition();
  const digest = error instanceof Error && "digest" in error && typeof error.digest === "string" ? error.digest : null;
  const lead = cause ? `${cause} ` : "";
  return (
    <Page>
      <PageHeader title={title} summary={summary} />
      <Notice
        tone="fault"
        action={
          <Button size="sm" loading={pending} onClick={() => start(retry)}>
            Try again
          </Button>
        }
      >
        {lead}
        {digest ? `If it keeps happening, the server log has the details (reference ${digest}).` : "If it keeps happening, the server log has the details."}
      </Notice>
    </Page>
  );
}
