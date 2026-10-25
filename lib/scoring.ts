// Deterministic scoring. The model supplies pillar scores; this file does all arithmetic.
import rubric from "./rubric.json";

/**
 * Where a pillar stands:
 * - scored / partial: has a score and is counted;
 * - not_applicable: weight is 0 for this page type;
 * - needs_data: cannot be judged from a public page (always the case for pillar 8);
 * - could_not_test: a tool failed (for example no PageSpeed key for pillar 7).
 */
export type Status = "scored" | "partial" | "not_applicable" | "needs_data" | "could_not_test";
/** One of the page types that have a weight table in the rubric. */
export type PageType = keyof typeof rubric.weights;
/** A pillar as supplied to the score engine, before weights are applied. */
export interface PillarIn { id: number; status: Status; score?: number | null; evidence_ids?: string[]; interpretation?: string }
/** A pillar after scoring: carries its name and weight, and `score` is null when the pillar is not counted. */
export interface PillarOut extends PillarIn { name: string; weight: number; score: number | null; evidence_ids: string[] }

/** The six page types the rubric has weights for. */
export const PAGE_TYPES = Object.keys(rubric.weights) as PageType[];
/** Pillar id to display name, read from the rubric so the names live in one place. */
export const PILLAR_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(rubric.pillars).map(([k, v]) => [k, (v as { name: string }).name]));
/** The rubric's 0 / 50 / 100 anchors for each pillar. They are sent to the model so it scores against written definitions. */
export const ANCHORS = rubric.pillars;
export { rubric };

/**
 * Confidence levels in ascending order. The index is the working "level" in computeScore.
 * High is unreachable in public mode (see rubric.confidence.public_mode_max).
 */
const LEVELS = ["low", "medium", "high"] as const;
type Level = (typeof LEVELS)[number];

/**
 * Raised when the inputs break the rubric's rules (unknown page type, missing pillar, score not a multiple of 5, nothing scorable).
 * The caller turns it into a "could not be scored" result rather than showing a wrong number.
 */
export class ScoringError extends Error {}

/**
 * Computes the page score. This is the ONLY place the number is calculated; the model never supplies it.
 *
 *   score = round( sum(weight x pillar score) / sum(weight of counted pillars) )
 *
 * Pillars that are not counted drop out of both sums, so missing data cannot lower the score. It lowers `coverage`
 * (the share of total weight that was scored) and therefore confidence.
 *
 * @param pageType  which weight table to use (landing, homepage, product, collection, checkout, lead)
 * @param pillars   one entry per pillar 1 to 8
 * @param opts.downgrade  reasons that each lower confidence by one level (for example "the URL redirected")
 * @param opts.forceLow   force Low confidence because a tool failed on a heavily weighted pillar
 * @returns overall score, band label, coverage, confidence with reasons, the per-pillar breakdown and the strongest and weakest pillars
 */
