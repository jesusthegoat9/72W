import type { Services } from "../container";
import { runDispatcher, type DispatchSummary } from "./dispatcher";

/**
 * Interface for a cron-driven dispatcher. Nothing deploys this yet.
 *
 * On Cloudflare the OpenNext worker only exports `fetch`; a custom worker
 * entry can add `scheduled` and call `createScheduledDispatcher`:
 *
 *   // custom-worker.ts (see README "Connecting Cloudflare")
 *   import handler from "./.open-next/worker.js";
 *   import { createScheduledDispatcher } from "./src/server/jobs/scheduled";
 *   export default {
 *     fetch: handler.fetch,
 *     scheduled: createScheduledDispatcher(async (env) => buildServicesFromBindings(env)),
 *   };
 *
 * and wrangler.jsonc gets `"triggers": { "crons": ["0 * * * *"] }`.
 */
export interface ScheduledEventLike {
  cron: string;
  scheduledTime: number;
}
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}
export type ScheduledHandler<Env> = (event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike) => Promise<void>;

export interface ScheduledDispatcher<Env> {
  handler: ScheduledHandler<Env>;
  runOnce(env: Env): Promise<DispatchSummary>;
}

export function createScheduledDispatcher<Env>(buildServices: (env: Env) => Promise<Services>): ScheduledDispatcher<Env> {
  const runOnce = async (env: Env) => {
    const services = await buildServices(env);
    return runDispatcher({ repos: services.repos, media: services.media, config: services.config });
  };
  return {
    runOnce,
    handler: async (_event, env, ctx) => {
      ctx.waitUntil(runOnce(env));
    },
  };
}
