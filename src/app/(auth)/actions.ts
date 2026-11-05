"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getServices } from "@/server/container";
import { SESSION_COOKIE } from "@/lib/session";
import { authenticateOperator, FAILED_LOGIN_DELAY_MS, safeNextPath, sessionCookieOptions } from "@/server/auth/operator";

export type AuthState = { error?: string };

/** Operator login: one password, one signed cookie, then the dashboard (or a same-site `next` path). */
export async function login(_prev: AuthState, formData: FormData): Promise<AuthState> {
  const { config } = await getServices();
  const result = await authenticateOperator(String(formData.get("password") ?? ""), config);
  if (!result.ok) {
    if (result.reason === "invalid" && process.env.NODE_ENV !== "test") await new Promise((r) => setTimeout(r, FAILED_LOGIN_DELAY_MS));
    return { error: result.error };
  }
  (await cookies()).set(SESSION_COOKIE, result.cookie, sessionCookieOptions(process.env.NODE_ENV === "production"));
  redirect(safeNextPath(String(formData.get("next") ?? "")));
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/");
}