export function computeScore(pageType: PageType, pillars: PillarIn[], opts: { downgrade?: string[]; forceLow?: boolean } = {}) {
  const weights = rubric.weights[pageType] as Record<string, number>;
  if (!weights) throw new ScoringError(`Unknown page type ${pageType}`);
  // total = sum of weight x score; scoredWeight = sum of weights of the pillars that were counted.
  let total = 0, scoredWeight = 0;
  const out: PillarOut[] = [];
  for (const id of Object.keys(weights).sort((a, b) => +a - +b)) {
    const p = pillars.find((x) => x.id === +id);
    if (!p) throw new ScoringError(`Pillar ${id} has no status`);
    const w = weights[id];
    // A weight of 0 means the pillar does not apply to this page type (message match on a checkout page, for example).
    let status: Status = w === 0 ? "not_applicable" : p.status;
    // Behaviour data cannot be seen from a public page, so it is never scored, whatever the caller passes in.
    if (id === "8") status = "needs_data"; // public audit only: behaviour is never guessed
    // Only scored and partial pillars take part in the arithmetic.
    const counted = status === "scored" || status === "partial";
    let score: number | null = null;
    if (counted) {
      const s = p.score;
      if (typeof s !== "number" || !Number.isInteger(s) || s < 0 || s > 100 || s % 5 !== 0)
        throw new ScoringError(`Pillar ${id}: score must be a multiple of 5 from 0 to 100`);
      score = s; total += w * s; scoredWeight += w;
    }
    out.push({ ...p, id: +id, name: PILLAR_NAMES[id], weight: w, status, score, evidence_ids: p.evidence_ids ?? [] });
  }
  if (scoredWeight === 0) throw new ScoringError("No pillar could be scored");
  // Round half up to a whole number.
  const overall = Math.floor(total / scoredWeight + 0.5);
  // Weights sum to 100 for every page type, so scored weight reads directly as a percentage of the rubric covered.
  const coverage = scoredWeight;

  // Public mode never exceeds Medium. Each listed reason lowers confidence one level.
  // Public mode never exceeds Medium. Start at Medium (1) when at least 60% is covered, else Low (0). Each reason lowers it one level.
  let level = coverage >= rubric.confidence.medium_min_coverage ? 1 : 0;
  const reasons: string[] = ["Public mode never exceeds Medium"];
  if (coverage < rubric.confidence.medium_min_coverage) reasons.push(`Coverage ${coverage}% is under ${rubric.confidence.medium_min_coverage}%`);
  for (const d of opts.downgrade ?? []) { level = Math.max(0, level - 1); reasons.push(`Lowered one level: ${d}`); }
  if (opts.forceLow) { level = 0; reasons.push("Forced Low: a tool failed on a heavily weighted pillar"); }
  // The band is looked up from the rounded score (for example 60 to 74 is "Moderate").
  const band = rubric.bands.find((b) => overall >= b.min && overall <= b.max)!.label;
  const counted = out.filter((p) => p.score !== null);
  return {
    overall, band, coverage, confidence: LEVELS[level] as Level, confidence_reasons: reasons,
    weighted_total: total, scored_weight: scoredWeight, pillars: out,
    excluded: out.filter((p) => p.score === null).map((p) => ({ id: p.id, name: p.name, status: p.status })),
    strongest: [...counted].sort((a, b) => b.score! - a.score! || a.id - b.id).slice(0, 3).map((p) => p.id),
    weakest: [...counted].sort((a, b) => a.score! - b.score! || a.id - b.id).slice(0, 3).map((p) => p.id),
  };
}

type P = typeof rubric.priority;
/**
 * Priority of a recommendation: (impact x evidence x severity) / (effort + brand risk), to one decimal.
 * Evidence counts: measured beats observed beats hypothesis. Throws ScoringError if a level is not in the rubric tables.
 */
export function priority(r: { impact: string; evidence: string; severity: number; effort: string; brand_risk: string }) {
  const t = rubric.priority as P;
  const num = (t.impact as any)[r.impact] * (t.evidence as any)[r.evidence] * (t.severity as any)[String(r.severity)];
  const den = (t.effort as any)[r.effort] + (t.brand_risk as any)[r.brand_risk];
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) throw new ScoringError("Invalid priority input");
  return Math.round((num / den) * 10) / 10;
}

/**
 * Adds a priority number and a bucket to each recommendation and sorts best first.
 *
 * Buckets: approval level 3 is a "Strategic hypothesis" (never a quick win); small effort with at least medium impact is a
 * "Quick win"; anything resting only on a hypothesis is an "Experiment"; the rest are "Medium changes".
 * Ties are broken by lower effort, then stronger evidence.
 */
export function rankRecommendations<T extends { impact: string; evidence: string; severity: number; effort: string; brand_risk: string; approval_level: number }>(recs: T[]) {
  const t = rubric.priority as P;
  const ranked = recs.map((r) => {
    const p = priority(r);
    const bucket = r.approval_level === 3 ? "Strategic hypotheses"
      : (t.effort as any)[r.effort] === 1 && (t.impact as any)[r.impact] >= 2 ? "Quick wins"
      : r.evidence === "hypothesis" ? "Experiments" : "Medium changes";
    return { ...r, priority: p, bucket };
  });
  return ranked.sort((a, b) => b.priority - a.priority || (t.effort as any)[a.effort] - (t.effort as any)[b.effort]
    || (t.evidence as any)[b.evidence] - (t.evidence as any)[a.evidence]);
}
