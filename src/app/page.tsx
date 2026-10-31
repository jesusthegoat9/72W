import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { site } from "@/lib/site";

const features = [
  { title: "Fast by default", body: "Static where it can be, dynamic only where it must be." },
  { title: "Auth-ready", body: "Login, signup and a protected dashboard are already routed." },
  { title: "Yours to shape", body: "A clean starting point with no decisions you'll have to undo." },
];

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main className="flex-1">
        <section className="mx-auto w-full max-w-5xl px-4 pt-24 pb-16">
          <p className="font-mono text-xs uppercase tracking-widest text-muted">{site.domain}</p>
          <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Something new is being built here.
          </h1>
          <p className="mt-4 max-w-xl text-base text-muted">{site.description}</p>
          <div className="mt-8 flex gap-3">
            <Link
              href="/signup"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90"
            >
              Get started
            </Link>
            <Link
              href="/login"
              className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-card"
            >
              Log in
            </Link>
          </div>
        </section>
        <section className="mx-auto grid w-full max-w-5xl gap-4 px-4 pb-24 sm:grid-cols-3">
          {features.map((f) => (
            <div key={f.title} className="rounded-lg border border-border bg-card p-5">
              <h2 className="text-sm font-medium">{f.title}</h2>
              <p className="mt-1 text-sm text-muted">{f.body}</p>
            </div>
          ))}
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
