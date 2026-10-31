"use server";

export type AuthState = { error?: string };

/**
 * Auth server actions. These are deliberately stubs: the forms, routing and
 * session plumbing are in place, but there is no user store yet.
 * Replace the bodies with real logic (validate, hash, persist, set the
 * session cookie from `@/lib/session`) when auth is built.
 */

export async function login(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Email is required." };
  return { error: "Login is not wired up yet." };
}

export async function signup(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) return { error: "Email is required." };
  return { error: "Sign up is not wired up yet." };
}
