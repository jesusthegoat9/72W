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

The first request creates `.data/x86xx.db`, applies `migrations/`, seeds the catalogue and runs a few **dry-run** jobs through the mock providers so the dashboard has history. Nothing calls a paid API.

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
| Login / signup | Forms render and post to stub server actions that return "not wired up yet". The proxy treats **any** session cookie as logged in. In `next dev` the dashboard is reachable without a cookie (it says so); production redirects to `/login`. |
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
      search, content/[id], health            read
      jobs (GET list, POST enqueue)            POST needs JOBS_API_TOKEN
      jobs/[id] (status), jobs/run (POST)      run needs JOBS_API_TOKEN
      media/[...key]                           serves objects from media storage
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
- Dry-run jobs publish their (simulated) content so the site feels alive. **Live jobs never auto-publish**: their content is created as `draft`.

### Safety switches

| Env | Default | Meaning |
|---|---|---|
| `GENERATION_LIVE` | `false` | master switch; with it off, live jobs are refused at enqueue and fail fast at dispatch |
| `GENERATION_DRY_RUN` | `true` | jobs are dry runs unless a caller explicitly asks for `live: true` |
| `GENERATION_MAX_PER_RUN` | `5` | jobs per dispatcher pass |
| `GENERATION_MAX_LIVE_PER_DAY` | `10` | live jobs created per UTC day |
| `GENERATION_MAX_ATTEMPTS` / `GENERATION_RETRY_BACKOFF_SECONDS` | `3` / `60` | retry policy |
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

`npm test` → vitest, 5 files, **40 tests passing** (run on 2026-11-01). Each file gets an in-memory database.

- `tests/db.test.ts` migrations apply once; seed is idempotent; content is isolated per agent; drafts hidden from public queries; unique slugs; foreign keys enforced.
- `tests/search.test.ts` search across title/description/tags, title-first ranking, category filter, sorts, limit clamping, related ordering, nav/explore href helpers.
- `tests/jobs.test.ts` state machine, backoff, enqueue validation errors, idempotency (explicit and derived keys), live refused when disabled, daily live budget, dispatcher end to end (text → content; chained video polling across runs → media stored and attached), bounded retries then failure, `next_attempt_at` honoured, exclusive claim, per-run limit, live job fails fast without retry when the switch is off.
- `tests/providers.test.ts` provider selection rules; Pruna adapter request shape (`apikey`, `Model`, `input.resolution=720p`, `draft=true`), status mapping, relative delivery URL, retryable vs fatal HTTP errors, cost estimates; OpenRouter request shape, headers, JSON mode, usage/cost; listing parser.
- `tests/routes.test.ts` every nav link has a page; proxy redirects; health; search validation; jobs API auth (401/503), create (201), idempotent repeat (200), validation (400 with field), live refusal (429), bad JSON (400), status/404/400; dispatcher endpoint gating and a real run.

Also run: `npm run lint` (clean), `npm run typecheck` (clean), `npm run build` (clean), `npm run cf:build` (clean).

Not covered by automated tests: rendered React output (no DOM test runner is installed), the R2 and D1 adapters themselves (exercised manually via wrangler as described above), and the live provider adapters against the real APIs.

## Remaining steps to go live

**Cloudflare**
1. `npx wrangler login`, then `npx wrangler d1 create x86xx` and put the printed `database_id` into `wrangler.jsonc`; `npx wrangler r2 bucket create x86xx-media`.
2. `npx wrangler d1 migrations apply x86xx --remote`, then load the catalogue: `npm run db:export-sql && npx wrangler d1 execute x86xx --remote --file .data/seed.sql`.
3. Add a custom domain to the bucket (or serve via the Worker route) and set `MEDIA_PUBLIC_URL` in `vars`.
4. Secrets: `npx wrangler secret put JOBS_API_TOKEN` (and later the provider keys).
5. Deploy: `npx opennextjs-cloudflare build && npx opennextjs-cloudflare deploy`; point `x86xx.com` at the Worker.
6. Cron: create `custom-worker.ts` that re-exports the OpenNext `fetch` and adds `scheduled` via `createScheduledDispatcher` (`src/server/jobs/scheduled.ts` has the sketch), set `main` to it and add `"triggers": { "crons": [...] }`. Until then, call `POST /api/jobs/run` with the token.

**OpenRouter**: set `OPENROUTER_API_KEY`; pick the model (`qwen/qwen3.7-flash` is the cheapest Qwen listed today at $0.03/$0.13 per 1M tokens; prices change, read them from `/api/v1/models`). Set `GENERATION_LIVE=true` only when you also want Pruna live, because the live selector requires both keys. Enqueue with `live: true`; outputs land as `draft`.

**Pruna**: set `PRUNA_API_KEY`. Defaults are `p-video`, 720p, `draft=true` ($0.005/s, so about $0.025 per 5 s clip). Switch to `PRUNA_DRAFT=false` ($0.02/s) only if draft quality is inadequate. Polling happens across dispatcher runs, so run the dispatcher every few minutes while renders are in flight. Generated files are `video/mp4`; the player placeholder currently renders stored media as an image and will need a `<video>` element once real MP4s exist.

**Auth**: implement a signed session in `src/lib/session.ts`, a user table and migration, and real bodies in `src/app/(auth)/actions.ts`. Remove the dev bypass in `src/proxy.ts` when done.

## Known gaps

- `src/server/db/migrate.ts` reads the filesystem, which makes Turbopack trace the project (a build warning, harmless). It only runs on the sqlite backend.
- Draft content has no UI; only the dashboard list shows it.
- The dashboard is read-only on purpose; there is no admin action anywhere in the UI.
- `node:sqlite` prints an ExperimentalWarning on Node 24.
