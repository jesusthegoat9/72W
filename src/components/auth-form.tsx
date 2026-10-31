"use client";

import { useActionState } from "react";
import { login, signup, type AuthState } from "@/app/(auth)/actions";

const initial: AuthState = {};

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const action = mode === "login" ? login : signup;
  const [state, formAction, pending] = useActionState(action, initial);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        Email
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          className="rounded-md border border-border bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-accent"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Password
        <input
          name="password"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          required
          minLength={8}
          className="rounded-md border border-border bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-accent"
        />
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Working…" : mode === "login" ? "Log in" : "Create account"}
      </button>
    </form>
  );
}
