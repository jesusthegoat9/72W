/**
 * Session helpers.
 *
 * This is the single place the rest of the app should go through for auth.
 * Today it only knows about the cookie name. Wire a real implementation
 * (signed cookie + database lookup) here when auth is built, and the proxy
 * and pages will pick it up without changes.
 */

export const SESSION_COOKIE = "session";

export type Session = {
  userId: string;
};

/**
 * Optimistic session read from a raw cookie value. Used by the proxy, so it
 * must stay cheap: no database, no network.
 *
 * TODO: verify a signed token here instead of trusting any non-empty value.
 */
export function readSessionCookie(value: string | undefined): Session | null {
  if (!value) return null;
  return { userId: value };
}
