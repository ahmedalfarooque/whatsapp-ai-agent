# One Project, Multiple AI Apps

All apps use the SAME live checkout. A copied/uploaded/cloud snapshot cannot participate
in its lock. Cowork without live folder plus shell access must remain read-only.

## Before work
1. Read PROJECT.md, run `node scripts/project-sync.cjs check`, then inspect Git status/diff.
2. Read the `lastHandoff` file named in state.json and any relevant older handoffs.
3. Treat pre-existing and unattributed changes as unknown-owned. Do not overwrite, reset,
   clean, automatically commit, or claim authorship of them.
4. Before any write (including shell, Git, migrations, generated files, or delegated edits), run:
   `node scripts/project-sync.cjs start Codex "Describe task" unique-session-id`
   Substitute Claude-Code or Claude-Cowork as appropriate. Claude Code uses the hook session ID.
5. If another writer holds the lock, inspect/read only and wait for handoff. A session may
   coordinate its subagents, but must avoid overlapping edits. Never create an independent lock copy.

## During and after work
Before each edit batch run `node scripts/project-sync.cjs guard unique-session-id` and check
for changes outside your intended scope. Re-read changed files before editing.
Create `.project-sync/report.json` with four nonempty text fields:
`summary`, `reason`, `tests`, `nextSteps`. Include completed/pending work, design decisions,
affected behavior, commands and actual results, limitations and recovery details.
Do not put credentials, personal data, raw prompts, logs or source contents in reports.

After each milestone run:
`node scripts/project-sync.cjs checkpoint unique-session-id .project-sync/report.json`
Before ending run:
`node scripts/project-sync.cjs finish unique-session-id .project-sync/report.json`

Finish publishes a unique handoff, atomically replaces state.json, then releases the lock.
If it fails, retain the lock and retry; don't announce a clean handoff. Checkpoints retain it.
Record verification honestly: unrun, failed, mocked and live checks are different.

## Interrupted sessions
Read writer.json and the last checkpoint. Resume using the original session ID only after
confirming that session is yours or its owner has stopped and explicitly handed it over.
Complete its recovery handoff using that session ID, finish, then start a new session.
Never delete or steal a lock based on age. The helper is cooperative, not an OS security boundary.
An unreadable/empty lock after a crash requires inspection and confirmed owner termination
before manual recovery; preserve it as evidence. No automatic timeout takeover exists.

## Integration status
Codex: AGENTS.md installed; instructions exercised in this setup session.
Claude Code: project hooks installed and locally simulated; fresh app session not verified.
Cowork: folder instruction text is in COWORK.md; native folder binding not yet verified.
Do not report all apps activated until each has loaded instructions against this live checkout.

Shared records contain paths/hashes and agent-written summaries, not private conversations.
Fingerprints exclude ignored files, secrets, runtime data and generated output. Sensitive
material must live in ignored files; free-text summaries still require human/agent care.
