# Local inference on the Oracle host: measured evidence (2026-10-15)

Synthetic data only (invented business facts, Arabic and English questions with automatic checks; no customer conversation was used).
Host: Oracle Ampere A1, 2 × Neoverse-N1 cores (dot-product only: no i8mm / bf16 / SVE), 12 GB RAM (about 8.4 GB available), CPU only.
Runtime: the existing Ollama 0.40.4 (not reinstalled); the benchmark ran a **second, temporary, low-priority Ollama on port 11435** (memory
capped, stopped afterwards), so the production service, the app and port 3000 were never disturbed (health stayed 200 throughout).

## Models (9 questions each: identity, services, price, an unknown price, hours, offers, history-dependent follow-up; Arabic and English)

| model | prompt style | first token (median / max) | whole answer (median / max) | automatic checks passed |
|---|---|---|---|---|
| qwen2.5 3B q4_K_M | question-dependent knowledge | 4.4 s / 12 s | 8.6 s / 17.8 s | 8 / 9 |
| qwen2.5 3B q4_K_M | **stable per-business prefix** | **0.7 s** / 4 s | 5.7 s / 18 s | 8 / 9 |
| qwen3 1.7B (thinking off) | question-dependent | 2.5 s / 6.5 s | 5.6 s / 9.6 s | 7 / 9 |
| qwen3 1.7B (thinking off) | stable prefix | 0.7 s / 2.3 s | 5.8 s / 9.6 s | 7 / 9 |
| gemma3 4B q4_K_M | question-dependent | 14.8 s / 17.3 s | 26 s / 34 s | 5 / 9 |
| gemma3 4B q4_K_M | stable prefix | 17.1 s / 20 s | 29 s / 36 s | 4 / 9 |

* Generation speed is about 8 tokens per second for the 3B model; the cost of a larger model is paid on every request, so a bigger model is
  **not** faster. Gemma 3 4B was too slow and answered Arabic to English questions. Qwen2.5 3B wrote a garbled Arabic word in one answer;
  qwen3 1.7B answered an English question in Arabic. Neither is trustworthy for Arabic customer replies without a human-checked sample.
* A **stable per-business prefix** (identity, facts, hours, all knowledge first; the open/closed status and the customer's message last)
  makes the first token arrive in about 0.6 s once the business's prefix is cached, against 4–15 s when the prompt changes per question.
* Three businesses served in turn: after the first cold request of each (10–15 s to first token), later requests hit the cache even with one
  parallel slot (first token 0.5–0.7 s). Three requests at the same instant take about 18 s wall-clock on two cores whatever the slot count.

## Conclusion
The local route **stays off for customer replies**. The first request of each business after a restart costs 10–15 s, long answers take up
to ~15 s, concurrent customers queue, and Arabic quality is not yet reliable. A pilot that could pass the bar: a stable-prefix prompt, a
short answer limit (about 60 tokens), a warm-up request per business after start-up and knowledge edits, a human-reviewed Arabic sample
set — measured in shadow mode (the answer generated and logged, never sent) before any customer sees it.

## A stronger always-on computer
This workstation (6-core i5-10400F, 16 GB, RTX 2060 SUPER 4 GB) could answer in about a second, but it is a desktop that sleeps and is
not always on, sits behind a home connection, and would need a private tunnel to the Oracle server (for example an SSH reverse tunnel or
a private network): it adds an availability dependency to a 24/7 service. It would only ever be an *additional* provider in the order,
behind the free cloud entries, with the same failover — and it is a hosting and electricity cost, not free inference. Nothing was installed.

---

# Removal of Ollama (2026-10-15) — inventory, backup and rollback

The owner decided not to use Ollama in this application. The measurements above stay as history; the feature itself was removed.

## Inventory (verified before anything was deleted)
| where | what | owner / use |
|---|---|---|
| repository | provider kind, preset and routing branches, the built-in local route, the lean local prompt (`localPrompt.ts`), the compact-prompt path through the agent loop and router, `OLLAMA_*` settings in `src/config/env.ts` and `.env.example`, dashboard strings, tests | this application only |
| Oracle host | user service `ollama-local` (loopback 127.0.0.1:11434), `~/ollama` (2.1 GB binaries, v0.40.4), `~/.ollama` (7.2 GB: three model families pulled for the evaluation, plus Ollama's own key pair), three `OLLAMA_*` lines in the application's `.env`, evaluation scripts and outputs in the home folder and `/tmp`, user linger (enabled only for that service) | created for this application on 2026-10-14; no other project or service references port 11434 |
| this PC | nothing (no Ollama, no `OLLAMA_*` in the local `.env`) | — |
| Vercel (`whatsapp-ai-agent`) | no environment variables at all; no `vercel.json` in the repository | nothing to remove |
| Supabase | the application does not use Supabase at runtime (only unused packages in `package.json`, unrelated to Ollama) | nothing to remove |
| database | no provider row of kind `ollama` existed on production; migration 030 deletes any such row anywhere | — |

## What was removed
Application code and configuration (above); on the host: the service, its unit file, `~/ollama`, `~/.ollama`, the evaluation scripts and the three `.env` lines, and linger. Not touched: the application, its database, WhatsApp sessions, customer data, other files, other services.

## Backup and rollback
Before deleting, the host kept `~/whatsapp-backups/ollama-removal-20261015/` (the unit file, a copy of the application's `.env` as it was, and the benchmark outputs). Model weights are public and re-downloadable, so they were not backed up.
To restore the application code: `git checkout -B master 7d7cae6`, `npm run build`, restart only `whatsapp-ai-agent` (migration 030 only removes rows that no longer exist). To restore the host runtime (not recommended): download the Ollama arm64 release v0.40.4 to `~/ollama`, copy the unit file from the backup to `~/.config/systemd/user/`, `loginctl enable-linger ubuntu`, `systemctl --user enable --now ollama-local`, put the three `OLLAMA_*` lines back from the backup `.env`, and re-pull a model. The previous application code (7d7cae6) is required for the local route to exist again.
