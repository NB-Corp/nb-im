import https from 'node:https';
import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';
import { publicAddress } from '../http-transport.ts';
import { abortError } from './contract.ts';

/** Pinned public CDN downloads; never forward a Slack token to a redirect destination. */
export async function downloadPlatformMedia(raw: string, input: {
  platform: 'discord' | 'slack'; token?: string; cap: number; signal: AbortSignal;
}, redirects = 0): Promise<Uint8Array> {
  if (input.signal.aborted) throw abortError();
  const url = new URL(raw);
  const host = url.hostname;
  const allowed = input.platform === 'discord' ? ['cdn.discordapp.com', 'media.discordapp.net'] :
    ['files.slack.com', 'slack.com', 'slack-files.com'];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
    !allowed.some((domain) => host === domain || host.endsWith(`.${domain}`))) throw new Error('media_url_rejected');
  const answers = await Promise.allSettled([resolve4(host), resolve6(host)]);
  const ips = answers.flatMap((a) => a.status === 'fulfilled' ? a.value : []);
  if (!ips.length || ips.some((ip) => !publicAddress(ip))) throw new Error('media_address_rejected');
  const ip = ips.find((ip) => isIP(ip) === 4) ?? ips[0]!;
  const auth = input.platform === 'slack' && input.token && (host === 'files.slack.com' || host === 'slack.com');
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: host, path: url.pathname + url.search, method: 'GET', agent: false,
      signal: input.signal, timeout: 15000, headers: auth ? { authorization: `Bearer ${input.token}` } : {},
      lookup: (_host, _opts, callback) => callback(null, ip, isIP(ip) as 4 | 6),
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects < 3) {
        res.resume();
        // Every redirect is independently allowlisted, resolved and pinned.
        downloadPlatformMedia(new URL(res.headers.location, url).href, input, redirects + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) { res.resume(); reject(new Error('media_http_failed')); return; }
      if (Number(res.headers['content-length'] ?? 0) > input.cap) { req.destroy(new Error('media_too_large')); return; }
      let size = 0; const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > input.cap) req.destroy(new Error('media_too_large')); else chunks.push(chunk); });
      res.on('aborted', () => reject(new Error('media_aborted')));
      res.on('error', reject);
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('media_timeout')));
    req.on('error', reject);
    req.end();
  });
}
