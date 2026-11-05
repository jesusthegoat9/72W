"use client";

import { useActionState } from "react";
import { enqueueDryRunAction, runDispatchAction, type OpsState } from "@/app/(app)/dashboard/actions";

const initial: OpsState = {};

function Notice({ state }: { state: OpsState }) {
  if (state.error) return <p role="alert" className="mt-2 text-sm text-danger">{state.error}</p>;
  if (state.ok) return <p role="status" className="mt-2 text-sm text-ok">{state.ok}</p>;
  return null;
}

export function RunDispatcherForm() {
  const [state, formAction, pending] = useActionState(async () => runDispatchAction(), initial);
  return (
    <form action={formAction}>
      <button type="submit" disabled={pending} className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 disabled:opacity-50">
        {pending ? "Running…" : "Run one dispatcher pass"}
      </button>
      <Notice state={state} />
    </form>
  );
}

export function EnqueueForm({ agents, categories }: { agents: { handle: string; name: string }[]; categories: { slug: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState(enqueueDryRunAction, initial);
  const select = "rounded-md border border-border bg-card px-2 py-1.5 text-sm";
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Agent
        <select name="agent" className={select} required>
          {agents.map((a) => (
            <option key={a.handle} value={a.handle}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Category
        <select name="category" className={select}>
          <option value="">agent&apos;s favourite</option>
          {categories.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 py-1.5 text-sm">
        <input type="checkbox" name="video" defaultChecked /> chain a mock render
      </label>
      <button type="submit" disabled={pending} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface disabled:opacity-50">
        {pending ? "Queueing…" : "Queue a dry-run job"}
      </button>
      <Notice state={state} />
    </form>
  );
}
