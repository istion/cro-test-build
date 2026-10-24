// Page inspector: static HTML measurements, Shopify public data, optional PageSpeed. Tools measure; the model judges.
import * as cheerio from "cheerio";
import { safeFetch, robotsAllows, FetchBlocked } from "./guard";
import { scan, scanClaims, IntegrityFlag } from "./injection";
import rubric from "./rubric.json";

export interface Inspection {
  couldNotAudit?: string;
  url: string; finalUrl: string; fetchedAt: string;
  facts: Record<string, any>;
  text: string;
  flags: IntegrityFlag[];
  claims: string[];
  shopify: boolean;
  diagnostics: Record<string, any>;
}

const CTA = /(add to (cart|bag|basket)|buy( now)?|checkout|book|sign ?up|get started|start|subscribe|download|install|contact|request|try|order|shop|join|apply|learn more)/i;
const BLOCK = /(captcha|are you a robot|access denied|verify you are human|unusual traffic|enable javascript)/i;

export async function inspect(rawUrl: string): Promise<Inspection> {
  const fetchedAt = new Date().toISOString();
  const base = { url: rawUrl, finalUrl: rawUrl, fetchedAt, facts: {}, text: "", flags: [], claims: [], shopify: false, diagnostics: {} } as Inspection;
  const stop = (why: string): Inspection => ({ ...base, couldNotAudit: why });

  let res;
  try {
    if (!(await robotsAllows(rawUrl))) return stop("robots.txt disallows inspection of this URL");
    res = await safeFetch(rawUrl);
  } catch (e) {
    return stop(e instanceof FetchBlocked ? e.message : `The page failed to load: ${(e as Error).message.slice(0, 160)}`);
  }
  if (res.status === 401 || res.status === 403) return stop(`The page refused access (HTTP ${res.status}); the audit does not bypass access controls`);
  if (res.status >= 400) return stop(`The page returned HTTP ${res.status}`);
  if (!/html/i.test(res.contentType)) return stop(`The URL did not return a web page (${res.contentType || "unknown type"})`);

  const $ = cheerio.load(res.body);
  // Surfaces an attacker controls. Scanned here, never obeyed.
  const flags: IntegrityFlag[] = [];
  const surfaces: [string, string][] = [
    ["meta description", $('meta[name="description"]').attr("content") ?? ""], ["title", $("title").text()],
  ];
  $("img[alt]").each((i, el) => { if (i < 80) surfaces.push([`image alt #${i + 1}`, $(el).attr("alt") ?? ""]); });
  $('[style*="display:none"], [style*="display: none"], [hidden], [aria-hidden="true"]').each((i, el) => { if (i < 40) surfaces.push([`hidden element #${i + 1}`, $(el).text().slice(0, 400)]); });
  const comments: string[] = [];
  $("*").contents().each((_, n) => { if (n.type === "comment" && comments.length < 40) comments.push((n as any).data); });
  comments.forEach((c, i) => surfaces.push([`HTML comment #${i + 1}`, c]));

  $("script, style, noscript, template, svg").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  surfaces.push(["visible text", text]);
  for (const [where, t] of surfaces) flags.push(...scan(t, where));

  if (BLOCK.test(text.slice(0, 1500)) && text.length < 1500) return { ...stop("The page is blocked by a CAPTCHA or access restriction"), flags };
  if (text.length < 300) return { ...stop("The page returned too little static content to inspect. It may render in the browser with JavaScript, which this version cannot run"), flags };
  if ($('input[type="password"]').length && text.length < 1500) return stop("The page appears to need a login");

  const html = res.body;
  const final = new URL(res.url);
  const shopify = /cdn\.shopify\.com|Shopify\.theme|myshopify\.com/i.test(html);
  const headings = $("h1,h2,h3,h4").map((_, e) => `${e.tagName.toUpperCase()}: ${$(e).text().trim().slice(0, 90)}`).get().slice(0, 40);
  const levels = $("h1,h2,h3,h4,h5,h6").map((_, e) => +e.tagName[1]).get();
  const ctas = $("a[href], button, input[type=submit], [role=button]").map((i, e) => {
    const t = ($(e).text() || $(e).attr("value") || $(e).attr("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return { text: t, tag: e.tagName, order: i };
  }).get().filter((c) => c.text && CTA.test(c.text));
  const total = $("a[href], button").length;
  const forms = $("form").map((_, f) => {
    const fields = $(f).find("input, select, textarea").filter((_, i) => !["hidden", "submit", "button"].includes($(i).attr("type") ?? ""));
    return {
      fields: fields.length, required: fields.filter((_, i) => $(i).is("[required]")).length,
      types: [...new Set(fields.map((_, i) => $(i).attr("type") || i.tagName).get())],
      with_autocomplete: fields.filter((_, i) => !!$(i).attr("autocomplete") && $(i).attr("autocomplete") !== "off").length,
      unlabelled: fields.filter((_, i) => { const id = $(i).attr("id"); return !$(i).attr("aria-label") && !$(i).attr("placeholder") && !(id && $(`label[for="${id}"]`).length) && !$(i).closest("label").length; }).length,
      prechecked_boxes: fields.filter((_, i) => $(i).attr("type") === "checkbox" && $(i).is("[checked]")).length,
    };
  }).get().slice(0, 8);
  const imgs = $("img");
  const jsonld: any[] = [];
  $('script[type="application/ld+json"]').each((_, e) => { try { jsonld.push(JSON.parse($(e).html() ?? "")); } catch { /* ignore malformed */ } });
  const types = JSON.stringify(jsonld).match(/"@type":"([A-Za-z]+)"/g)?.map((s) => s.slice(9, -1)) ?? [];
  const hosts = new Set<string>();
  $("script[src], link[rel=stylesheet][href], iframe[src]").each((_, e) => { try { const h = new URL($(e).attr("src") ?? $(e).attr("href") ?? "", res.url).host; if (h !== final.host) hosts.add(h); } catch { /* skip */ } });
  const has = (rx: RegExp) => rx.test(text);

  const facts: Record<string, any> = {
    title: $("title").text().trim(), meta_description: $('meta[name="description"]').attr("content") ?? null,
    canonical: $('link[rel="canonical"]').attr("href") ?? null, lang: $("html").attr("lang") ?? null,
    viewport_meta: !!$('meta[name="viewport"]').length, https: final.protocol === "https:",
    h1: $("h1").map((_, e) => $(e).text().trim()).get().slice(0, 5), headings,
    heading_order_skips: levels.filter((l, i) => i > 0 && l - levels[i - 1] > 1).length,
    first_800_chars_of_text: text.slice(0, 800),
    action_count: total, cta_candidates: ctas.slice(0, 8),
    first_cta_position_pct_of_page: ctas.length ? Math.round((ctas[0].order / Math.max(1, total)) * 100) : null,
    forms, images: { total: imgs.length, missing_alt: imgs.filter((_, e) => $(e).attr("alt") === undefined).length },
    structured_data_types: [...new Set(types)].slice(0, 12),
    cues: {
      price: has(/[$€£₹]\s?\d|\b(INR|USD|CAD|Rs\.?)\s?\d/i), reviews: has(/\b(reviews?|rated|testimonials?)\b/i),
      returns: has(/\b(returns?|refunds?|money[- ]back|guarantee)\b/i), shipping: has(/\b(shipping|delivery|dispatch)\b/i),
      contact: has(/\b(contact|support)\b/i) || !!$('a[href^="mailto:"], a[href^="tel:"]').length,
      secure: has(/\b(secure|ssl|encrypted)\b/i), subscription: has(/\b(subscribe|subscription|recurring|per month|\/mo)\b/i),
      stock: has(/\b(in stock|out of stock|sold out|only \d+ left)\b/i),
    },
    tags: { ga4_or_gtm: /googletagmanager\.com|gtag\(/.test(html), meta_pixel: /fbevents\.js|fbq\(/.test(html) },
    third_party_hosts: hosts.size, html_bytes: res.bytes, truncated: res.truncated,
    redirected: res.redirects.length ? res.redirects : null,
    ab_variant_signs: /optimizely|vwo_|abtasty|google_optimize/i.test(html),
    consent_banner_in_markup: /cookie[-_ ]?(banner|consent)|onetrust|cookiebot|usercentrics/i.test(html),
    not_measured_in_this_version: ["tap target size", "text contrast", "viewport screenshots", "above-the-fold position in pixels", "rendered (JavaScript) content"],
  };
  Object.assign(base, { finalUrl: res.url, facts, text, flags, claims: scanClaims(text), shopify });

  if (shopify) base.facts.shopify = await shopifyFacts(final);
  base.diagnostics = await pageSpeed(res.url);
  return base;
}

/** Public Shopify product JSON (no login, no admin API). Only fields the store itself publishes. */
async function shopifyFacts(u: URL) {
  const m = u.pathname.match(/\/products\/([^/?#]+)/);
  if (!m) return { detected: true, note: "Shopify store detected. Product-level data is read only on /products/<handle> pages." };
  try {
    const r = await safeFetch(`${u.origin}/products/${m[1]}.json`, { maxBytes: 500_000, accept: "application/json" });
    if (r.status !== 200) return { detected: true, note: `Product JSON not available (HTTP ${r.status})` };
    const p = JSON.parse(r.body).product;
    const v = p.variants ?? [];
    const prices = v.map((x: any) => parseFloat(x.price)).filter(Number.isFinite);
    return {
      detected: true, source: `${u.origin}/products/${m[1]}.json`, title: p.title, variants: v.length,
      price_min: prices.length ? Math.min(...prices) : null, price_max: prices.length ? Math.max(...prices) : null,
      compare_at_price_shown: v.some((x: any) => x.compare_at_price && parseFloat(x.compare_at_price) > parseFloat(x.price)),
      any_variant_available: v.some((x: any) => x.available), all_variants_available: v.every((x: any) => x.available),
      images: (p.images ?? []).length, images_missing_alt: (p.images ?? []).filter((i: any) => !i.alt).length,
      description_chars: String(p.body_html ?? "").replace(/<[^>]+>/g, "").length,
    };
  } catch (e) { return { detected: true, note: `Product JSON could not be read: ${(e as Error).message.slice(0, 100)}` }; }
}

/** Core Web Vitals via PageSpeed Insights. Returns could_not_test when no key or the call fails. */
async function pageSpeed(url: string) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) return { could_not_test: "No PAGESPEED_API_KEY configured, so Core Web Vitals were not measured" };
  try {
    const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance&url=${encodeURIComponent(url)}&key=${key}`, { signal: AbortSignal.timeout(40_000) });
    if (!r.ok) return { could_not_test: `PageSpeed Insights returned HTTP ${r.status}` };
    const d = await r.json(); const a = d.lighthouseResult?.audits ?? {}; const t = rubric.thresholds;
    const lcp = a["largest-contentful-paint"]?.numericValue / 1000, cls = a["cumulative-layout-shift"]?.numericValue;
    const band = (v: number, g: number, p: number) => (v <= g ? "good" : v > p ? "poor" : "needs improvement");
    const fi = d.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile;
    return {
      tool: "PageSpeed Insights (Lighthouse, mobile)", data_type: "lab", fetched_at: d.analysisUTCTimestamp,
      LCP_s: +lcp.toFixed(2), LCP_band: band(lcp, t.lcp_good_s, t.lcp_poor_s),
      CLS: +cls.toFixed(3), CLS_band: band(cls, t.cls_good, t.cls_poor),
      field_INP_ms: fi ?? null, field_INP_band: fi == null ? null : band(fi, t.inp_good_ms, t.inp_poor_ms),
    };
  } catch (e) { return { could_not_test: `PageSpeed Insights failed: ${(e as Error).message.slice(0, 100)}` }; }
}

/** Pillar 7 comes from tool output only, by the rubric anchors. */
export function speedPillar(d: Record<string, any>): { status: "scored" | "could_not_test"; score?: number } {
  if (d.could_not_test) return { status: "could_not_test" };
  const bands = [d.LCP_band, d.CLS_band, d.field_INP_band].filter(Boolean);
  if (bands.some((b) => b === "poor")) return { status: "scored", score: 0 };
  if (bands.every((b) => b === "good")) return { status: "scored", score: 100 };
  return { status: "scored", score: 50 };
}
