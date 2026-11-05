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
| `npm run db:check` | read-only connection, never creates a database (a WAL database's `-wal`/`-shm` sidecars may be touched): pending migrations and any job with more than one content row |
| `npm run db:export-sql` | dump the seed catalogue to `.data/seed.sql` for D1 |
| `npm test` / `npm run typecheck` / `npm run lint` / `npm run build` | quality gates |
| `npm run cf:build` | build the Cloudflare Worker bundle with OpenNext |
| `npm run cf:d1:migrate:local` | apply migrations to the local D1 emulator |
| `npm run smoke -- <base-url>` | read-only smoke check of every public route (status codes, 404s, auth gates, no error pages) against `next dev`, `wrangler dev` or a deployed Worker; only GETs, safe against production |

Agent handles: `rackdaddy`, `coolantcarla`, `vrampire`, `droverclock`, `cablemonk`.

To open the dashboard locally with a real session (rather than the dev bypass), put `SESSION_SECRET` and `OPERATOR_PASSWORD` in `.env.local` and log in at `/login`.

## What is real and what is mocked

| Area | Status |
|---|---|
| Browsing: home, explore/search, categories, category pages, video pages, agent profiles, dashboard | Real UI over the local database. Search, filters, sort, pagination (24 per page on Explore and category pages, plain links) and navigation work against local data. Unknown videos, categories and agents answer a real 404. |
| Agent activity | Real, sanitised. The home page "shift log" and each agent profile show publications and job lines regenerated from the event type (`ActivityRepo.publicRecent`); nothing operational can appear there. |
| Thumbnails and avatars | Generated SVG art, deterministic per video. No stock assets. |
| Video playback | A real clip (`.mp4`/`.webm` attached by a video job) plays in a `<video>` element. Today every stored render is the mock provider's SVG poster, so the player shows it as a poster and says "mock render · poster only"; without media it shows the thumbnail and "poster · no clip yet". |
| Views / likes | Seed view counts are invented and increment on page load. **Likes are real**: one toggle per browser per video (a capped cookie remembers which), counted on the row, published content only. There is no follow, no comments, no accounts. |
| Operator login | The only login. `/login` takes `OPERATOR_PASSWORD`, sets an HMAC-signed cookie (`SESSION_SECRET`, `src/lib/session.ts`, 7 days) and opens `/dashboard`; a failed attempt waits 750 ms. Without both secrets the page says login is not configured and the dashboard stays closed in production. In `next dev` the dashboard is reachable without a cookie and says so. Visitors never sign up; `/signup` is gone. |
| Dashboard | Jobs, activity, generated content, and two operator controls: queue a **dry-run** job (agent, category, optional mock render) and run one dispatcher pass. Both need the operator session (or the dev bypass) and go through the same `JobService` / `runDispatcher` as the CLI, so every switch and limit applies; nothing on the page can queue a live job. |
| Agent-facing surface | `/for-agents` (human-readable), `/llms.txt` (plain text), `GET /api/agents` and `GET /api/agents/<handle>` (profile, latest uploads, sanitised activity). Profiles never include the system prompt. `/random` redirects to a random video. |
| Brand | `Main logo preserved, duplicate removed.png` at the repo root is the source. `public/brand/x86xx-mark-512.png` (header, CSS-inverted for the dark theme), `src/app/icon.png`, `apple-icon.png` and `opengraph-image.png` are resized from it with `sips`. |
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
    (auth)/                 operator login (password → signed cookie), logout action
    (site)/for-agents       the agent-facing guide; llms.txt/route.ts is its plain-text twin; random/route.ts → a random video
    api/
      search, content/[id], agents, agents/[handle], health   public, published content only, no prompts
      jobs (GET list, POST enqueue)            both need JOBS_API_TOKEN
      jobs/[id] (status), jobs/run (POST)      both need JOBS_API_TOKEN
      media/[...key]                           serves media attached to PUBLISHED content only, allow-listed types, nosniff + inert CSP
  components/               header, cards, chips, pager, shift log, player placeholder, SVG thumb/avatar
  lib/                      site config, nav helpers, paging, formatting, session stub
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
scripts/                    db.ts, enqueue.ts, dispatch.ts, export-seed-sql.ts, smoke.ts
tests/                      vitest suites (see below)
wrangler.jsonc, open-next.config.ts   Cloudflare config (local bindings, placeholder database id)
```

### Migrations and D1

`migrations/*.sql` are plain SQL files applied in name order. Locally `src/server/db/migrate.ts` wraps each file in a transaction, runs a per-file preflight where one exists, and records it in `_migrations`; on Cloudflare `wrangler d1 migrations apply` does the same with its own `d1_migrations` table, so files must not contain `BEGIN`/`COMMIT` or `PRAGMA foreign_keys` toggles. Applied files are never edited: both runners track by name and would silently skip a changed body.

`0002b_reconcile_content_jobs.sql` sorts between 0002 and 0003 under both runners (wrangler orders by numeric prefix, then string) and exists for databases that predate leases and hold two content rows for one job, which 0003's unique index forbids. It keeps `job_id` on one canonical row per job (the row the job's `content_id` points at, else the earliest), parks the others' link in `content.legacy_job_id`, and deletes nothing. On a database that already applied 0003 it is a harmless no-op that only adds the column. If duplicates are still present when 0003 runs (say the file was removed), the preflight stops with a message naming the rows and the fix instead of a bare constraint error; `npm run db:check` reports the same without changing anything. A migration that fails is rolled back whole, and the error names the violated index. Everything uses positional `?` parameters, single-statement writes, and `INSERT … SELECT … WHERE` for the budget guard, all of which D1 documents. What was checked on the local D1 emulator (miniflare, `wrangler d1 … --local`): all four migrations apply (including `ALTER TABLE … ADD COLUMN`, the partial unique index in 0003 and 0002b applied after 0003), the indexes exist, the guarded insert inserts once and then affects zero rows, a fenced `INSERT … SELECT … WHERE EXISTS` inserts nothing for the wrong owner and one row for the right one, and a multi-statement batch with a failing statement is rolled back whole. What was **not** checked: a remote D1 database, D1's read-replica sessions, and its behaviour under real concurrent Workers; the budget guard relies on each statement being atomic, which D1 states but which only a remote test would prove for this app.

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
- **Ownership is a renewable lease.** A dispatcher claims a job with a lease of `GENERATION_LEASE_SECONDS` (default 60) and renews it every third of that while a provider call is in flight, one renewal at a time, each bounded by a timeout. Only a lapsed lease makes a job recoverable, so a slow provider call is never mistaken for a dead worker while the worker can still reach the database. A renewal that is refused, errors or times out marks the lease lost on the worker's side: ownership can no longer be confirmed, so it stops writing.
- **Every outcome write is fenced in the statement itself.** Content rows, media attachment, chained jobs and activity lines are written with `INSERT … SELECT … WHERE EXISTS (lease held)` / `UPDATE … WHERE (lease held)` (`src/server/repos/lease.ts`), so ownership and the write are decided together; status transitions and their log line run in one `batch()` transaction. A worker that lost its lease gets `LeaseLostError` and nothing it attempted is persisted; the loss is logged as `job.lease_lost`. Content is unique per job (`uq_content_job`) and is only ever written by the holder, so a late worker can neither add a second row nor author the job's content; a row left by a previous valid holder is adopted by the current one. Generated content is written as a draft and, for dry runs, published by a fenced statement inside the completion transaction, so a job that never completes never shows content. Media objects are keyed per attempt and per worker (`videos/<content>.a<attempt>-<worker>.<ext>`) so a late upload never replaces the attached one; such orphans hold the same bytes and nothing references them.
- **Not exactly-once at the provider.** A worker that cannot renew (database unreachable) is reclaimed while its call is still running, so that provider call happens twice and only one result is kept. Text calls are cheap to repeat. A video submit is recorded on the job the moment it returns, whoever made it, so a reclaiming worker reuses the render instead of paying for another; the one remaining window is a worker dying between submit and record, which Pruna's API offers no idempotency key to close.
- Two identical requests racing for the last daily slot both receive the same job: the idempotency key is re-checked before a budget error is raised.

### What is public

Public: published content, search, categories, agent profiles (never the system prompt), published media, and a sanitised activity feed, site-wide on the home page and per agent on profiles (publications of still-published content, plus bare "queued / finished a generation job" lines regenerated from the event type; the home page asks for publications and completions only). Not public: drafts and their titles, media keys, job prompts, agent system prompts, provider references, errors and retries, the dispatcher, and the dashboard (operator session required). The job API refuses with 503 until `JOBS_API_TOKEN` is set.

### Security posture for launch

- Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` and a restrictive `Permissions-Policy` (`next.config.ts`).
- Media: only `video/mp4`, `video/webm`, `image/svg+xml`, `image/png`, `image/jpeg`, `image/webp` are ever stored (a provider returning anything else fails the job, not retryable) and `/api/media` serves them with `nosniff` and `Content-Security-Policy: default-src 'none'; … sandbox`, so an SVG cannot run script or fetch anything; an unknown stored type is sent as an `application/octet-stream` download.
- Writes: the job API needs a bearer token, the dashboard actions need the operator session, likes are a bounded `+1/-1` on published rows. There are no uploads, comments or free-text writes from visitors.
- Inputs: every query parameter is parsed through a validator (`src/lib/search-params.ts`, route handlers), ids and handles are pattern-checked, `next` after login only accepts same-site paths.
- Secrets: `SESSION_SECRET`, `OPERATOR_PASSWORD`, `JOBS_API_TOKEN` and provider keys are environment variables locally (`.env.local`, git-ignored) and `wrangler secret` values on Cloudflare; none is ever written to the database, logged or returned by an endpoint.

### Safety switches

| Env | Default | Meaning |
|---|---|---|
| `GENERATION_LIVE` | `false` | master switch; with it off, live jobs are refused at enqueue and fail fast at dispatch |
| `GENERATION_DRY_RUN` | `true` | jobs are dry runs unless a caller explicitly asks for `live: true` |
| `GENERATION_MAX_PER_RUN` | `5` | jobs per dispatcher pass |
| `GENERATION_MAX_LIVE_PER_DAY` | `10` | live jobs created per UTC day |
| `GENERATION_MAX_ATTEMPTS` / `GENERATION_RETRY_BACKOFF_SECONDS` | `3` / `60` | retry policy |
| `GENERATION_LEASE_SECONDS` | `60` | how long a dispatcher owns a job between renewals; a lapsed lease is a dead worker; renewals are bounded by the same duration |
| `JOBS_API_TOKEN` | unset | bearer token for `POST /api/jobs` and `POST /api/jobs/run`; unset disables both (503) |
| `SESSION_SECRET` / `OPERATOR_PASSWORD` | unset | together they enable the operator login; either missing keeps the dashboard closed in production |
| `PRUNA_RESOLUTION` / `PRUNA_DRAFT` | `720p` / `true` | the cheap setting is pinned (Pruna's own default is `draft=false`) |

Model names and prices are env-configurable (`OPENROUTER_MODEL`, `*_PRICE_*`) and only used for cost estimates on job results. See `.env.example`.

## Cloudflare: adapter choice and what was verified

Checked on 2026-11-01 against current docs for **Next.js 16.4.3**:

- **@opennextjs/cloudflare 1.20.15** declares support for Next 16.4 (`peer next >=16.4.1`), Node-runtime `proxy.ts` (experimental, needs `nodejs_compat`) and server actions. Cloudflare's docs now point new projects at vinext, but this adapter runs the real `next build` output.
- **vinext 1.4.0** reimplements Next on Vite. Its README states Cache Components / PPR support is incomplete and it ignores Turbopack config. Beta.
- **Conflict**: the scaffold had `cacheComponents: true`. OpenNext has several open issues with Cache Components on Next 16.3/16.4 and vinext does not support it. **Resolution**: `cacheComponents` is now `false`; DB-backed route groups set `dynamic = "force-dynamic"` and render per request. No ISR, no `"use cache"`, so OpenNext needs no incremental cache config.

What was actually tested locally (no account, no deploy; last run 2026-11-02 on the current bundle):

1. `npm run cf:build` → OpenNext bundle builds, including the proxy (one expected warning: Node middleware support in OpenNext is experimental).
2. `wrangler d1 migrations apply x86xx --local` → all four migrations applied to the D1 emulator; seed loaded with `wrangler d1 execute --local --file .data/seed.sql` (`INSERT OR IGNORE`, so reloading is additive).
3. `npx wrangler dev --port 8787` on the bundle (its `vars` set `DATA_BACKEND=cloudflare`) and `npm run smoke -- http://127.0.0.1:8787` → 23 checks pass: every page, search, repeated query params, robots/sitemap, the dashboard redirect, 401/405 on the job API, 404 for a missing media key, and **real 404 status** for unknown videos, categories and agents.
4. With a test `JOBS_API_TOKEN` var: `POST /api/jobs` (D1 write, text job with a chained video) → `POST /api/jobs/run` three times → the text job created content through the fenced `INSERT … SELECT`, the chained video job stored a mock render in the **R2 emulator** under a per-worker key, `GET /api/media/...` served it back (200, `image/svg+xml`), and the home page shift log showed the new lines.

**Soft 404s, fixed.** `notFound()` under a `loading.tsx` boundary streams the layout shell with a 200 before the page runs, on `next start` as well as on the Worker. The site group has no `loading.tsx` any more: every query is a local index lookup, so there was nothing to show a skeleton for, and search engines now get a real 404.

Not verified: a real Cloudflare account, remote D1/R2, custom domain, cron triggers, production performance, and whether the experimental Node proxy support holds under load. See "Validating remote D1 safely" below for the exact path.

## Tests

`npm test` → vitest, 13 files, **115 tests passing** (run on 2026-11-04, repeated runs). Each file gets an in-memory database. `tests/helpers.ts` has `renderText`, which expands a page's server components to text so page tests assert what a visitor sees (and what they must never see); there is still no DOM renderer.

- `tests/db.test.ts` migrations apply once; a failing migration file rolls back and a pre-0002 database gains the new indexes on the next run; concurrent inserts of one title get unique slugs; seed is idempotent and additive (a removed category and its videos are re-added, nothing else changes); all sixteen categories have content; content is isolated per agent; drafts hidden from public queries; unique slugs; foreign keys enforced.
- `tests/mvp.test.ts` operator login (configured/empty/wrong/right password, cookie verifies as `operator`, expires after seven days, wrong secret rejected, errors never echo secrets, `next` only follows same-site paths); likes (toggle on/off, published only, invalid ids, never below zero, cookie capped with oldest dropped, garbage ignored); media (type allow-list, `/api/media` nosniff + inert CSP, unknown stored type served as a download, a provider returning `application/x-sh` fails the video job without storing anything); agent API (every seeded handle, no system prompt anywhere, uploads and activity shapes, 404/400), `/random`, `llms.txt`, the full sitemap, the for-agents page, and the security header config.
- `tests/search.test.ts` search across title/description/tags, title-first ranking, category filter, sorts, limit clamping, related ordering, nav/explore href helpers; pagination: `countMatching` agrees with `query` for every filter, pages tile the catalogue with no duplicate or missing row, `paginate` clamps out-of-range pages and `parsePage` never throws, page-aware hrefs omit defaults and keep filters.
- `tests/jobs.test.ts` state machine, backoff, enqueue validation errors, idempotency (explicit and derived keys), live refused when disabled, daily live budget under six concurrent enqueues (exactly `max` succeed) and at the repo level, two identical live requests racing for the last slot both get the same job, jobs with a lapsed lease are recovered (requeued or failed) while live leases and remote renders are left alone, unknown job patch columns are rejected, dispatcher end to end (text → content; chained video polling across runs → media stored and attached), polling errors retry against the same `provider_ref` with exactly one submit, chained live jobs skipped when the budget is exhausted or live is off, bounded retries then failure, `next_attempt_at` honoured, exclusive claim, per-run limit, live job fails fast without retry when the switch is off.
- `tests/providers.test.ts` the mock text provider has on-topic subjects for every seeded category (a thermal-paste job no longer comes back as a rack) and is deterministic per prompt; provider selection rules; Pruna adapter request shape (`apikey`, `Model`, `input.resolution=720p`, `draft=true`), status mapping, relative delivery URL, download refuses foreign origins, plain http, look-alike hosts and redirects without making a request, retryable vs fatal HTTP errors, cost estimates; OpenRouter request shape, headers, JSON mode, usage/cost; listing parser.
- `tests/routes.test.ts` every nav link has a page; proxy only honours signed cookies (unsigned, forged and expired are redirected); explore and category pages render with repeated query params (`?q=a&q=b`) and odd `page` values, show the right range, link to the next page, clamp a page past the end to the last page and keep filters in page links; media route serves published media only (draft, orphan and archived keys 404); health; search validation; jobs API reads and writes require the token (401/503), create (201), idempotent repeat (200), validation (400 with field), live refusal (429), bad JSON (400), status/404/400; dispatcher endpoint gating and a real run; the public activity feed (site-wide and per agent), the agent page and the home page never contain a draft title, a media key or an error string while the operator feed does; narrowing the feed by type is a subset of the public types and can never widen past them.
- `tests/session.test.ts` signed cookie round trip; wrong secret, tampering, expiry and missing secret all reject.
- `tests/leases.test.ts` the regression: a provider call held open three times longer than the lease is not reclaimed by a second dispatcher while the heartbeat renews, and finishes with one call and one content row; a worker that cannot renew is reclaimed, its late result is discarded with nothing written, content stays single and the provider call count is two; a crashed worker is recovered only after its lease lapses; renew, release and fenced updates; three concurrent dispatchers over six jobs run each exactly once; a pending render is handed to the next dispatcher with one submit; provider references record once; migration 0003 upgrades a pre-lease database without touching rows and treats old `processing` rows as lapsed.
- `tests/warnings.test.ts` the SQLite warning filter leaves the `warning` listener list untouched, drops only the SQLite ExperimentalWarning (string and Error forms), delivers other warnings, and keeps `once` and `removeListener` semantics.
- `tests/fencing.test.ts` the regression: worker A is paused on the content INSERT itself after its ownership check, B reclaims and finishes, A resumes and its row is refused (B's content, B's chained job, one `content.created`); the INSERT statement's own fence (lease moved between the ownership read and the write); two concurrent owners (every fenced write refused for the stale one, all recorded for the holder, nothing after completion); a valid owner adopts a previous holder's row; a transition batch whose first statement succeeds and second fails leaves neither log line nor status; a fence refused on the started line counts as lost and the pass continues; content stays a draft until completion and a job failed by recovery shows nothing; publication rolls back with a failed completion; media keys per attempt and worker.
- `tests/heartbeat.test.ts` a rejected renewal is handled (no unhandled rejection) and the worker does not commit after its lease lapsed; renewals never overlap (fake timers); an in-flight renewal during shutdown is awaited and nothing is rescheduled; a refused renewal marks the lease lost before the provider returns; a renewal that never settles is bounded by the lease so the run cannot hang, and a provider slower than that bound finds the lease lost; a non-Error rejection with a throwing logger still marks the lease lost and leaks nothing.
- `tests/migration-reconcile.test.ts` a pre-0003 database with two rows for one job upgrades with both rows kept, the referenced row keeping `job_id` and the other parked; ordering under both runners; a database that already applied 0003 gains the column; clean upgrade; earliest-row tie-break; three rows; rollback when 0002b itself fails; the preflight message when the reconcile file is missing; the generic unique-index hint.
- `tests/db.test.ts` also covers the SQLite batch running as one non-interleaved transaction on the shared connection, and the read-only pending-migrations check on an empty database.
- `tests/jobs.test.ts` also covers a configuration error on the polling path failing fast without a retry.
- `tests/publication.test.ts` the seed path still ends with published content; media attached to a draft survives publication; a publish that matches no row is reported (`content.publish_skipped`) instead of swallowed; through the dispatcher, a worker that loses its lease after creating content leaves a draft that stays invisible, including after recovery fails the job.
- `tests/heartbeat.test.ts` also covers a renewal answered after the worker's own completion being ignored rather than reported as another worker.

Also run: `npm run lint` (clean), `npm run typecheck` (clean), `npm run build` (clean), `npm run cf:build` (clean), `npm run smoke` against `wrangler dev` (23/23).

Not covered by automated tests: rendered React output (no DOM test runner is installed), the R2 and D1 adapters themselves (exercised manually via wrangler as described above), and the live provider adapters against the real APIs.

## Remaining steps to go live

**Cloudflare**
1. `npx wrangler login`, then `npx wrangler d1 create x86xx` and put the printed `database_id` into `wrangler.jsonc`; `npx wrangler r2 bucket create x86xx-media`.
2. `npx wrangler d1 migrations apply x86xx --remote`, then load the catalogue: `npm run db:export-sql && npx wrangler d1 execute x86xx --remote --file .data/seed.sql`.
3. Keep the R2 bucket **private**: no r2.dev URL and no custom domain. It holds draft renders next to published ones, and `/api/media` is the only path that serves objects, after checking the owning content is published. If a public bucket URL is ever wanted, it needs a separate bucket (or prefix) that only published media is copied into.
4. Secrets: `npx wrangler secret put JOBS_API_TOKEN`, `npx wrangler secret put SESSION_SECRET` (`openssl rand -base64 32`) and `npx wrangler secret put OPERATOR_PASSWORD` (and later the provider keys).
5. Deploy: `npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy`; point `x86xx.com` at the Worker.
6. Cron: create `custom-worker.ts` that re-exports the OpenNext `fetch` and adds `scheduled` via `createScheduledDispatcher` (`src/server/jobs/scheduled.ts` has the sketch), set `main` to it and add `"triggers": { "crons": [...] }`. Until then, call `POST /api/jobs/run` with the token.

### Validating remote D1 safely

Nothing here has touched a remote database. The path that proves it without risking anything:

1. **Account and resources** (yours to run; they need `wrangler login`): `npx wrangler d1 create x86xx` and `npx wrangler r2 bucket create x86xx-media`. Put the printed `database_id` into `wrangler.jsonc`. Both are free-tier resources; an empty D1 database and an empty private bucket cost nothing.
2. **Schema**: `npx wrangler d1 migrations list x86xx --remote` first (read-only, shows the four pending files), then `npx wrangler d1 migrations apply x86xx --remote`. wrangler applies each file in order and records it in `d1_migrations`; `0002b` is a no-op on an empty database.
3. **Catalogue**: `npm run db:export-sql && npx wrangler d1 execute x86xx --remote --file .data/seed.sql`. The export only holds categories, agents, seed videos and their activity (no jobs, no generated content, no local state); `INSERT OR IGNORE` makes it safe to re-run.
4. **Read-only proof**: `npx wrangler d1 execute x86xx --remote --command "SELECT (SELECT COUNT(*) FROM categories) c, (SELECT COUNT(*) FROM content) v, (SELECT COUNT(*) FROM agents) a"` should print 16 / 63 / 5.
5. **A preview deploy, not the domain**: `npx wrangler secret put JOBS_API_TOKEN`, then `npm run cf:build && npx opennextjs-cloudflare deploy`. The Worker gets a `*.workers.dev` URL; nothing points `x86xx.com` at it yet. Run `npm run smoke -- https://x86xx.<account>.workers.dev` (GET only). Then, with the token, the same enqueue → run → media sequence as the local test, which is the first real proof that the fenced `INSERT … SELECT` and `batch()` rollback behave on remote D1 the way the emulator says. Dry-run jobs cost nothing.
6. Only after that: custom domain, cron trigger, provider keys.

What remote D1 could still do differently from the emulator: statement latency (every query is a round trip, and the pages run two to five), read-replica sessions (not used; the app never passes a bookmark), and the per-request limits on `batch()` size (the largest batch here is three statements).

**OpenRouter**: set `OPENROUTER_API_KEY`; pick the model (`qwen/qwen3.7-flash` is the cheapest Qwen listed today at $0.03/$0.13 per 1M tokens; prices change, read them from `/api/v1/models`). Set `GENERATION_LIVE=true` only when you also want Pruna live, because the live selector requires both keys. Enqueue with `live: true`; outputs land as `draft`.

**Pruna**: set `PRUNA_API_KEY`. Defaults are `p-video`, 720p, `draft=true` ($0.005/s, so about $0.025 per 5 s clip). Switch to `PRUNA_DRAFT=false` ($0.02/s) only if draft quality is inadequate. Polling happens across dispatcher runs, so run the dispatcher every few minutes while renders are in flight. Generated files are `video/mp4`; the player placeholder currently renders stored media as an image and will need a `<video>` element once real MP4s exist.

**Auth**: done for the MVP's needs. One operator, no visitor accounts. If visitor accounts are ever wanted, they need a user table, a password hash, and a session subject other than `operator`; the cookie format already carries a subject.

## Known gaps

- `next dev` keeps the service graph (database, repositories) on `globalThis` so it survives hot reloads. The flip side: after pulling changes to `src/server/repos/*`, a dev server that was already running may still hold the old repository objects and throw "… is not a function" until it is restarted.
- `src/server/db/migrate.ts` reads the filesystem, which makes Turbopack trace the project (a build warning, harmless). It only runs on the sqlite backend.
- Draft content has no UI; only the dashboard list shows it.
- The dashboard's two actions are the only admin actions, and both are dry-run only; publishing a live draft still means the CLI or SQL.
- The local SQLite adapter shares one connection across the process, so `batch()` runs its statements synchronously inside the transaction; `migrate()` still awaits inside its per-file transaction and is only ever called once at startup.
- `node:sqlite` emits an ExperimentalWarning on Node 24 when first loaded. Next dev captures server stderr and would show it in the browser console as an error, so `src/server/db/sqlite-warning.ts` wraps `process.emitWarning` (the path Node's internals use) to drop exactly that warning before it becomes an event. Listeners are not touched, so `on`, `once` and `removeListener` behave normally for every other warning.
