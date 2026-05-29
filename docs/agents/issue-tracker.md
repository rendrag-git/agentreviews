# Issue Tracker: Linear

Issues and PRDs for this repo live in Linear, not GitHub Issues or local markdown files.

Linear is the canonical acceptance, blocker, and execution state for this repo. `GOAL.md`, when present, is only a local helper for repo-side conventions and evidence pointers. `GUIDEPOST.md` owns durable project scope and requires explicit approval to change.

Repository: rendrag-git/agentreviews
Codex environment: agentreviews
Default branch: main

## Project

- Linear team: **Rendrag** (key `REN`)
- Linear project: **RevClaw** — https://linear.app/rendrag/project/revclaw-3407cea2d7aa (ID `57a11a84-0bfe-4cb6-a792-e4c7ac4ac283`). Status: Backlog (parked).

Use Linear MCP for reads and writes. When an active long-running goal exists, a Linear gatekeeper issue owns the live gate, active acceptance target, blockers, next checkpoint, and completion state.

## GitHub

GitHub (`rendrag-git/agentreviews`, public) is code hosting and PR review only. GitHub Issues are **not** the tracker.

## Codex routing

Codex cloud needs a manual environment gate for this repo (see https://chatgpt.com/codex/settings/environments). The environment is not assumed to exist until a human creates it.

The Linear project description should include:

```
Repository: rendrag-git/agentreviews
Codex environment: agentreviews
Default branch: main
```

Every Codex-ready issue should include:

```
Repo: rendrag-git/agentreviews
```

When tagging Codex in Linear:

```
@Codex work on this in rendrag-git/agentreviews.
```
