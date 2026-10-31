# x86xx

Web app for [x86xx.com](https://x86xx.com). Next.js 16, React 19, TypeScript, Tailwind v4.

## Run it

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000.

## Layout

```
src/
  app/
    page.tsx              landing page
    (auth)/               login, signup, server action stubs
    (app)/dashboard/      protected area (placeholder)
    robots.ts, sitemap.ts
  components/             header, footer, auth form
  lib/
    site.ts               name, domain, URL
    session.ts            session cookie helpers (stub)
  proxy.ts                redirects: no session -> /login, has session -> /dashboard
```

## Status

Scaffold only. Auth forms render and post to server actions that return "not wired up yet".
To build real auth: implement `src/lib/session.ts` (signed cookie), add a user store,
and fill in `src/app/(auth)/actions.ts`.

## Deploy

Not decided yet. Works on Vercel, Cloudflare, or any Node host (`npm run build && npm start`).
Set `NEXT_PUBLIC_SITE_URL` and point the `x86xx.com` DNS at the host.
