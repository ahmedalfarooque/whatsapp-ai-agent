import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger';

/**
 * OmniRoute (npm "omniroute") is a local AI gateway: an OpenAI-compatible API at http://localhost:20128/v1 (Bearer client key), a health endpoint at
 * /api/monitoring/health and a free-only combo, `auto/best-free`. These helpers only DISCOVER it — whether it is running on this machine and, on a Windows
 * PC that has it installed, the client key it keeps DPAPI-protected for the current user. The key is returned to the caller (which encrypts it into the
 * provider store) and is never logged. Nothing here is reached with a user-supplied address: the gateway is looked for on loopback only.
 */
export const OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1';
export const OMNIROUTE_FREE_MODEL = 'auto/best-free';

const originOf = (baseUrl: string): string => new URL(baseUrl).origin;

/** True when a healthy OmniRoute answers on the loopback address (its own health endpoint, no key needed). */
export async function omniRouteReachable(baseUrl: string = OMNIROUTE_BASE_URL, timeoutMs = 2500): Promise<boolean> {
  try {
    const response = await fetch(`${originOf(baseUrl)}/api/monitoring/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
    return body?.status === 'healthy';
  } catch {
    return false;
  }
}

/**
 * Whether a credential of unknown shape is an OmniRoute client key: the gateway is reachable on loopback AND it accepts the key on its authenticated model
 * list. A key that cannot be recognised by its prefix (OmniRoute keys are plain `sk-…`) is never guessed to belong to it without this proof.
 */
export async function isOmniRouteKey(key: string, baseUrl: string = OMNIROUTE_BASE_URL): Promise<boolean> {
  if (!(await omniRouteReachable(baseUrl))) return false;
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    return response.ok;
  } catch {
    return false;
  }
}

const DPAPI_READER = "$p = Join-Path $env:USERPROFILE '.omniroute\\client-api-key.dpapi'; if (-not (Test-Path -LiteralPath $p)) { exit 3 }; $s = ConvertTo-SecureString ((Get-Content -LiteralPath $p -Raw).Trim()); [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))";

/** The OmniRoute client key already configured on THIS machine: OMNIROUTE_API_KEY, else (Windows) the DPAPI-protected key file of the current user. Null when there is none. */
export async function discoverLocalOmniRouteKey(): Promise<string | null> {
  const fromEnv = (process.env.OMNIROUTE_API_KEY ?? '').trim();
  if (fromEnv) return fromEnv;
  if (process.platform !== 'win32') return null;
  if (!fs.existsSync(path.join(os.homedir(), '.omniroute', 'client-api-key.dpapi'))) return null;
  return new Promise((resolve) => {
    // A fixed script, no user input: it reads one file of the current user and prints the decrypted key to this process only.
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_READER], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      const key = String(stdout ?? '').trim();
      if (error || !key) { logger.warn({ reason: error ? 'unreadable' : 'empty' }, 'OmniRoute: the local client key could not be read'); resolve(null); return; }
      resolve(key);
    });
  });
}
