# AGENTS.md

Shared rules for any agent (Codex, Claude Code, others) working in this repo. Claude Code layers additional specifics in `CLAUDE.md`; everything here applies to all agents.

## What is RevClaw

Agent-to-agent review network. AI agents review places — restaurants, coffee shops, bathrooms — on behalf of their humans. Public product name: **AgentReviews**. See `docs/agents/domain.md` for the domain vocabulary and `docs/BRAINSTORM.md` for the full architecture spec.

- Public site: https://agentreviews.io (Cloudflare Pages backing URL: revclaw-web.pages.dev)
- Live API: https://revclaw-api.aws-cce.workers.dev
- Repository: rendrag-git/agentreviews (public)
- Default branch: main
- Status: parked / backlog — not actively developed.

## Repo layout

Monorepo with two deployable units:

- `api/` — Cloudflare Worker (TypeScript), D1 (SQLite) storage. Entry: `src/index.ts`.
- `web/` — Static HTML site on Cloudflare Pages. No build step.

Build/test/deploy commands live in `CLAUDE.md`. No test framework or linter is configured.

## Agent skills

### Issue tracker

Issues and PRDs are tracked through Linear MCP in the **RevClaw** project (team Rendrag). See `docs/agents/issue-tracker.md`. Linear is canonical for work state, blockers, acceptance, ownership, and discussion — not GitHub Issues or local markdown.

### Triage labels

Use the default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain-doc layout. See `docs/agents/domain.md`.

## Project Guidepost

`GUIDEPOST.md` is the permission-guarded project scope charter. Read it after setup, after durable planning or grilling decisions, before major planning pivots, and after completing any major feature, vertical slice, milestone, or goal-loop acceptance item.

Do not edit `GUIDEPOST.md` without explicit user approval. If completed work implies a scope change, stop and report the proposed change instead of quietly updating the guidepost.

## Goal-Loop Conventions

- Re-read the Linear gatekeeper issue or RevClaw project, `GOAL.md`, and `GUIDEPOST.md` at the start of each continuation.
- Prefer the Linear gatekeeper issue model for active long-running goals.
- Keep `/goal` commands stable and free of Linear issue numbers, issue URLs, PR numbers, and ticket IDs. Put mutable identifiers in Linear, `GOAL.md`, or `docs/agents/issue-tracker.md`.
- Linear wins if Linear and `GOAL.md` disagree.
- `GUIDEPOST.md` wins for durable scope unless the user explicitly approves a change.
- Local progress entries are terse and evidence-based.
- Verify before marking acceptance complete. Two failed fix attempts means stop and record a blocker.
- Do not mark a goal complete until the canonical tracker and local evidence both show done.

## Codex cloud routing

Codex cloud requires a manual environment gate for this GitHub repo. The environment is **not** assumed to exist until a human creates it at https://chatgpt.com/codex/settings/environments.

Codex-ready Linear issues must include:

```
Repo: rendrag-git/agentreviews
```

When tagging Codex in Linear:

```
@Codex work on this in rendrag-git/agentreviews.
```

## Verification discipline

- Verify before claiming done: run it, read the output, confirm. For the API, `cd api && npx tsc --noEmit` plus the relevant dev/deploy command.
- No thrashing: if a fix fails twice, stop, reassess, and record a blocker in Linear.
- Don't destroy config or shared state while debugging — show the change first.
- Do not treat commit history, chat, GitHub, or local markdown as the canonical work tracker. Linear is canonical.
