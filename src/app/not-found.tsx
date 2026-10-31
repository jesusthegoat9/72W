import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="font-mono text-xs text-muted">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <Link href="/" className="text-sm underline">
        Back home
      </Link>
    </main>
  );
}
