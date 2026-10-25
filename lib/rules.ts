// Rules-only fallback audit. Used when the model is busy or out of quota. It reads only tool-measured facts, so every
// ledger entry quotes the facts JSON or page text and passes the same grounding check as a model audit.
import type { Inspection } from "./inspect";

/** A pillar as the rules produce it, in the same shape the model's answer uses so the rest of runAudit treats both alike. */
type Pillar = { id: number; status: "scored" | "partial" | "needs_data"; score?: number; evidence_ids: string[]; interpretation: string };

/**
 * Builds an audit from fixed checks on the measured facts, with no language model.
 *
 * Used only when the model is busy, out of quota, slow or unreachable, so the user still gets a result. It returns the same
 * shape as a model answer: a `report` (page, pillars, findings, recommendations, limitations) and a `ledger` of evidence.
 * Every ledger quote is copied from the facts JSON (for example `"viewport_meta":false`), so it passes the same quote check.
 *
 * It cannot judge copy, offer strength or message match, so pillar 2 is needs_data, the page type is a low-confidence guess
 * from the URL, and the limitations say plainly that the result is rules-only and generic.
 */
export function rulesReport(ins: Inspection) {
  const f = ins.facts, cues = f.cues ?? {};
  // Running counters e, n, r number the evidence (E-001), findings (F-001) and recommendations (R-001).
  const ledger: any[] = [], findings: any[] = [], recs: any[] = [];
  let e = 0, n = 0, r = 0;
  // Adds one observed ledger entry and returns its id.
  const ev = (pillar: number, observation: string, quote: string, location: string) => {
    const id = `E-${String(++e).padStart(3, "0")}`;
    ledger.push({ id, pillar, observation, quote, location, evidence_type: "observed" });
    return id;
  };
  // Adds a finding together with the one recommendation that fixes it, linked by id.
  const finding = (pillar: number, severity: 1 | 2 | 3, observation: string, why: string, eids: string[], change: string, impact: "low" | "medium" | "high", effort: "small" | "medium", level: 1 | 2 | 3, metric: string) => {
    const fid = `F-${String(++n).padStart(3, "0")}`;
    findings.push({ id: fid, pillar, severity, observation, evidence_ids: eids, why_it_matters: why, uncertainty: "Rules-only check of the page markup. A person or the full audit should confirm it." });
    recs.push({ id: `R-${String(++r).padStart(3, "0")}`, finding_ids: [fid], change, impact, impact_reason: why, effort, brand_risk: level === 3 ? "medium" : "low", approval_level: level, metric, guardrail_metric: "Conversion rate and bounce rate on this page" });
  };
  // Builds the exact JSON text of a boolean cue, which is what the quote check will search for.
  const bool = (k: string, v: boolean) => `"${k}":${v}`;

  // Pillar 1: value proposition
  const h1 = (f.h1 ?? [])[0] as string | undefined;
  const p1: Pillar = { id: 1, status: "partial", evidence_ids: [], interpretation: "" };
  // Base 50. +15 when an H1 headline exists (otherwise -15 and a finding); +5 for a meta description, -5 without one.
  let s1 = 50;
  if (h1) { p1.evidence_ids.push(ev(1, "The page has a main headline", h1, "H1")); s1 += 15; }
  else { p1.evidence_ids.push(ev(1, "No H1 headline was found in the markup", `"h1":[]`, "facts.h1")); s1 -= 15;
    finding(1, 2, "No H1 headline was found, so the main promise is not stated in a clear heading.", "A visitor decides within seconds whether the page is for them, and the headline is where they look first.", [p1.evidence_ids[0]], "Add one H1 that says what is offered and for whom.", "medium", "small", 1, "Click-through to the primary action"); }
  if (f.meta_description) s1 += 5; else s1 -= 5;
  p1.score = clamp(s1); p1.interpretation = h1 ? `Headline present: "${h1.slice(0, 80)}". Clarity of wording was not judged.` : "No H1 headline found.";

  // Pillar 3: CTA and friction
  const ctas = (f.cta_candidates ?? []) as { text: string }[];
  const p3: Pillar = { id: 3, status: "partial", evidence_ids: [], interpretation: "" };
  // Base 50. +15 when action wording exists (otherwise -20 and a severity 3 finding); -10 each for a form with over 6 fields and for a pre-ticked box.
  let s3 = 50;
  if (ctas.length) { p3.evidence_ids.push(ev(3, "A call-to-action button or link is present", ctas[0].text, "First CTA candidate")); s3 += 15; }
  else { p3.evidence_ids.push(ev(3, "No call-to-action wording was detected", `"cta_candidates":[]`, "facts.cta_candidates")); s3 -= 20;
    finding(3, 3, "No button or link with action wording (buy, add to cart, get started and similar) was detected.", "Without a clear next step, visitors have nothing obvious to do.", [p3.evidence_ids[0]], "Add one primary button that names the action.", "high", "small", 1, "Primary action click rate"); }
  const forms = (f.forms ?? []) as any[];
  const big = forms.find((x) => x.fields > 6);
  if (big) { const id = ev(3, `A form asks for ${big.fields} fields`, `"fields":${big.fields}`, "facts.forms"); p3.evidence_ids.push(id); s3 -= 10;
    finding(3, 2, `A form on the page has ${big.fields} fields.`, "Each extra field adds effort and lowers completion.", [id], "Remove or defer fields that are not needed for the first step.", "medium", "medium", 1, "Form completion rate"); }
  if (forms.some((x) => x.prechecked_boxes > 0)) { const id = ev(3, "A checkbox is ticked by default", `"prechecked_boxes":${forms.find((x) => x.prechecked_boxes > 0).prechecked_boxes}`, "facts.forms"); p3.evidence_ids.push(id); s3 -= 10;
    finding(3, 2, "A form has a pre-ticked checkbox.", "Pre-ticked consent or add-ons are a dark pattern and can erode trust.", [id], "Untick the box so visitors opt in themselves.", "low", "small", 1, "Opt-in rate and complaint rate"); }
  p3.score = clamp(s3); p3.interpretation = `${ctas.length} action-worded element(s) detected; ${forms.length} form(s). Label quality and layout were not judged.`;

  // Pillar 4: offer and pricing
  const p4: Pillar = { id: 4, status: "partial", evidence_ids: [], interpretation: "" };
  // Base 50. +15 when a price is visible (otherwise -10); +10 when shipping is mentioned (otherwise -10 and a finding).
  let s4 = 50;
  if (cues.price) { p4.evidence_ids.push(ev(4, "A price appears on the page", bool("price", true), "facts.cues")); s4 += 15; }
  else { p4.evidence_ids.push(ev(4, "No price was detected in the page text", bool("price", false), "facts.cues")); s4 -= 10; }
  if (cues.shipping) { p4.evidence_ids.push(ev(4, "Shipping or delivery is mentioned", bool("shipping", true), "facts.cues")); s4 += 10; }
  else { const id = ev(4, "Shipping or delivery is not mentioned", bool("shipping", false), "facts.cues"); p4.evidence_ids.push(id); s4 -= 10;
    finding(4, 2, "Shipping or delivery information was not found on the page.", "Surprise delivery costs and times are a common reason to abandon before checkout.", [id], "State delivery cost and timing near the price.", "medium", "small", 1, "Add-to-cart rate"); }
  p4.score = clamp(s4); p4.interpretation = "Presence of price, shipping and availability only. Whether terms are clear was not judged.";

  // Pillar 5: trust
  const p5: Pillar = { id: 5, status: "partial", evidence_ids: [], interpretation: "" };
  // Base 40. +12 for each trust cue present: reviews, returns or guarantee, contact, secure payment wording.
  let s5 = 40;
  const trust: [string, string][] = [["reviews", "reviews or ratings"], ["returns", "returns or guarantee information"], ["contact", "contact or support"], ["secure", "secure payment wording"]];
  const missing: string[] = [];
  for (const [k, label] of trust) {
    const on = !!cues[k];
    p5.evidence_ids.push(ev(5, on ? `The page mentions ${label}` : `The page does not mention ${label}`, bool(k, on), "facts.cues"));
    if (on) s5 += 12; else missing.push(label);
  }
  if (missing.length >= 2) finding(5, 2, `The page does not mention: ${missing.join(", ")}.`, "Proof and risk-reducers near the decision point help hesitant visitors commit.", p5.evidence_ids.slice(0, 4), "Add the missing proof or policy information close to the main action, using real material only.", "medium", "medium", 2, "Primary action rate");
  p5.score = clamp(s5); p5.interpretation = "Counts trust cues in the text. Whether proof is specific or genuine was not judged.";

  // Pillar 6: hierarchy, mobile, accessibility
  const p6: Pillar = { id: 6, status: "partial", evidence_ids: [], interpretation: "" };
  // Base 55. +10 with a mobile viewport tag (otherwise -20 and a severity 3 finding); -5 for images without alt text; -5 for skipped heading levels.
  let s6 = 55;
  if (f.viewport_meta) { p6.evidence_ids.push(ev(6, "A mobile viewport tag is present", bool("viewport_meta", true), "facts")); s6 += 10; }
  else { const id = ev(6, "No mobile viewport tag", bool("viewport_meta", false), "facts"); p6.evidence_ids.push(id); s6 -= 20;
    finding(6, 3, "The page has no mobile viewport tag.", "Phones may show a shrunken desktop layout that is hard to use.", [id], "Add a viewport meta tag.", "high", "small", 1, "Mobile conversion rate"); }
  if (f.images?.missing_alt > 0) { const id = ev(6, `${f.images.missing_alt} image(s) have no alt attribute`, `"missing_alt":${f.images.missing_alt}`, "facts.images"); p6.evidence_ids.push(id); s6 -= 5;
    finding(6, 1, `${f.images.missing_alt} of ${f.images.total} images have no alt text.`, "Missing alt text hurts accessibility and search visibility.", [id], "Add short descriptive alt text to product and content images.", "low", "small", 1, "Accessibility check pass rate"); }
  if (f.heading_order_skips > 0) { p6.evidence_ids.push(ev(6, "Heading levels skip", `"heading_order_skips":${f.heading_order_skips}`, "facts")); s6 -= 5; }
  p6.score = clamp(s6); p6.interpretation = "Markup checks only. Layout, contrast and tap targets were not measured.";

  // Pillar 2 needs the ad or email text, which the rules cannot judge. Pillars 7 and 8 are added later by runAudit as usual.
  const pillars: Pillar[] = [p1, { id: 2, status: "needs_data", evidence_ids: [], interpretation: "Needs the traffic source or ad to judge message match." }, p3, p4, p5, p6];
  // A guess from the URL path only, so the page type is reported with low confidence.
  const isProduct = /\/products?\//i.test(ins.finalUrl);
  return {
    report: {
      page: { page_type: isProduct ? "product" : "landing", page_type_confidence: "low", inferred_goal: "Not judged in rules-only mode", goal_basis: "Guessed from the URL path only" },
      pillars, findings, recommendations: recs,
      limitations: [
        "RULES-ONLY RESULT: the language model was unavailable, so this audit uses fixed checks on the page markup. It cannot judge copy quality, offer strength or message match, and its findings are generic checks, not page-specific insight. Re-run later for the full agent audit.",
      ],
      human_review_flags: [] as string[],
    },
    ledger,
  };
}

/** Rounds to a multiple of 5 and keeps the value between 0 and 100, as the rubric requires. */
const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n / 5) * 5));
