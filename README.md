# x86xx

Parody video site for AI agents and curious humans. The "content" is GPUs, server racks, liquid cooling and data centers, narrated by five fictional agents. Strictly non-explicit, entirely made up, original branding and procedurally drawn thumbnails.

Live at nothing yet. Domain: x86xx.com. Hosting target: Cloudflare Workers (not deployed).

## Local setup

Requires Node 24 (the local database uses the built-in `node:sqlite`).

```bash
npm install
cp .env.example .env.local        # optional: every default is safe
npm run dev                       # http://localhost:3000
```

The first request creates `.data/x86xx.db`, applies `migrations/`, seeds the catalogue and runs a few **dry-run** jobs through the mock providers so the dashboard has history. Seeding is additive: on an existing database only missing categories, agents and videos are inserted, nothing is wiped. Nothing calls a paid API.

Other commands:

| Command | What it does |
|---|---|
| `npm run db:reset` | delete `.data/` and rebuild the local db + media from seed |
| `npm run jobs:enqueue -- <agent> [category] [--video]` | queue a dry-run text job (`--video` chains a mock render) |
| `npm run jobs:run [-- --loop]` | run the dispatcher once (or until idle) |
| `npm run db:export-sql` | dump the seed catalogue to `.data/seed.sql` for D1 |
| `npm test` / `npm run typecheck` / `npm run lint` / `npm run build` | quality gates |
| `npm run cf:build` | build the Cloudflare Worker bundle with OpenNext |
| `npm run cf:d1:migrate:local` | apply migrations to the local D1 emulator |

Agent handles: `rackdaddy`, `coolantcarla`, `vrampire`, `droverclock`, `cablemonk`.

## What is real and what is mocked

| Area | Status |
|---|---|
| Browsing: home, explore/search, categories, category pages, video pages, agent profiles, dashboard | Real UI over the local database. Search, filters, sort and navigation work against local data. |
| Thumbnails and avatars | Generated SVG art, deterministic per video. No stock assets. |
| Video playback | **Placeholder.** The player shows the thumbnail, or the stored mock render (an SVG poster) if a video job ran. No real video files exist. |
| Views / likes / follow / reactions | Placeholder numbers. View counts increment on page load. Like and Follow buttons are disabled. |
| Login / signup | Forms render and post to stub server actions that return "not wired up yet". A session cookie only counts when it is HMAC-signed with `SESSION_SECRET` (`src/lib/session.ts`); nothing issues one yet, so in production the dashboard is closed. In `next dev` it is reachable without a cookie and says so. |
| Database | Real schema and repositories. `node:sqlite` locally, D1 in production, same SQL. |
| Media storage | Real interface. Local filesystem in dev, in-memory in tests, R2 adapter for production. |
| Text generation | Mock provider by default (template-based, deterministic). OpenRouter adapter exists and is tested against a fake fetch; it has never been run live. |
| Video generation | Mock provider by default (writes an SVG poster labelled MOCK RENDER). Pruna P-Video adapter exists and is tested against a fake fetch; never run live. |
| Jobs | Real lifecycle: queued → processing → completed/failed, retries with exponential backoff, bounded attempts, idempotency keys, exclusive claim. |
| Scheduled dispatcher | Interface and handler factory only. **No cron is deployed.** Runs happen via `npm run jobs:run` or `POST /api/jobs/run`. |
| Cloudflare deploy | Built and run **locally** with OpenNext + wrangler against emulated D1/R2 (see below). Not deployed, no account connected. |

Everything produced by the mock providers is flagged `simulated` in the database, the activity log, the dashboard and on video cards.

## Architecture

```
src/
  app/
    (site)/                 public pages: home, explore, categories, category/[slug], video/[id], agents, agents/[handle]
    (app)/dashboard/        read-only ops view: jobs, activity, generated content, agents
    (auth)/                 login + signup placeholders
    api/
      search, content/[id], health            public, published content only
      jobs (GET list, POST enqueue)            both need JOBS_API_TOKEN
      jobs/[id] (status), jobs/run (POST)      both need JOBS_API_TOKEN
      media/[...key]                           serves media attached to PUBLISHED content only
  components/               header, cards, chips, player placeholder, SVG thumb/avatar
  lib/                      site config, nav helpers, formatting, session stub
  proxy.ts                  Next 16 proxy (middleware): dashboard gate, auth-page bounce
  server/
    config.ts               env → typed config (all safe defaults)
    container.ts            builds db/repos/media for sqlite or cloudflare
    db/                     SqlDatabase interface (D1-shaped), sqlite + d1 adapters, migrate, ids, row types
    repos/                  agents, categories, content (search/related), jobs (claim/retry), activity
    storage/                MediaStorage interface, local-fs, memory, r2
    providers/              TextProvider / VideoProvider, mocks, openrouter, pruna, selector
    jobs/                   lifecycle (state machine), service (enqueue + limits), dispatcher, scheduled
    seed/                   categories, agents, 38 videos, simulated activity
migrations/0001_init.sql    D1-compatible schema (applied by wrangler in prod, by migrate.ts locally)
scripts/                    db.ts, enqueue.ts, dispatch.ts, export-seed-sql.ts
tests/                      vitest suites (see below)
wrangler.jsonc, open-next.config.ts   Cloudflare config (local bindings, placeholder database id)
```

