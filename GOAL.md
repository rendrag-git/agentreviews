# Goal

Linear is the canonical execution tracker for this repo once configured. `GOAL.md` is a local helper for repo-side goal-loop conventions, routing pointers, and evidence locations. It is not the project scope charter and not a duplicate Linear work queue.

Use `GUIDEPOST.md` for the project north star, durable scope boundaries, non-goals, non-negotiables, and locked user decisions.

## Routing

- Repository: rendrag-git/agentreviews (public)
- Codex environment: agentreviews — manual gate at https://chatgpt.com/codex/settings/environments (not assumed to exist until a human creates it)
- Default branch: main
- Linear team: Rendrag (key `REN`)
- Linear project: **RevClaw** — https://linear.app/rendrag/project/revclaw-3407cea2d7aa (ID `57a11a84-0bfe-4cb6-a792-e4c7ac4ac283`). Status: Backlog (parked).
- Gatekeeper / root issue / PRD: none yet.
- Out of scope here: the OpenClaw RevClaw skill (rendrag-git/revclaw-skill) — tracked separately.

## Canonical surfaces

- Work state, acceptance, blockers, discussion → **Linear** (team Rendrag, RevClaw project).
- Durable scope → `GUIDEPOST.md`.
- Tracker routing + labels → `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`.
- Domain vocabulary → `docs/agents/domain.md`. Full spec → `docs/BRAINSTORM.md`.
- Commit history, chat, GitHub, and local markdown are **not** canonical.

## Evidence locations

- API typecheck: `cd api && npx tsc --noEmit`.
- API local run: `cd api && npm run dev` (wrangler).
- D1 migrations: `cd api && npx wrangler d1 migrations apply revclaw [--local]`.
- Live API: https://revclaw-api.aws-cce.workers.dev — public site: https://agentreviews.io (Pages backing URL: revclaw-web.pages.dev)
- No test framework configured; verify by running the worker and exercising endpoints.

## Conventions

- Re-read the Linear gatekeeper issue (when one exists), this file, and `GUIDEPOST.md` at the start of each continuation.
- Linear wins over `GOAL.md` on disagreement; `GUIDEPOST.md` wins on durable scope unless the user approves a change.
- Verify before marking acceptance complete. Two failed fix attempts → stop and record a blocker in Linear.
- Keep any `/goal` command stable and free of issue/PR/ticket identifiers; put mutable IDs in Linear or this file.

## Setup acceptance (bootstrap)

- [x] Public GitHub remote at rendrag-git/agentreviews.
- [x] AGENTS.md, CLAUDE.md, GUIDEPOST.md, GOAL.md, and docs/agents/* present.
- [x] Codex manual environment gate recorded (creation pending human action).
- [x] Linear RevClaw project created and linked here, in `docs/agents/issue-tracker.md`, and in `GUIDEPOST.md`.
