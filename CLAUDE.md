# Shared AI coordination

@AGENTS.md
@.project-sync/PROTOCOL.md
@.project-sync/PROJECT.md

Use your Claude session ID reported by the startup hook as the writer session ID.
Before editing, acquire the lock; before ending, write a detailed handoff and finish.
Hooks do not replace these requirements, especially for shell or MCP mutations.