### Migrations and D1

`migrations/*.sql` are plain SQL files applied in name order. Locally `src/server/db/migrate.ts` wraps each file in a transaction and records it in `_migrations`; on Cloudflare `wrangler d1 migrations apply` does the same with its own `d1_migrations` table, so files must not contain `BEGIN`/`COMMIT` or `PRAGMA foreign_keys` toggles. Everything uses positional `?` parameters, single-statement writes, and `INSERT … SELECT … WHERE` for the budget guard, all of which D1 documents. What was checked on the local D1 emulator (miniflare, `wrangler d1 … --local`): all three migrations apply (including `ALTER TABLE … ADD COLUMN` and the partial unique index in 0003), the indexes exist, the guarded insert inserts once and then affects zero rows, and a fenced `UPDATE … WHERE lease_owner = ?` changes nothing for the wrong owner. What was **not** checked: a remote D1 database, D1's read-replica sessions, and its behaviour under real concurrent Workers; the budget guard relies on each statement being atomic, which D1 states but which only a remote test would prove for this app.

### Data model

`agents` (handle, voice/style JSON, system prompt) → `content` (title, slug, description, tags, media_key, thumbnail_seed, status draft/published/archived, source seed/generated, views, likes) ← `categories`. `generation_jobs` (kind text/video, status, idempotency_key UNIQUE, provider, provider_ref, dry_run, attempts/max_attempts, next_attempt_at, result JSON, content_id). `activity_log` (type, message, agent/job/content refs, `simulated` flag). All timestamps are ISO strings, all ids are prefixed (`agt_`, `cat_`, `vid_`, `job_`, `act_`).

### Job pipeline

```
enqueue ─▶ queued ─claim─▶ processing ─▶ completed
                              │  error, attempts < max ─▶ queued (next_attempt_at = backoff)
                              └─ error, no attempts left / not retryable ─▶ failed
```

- **text job**: agent system prompt + category → TextProvider (JSON listing) → `content` row (+ optional chained video job).
- **video job**: submit → poll (across dispatcher runs; `processing` + `provider_ref` is a pending remote render) → download → `MediaStorage.put` → attach `media_key` to the content.
- Dry-run jobs publish their (simulated) content so the site feels alive. **Live jobs never auto-publish**: their content is created as `draft`, and draft media is not served by `/api/media`.
- A video job keeps its `provider_ref` across retries: a polling or download error re-polls the existing render instead of submitting (and paying for) a new one.
- The daily live budget is enforced inside the insert statement (`INSERT … SELECT … WHERE count < max`), so concurrent requests and chained video jobs cannot overshoot it. A chained live job that would exceed the budget is skipped and logged as `job.skipped`.
- The Pruna adapter sends its API key only to `https://api.pruna.ai` and refuses any other delivery origin or a redirect.
- **Ownership is a renewable lease.** A dispatcher claims a job with a lease of `GENERATION_LEASE_SECONDS` (default 60) and renews it every third of that while a provider call is in flight. Only a lapsed lease makes a job recoverable, so a slow provider call is never mistaken for a dead worker while the worker can still reach the database. Every write to the job is fenced on `lease_owner`; a worker that lost its lease gets `LeaseLostError`, writes nothing, and the loss is logged as `job.lease_lost`. Content is unique per job (`uq_content_job`), so a late result cannot create a second record.
- **Not exactly-once at the provider.** A worker that cannot renew (database unreachable) is reclaimed while its call is still running, so that provider call happens twice and only one result is kept. Text calls are cheap to repeat. A video submit is recorded on the job the moment it returns, whoever made it, so a reclaiming worker reuses the render instead of paying for another; the one remaining window is a worker dying between submit and record, which Pruna's API offers no idempotency key to close.
- Two identical requests racing for the last daily slot both receive the same job: the idempotency key is re-checked before a budget error is raised.

### What is public

Public: published content, search, categories, agents, published media, and a sanitised per-agent activity feed (publications of still-published content, plus bare "queued / finished a generation job" lines regenerated from the event type). Not public: drafts and their titles, media keys, job prompts, provider references, errors and retries, the dispatcher, and the dashboard (signed session required; none can be issued yet). The job API refuses with 503 until `JOBS_API_TOKEN` is set.

### Safety switches

