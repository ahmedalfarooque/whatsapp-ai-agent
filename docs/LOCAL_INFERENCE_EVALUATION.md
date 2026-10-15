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
