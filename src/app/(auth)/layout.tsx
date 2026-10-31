import Link from "next/link";
import { site } from "@/lib/site";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <Link href="/" className="mb-8 font-mono text-sm font-semibold">
        {site.name}
      </Link>
      <div className="w-full max-w-sm rounded-lg border border-border bg-card p-6">
        {children}
      </div>
    </main>
  );
}
