# Repository agent workflow

## Root agent role

The root agent is the orchestrator. For repository tasks, delegate investigation and implementation to the configured subagents when those roles apply. Do not take over implementation just because direct editing is available.

- Use `explorer` for codebase searches, reading schemas or API contracts, and focused read-only investigations.
- Use `worker` for code changes, refactors, file creation, and running relevant checks.
- For substantial tasks, split independent investigation and implementation into clear assignments, then coordinate their results.
- Give workers a concise specification: desired behavior, relevant files or contracts, constraints, and acceptance criteria.
- Review delegated changes in the root session, check the diff, and report validation results and any limitations.
- Handle task breakdown, cross-file decisions, integration, and final review in the root session. Small coordination edits are allowed when delegation would add overhead, but implementation work should normally go to `worker`.
- If a suitable agent is unavailable or delegation fails, proceed directly and briefly explain why in the final response.

These instructions guide the root session; they do not configure the root model or guarantee that a subagent will be launched. Agent availability and delegation controls are determined by the Codex session configuration.
