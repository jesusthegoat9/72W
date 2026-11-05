"use server";

import { revalidatePath } from "next/cache";
import { getServices } from "@/server/container";
import { requireOperator, OperatorRequiredError } from "@/lib/operator";
import { runDispatcher, type DispatchSummary } from "@/server/jobs/dispatcher";
import { JobService, ValidationError, LimitExceededError } from "@/server/jobs/service";

export type OpsState = { ok?: string; error?: string; summary?: DispatchSummary };

/**
 * Ops actions. Both require an operator session (or the dev bypass) and
 * both are bounded by the same switches as the CLI and the token API:
 * jobs queued here are always dry runs against the mock providers, and a
 * dispatcher pass only ever calls a paid provider when GENERATION_LIVE is on
 * and a job was explicitly queued live elsewhere.
 */
export async function runDispatchAction(): Promise<OpsState> {
  try {
    await requireOperator();
    const { repos, media, config } = await getServices();
    const summary = await runDispatcher({ repos, media, config });
    revalidatePath("/dashboard");
    return { ok: `Dispatcher pass finished: ${summary.completed} completed, ${summary.pending} pending, ${summary.failed} failed.`, summary };
  } catch (err) {
    return { error: describe(err) };
  }
}

export async function enqueueDryRunAction(_prev: OpsState, formData: FormData): Promise<OpsState> {
  try {
    await requireOperator();
    const { repos, config } = await getServices();
    const agentHandle = String(formData.get("agent") ?? "");
    const categorySlug = String(formData.get("category") ?? "");
    const withVideo = formData.get("video") === "on";
    const { job } = await new JobService(repos, config).enqueue({
      agentHandle,
      kind: "text",
      params: { ...(categorySlug ? { categorySlug } : {}), withVideo },
      idempotencyKey: `ops-${crypto.randomUUID()}`,
      live: false,
    });
    revalidatePath("/dashboard");
    return { ok: `Queued dry-run job ${job.id} for @${agentHandle}${withVideo ? " with a mock render" : ""}. Run the dispatcher to process it.` };
  } catch (err) {
    return { error: describe(err) };
  }
}

function describe(err: unknown): string {
  if (err instanceof OperatorRequiredError) return "Your operator session has expired. Log in again.";
  if (err instanceof ValidationError || err instanceof LimitExceededError) return err.message;
  console.error(err);
  return "That did not work. The server log has the details.";
}
