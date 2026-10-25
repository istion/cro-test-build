// Page inspector: static HTML measurements, optional PageSpeed. Tools measure; the model judges.
import * as cheerio from "cheerio";
import { safeFetch, robotsAllows, FetchBlocked } from "./guard";
import { scan, scanClaims, IntegrityFlag } from "./injection";
import rubric from "./rubric.json";

/**
 * Everything measured about a page. `couldNotAudit` is set (with a reason) when the page cannot be inspected,
 * and in that case no score is produced.
 */
export interface Inspection {
  couldNotAudit?: string;
  url: string; finalUrl: string; fetchedAt: string;
  facts: Record<string, any>;
  text: string;
  flags: IntegrityFlag[];
  claims: string[];
  diagnostics: Record<string, any>;
}

/** Words that make a button or link look like a call to action. Used to find CTA candidates in the markup. */
const CTA = /(add to (cart|bag|basket)|buy( now)?|checkout|book|sign ?up|get started|start|subscribe|download|install|contact|request|try|order|shop|join|apply|learn more)/i;
/** Wording of bot walls and access blocks. A short page containing it is treated as blocked, not as content. */
const BLOCK = /(captcha|are you a robot|access denied|verify you are human|unusual traffic|enable javascript)/i;

/**
 * Fetches one page and measures it. The tools measure; the model judges.
 *
 * Order: robots.txt, safe fetch, refusals (access denied, non-HTML, error status), injection scan of every attacker-controlled
 * surface, bot-wall / too-little-content / login checks, then the facts the model will be shown, then PageSpeed (optional).
 * Pages that cannot be read return `couldNotAudit` instead of guessing.
 */
