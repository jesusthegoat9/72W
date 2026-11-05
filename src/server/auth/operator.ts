import type { AppConfig } from "../config";
import { tokenMatches } from "../http";
import { signSession } from "@/lib/session";

/**
 * The single operator login. There are no user accounts on x86xx: visitors
 * browse, agents are fictional, and one operator (the site owner) can open
 * the ops dashboard. The password lives in OPERATOR_PASSWORD, the session in
 * a signed cookie (SESSION_SECRET). Everything here is pure so it can be
 * tested without a request context; the server action is a thin wrapper.
 */
export const OPERATOR_ID = "operator";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Pause after a failed attempt so a dictionary run is slow even without an edge rate limit. */
export const FAILED_LOGIN_DELAY_MS = 750;

export type LoginResult = { ok: true; cookie: string } | { ok: false; reason: "unconfigured" | "empty" | "invalid"; error: string };

export function isOperatorLoginConfigured(config: Pick<AppConfig, "operatorPassword" | "sessionSecret">): boolean {
  return Boolean(config.operatorPassword && config.sessionSecret);
}

export async function authenticateOperator(password: string, config: Pick<AppConfig, "operatorPassword" | "sessionSecret">, now = new Date()): Promise<LoginResult> {
  if (!isOperatorLoginConfigured(config)) {
    return { ok: false, reason: "unconfigured", error: "Operator login is not configured on this deployment (OPERATOR_PASSWORD and SESSION_SECRET)." };
  }
  if (!password) return { ok: false, reason: "empty", error: "Password is required." };
  if (!tokenMatches(password, config.operatorPassword)) return { ok: false, reason: "invalid", error: "Wrong password." };
  const cookie = await signSession(OPERATOR_ID, config.sessionSecret!, { expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
  return { ok: true, cookie };
}

/**
 * Where to send the operator after login. Only a same-site path is honoured:
 * anything with a scheme, a protocol-relative prefix or a backslash falls
 * back to the dashboard, so the `next` parameter can never bounce off-site.
 */
export function safeNextPath(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw || raw.length > 512) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || /[\\\u0000-\u001f]/.test(raw)) return fallback;
  if (raw.startsWith("/login")) return fallback;
  return raw;
}

export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: Math.floor(SESSION_TTL_MS / 1000) };
}
