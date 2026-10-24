// Safe fetching. This server fetches user-supplied URLs, so it must not be usable to reach internal networks.
import dns from "node:dns/promises";
import net from "node:net";

export class FetchBlocked extends Error {}

function privateIPv4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return privateIPv4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return privateIPv4(v.slice(7));
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new FetchBlocked("That is not a valid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new FetchBlocked("Only http and https URLs can be audited");
  if (u.username || u.password) throw new FetchBlocked("URLs with credentials are not allowed");
  if (u.port && !["80", "443"].includes(u.port)) throw new FetchBlocked("Only standard web ports are allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new FetchBlocked("Private addresses cannot be audited");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => { throw new FetchBlocked("Could not resolve that host"); })).map((r) => r.address);
  if (!ips.length || ips.some(isPrivateIp)) throw new FetchBlocked("Private addresses cannot be audited");
  return u;
}

const UA = "CROScoreAgent/1.0 (read-only audit)";

/** Manual redirects so every hop is re-validated. Streams the body and stops at maxBytes. */
export async function safeFetch(raw: string, opts: { maxBytes?: number; timeoutMs?: number; accept?: string } = {}) {
  const { maxBytes = 2_000_000, timeoutMs = 12_000, accept = "text/html,application/xhtml+xml" } = opts;
  let url = (await assertPublicUrl(raw)).toString();
  const redirects: string[] = [];
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA, accept } });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = (await assertPublicUrl(new URL(res.headers.get("location")!, url).toString())).toString();
      redirects.push(url);
      continue;
    }
    const chunks: Uint8Array[] = []; let size = 0, truncated = false;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; chunks.push(value);
      if (size > maxBytes) { truncated = true; await reader.cancel(); break; }
    }
    return { status: res.status, url, redirects, contentType: res.headers.get("content-type") ?? "", truncated,
      body: Buffer.concat(chunks).toString("utf8"), bytes: size };
  }
  throw new FetchBlocked("Too many redirects");
}

/** Minimal robots.txt check for User-agent: * (and our own UA). Unreachable robots.txt means no restriction. */
export async function robotsAllows(pageUrl: string): Promise<boolean> {
  const u = new URL(pageUrl);
  try {
    const r = await safeFetch(`${u.origin}/robots.txt`, { maxBytes: 200_000, timeoutMs: 5000, accept: "text/plain" });
    if (r.status !== 200) return true;
    let applies = false; const rules: string[] = [], allows: string[] = [];
    for (const line of r.body.split(/\r?\n/)) {
      const [k, ...rest] = line.split("#")[0].split(":");
      const key = k.trim().toLowerCase(), val = rest.join(":").trim();
      if (key === "user-agent") applies = val === "*" || val.toLowerCase().includes("croscoreagent");
      else if (applies && key === "disallow" && val) rules.push(val);
      else if (applies && key === "allow" && val) allows.push(val);
    }
    const target = u.pathname + u.search;
    const toRegex = (rule: string) => {
      const anchored = rule.endsWith("$");
      const body = (anchored ? rule.slice(0, -1) : rule).split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      return new RegExp("^" + body + (anchored ? "$" : ""));
    };
    const match = (rule: string) => toRegex(rule).test(target);
    // Longest matching rule wins; Allow wins ties.
    const d = Math.max(0, ...rules.filter(match).map((r) => r.length)), a = Math.max(0, ...allows.filter(match).map((r) => r.length));
    return !(d > 0 && d > a);
  } catch { return true; }
}