export async function inspect(rawUrl: string): Promise<Inspection> {
  const fetchedAt = new Date().toISOString();
  const base = { url: rawUrl, finalUrl: rawUrl, fetchedAt, facts: {}, text: "", flags: [], claims: [], diagnostics: {} } as Inspection;
  // Helper for every "cannot audit" exit, keeping the partial inspection data.
  const stop = (why: string): Inspection => ({ ...base, couldNotAudit: why });

  let res;
  try {
    // Respect robots.txt before touching the page.
    if (!(await robotsAllows(rawUrl))) return stop("robots.txt disallows inspection of this URL");
    res = await safeFetch(rawUrl);
  } catch (e) {
    return stop(e instanceof FetchBlocked ? e.message : `The page failed to load: ${(e as Error).message.slice(0, 160)}`);
  }
  // Access controls are never bypassed.
  if (res.status === 401 || res.status === 403) return stop(`The page refused access (HTTP ${res.status}); the audit does not bypass access controls`);
  if (res.status >= 400) return stop(`The page returned HTTP ${res.status}`);
  if (!/html/i.test(res.contentType)) return stop(`The URL did not return a web page (${res.contentType || "unknown type"})`);

  // Parse the HTML once; everything below reads from this tree.
  const $ = cheerio.load(res.body);
  // Surfaces an attacker controls. Scanned here, never obeyed.
  const flags: IntegrityFlag[] = [];
  // Each entry is [where it was found, its text]. The injection scanner reads all of them.
  const surfaces: [string, string][] = [
    ["meta description", $('meta[name="description"]').attr("content") ?? ""], ["title", $("title").text()],
  ];
  // Image alt text and hidden elements are classic places to hide instructions aimed at an AI.
  $("img[alt]").each((i, el) => { if (i < 80) surfaces.push([`image alt #${i + 1}`, $(el).attr("alt") ?? ""]); });
  $('[style*="display:none"], [style*="display: none"], [hidden], [aria-hidden="true"]').each((i, el) => { if (i < 40) surfaces.push([`hidden element #${i + 1}`, $(el).text().slice(0, 400)]); });
  // HTML comments never render, so they are another hiding place.
  const comments: string[] = [];
  $("*").contents().each((_, n) => { if (n.type === "comment" && comments.length < 40) comments.push((n as any).data); });
  comments.forEach((c, i) => surfaces.push([`HTML comment #${i + 1}`, c]));

  // Remove non-visible markup so `text` approximates what a visitor reads.
  $("script, style, noscript, template, svg").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  surfaces.push(["visible text", text]);
  // Flags are collected, shown to the user and never obeyed.
  for (const [where, t] of surfaces) flags.push(...scan(t, where));

  // A bot wall with almost no content: report it rather than score the wall.
  if (BLOCK.test(text.slice(0, 1500)) && text.length < 1500) return { ...stop("The page is blocked by a CAPTCHA or access restriction"), flags };
  // Almost no static text usually means a JavaScript-rendered page, which this version cannot run.
  if (text.length < 300) return { ...stop("The page returned too little static content to inspect. It may render in the browser with JavaScript, which this version cannot run"), flags };
  // A login form with little else on the page: the real content is behind an account.
  if ($('input[type="password"]').length && text.length < 1500) return stop("The page appears to need a login");

  // Keep the raw HTML for the pattern checks below (analytics tags, A/B tools, consent banners).
  const html = res.body;
  const final = new URL(res.url);
  // Heading outline (up to 40) and the numeric levels, used to count skipped levels.
  const headings = $("h1,h2,h3,h4").map((_, e) => `${e.tagName.toUpperCase()}: ${$(e).text().trim().slice(0, 90)}`).get().slice(0, 40);
  const levels = $("h1,h2,h3,h4,h5,h6").map((_, e) => +e.tagName[1]).get();
  // Links and buttons whose label looks like an action, in page order.
  const ctas = $("a[href], button, input[type=submit], [role=button]").map((i, e) => {
    const t = ($(e).text() || $(e).attr("value") || $(e).attr("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return { text: t, tag: e.tagName, order: i };
  }).get().filter((c) => c.text && CTA.test(c.text));
  // Total number of clickable actions, used to express where the first CTA sits as a share of the page.
  const total = $("a[href], button").length;
  // Per form: field counts, required fields, types, autocomplete and label coverage, and pre-ticked boxes (a dark-pattern signal).
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
  // Structured data (JSON-LD) types, for example Product or Organization.
  const jsonld: any[] = [];
  $('script[type="application/ld+json"]').each((_, e) => { try { jsonld.push(JSON.parse($(e).html() ?? "")); } catch { /* ignore malformed */ } });
  const types = JSON.stringify(jsonld).match(/"@type":"([A-Za-z]+)"/g)?.map((s) => s.slice(9, -1)) ?? [];
  // Distinct third-party hosts the page loads scripts, styles or frames from (a speed and privacy signal).
  const hosts = new Set<string>();
  $("script[src], link[rel=stylesheet][href], iframe[src]").each((_, e) => { try { const h = new URL($(e).attr("src") ?? $(e).attr("href") ?? "", res.url).host; if (h !== final.host) hosts.add(h); } catch { /* skip */ } });
  // Case-insensitive keyword test over the visible text.
  const has = (rx: RegExp) => rx.test(text);

  // The facts JSON shown to the model and used by the rules-only fallback. Quotes in the ledger are checked against it.
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
    // Presence of common trust and offer cues. They are keyword hits in the text, not proof of quality.
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
  // Fill in the result object; finalUrl is where redirects ended.
  Object.assign(base, { finalUrl: res.url, facts, text, flags, claims: scanClaims(text) });

  // Core Web Vitals come from PageSpeed Insights when a key is configured; otherwise `could_not_test` is recorded.
  base.diagnostics = await pageSpeed(res.url);
  return base;
}

/**
 * Core Web Vitals from PageSpeed Insights (Lighthouse, mobile, lab data) plus field INP when available.
 * Each metric is placed in the good / needs improvement / poor band using the rubric thresholds.
 * Returns `{ could_not_test: reason }` if there is no key or the call fails or takes over 20 seconds.
 */
async function pageSpeed(url: string) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) return { could_not_test: "No PAGESPEED_API_KEY configured, so Core Web Vitals were not measured" };
  try {
    const r = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance&url=${encodeURIComponent(url)}&key=${key}`, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return { could_not_test: `PageSpeed Insights returned HTTP ${r.status}` };
    const d = await r.json(); const a = d.lighthouseResult?.audits ?? {}; const t = rubric.thresholds;
    const lcp = a["largest-contentful-paint"]?.numericValue / 1000, cls = a["cumulative-layout-shift"]?.numericValue;
    // good at or below the first threshold, poor above the second, otherwise needs improvement.
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

/**
 * Scores pillar 7 from tool output only: any poor metric gives 0, all good gives 100, anything else 50.
 * No model judgement is involved. Without data the pillar is `could_not_test` and lowers confidence.
 */
export function speedPillar(d: Record<string, any>): { status: "scored" | "could_not_test"; score?: number } {
  if (d.could_not_test) return { status: "could_not_test" };
  const bands = [d.LCP_band, d.CLS_band, d.field_INP_band].filter(Boolean);
  if (bands.some((b) => b === "poor")) return { status: "scored", score: 0 };
  if (bands.every((b) => b === "good")) return { status: "scored", score: 100 };
  return { status: "scored", score: 50 };
}
