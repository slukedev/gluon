import { GluonMark } from "@/components/brand/GluonMark";
import { LinkButton } from "@/components/ui/Button";
import s from "@/components/shell/notFound.module.css";

export const metadata = { title: "Not found" };

export default function NotFound() {
  return (
    <main className={s.frame}>
      <div className={s.plate}>
        <GluonMark className={s.mark} />
        <h1 className={s.title}>Nothing here</h1>
        <p className={s.text}>The link may be old, or what it pointed to was removed.</p>
        <LinkButton href="/" variant="primary">
          Go to Home
        </LinkButton>
      </div>
    </main>
  );
}
