# Blog Platform (Poverty-Driven Demo)

**Live Demo**: hopefully `blog.<you>.workers.dev` soon, on the free plan.

The old version of this repo ran a blog on a **Raspberry Pi 5** because hosting is expensive.
To get the price to zero it used Kafka, Elasticsearch, Celery, RabbitMQ, Redis, Postgres, Traefik,
LocalStack, LocalStripe, a FastAPI microservice, two Django replicas, and a Cloudflare Tunnel
pointed at all of it.

This version is one TypeScript Worker on the Cloudflare free plan. It does the same things and
costs the same $0. It also stays up when someone trips over the Pi's power cable.

## Core Features

Unchanged, and the React app is untouched apart from the footer:

*   **Content Creation**: standard posts, **paid posts**, and **delayed posts** (published by a Cron Trigger).
*   **Monetization**: buy a subscription or a single post with the same mock test cards (`4242...`).
*   **Interactive Features**: likes, dislikes, comments, search, in-app "emails", and profile pictures.

## Architecture

```
┌──────────────────────────────────────────┐
│        Cloudflare Worker (free)          │
│                                          │
│  React build ─ static assets             │
│  /api/*      ─ Hono, same REST API       │
│  cron        ─ scheduled posts, expiry   │
└───────┬──────────────────────┬───────────┘
        │                      │
   ┌────▼────┐            ┌────▼────┐
   │   D1    │            │   KV    │
   │ SQLite  │            │ avatars │
   │ + FTS5  │            └─────────┘
   └─────────┘
```

| Before | After |
|---|---|
| Django 5 + DRF, 2 replicas behind Traefik | Hono on Workers (`worker/src`) |
| FastAPI payment microservice | `routes/billing.ts` |
| Kafka 4.1 (producers, consumers, topics) | a function call |
| Celery 5 + RabbitMQ 4.2 | Cron Triggers in `wrangler.jsonc` |
| Postgres 17 | D1 (`migrations/0001_init.sql`) |
| Elasticsearch 9 | SQLite FTS5 virtual table |
| Redis 8 | not needed |
| S3 via LocalStack | Workers KV |
| Stripe via LocalStripe | the frontend already checked the fake card itself, so "confirm" is one `UPDATE` |
| Docker Compose, Traefik, Cloudflare Tunnel, Raspberry Pi 5 | `npm run deploy` |

### Tech Stack
*   **Backend**: TypeScript, Hono, Cloudflare Workers
*   **Frontend**: React 18, TypeScript, MUI (unchanged)
*   **Data**: D1, KV
*   **Infrastructure**: a free Cloudflare account

## Quick Start

```bash
npm install && npm --prefix frontend install
npm run build        # build the React app into frontend/build
npm run dev          # local D1 + Worker on http://localhost:8787
npm test             # API tests inside the Workers runtime (vitest)
```

For frontend hot reload, run `npm run dev:frontend` next to `npm run dev`. CRA proxies `/api` to port 8787.

## Deploy (free plan, no credit card)

```bash
npx wrangler login
npx wrangler d1 create blog                # paste database_id into wrangler.jsonc
npx wrangler kv namespace create MEDIA     # paste id into wrangler.jsonc
npm run deploy                             # build, migrate, deploy
```

Make yourself an admin (Django admin did not survive the move):

```bash
npx wrangler d1 execute blog --remote --command "UPDATE users SET is_admin = 1 WHERE email = 'you@example.com'"
```

## Free plan notes

*   100k requests per day. The Pi was never going to get there either.
*   10 ms CPU per request, so passwords use PBKDF2-SHA256 with 20k rounds. The count is stored in each hash, so you can raise it later.
*   KV allows 1k writes per day on the free plan. That is plenty for avatar uploads.

---
*Originally created by Oleh Kazaiev. Ported to a budget he can actually afford.*
