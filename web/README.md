# Solenne ESS — Trellis HRMS employee self-service

Client app for the Trellis HRMS platform (backend: `../backend`). Next.js 16.3.5 +
TypeScript + Tailwind v4, fully client-side with TanStack Query, consuming the
deployed backend API (`https://backend-liard-chi-84.vercel.app`).

**Live:** https://solenne-ess-prod.vercel.app (Vercel project `solenne-ess`,
git-connected to `main`, root dir `web/`, framework preset Next.js).

## Deployment

Deploys automatically on every push to `main` (git integration on the
`solenne-ess` Vercel project). Manual override:

```bash
vercel --cwd web --prod --yes
```

## Pages

| Route | Access | What it does |
| --- | --- | --- |
| `/login` | public | Tenant subdomain + email + password sign-in |
| `/dashboard` | authed | Leave balances, clock-in/out, recent attendance, recent leave requests |
| `/leave` | authed | Submit leave requests + list own requests |
| `/reports` | `reporting:read` (admin/HR) | Headcount, attendance summary, leave summary |

## Getting started

```bash
pnpm install
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL defaults to prod
pnpm dev                            # http://localhost:3000
```

Demo sign-in: tenant `acme`, email `aisha@acme.com`, password `employee123`
(also `admin@acme.com` / `admin123` for the reporting views).

## Scripts

```bash
pnpm build   # next build (TypeScript + prerender check)
pnpm lint    # eslint
pnpm dev     # dev server

pnpm build && pnpm lint   # CI-equivalent gate (both must pass green)
```

## Notes

- All data flows through `lib/api.ts`, a single typed client with silent
  401 → `/auth/refresh` token rotation and a shared refresh promise.
- Tokens live in `localStorage` (`solenne.access`, `solenne.refresh`).
- Next.js 16 has breaking changes; keep `AGENTS.md` in sync (re-added by
  `next dev`) and consult `node_modules/next/dist/docs/` before writing code.