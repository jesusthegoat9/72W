/**
 * Session helpers (auth foundation, no issuer yet).
 *
 * A session cookie is `userId.expiresAtMs.signature` where the signature is
 * HMAC-SHA256 over `userId.expiresAtMs` with SESSION_SECRET, base64url.
 * Nothing in the app issues cookies today; `signSession` exists so the proxy,
 * the dashboard and the tests agree on the format. Without SESSION_SECRET no
 * cookie verifies, so protected routes stay closed in production.
 * Web Crypto only, so it runs in Node, the Next proxy and Cloudflare Workers.
 */

export const SESSION_COOKIE = "session";

export interface Session {
  userId: string;
  expiresAt: Date;
}

const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSession(userId: string, secret: string, opts: { expiresAt?: Date; ttlMs?: number } = {}): Promise<string> {
  if (!secret) throw new Error("SESSION_SECRET is required to sign a session");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId)) throw new Error("userId must be 1-64 url-safe characters");
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + (opts.ttlMs ?? 7 * 24 * 60 * 60 * 1000));
  const payload = `${userId}.${expiresAt.getTime()}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

/** Verifies a cookie value. Cheap (one HMAC), so safe to call from the proxy. */
export async function verifySession(value: string | undefined, secret: string | undefined, now: Date = new Date()): Promise<Session | null> {
  if (!value || !secret) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userId, expRaw, signature] = parts;
  const expiresMs = Number(expRaw);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(userId) || !Number.isFinite(expiresMs)) return null;
  if (!timingSafeEqual(signature, await hmac(secret, `${userId}.${expRaw}`))) return null;
  if (expiresMs <= now.getTime()) return null;
  return { userId, expiresAt: new Date(expiresMs) };
}