| Env | Default | Meaning |
|---|---|---|
| `GENERATION_LIVE` | `false` | master switch; with it off, live jobs are refused at enqueue and fail fast at dispatch |
| `GENERATION_DRY_RUN` | `true` | jobs are dry runs unless a caller explicitly asks for `live: true` |
| `GENERATION_MAX_PER_RUN` | `5` | jobs per dispatcher pass |
| `GENERATION_MAX_LIVE_PER_DAY` | `10` | live jobs created per UTC day |
| `GENERATION_MAX_ATTEMPTS` / `GENERATION_RETRY_BACKOFF_SECONDS` | `3` / `60` | retry policy |
| `GENERATION_LEASE_SECONDS` | `60` | how long a dispatcher owns a job between renewals; a lapsed lease is a dead worker |
| `JOBS_API_TOKEN` | unset | bearer token for `POST /api/jobs` and `POST /api/jobs/run`; unset disables both (503) |
| `PRUNA_RESOLUTION` / `PRUNA_DRAFT` | `720p` / `true` | the cheap setting is pinned (Pruna's own default is `draft=false`) |

Model names and prices are env-configurable (`OPENROUTER_MODEL`, `*_PRICE_*`) and only used for cost estimates on job results. See `.env.example`.

## Cloudflare: adapter choice and what was verified

Checked on 2026-11-01 against current docs for **Next.js 16.4.3**:

- **@opennextjs/cloudflare 1.20.15** declares support for Next 16.4 (`peer next >=16.4.1`), Node-runtime `proxy.ts` (experimental, needs `nodejs_compat`) and server actions. Cloudflare's docs now point new projects at vinext, but this adapter runs the real `next build` output.
- **vinext 1.4.0** reimplements Next on Vite. Its README states Cache Components / PPR support is incomplete and it ignores Turbopack config. Beta.
- **Conflict**: the scaffold had `cacheComponents: true`. OpenNext has several open issues with Cache Components on Next 16.3/16.4 and vinext does not support it. **Resolution**: `cacheComponents` is now `false`; DB-backed route groups set `dynamic = "force-dynamic"` and render per request. No ISR, no `"use cache"`, so OpenNext needs no incremental cache config.

What was actually tested locally (no account, no deploy):

1. `npm run cf:build` → OpenNext bundle builds, including the proxy.
2. `wrangler d1 migrations apply x86xx --local` → schema applied to the D1 emulator; seed loaded with `wrangler d1 execute --local --file .data/seed.sql`.
3. `wrangler dev` on the bundle with `DATA_BACKEND=cloudflare` → every page, the proxy redirect, robots/sitemap, 404s and all API routes returned the expected status reading from D1.
4. With a test `JOBS_API_TOKEN` var: `POST /api/jobs` (D1 write) → `POST /api/jobs/run` twice → text job created content, video job stored a mock render in the **R2 emulator**, `GET /api/media/...` served it back (200, `image/svg+xml`).

Not verified: a real Cloudflare account, remote D1/R2, custom domain, cron triggers, production performance, and whether the experimental Node proxy support holds under load.

## Tests

`npm test` → vitest, 8 files, **67 tests passing** (run on 2026-11-01). Each file gets an in-memory database.

- `tests/db.test.ts` migrations apply once; a failing migration file rolls back and a pre-0002 database gains the new indexes on the next run; concurrent inserts of one title get unique slugs; seed is idempotent and additive (a removed category and its videos are re-added, nothing else changes); all sixteen categories have content; content is isolated per agent; drafts hidden from public queries; unique slugs; foreign keys enforced.
- `tests/search.test.ts` search across title/description/tags, title-first ranking, category filter, sorts, limit clamping, related ordering, nav/explore href helpers.
- `tests/jobs.test.ts` state machine, backoff, enqueue validation errors, idempotency (explicit and derived keys), live refused when disabled, daily live budget under six concurrent enqueues (exactly `max` succeed) and at the repo level, two identical live requests racing for the last slot both get the same job, jobs with a lapsed lease are recovered (requeued or failed) while live leases and remote renders are left alone, unknown job patch columns are rejected, dispatcher end to end (text → content; chained video polling across runs → media stored and attached), polling errors retry against the same `provider_ref` with exactly one submit, chained live jobs skipped when the budget is exhausted or live is off, bounded retries then failure, `next_attempt_at` honoured, exclusive claim, per-run limit, live job fails fast without retry when the switch is off.
- `tests/providers.test.ts` provider selection rules; Pruna adapter request shape (`apikey`, `Model`, `input.resolution=720p`, `draft=true`), status mapping, relative delivery URL, download refuses foreign origins, plain http, look-alike hosts and redirects without making a request, retryable vs fatal HTTP errors, cost estimates; OpenRouter request shape, headers, JSON mode, usage/cost; listing parser.
- `tests/routes.test.ts` every nav link has a page; proxy only honours signed cookies (unsigned, forged and expired are redirected); explore and category pages render with repeated query params (`?q=a&q=b`); media route serves published media only (draft, orphan and archived keys 404); health; search validation; jobs API reads and writes require the token (401/503), create (201), idempotent repeat (200), validation (400 with field), live refusal (429), bad JSON (400), status/404/400; dispatcher endpoint gating and a real run; the public agent activity feed and agent page never contain a draft title, a media key or an error string while the operator feed does.
- `tests/session.test.ts` signed cookie round trip; wrong secret, tampering, expiry and missing secret all reject.
- `tests/leases.test.ts` the regression: a provider call held open three times longer than the lease is not reclaimed by a second dispatcher while the heartbeat renews, and finishes with one call and one content row; a worker that cannot renew is reclaimed, its late result is discarded with nothing written, content stays single and the provider call count is two; a crashed worker is recovered only after its lease lapses; renew, release and fenced updates; three concurrent dispatchers over six jobs run each exactly once; a pending render is handed to the next dispatcher with one submit; provider references record once; migration 0003 upgrades a pre-lease database without touching rows and treats old `processing` rows as lapsed.
- `tests/warnings.test.ts` the SQLite warning filter leaves the `warning` listener list untouched, drops only the SQLite ExperimentalWarning (string and Error forms), delivers other warnings, and keeps `once` and `removeListener` semantics.

Also run: `npm run lint` (clean), `npm run typecheck` (clean), `npm run build` (clean), `npm run cf:build` (clean).

Not covered by automated tests: rendered React output (no DOM test runner is installed), the R2 and D1 adapters themselves (exercised manually via wrangler as described above), and the live provider adapters against the real APIs.

## Remaining steps to go live

**Cloudflare**
1. `npx wrangler login`, then `npx wrangler d1 create x86xx` and put the printed `database_id` into `wrangler.jsonc`; `npx wrangler r2 bucket create x86xx-media`.
2. `npx wrangler d1 migrations apply x86xx --remote`, then load the catalogue: `npm run db:export-sql && npx wrangler d1 execute x86xx --remote --file .data/seed.sql`.
3. Keep the R2 bucket **private**: no r2.dev URL and no custom domain. It holds draft renders next to published ones, and `/api/media` is the only path that serves objects, after checking the owning content is published. If a public bucket URL is ever wanted, it needs a separate bucket (or prefix) that only published media is copied into.
4. Secrets: `npx wrangler secret put JOBS_API_TOKEN` (and later the provider keys).
5. Deploy: `npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy`; point `x86xx.com` at the Worker.
6. Cron: create `custom-worker.ts` that re-exports the OpenNext `fetch` and adds `scheduled` via `createScheduledDispatcher` (`src/server/jobs/scheduled.ts` has the sketch), set `main` to it and add `"triggers": { "crons": [...] }`. Until then, call `POST /api/jobs/run` with the token.

**OpenRouter**: set `OPENROUTER_API_KEY`; pick the model (`qwen/qwen3.7-flash` is the cheapest Qwen listed today at $0.03/$0.13 per 1M tokens; prices change, read them from `/api/v1/models`). Set `GENERATION_LIVE=true` only when you also want Pruna live, because the live selector requires both keys. Enqueue with `live: true`; outputs land as `draft`.

**Pruna**: set `PRUNA_API_KEY`. Defaults are `p-video`, 720p, `draft=true` ($0.005/s, so about $0.025 per 5 s clip). Switch to `PRUNA_DRAFT=false` ($0.02/s) only if draft quality is inadequate. Polling happens across dispatcher runs, so run the dispatcher every few minutes while renders are in flight. Generated files are `video/mp4`; the player placeholder currently renders stored media as an image and will need a `<video>` element once real MP4s exist.

**Auth**: the cookie format and verifier exist (`src/lib/session.ts`, HMAC-SHA256 with `SESSION_SECRET`). Still needed: a user table and migration, real bodies in `src/app/(auth)/actions.ts` that call `signSession` and set the cookie, and removing the dev bypass in `src/proxy.ts`.

## Known gaps

- `src/server/db/migrate.ts` reads the filesystem, which makes Turbopack trace the project (a build warning, harmless). It only runs on the sqlite backend.
- Draft content has no UI; only the dashboard list shows it.
- The dashboard is read-only on purpose; there is no admin action anywhere in the UI.
- `node:sqlite` emits an ExperimentalWarning on Node 24 when first loaded. Next dev captures server stderr and would show it in the browser console as an error, so `src/server/db/sqlite-warning.ts` wraps `process.emitWarning` (the path Node's internals use) to drop exactly that warning before it becomes an event. Listeners are not touched, so `on`, `once` and `removeListener` behave normally for every other warning.
