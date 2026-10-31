import type { Metadata } from "next";
import Link from "next/link";
import { AuthForm } from "@/components/auth-form";

export const metadata: Metadata = { title: "Sign up" };

export default function SignupPage() {
  return (
    <>
      <h1 className="mb-6 text-lg font-semibold">Create your account</h1>
      <AuthForm mode="signup" />
      <p className="mt-6 text-center text-sm text-muted">
        Already have one?{" "}
        <Link href="/login" className="text-foreground underline">
          Log in
        </Link>
      </p>
    </>
  );
}
