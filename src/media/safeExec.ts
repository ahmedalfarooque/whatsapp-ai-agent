import { execFile } from 'node:child_process';

/**
 * How the media tools (FFmpeg, pdftoppm) are started for a customer's file. They parse UNTRUSTED input, so a bug in them must not hand an attacker this
 * application's secrets or a shell:
 *  - no shell: the binary is run directly with an argument ARRAY (nothing the customer wrote is ever part of a command line);
 *  - a MINIMAL environment: only what the tool needs to start. The API keys, the dashboard master key, the database path and every other variable of this
 *    process are NOT passed on, so even a compromised tool cannot read them from its environment;
 *  - the working directory is the private temporary directory of the job (never the application directory);
 *  - a hard timeout that kills the process (SIGKILL), an output buffer cap and an optional AbortSignal so a cancelled message stops the work.
 * What code cannot provide is OS-level isolation (no network, no access to the rest of the disk): run the service as an unprivileged user, or in a container with
 * no outbound network and a read-only application directory, and keep the secrets readable only by the application user. See docs/MEDIA_SECURITY.md.
 */
export interface RunToolContext { cwd?: string; signal?: AbortSignal }
export type RunTool = (bin: string, args: string[], timeoutMs: number, context?: RunToolContext) => Promise<{ ok: boolean }>;

const KEEP_POSIX = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'LD_LIBRARY_PATH', 'HOME', 'XDG_CACHE_HOME', 'FONTCONFIG_PATH'];
const KEEP_WINDOWS = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'COMSPEC'];

/** The only variables a media tool receives (exported so tests can assert that no secret is among them). */
export function minimalToolEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = process.platform === 'win32' ? KEEP_WINDOWS : KEEP_POSIX;
  const out: NodeJS.ProcessEnv = {};
  for (const name of keep) if (source[name] !== undefined) out[name] = source[name];
  return out;
}

export const runTool: RunTool = (bin, args, timeoutMs, context) => new Promise((resolve) => {
  execFile(bin, args, { timeout: timeoutMs, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1 << 20, env: minimalToolEnv(), cwd: context?.cwd, signal: context?.signal, shell: false }, (error) => resolve({ ok: !error }));
});
