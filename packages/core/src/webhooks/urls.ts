// Where a webhook may be sent (plan Section 5.13, safety). Checked when a subscription is saved
// and again before every delivery, so a rule added later also covers existing subscriptions.
//
// Hostnames are not resolved: a Worker cannot look up DNS, and Cloudflare's fetch does not reach
// private networks. These checks refuse what can be refused from the URL itself.

export type WebhookUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const INTERNAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.localdomain'];

/** IPv4 ranges that are private, loopback, link-local, shared, documentation, or reserved. */
const IPV4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return IPV4_BLOCKED.some(([base, bits]) => {
    const b = ipv4ToInt(base)!;
    const size = 2 ** (32 - bits);
    return Math.floor(n / size) === Math.floor(b / size);
  });
}

/** Expands an IPv6 literal (without brackets) to eight 16-bit groups, or null. */
function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase();
  // A trailing dotted IPv4 (the WHATWG parser rewrites these, but be safe).
  const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]!);
    if (n === null) return null;
    text = `${text.slice(0, -v4[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === '' ? [] : s.split(':'));
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(Number.parseInt(g, 16));
  }
  return out;
}

export function isBlockedIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return true; // Unparseable literal: refuse.
  const [a, b] = [g[0]!, g[1]!];
  const allZero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return true; // ::
  if (allZero(0, 7) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): check the embedded address.
  if (allZero(0, 5) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = `${g[6]! >> 8}.${g[6]! & 0xff}.${g[7]! >> 8}.${g[7]! & 0xff}`;
    return g[5] === 0 ? true : isBlockedIpv4(v4);
  }
  if (a === 0x64 && b === 0xff9b) return true; // NAT64
  if (a === 0x0100 && allZero(1, 4)) return true; // discard prefix 100::/64
  if (a === 0x2001 && b < 0x0200) return true; // 2001::/23, IETF protocol assignments
  if (a === 0x2001 && b === 0x0db8) return true; // documentation
  if (a === 0x2002) return true; // 6to4
  if ((a & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((a & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((a & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((a & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export function checkWebhookUrl(value: string): WebhookUrlCheck {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, reason: 'Enter a full URL, starting with https://.' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'Webhooks are sent over HTTPS only.' };
  if (url.username || url.password) {
    return { ok: false, reason: 'Put credentials in the URL path, not before the host name.' };
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[')) {
    if (isBlockedIpv6(host.slice(1, -1))) {
      return { ok: false, reason: 'That address is private or reserved.' };
    }
    return { ok: true, url };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isBlockedIpv4(host)) return { ok: false, reason: 'That address is private or reserved.' };
    return { ok: true, url };
  }
  if (
    host === 'localhost' ||
    INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    !host.includes('.')
  ) {
    return { ok: false, reason: 'That host name is internal; use a public address.' };
  }
  return { ok: true, url };
}
