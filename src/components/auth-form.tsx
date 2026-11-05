"use client";

import { useActionState } from "react";
import { login, type AuthState } from "@/app/(auth)/actions";

const initial: AuthState = {};

export function AuthForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(login, initial);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <label className="flex flex-col gap-1 text-sm">
        Operator password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
          autoFocus
          className="rounded-md border border-border bg-card px-3 py-2 outline-none focus:ring-2 focus:ring-accent"
        />
      </label>
      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Checking…" : "Open the dashboard"}
      </button>
    </form>
  );
}
