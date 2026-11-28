import { Page, PageHeader } from "@/components/ui/Surface";
import { LinkButton } from "@/components/ui/Button";

export default function ShellNotFound() {
  return (
    <Page>
      <PageHeader
        title="Nothing here"
        summary="The link may be old, or what it pointed to was removed."
        actions={
          <LinkButton href="/" variant="primary">
            Go to Home
          </LinkButton>
        }
      />
    </Page>
  );
}
