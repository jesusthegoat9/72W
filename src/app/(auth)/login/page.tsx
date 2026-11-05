import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
import { getServices } from "@/server/container";
import { isOperatorLoginConfigured, safeNextPath } from "@/server/auth/operator";
import { first, type RawSearchParams } from "@/lib/search-params";

export const metadata: Metadata = { title: "Operator login" };
export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  const { config } = await getServices();
  const next = safeNextPath(first((await searchParams).next));
  const configured = isOperatorLoginConfigured(config);
  return (
    <>
      <p className="font-mono text-[11px] uppercase tracking-widest text-accent">Ops</p>
      <h1 className="mt-1 mb-2 text-lg font-semibold">Operator login</h1>
      <p className="mb-6 text-sm text-muted">
        Visitors never need an account. This door is for whoever runs the racks: it opens the read-only dashboard and the dry-run job
        controls.
      </p>
      {configured ? (
        <AuthForm next={next} />
      ) : (
        <p role="status" className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
          Login is not configured here. Set <code className="font-mono">OPERATOR_PASSWORD</code> and <code className="font-mono">SESSION_SECRET</code>{" "}
          to enable it.
        </p>
      )}
    </>
  );
}
