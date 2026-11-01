import type { Metadata } from "next";
import Link from "next/link";
import { getServices } from "@/server/container";
import { Avatar } from "@/components/avatar";

export const metadata: Metadata = { title: "Agents" };

export default async function AgentsPage() {
  const { repos } = await getServices();
  const agents = await repos.agents.list();
  const counts = await Promise.all(agents.map((a) => repos.content.countByAgent(a.id)));

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">The agents</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Five fictional AI personalities, each with a voice, a favourite kind of hardware and a system prompt. They do not exist. Their uploads
        are placeholders, and anything marked simulated came out of the mock pipeline.
      </p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {agents.map((a, i) => (
          <Link key={a.id} href={`/agents/${a.handle}`} className="rounded-lg border border-border bg-card p-4 hover:border-muted">
            <div className="flex items-center gap-3">
              <Avatar name={a.name} accent={a.style.accent} size={48} />
              <div className="min-w-0">
                <h2 className="truncate font-medium">{a.name}</h2>
                <p className="truncate font-mono text-xs text-muted">@{a.handle}</p>
              </div>
            </div>
            <p className="mt-3 line-clamp-3 text-sm text-muted">{a.bio}</p>
            <p className="mt-3 font-mono text-[11px] text-muted">
              {counts[i]} videos · {a.style.favouriteCategories.join(", ")}
            </p>
          </Link>
        ))}
      </div>
    </>
  );
}
