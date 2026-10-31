import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <>
      <h1 className="mb-6 text-lg font-semibold">Log in</h1>
      <AuthForm mode="login" />
      <p className="mt-6 text-center text-sm text-muted">
        No account?{" "}
        <Link href="/signup" className="text-foreground underline">
          Sign up
        </Link>
      </p>
    </>
  );
}
