# OmniRoute as the first AI route

OmniRoute (npm `omniroute`, tested with 3.8.50) is a local gateway with an OpenAI-compatible API (`http://127.0.0.1:20128/v1`, Bearer client key, health at `/api/monitoring/health`). The agent treats it as provider vendor `omniroute`, priority 5 — tried before OpenRouter (10), Gemini (100) and Groq (110), which remain automatic fallbacks (502, timeout, 429, rejected key, malformed or empty answers all fail over; a failed OmniRoute rests and is retried by itself).

## Rules
* **Never start `omniroute` from the agent's project folder.** It reads `.env` from its working directory and would take the agent's `PORT=3000`. Start it from its own folder with `PORT=20128` (Windows: `cd %USERPROFILE%\.omniroute` then `omniroute`).
* The gateway only helps when it has a **connected free provider**. `auto/best-free` is its own free-only combo; it answers 502 while none of its free providers has working credentials. Connect one in OmniRoute's own dashboard (for example a free key from llm7, Gemini, Groq, NVIDIA or Ollama Cloud) and check: `POST /v1/chat/completions` with `model: auto/best-free` must return an answer.
* Do not route paid or subscription models through the agent: only `auto/best-free` is auto-confirmed as free; any other model id needs the administrator's confirmation.
* OmniRoute's credentials and data directory never go into Git. Each environment (this PC, the server) has its own.

## Adding it to the agent (localhost or live)
Dashboard → Super Admin → Providers & Legacy API → add: name `OmniRoute`, key empty (the local OmniRoute key is read: `OMNIROUTE_API_KEY`, or on Windows `~/.omniroute/client-api-key.dpapi`) or paste the client key. Endpoint, model and priority are filled in; the key is tested with a real request and stored encrypted.

## Production server (not installed at the time of writing)
Needs Node ≥ 20 (server has 24), ~1 GB RAM. Outline, run as a dedicated user, never as the agent's user, never on port 3000/3005:
1. `sudo useradd -m -s /usr/sbin/nologin omniroute && sudo npm i -g omniroute`
2. systemd unit `omniroute.service`: `User=omniroute`, `WorkingDirectory=/home/omniroute`, `Environment=PORT=20128`, `ExecStart=$(command -v omniroute)`, `Restart=on-failure`; bind to loopback (`OMNIROUTE_SERVER_HOST=127.0.0.1` in its own `.env`); do not open the port in the firewall.
3. Connect a free provider in its dashboard through an SSH tunnel (`ssh -L 20128:127.0.0.1:20128 …`), create the client key, then add the provider on the live dashboard as above.
4. Verify a real `auto/best-free` answer from the server before relying on it.
