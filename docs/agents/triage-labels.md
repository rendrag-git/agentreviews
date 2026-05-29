# Triage Labels

This repo uses the default five-role triage vocabulary. Labels live in Linear (team Rendrag, RevClaw project).

| Label | Meaning |
|-------|---------|
| `needs-triage` | New, unreviewed. Default state for incoming issues. |
| `needs-info` | Blocked on missing information from the reporter or user. |
| `ready-for-agent` | Scoped well enough for an agent (Codex/Claude) to execute autonomously. |
| `ready-for-human` | Needs a human decision, review, or action before it can proceed. |
| `wontfix` | Acknowledged but intentionally not being addressed. |

## Conventions

- Every new issue starts at `needs-triage`.
- Move to `ready-for-agent` only when the issue has enough detail to act on without further clarification, and include the Codex routing line `Repo: rendrag-git/agentreviews`.
- `needs-info` and `ready-for-human` are terminal until the blocking condition clears.
- Use Linear MCP to apply and read labels.
