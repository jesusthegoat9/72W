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
