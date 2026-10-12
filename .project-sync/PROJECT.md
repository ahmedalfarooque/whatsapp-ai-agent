# Current project context

Canonical root: D:\PROJECTS\WhatsApp AI Agent (the former C:\Websites\WhatsApp AI Agent no longer exists; older handoffs may still name it). GitHub `master` is the
source of truth for code. Production runs on the Oracle server with its own database and WhatsApp sessions; this machine's `data/` is a separate development
environment (see docs/ENVIRONMENTS_AND_RELEASES.md).
Backend: Node.js/TypeScript, Express, SQLite migrations and persistent conversation memory.
Integrations: Meta WhatsApp webhook/outbound messages, OpenRouter tool calling,
Google Calendar availability/booking. Markdown/JSON business knowledge. Docker/Caddy deployment.
Local mock providers and production-only credential validation were added at commit 82c293d.

At coordination setup, booking, AI, tools, retries, WhatsApp client and their tests had
uncommitted edits. New booking locks/migrations and provider/error tests were also present.
Their ownership is UNKNOWN. Preserve and inspect them; this setup does not validate authorship.

Use state.json and its referenced handoff for latest tests and pending work. FINAL_STATUS.md
contains historical claims and is not authoritative proof of today's production readiness.
Real credentials, deployment, Docker and live end-to-end verification require separate evidence.
