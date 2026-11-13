import { BlockList, isIP } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ProviderContext } from './contracts.ts';

export interface PrivateEndpointGrant {
  host: string;
  ip: string;
  port: number;
  protocol: 'http:' | 'https:';
}
export interface OutboundHttpRequest {
  url: string;
  body: string;
  content_type: 'application/json' | 'application/x-www-form-urlencoded' | 'application/xml';
  authorization?: string;
  private_grant?: PrivateEndpointGrant;
}
export type HttpOutcome = { status: number; body: string } | { blocked: 'stale' | 'expired' };
export interface OutboundHttpTransport {
  post(input: OutboundHttpRequest, permit: ProviderContext['beginDispatch']): Promise<HttpOutcome>;
}
export interface ResolvedRequest {
  readonly url: URL;
  readonly ip: string;
  readonly family: 4 | 6;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | number>>;
}
export type ResolveAddresses = (host: string) => Promise<readonly string[]>;
export type SendPinned = (request: ResolvedRequest) => Promise<{ status: number; body: string }>;

// Conservative snapshot of IANA special-purpose *non-global*, unknown and terminated
// allocations; refresh against both registries when updating address policy:
// https://www.iana.org/assignments/iana-ipv4-special-registry/iana-ipv4-special-registry-1.csv
// https://www.iana.org/assignments/iana-ipv6-special-registry/iana-ipv6-special-registry-1.csv
// A union-deny intentionally blocks global exceptions inside reserved supernets (e.g.
// 192.0.0.9/32); explicit per-instance exact IP grants remain available where justified.
const forbidden4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4], // multicast/reserved outside global unicast
] as const) forbidden4.addSubnet(address, prefix, 'ipv4');
const forbidden6 = new BlockList();
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
] as const) forbidden6.addSubnet(address, prefix, 'ipv6');
export function publicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !forbidden4.check(ip, 'ipv4');
  if (family === 6) {
    // Only IANA IPv6 global unicast 2000::/3, minus its special-use allocations.
    // This also excludes IPv4-mapped, NAT64, ULA, link-local, multicast and tunnels.
    const first = Number.parseInt(ip.split(':', 1)[0]!, 16);
    return first >= 0x2000 && first < 0x4000 && !forbidden6.check(ip, 'ipv6');
  }
  return false;
}
function literalHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}
function endpoint(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 2048) throw new Error('unsafe_endpoint');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('unsafe_endpoint'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username ||
      url.password || url.hash || url.href !== raw || /[\r\n\0]/u.test(raw) ||
      /(^|\.)localhost\.?$/iu.test(url.hostname)) throw new Error('unsafe_endpoint');
  if (url.search && (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com' ||
      url.pathname !== '/robot/send' || !/^[A-Za-z0-9_%+./=&-]{1,800}$/u.test(url.search.slice(1)) ||
      [...url.searchParams.keys()].some((key) =>
        !['access_token', 'timestamp', 'sign'].includes(key)) ||
      url.searchParams.getAll('access_token').length !== 1 ||
      url.searchParams.getAll('timestamp').length > 1 ||
      url.searchParams.getAll('sign').length > 1)) throw new Error('unsafe_endpoint');
  return url;
}
function port(url: URL): number {
  return url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
}
function granted(url: URL, ip: string, grant: PrivateEndpointGrant | undefined): boolean {
  return !!grant && grant.host === literalHost(url.hostname) && grant.ip === ip &&
    grant.port === port(url) && grant.protocol === url.protocol;
}
export function validateHttpEndpoint(raw: string, grant?: PrivateEndpointGrant): URL {
  const url = endpoint(raw);
  if (grant && (typeof grant !== 'object' || isIP(grant.ip) === 0 ||
      grant.host !== literalHost(url.hostname) || grant.port !== port(url) ||
      grant.protocol !== url.protocol || Object.keys(grant).some((key) =>
        !['host', 'ip', 'port', 'protocol'].includes(key)))) throw new Error('invalid_private_grant');
  if (url.protocol === 'http:' && !grant) throw new Error('unsafe_endpoint');
  if (isIP(literalHost(url.hostname)) && !publicAddress(literalHost(url.hostname)) &&
      !granted(url, literalHost(url.hostname), grant)) throw new Error('unsafe_endpoint');
  return url;
}
async function defaultResolve(host: string): Promise<readonly string[]> {
  if (isIP(host)) return [host];
  let timer: NodeJS.Timeout | undefined;
  const lookup = Promise.allSettled([resolve4(host), resolve6(host)]);
  try {
    const answers = await Promise.race([lookup, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('dns_timeout')), 5000);
    })]);
    const ips: string[] = [];
    for (const answer of answers) {
      if (answer.status === 'fulfilled') ips.push(...answer.value);
      else if (!['ENODATA', 'ENOTFOUND'].includes((answer.reason as NodeJS.ErrnoException)?.code ?? '')) {
        throw new Error('dns_failed');
      }
    }
    return ips;
  } finally { if (timer) clearTimeout(timer); }
}
export async function planHttpConnection(input: OutboundHttpRequest,
  resolve: ResolveAddresses = defaultResolve): Promise<ResolvedRequest> {
  const url = validateHttpEndpoint(input.url, input.private_grant);
  if (typeof input.body !== 'string' || Buffer.byteLength(input.body) > 16_384 ||
      !['application/json', 'application/x-www-form-urlencoded', 'application/xml']
        .includes(input.content_type)) throw new Error('invalid_http_request');
  if (input.authorization !== undefined &&
      (typeof input.authorization !== 'string' || !/^Bearer [A-Za-z0-9._~+/-]{1,1024}$/u.test(input.authorization) ||
       url.protocol !== 'https:')) throw new Error('invalid_http_auth');
  const host = literalHost(url.hostname);
  const ips = isIP(host) ? [host] : [...await resolve(host)];
  if (!ips.length || ips.length > 32 || ips.some((ip) => !isIP(ip))) throw new Error('unsafe_endpoint');
  if (input.private_grant) {
    // Exact exception pins a single resolved address; no silent fallback to another DNS record.
    if (ips.some((ip) => !granted(url, ip, input.private_grant))) throw new Error('unsafe_endpoint');
  } else if (ips.some((ip) => !publicAddress(ip))) throw new Error('unsafe_endpoint');
  const ip = ips.find((value) => isIP(value) === 4) ?? ips[0]!;
  const headers: Record<string, string | number> = {
    'content-type': input.content_type, 'content-length': Buffer.byteLength(input.body),
  };
  if (input.authorization) headers.authorization = input.authorization;
  return { url, ip, family: isIP(ip) as 4 | 6, body: input.body, headers };
}
const defaultSend: SendPinned = (input) => new Promise((resolve, reject) => {
  let deadline: NodeJS.Timeout;
  const fail = (error: Error) => { clearTimeout(deadline); reject(error); };
  const succeed = (response: { status: number; body: string }) => {
    clearTimeout(deadline); resolve(response);
  };
  const transport = input.url.protocol === 'https:' ? httpsRequest : httpRequest;
  const req = transport({ hostname: input.url.hostname, port: port(input.url),
    path: input.url.pathname + input.url.search, method: 'POST', timeout: 15_000,
    headers: input.headers,
    // An agent pool could reuse a socket bound to an earlier resolution and bypass
    // this request's validated address. Force a fresh, pinned connection each time.
    agent: false, family: input.family,
    lookup: (_hostname, _options, callback) => callback(null, input.ip, input.family),
  }, (res) => {
    let body = ''; let bytes = 0;
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65_536) req.destroy(new Error('response_too_large'));
      else body += chunk;
    });
    res.on('aborted', () => fail(new Error('response_aborted')));
    res.on('error', fail);
    res.on('end', () => bytes > 65_536 ? fail(new Error('response_too_large')) :
      succeed({ status: res.statusCode ?? 0, body }));
  });
  deadline = setTimeout(() => req.destroy(new Error('timeout')), 15_000);
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', fail);
  req.end(input.body);
});
// Resolver and pinned connector injection is for offline tests; production uses both defaults.
export function createSafeHttpTransport(resolve: ResolveAddresses = defaultResolve,
  send: SendPinned = defaultSend): OutboundHttpTransport {
  return { async post(input, permit) {
    const planned = await planHttpConnection(input, resolve);
    const state = permit();
    if (state !== 'ready') return { blocked: state };
    // No redirect-follow: a 3xx is returned to the provider, never dereferenced.
    return send(planned);
  } };
}
export const safeHttpTransport = createSafeHttpTransport();
