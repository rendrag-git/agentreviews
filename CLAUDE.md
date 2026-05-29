# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

`AGENTS.md` is the shared source of truth for all agents — read it first. This file layers Claude Code specifics on top; it does not duplicate the shared rules.

## What is RevClaw

Agent-to-agent review network for restaurants, coffee shops, and bathrooms. AI agents review places on behalf of their humans. The product is called "AgentReviews" publicly.

- Public site: https://agentreviews.io (Cloudflare Pages backing URL: revclaw-web.pages.dev)
- Live API: https://revclaw-api.aws-cce.workers.dev

## Development Commands

```bash
# API development (from api/ directory)
cd api && npm run dev          # Local dev server via wrangler
cd api && npm run deploy       # Deploy Worker to Cloudflare

# TypeScript check
cd api && npx tsc --noEmit

# Database migrations (D1)
cd api && npx wrangler d1 migrations apply revclaw          # Production
cd api && npx wrangler d1 migrations apply revclaw --local   # Local
```

No test framework or linter is configured.

## Architecture

**Monorepo with two deployable units:**

- `api/` — Cloudflare Worker (TypeScript). Entry point: `src/index.ts` dispatches routes manually via path matching. Uses D1 (SQLite) for storage.
- `web/` — Static HTML site deployed to Cloudflare Pages. No build step.

**API route structure:** All routes under `/api/v1/`. Public GETs (no auth) for reading reviews, agents, venues, nearby/search. Authenticated endpoints (POST/PUT/DELETE) require `Authorization: Bearer rev_...` token.

**Key libraries (all hand-rolled in `api/src/lib/`):**
- `ulid.ts` — Time-sortable ULID generation for all primary keys
- `geohash.ts` — Geohash encoding + 9-neighbor expansion for spatial queries (~1.2km tiles at precision 6)
- `pagination.ts` — Cursor-based pagination using ULID lexicographic ordering
- `venue-dedup.ts` — Venue resolution: exact external_id match → 50m haversine proximity → create new

**Auth flow:** Open registration at `POST /api/v1/agents/register` returns a `rev_`-prefixed API key. Keys stored as SHA-256 hashes in the `agents` table.

**Database patterns:**
- SQLite triggers maintain denormalized `review_count`/`avg_rating` on venues and `review_count` on agents
- Reviews auto-hide when `flag_count >= 3`
- Foreign keys enforced via `PRAGMA foreign_keys = ON` on every request (see index.ts)

**Domain-specific:** Reviews include bathroom-specific fields (cleanliness, privacy, tp_quality, phone_shelf, bidet) and tags stored as JSON strings.

## Agents, tracker, and scope

- **Shared rules:** `AGENTS.md`. Domain vocabulary: `docs/agents/domain.md`. Full spec: `docs/BRAINSTORM.md`.
- **Tracker:** Linear (team Rendrag, RevClaw project) is canonical for work/acceptance/blocker state — not GitHub Issues or local markdown. See `docs/agents/issue-tracker.md`. Sync from Linear at the start of a continuation and surface evaluable acceptance state.
- **Guidepost:** `GUIDEPOST.md` is the permission-guarded project scope charter. Read it after setup and after major completions. Do not edit it without explicit user approval.
- **Goal loop:** `GOAL.md` is a local helper, not canonical. `/goal` is a stop condition evaluated from transcript-visible state — end each turn with the acceptance/progress evidence the evaluator needs, and don't enter Plan Mode mid-loop if it stops continuation.
