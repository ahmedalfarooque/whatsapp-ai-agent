import net from 'node:net';

/**
 * Where an AI provider endpoint (and therefore its API key) may be sent. The dashboard lets an administrator type an address; this is the one place that decides
 * whether that address is acceptable, so a key can never be posted in clear text over the internet, to a cloud-metadata address or to a service on the internal
 * network (server-side request forgery).
 *
 * Rules: a remote provider must be HTTPS and must not be a private, link-local or internal-looking host. Plain HTTP (or HTTPS) to THIS machine's loopback
 * address is accepted only when the deployment allows local providers (env.allowLocalHttpProviders: on in development, off in production unless set).
 * Redirects are never followed by provider requests (they use `redirect: 'error'`), so an accepted address cannot bounce the key elsewhere.
 *
 * Limit, stated plainly: a HOSTNAME is judged by its name only. A name that an attacker's DNS points at an internal address is not detected here; block that at the
 * network (egress rules of the host / container), which code cannot do reliably.
 */
export type HostClass = 'loopback' | 'private' | 'link_local' | 'public';
export type EndpointRefusal = 'invalid_url' | 'credentials_in_url' | 'unsupported_scheme' | 'insecure_http' | 'private_address' | 'local_providers_disabled';

function classifyV4(host: string): HostClass {
  const [a, b] = host.split('.').map(Number) as [number, number];
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link_local';
  if (a === 0 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224) return 'private';
  return 'public';
}

function classifyV6(host: string): HostClass {
  if (host === '::1') return 'loopback';
  if (host === '::') return 'private';
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host); // an IPv4 address wearing an IPv6 coat: judge the IPv4 address
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return classifyV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (/^fe[89ab]/.test(host)) return 'link_local';
  if (/^f[cd]/.test(host)) return 'private';
  return 'public';
}

/** The class of a URL hostname (already normalised by the URL parser: numeric / hex / octal IPv4 spellings arrive dotted). */
export function classifyHost(hostname: string): HostClass {
  let host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  const family = net.isIP(host);
  if (family === 4) return classifyV4(host);
  if (family === 6) return classifyV6(host);
  // A single-label name ("intranet", "db") or a conventional internal suffix is not a public provider.
  if (!host.includes('.') || /\.(local|internal|lan|home|corp|intranet|localdomain|home\.arpa)$/.test(host)) return 'private';
  return 'public';
}

/** null = the endpoint may be used; otherwise why not. `allowLocal` is env.allowLocalHttpProviders (passed in so tests and callers decide explicitly). */
export function checkProviderEndpoint(baseUrl: string, allowLocal: boolean): EndpointRefusal | null {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return 'invalid_url'; }
  if (url.username || url.password) return 'credentials_in_url';
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'unsupported_scheme';
  const cls = classifyHost(url.hostname);
  if (cls === 'loopback') return allowLocal ? null : 'local_providers_disabled';
  if (cls === 'private' || cls === 'link_local') return 'private_address';
  return url.protocol === 'https:' ? null : 'insecure_http';
}

/** Why an address was refused, in words an administrator can act on (the dashboard shows it instead of a bare "Check baseUrl"). */
const REFUSAL_TEXT: Record<EndpointRefusal, string> = {
  invalid_url: 'The address is not a valid URL. Use a full address such as https://api.example.com/v1.',
  credentials_in_url: 'Do not put a user name or password in the address; the key is entered separately.',
  unsupported_scheme: 'Only https:// addresses are allowed (http:// only for 127.0.0.1 on this server).',
  insecure_http: 'A remote provider must use https://; plain http:// would send the key unencrypted.',
  private_address: 'Private, internal and link-local addresses are not allowed for a provider.',
  local_providers_disabled: 'This address is on this server (127.0.0.1) and local providers are switched off here. The server administrator must set AI_ALLOW_LOCAL_HTTP_PROVIDERS=true in the server configuration (loopback addresses only).',
};
export const describeEndpointRefusal = (code: EndpointRefusal): string => REFUSAL_TEXT[code];

/**
 * The one spelling of a provider address used for saving, listing models, testing and inference: surrounding spaces and trailing slashes removed, nothing else
 * changed (the host the administrator typed, `localhost` included, is kept; the model list and the request add their own path).
 */
export function normalizeProviderBaseUrl(raw: string): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

/** True only for the loopback gateway address (127.0.0.1 / localhost / ::1) — used where a request must NEVER leave this machine. */
export function isLoopbackUrl(value: string): boolean {
  try { return classifyHost(new URL(value).hostname) === 'loopback'; } catch { return false; }
}
