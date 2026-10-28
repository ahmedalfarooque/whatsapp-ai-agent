# OmniRoute as the first AI route

OmniRoute (npm `omniroute`, tested with 3.8.50) is a local gateway with an OpenAI-compatible API (`http://127.0.0.1:20128/v1`, Bearer client key, health at `/api/monitoring/health`). The agent treats it as provider vendor `omniroute`, priority 5 — tried before OpenRouter (10), Gemini (100) and Groq (110), which remain automatic fallbacks (502, timeout, 429, rejected key, malformed or empty answers all fail over; a failed OmniRoute rests and is retried by itself).

## Rules
* **Never start `omniroute` from the agent's project folder.** It reads `.env` from its working directory and would take the agent's `PORT=3000`. Start it from its own folder with `PORT=20128` (Windows: `cd %USERPROFILE%\.omniroute` then `omniroute`).
* The gateway only helps when it has a **connected free provider**. `auto/best-free` is its own free-only combo; it answers 502 while none of its free providers has working credentials. Connect one in OmniRoute's own dashboard (for example a free key from llm7, Gemini, Groq, NVIDIA or Ollama Cloud) and check: `POST /v1/chat/completions` with `model: auto/best-free` must return an answer.
* Do not route paid or subscription models through the agent: only `auto/best-free` is auto-confirmed as free; any other model id needs the administrator's confirmation.
* OmniRoute's credentials and data directory never go into Git. Each environment (this PC, the server) has its own.

## Adding it to the agent (localhost or live)
Dashboard → Super Admin → Providers & Legacy API → add: name `OmniRoute`, key empty (the local OmniRoute key is read: `OMNIROUTE_API_KEY`, or on Windows `~/.omniroute/client-api-key.dpapi`) or paste the client key. Endpoint, model and priority are filled in; the key is tested with a real request and stored encrypted.

## Production server (installed 2026-10-28: 3.8.50, `omniroute.service`, loopback only; NO upstream provider connected yet)
Needs Node ≥ 20 (server has 24), ~1 GB RAM. Outline, run as a dedicated user, never as the agent's user, never on port 3000/3005:
1. `sudo useradd -m -s /usr/sbin/nologin omniroute && sudo npm i -g omniroute`
2. systemd unit `omniroute.service`: `User=omniroute`, `WorkingDirectory=/home/omniroute`, `Environment=PORT=20128`, `ExecStart=$(command -v omniroute)`, `Restart=on-failure`; bind to loopback (`OMNIROUTE_SERVER_HOST=127.0.0.1` in its own `.env`); do not open the port in the firewall.
3. Connect a free provider in its dashboard through an SSH tunnel (`ssh -L 20128:127.0.0.1:20128 …`), create the client key, then add the provider on the live dashboard as above.
4. Verify a real `auto/best-free` answer from the server before relying on it.

**Operating notes (verified on 3.8.50):**
* The "v16.3.1" in the startup banner is Next.js, not OmniRoute. The live credential is the bcrypt hash in the gateway's settings store; `INITIAL_PASSWORD` only bootstraps one and is ignored once a hash exists.
* The login lockout is in memory only: 5 failures per client IP, then 15 minutes (through an SSH tunnel every browser is `127.0.0.1`, so a mistyped password locks the tunnel). It expires by itself; a service restart also clears it. Nothing needs resetting.
* Change the dashboard password from the dashboard, or with the same `PATCH /api/settings` `{currentPassword,newPassword}` call it uses, or (last resort, needs a restart) `omniroute reset-password`. Never edit the database by hand.
* **Set `REQUIRE_API_KEY=true` in the gateway's own `.env` before connecting any provider account.** It defaults to false ("keyless local-first"): `/v1/models` asked for a key but `/v1/chat/completions` answered anonymous and invalid-key callers like valid ones (any local process could spend the connected accounts). Production has it on since 2026-10-28 (verified: no key and an invalid key get 401, the client key passes; needs one restart of the gateway only).
* A fresh gateway has zero provider connections: its catalog is keyless built-ins (some flagged `tos: avoid` by the gateway itself) and `auto/best-free` returns 502. Connect your own free-tier account (Groq, Gemini, OpenRouter, Cerebras, …) in its dashboard; do not point the customer agent at anonymous or scraped endpoints.

## Configuration (this server or this PC)
* `OMNIROUTE_BASE_URL` (optional, loopback only; default `http://127.0.0.1:20128/v1`) and `OMNIROUTE_API_KEY` (or, on Windows, `~/.omniroute/client-api-key.dpapi`). Names only in `.env.example`; never commit a value.
* OmniRoute is used **only when chosen explicitly** under More options (a name containing "omni" or an unknown key never selects it, and an unknown key is never tried on the local port).
* **Load models from the gateway** (More options) lists the gateway's models as suggestions. A listed model is not proof it works: saving tests the chosen model with a real request, never saves one that does not answer, and records a provider that answers nothing as failed and unverified. `auto/best-free` is only a name: the route counts as free after an administrator confirms it.
* A real `auto/best-free` answer additionally needs a working free provider **inside OmniRoute** (add its credential in OmniRoute's own dashboard). On 2026-10-22 the gateway answered HTTP 502 for the whole free pool (an OpenCode key required, deprecated models); that is a missing credential inside the gateway, not an agent fault.

