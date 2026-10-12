# Shared AI project instructions

The canonical working checkout on this machine is D:\PROJECTS\WhatsApp AI Agent (the former C:\Websites path no longer exists); GitHub `master` is
the source of truth for code. Which database and WhatsApp sessions belong to which machine, and how code is released, is in `docs/ENVIRONMENTS_AND_RELEASES.md`;
`node scripts/env-report.cjs` shows which environment a checkout is (read-only).
Before every task, read `.project-sync/PROTOCOL.md`, `.project-sync/PROJECT.md`,
and run `node scripts/project-sync.cjs check`. Read the latest referenced handoff.
Inspect `git status --short` and relevant diffs before editing. Preserve unattributed changes.
Acquire the shared writer lock before any mutation; checkpoint and finish as the protocol requires.
This applies to Codex, Claude Code, Claude Cowork and their delegated agents.
Coordination is local to this repository; no other project or Downloads reference is required.
