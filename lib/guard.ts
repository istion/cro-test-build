// Safe fetching. This server fetches user-supplied URLs, so it must not be usable to reach internal networks.
import dns from "node:dns/promises";
import net from "node:net";

/**
 * Raised when a URL is refused or cannot be fetched safely.
 * The message is written for the end user, so the caller can show it as the "could not audit" reason.
 */
export class FetchBlocked extends Error {}

/**
 * True for IPv4 ranges that a public audit must never contact:
 * this network (0/8), private (10/8, 172.16/12, 192.168/16), loopback (127/8), link-local (169.254/16,
 * which includes cloud metadata services), carrier-grade NAT (100.64/10), and multicast/reserved (224 and up).
 */
function privateIPv4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
/**
 * True if an IPv4 or IPv6 address points at an internal network.
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are judged by their IPv4 part so they cannot be used to sneak past the check.
 */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return privateIPv4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIPv4(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

/**
 * Validates that a URL is safe to fetch and returns it parsed. Throws FetchBlocked otherwise.
 *
 * Checks, in order: http(s) only; no embedded credentials; ports 80/443 only; no localhost, .local or .internal names;
 * then resolves DNS and rejects the URL if ANY returned address is private. Resolving here (and again on every redirect)
 * is what stops a public-looking hostname from pointing at an internal server (SSRF).
 */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchBlocked("That is not a valid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new FetchBlocked("Only http and https URLs can be audited");
  if (u.username || u.password) throw new FetchBlocked("URLs with credentials are not allowed");
  if (u.port && !["80", "443"].includes(u.port)) throw new FetchBlocked("Only standard web ports are allowed");
  // Strip the brackets that URL parsing leaves around IPv6 literals.
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new FetchBlocked("Private addresses cannot be audited");
  // A literal IP is checked as is; a hostname is resolved to all of its addresses.
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => { throw new FetchBlocked("Could not resolve that host"); })).map((r) => r.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new FetchBlocked("Private addresses cannot be audited");
  return u;
}

// Identifies the agent honestly so site owners can recognise and block it in robots.txt.
const UA = "CROScoreAgent/1.0 (read-only audit)";

/**
 * Fetches a public page with network-level safety limits and returns status, final URL, redirect chain, body and size.
 *
 * Options: maxBytes (default 2 MB, body is cut and flagged `truncated`), timeoutMs (default 12 s per hop), accept header.
 * Redirects are followed by hand, up to 5 hops, and each hop is re-validated with assertPublicUrl.
 */
export async function safeFetch(raw: string, opts: { maxBytes?: number; timeoutMs?: number; accept?: string } = {}) {
  const { maxBytes = 2_000_000, timeoutMs = 12_000, accept = "text/html,application/xhtml+xml" } = opts;
  let url = (await assertPublicUrl(raw)).toString();
  const redirects: string[] = [];
  // One iteration per redirect hop; automatic redirects are disabled so no hop skips validation.
  for (let hop = 0; hop < 5; hop++) {
    // redirect: "manual" returns the 3xx response itself instead of following it.
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA, accept } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = (await assertPublicUrl(new URL(res.headers.get("location")!, url).toString())).toString();
      redirects.push(url);
      continue;
    }
    // Not a redirect: read the body as a stream so a huge page cannot exhaust memory.
    const chunks: Uint8Array[] = []; let size = 0, truncated = false;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; chunks.push(value);
      // Over the cap: keep what we have, mark it truncated and stop downloading.
      if (size > maxBytes) { truncated = true; await reader.cancel(); break; }
    }
    return { status: res.status, url, redirects, contentType: res.headers.get("content-type") ?? "", truncated,
      body: Buffer.concat(chunks).toString("utf8"), bytes: size };
  }
  throw new FetchBlocked("Too many redirects");
}

/**
 * Applies the site's robots.txt (rules for `User-agent: *` or this agent) to a page URL. True means "allowed".
 *
 * Supports `*` wildcards and a trailing `$`. When several rules match, the longest wins and Allow wins a tie, which
 * matches how major crawlers read the file. A missing, unreadable or non-200 robots.txt means no restriction.
 */
export async function robotsAllows(pageUrl: string): Promise<boolean> {
  const u = new URL(pageUrl);
  try {
    const r = await safeFetch(`${u.origin}/robots.txt`, { maxBytes: 200_000, timeoutMs: 5000, accept: "text/plain" });
    if (r.status !== 200) return true;
    // `applies` is true while we are inside a group that targets us; rules are collected only then.
    let applies = false; const rules: string[] = [], allows: string[] = [];
    // Parse line by line: drop comments after `#`, split `key: value`.
    for (const line of r.body.split(/\r?\n/)) {
      const [k, ...rest] = line.split("#")[0].split(":");
      const key = k.trim().toLowerCase(), val = rest.join(":").trim();
      if (key === "user-agent") applies = val === "*" || val.toLowerCase().includes("croscoreagent");
      else if (applies && key === "disallow" && val) rules.push(val);
      else if (applies && key === "allow" && val) allows.push(val);
    }
    // robots rules match against the path plus query string.
    const target = u.pathname + u.search;
    // Turn a robots pattern into a regex: escape regex characters, map `*` to `.*`, honour a trailing `$`.
    const toRegex = (rule: string) => {
      const anchored = rule.endsWith("$");
      const body = (anchored ? rule.slice(0, -1) : rule).split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      return new RegExp("^" + body + (anchored ? "$" : ""));
    };
    const match = (rule: string) => toRegex(rule).test(target);
    // Longest matching rule wins; Allow wins ties.
    // Length of the longest matching Disallow (d) and Allow (a) rule. Disallow only wins if it is strictly longer.
    const d = Math.max(0, ...rules.filter(match).map((r) => r.length)), a = Math.max(0, ...allows.filter(match).map((r) => r.length));
    return !(d > 0 && d > a);
  } catch { return true; }
}
