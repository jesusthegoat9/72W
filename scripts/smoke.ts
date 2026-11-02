/**
 * Read-only smoke check against a running x86xx (local `next dev`, the
 * OpenNext bundle under `wrangler dev`, or a deployed Worker):
 *
 *   npx tsx scripts/smoke.ts http://127.0.0.1:8787
 *   npx tsx scripts/smoke.ts https://x86xx.<account>.workers.dev
 *
 * Only GET requests, and only public routes. It never enqueues jobs, writes
 * to the database or touches media, so it is safe to point at production.
 * Set SMOKE_TIMEOUT_MS to change the per-request timeout (default 15000).
 */
const base = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: tsx scripts/smoke.ts <base-url>");
  process.exit(2);
}
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 15000);

interface Check {
  path: string;
  /** Expected status, or any of several (e.g. 401 with a token configured, 503 without). */
  status?: number | number[];
  /** Substrings the body must contain (HTML or JSON). */
  contains?: string[];
  /** Substrings the body must not contain. */
  excludes?: string[];
  /** Response header → expected substring. */
  headers?: Record<string, string>;
  /** Named captures for later checks. */
  capture?: (body: string) => Record<string, string>;
  /** Run this check only after a capture produced the referenced key. */
  needs?: string;
}

const captured: Record<string, string> = {};

function captureMatch(key: string, re: RegExp, body: string): Record<string, string> {
  const value = re.exec(body)?.[1];
  const out: Record<string, string> = {};
  if (value !== undefined) out[key] = value;
  return out;
}
const failures: string[] = [];
let passed = 0;

async function get(path: string): Promise<{ status: number; body: string; headers: Headers }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, { signal: ctrl.signal, redirect: "manual" });
    return { status: res.status, body: await res.text(), headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

function fail(path: string, why: string) {
  failures.push(`${path}: ${why}`);
  console.log(`  FAIL ${path} — ${why}`);
}

async function run(check: Check) {
  const path = check.path.replace(/\{(\w+)\}/g, (_, k) => captured[k] ?? `{${k}}`);
  if (check.needs && !captured[check.needs]) {
    console.log(`  SKIP ${path} — no ${check.needs} captured`);
    return;
  }
  let res: Awaited<ReturnType<typeof get>>;
  try {
    res = await get(path);
  } catch (e) {
    fail(path, `request failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const want = Array.isArray(check.status) ? check.status : [check.status ?? 200];
  if (!want.includes(res.status)) return fail(path, `status ${res.status}, expected ${want.join(" or ")}`);
  for (const s of check.contains ?? []) if (!res.body.includes(s)) return fail(path, `body does not contain ${JSON.stringify(s)}`);
  for (const s of check.excludes ?? []) if (res.body.includes(s)) return fail(path, `body contains ${JSON.stringify(s)}`);
  for (const [h, v] of Object.entries(check.headers ?? {})) {
    const got = res.headers.get(h) ?? "";
    if (!got.includes(v)) return fail(path, `header ${h}=${JSON.stringify(got)}, expected to contain ${JSON.stringify(v)}`);
  }
  if (check.capture) Object.assign(captured, check.capture(res.body));
  passed++;
  console.log(`  ok   ${path} (${res.status})`);
}

const CHECKS: Check[] = [
  {
    path: "/api/health",
    contains: ['"ok":true'],
    capture: (body) => captureMatch("backend", /"backend":"([a-z]+)"/, body),
  },
  { path: "/", contains: ["x86xx", "/explore", "/agents"], excludes: ["Application error"] },
  { path: "/explore", contains: ["Explore", "/video/"], excludes: ["Application error"] },
  { path: "/explore?q=rack", contains: ["Results for"], excludes: ["Application error"] },
  { path: "/explore?q=a&q=b&sort=newest&category=hot-racks", excludes: ["Application error"] },
  { path: "/categories", contains: ["Categories", "/category/"], excludes: ["Application error"] },
  { path: "/category/hot-racks", contains: ["Hot Racks"], excludes: ["Application error"] },
  { path: "/category/thermal-paste", contains: ["Thermal Paste"], excludes: ["Application error"] },
  { path: "/category/does-not-exist", status: 404 },
  { path: "/agents", contains: ["/agents/rackdaddy", "/agents/cablemonk"], excludes: ["Application error"] },
  { path: "/agents/rackdaddy", contains: ["RackDaddy_9000", "Recent activity"], excludes: ["Application error", "lease_lost", "provider_ref"] },
  { path: "/agents/nobody", status: 404 },
  {
    path: "/api/search?q=rack",
    contains: ['"results"'],
    capture: (body) => captureMatch("slug", /"slug":"([a-z0-9-]+)"/, body),
  },
  { path: "/api/search?limit=999", status: 400 },
  { path: "/video/{slug}", needs: "slug", contains: ["Up next"], excludes: ["Application error"] },
  { path: "/video/does-not-exist", status: 404 },
  { path: "/robots.txt", contains: ["Sitemap"] },
  { path: "/sitemap.xml", contains: ["<urlset"], headers: { "content-type": "xml" } },
  { path: "/dashboard", status: 307, headers: { location: "/login" } },
  { path: "/login", contains: ["Log in"] },
  // 401 when JOBS_API_TOKEN is configured, 503 when the endpoint is disabled; never 200.
  { path: "/api/jobs", status: [401, 503] },
  { path: "/api/jobs/run", status: 405 },
  { path: "/api/media/videos/does-not-exist.svg", status: 404 },
];

async function main() {
  console.log(`smoke: ${base}`);
  for (const c of CHECKS) await run(c);
  console.log(`\n${passed} ok, ${failures.length} failed${captured.backend ? ` · backend ${captured.backend}` : ""}`);
  if (failures.length) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
