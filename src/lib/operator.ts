import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySession, type Session } from "./session";
import { getServices } from "@/server/container";

/** The operator session for the current request, or null. */
export async function currentOperator(): Promise<Session | null> {
  const { config } = await getServices();
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value, config.sessionSecret ?? undefined);
}

/** `next dev` lets the ops pages render without a session so they can be previewed; production never does. */
export function devBypass(): boolean {
  return process.env.NODE_ENV === "development";
}

export class OperatorRequiredError extends Error {
  constructor() {
    super("operator session required");
    this.name = "OperatorRequiredError";
  }
}

/** Gate for ops-only server actions: a verified session, or the dev bypass. */
export async function requireOperator(): Promise<void> {
  if (devBypass()) return;
  if (!(await currentOperator())) throw new OperatorRequiredError();
}
