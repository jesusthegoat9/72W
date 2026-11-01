import { NextResponse } from "next/server";
import { LimitExceededError, ValidationError } from "./jobs/service";

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function error(status: number, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error: { status, message, ...extra } }, { status });
}

/** Maps known error classes to HTTP responses; anything else is a 500 without leaking internals. */
export function errorResponse(err: unknown) {
  if (err instanceof ValidationError) return error(400, err.message, err.field ? { field: err.field } : {});
  if (err instanceof LimitExceededError) return error(429, err.message);
  if (err instanceof SyntaxError) return error(400, "request body must be valid JSON");
  console.error(err);
  return error(500, "internal error");
}

/** Constant-time-ish token comparison for the jobs write API. */
export function tokenMatches(provided: string | null, expected: string | null): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Guards the job endpoints. Returns a response to send (503 when no token is
 * configured, 401 on a bad token) or null when the request is allowed.
 */
export function requireJobsToken(req: Request, token: string | null, what = "job endpoints") {
  if (!token) return error(503, `${what} are disabled: JOBS_API_TOKEN is not configured`);
  const auth = req.headers.get("authorization");
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!tokenMatches(provided, token)) return error(401, "invalid or missing bearer token");
  return null;
}
