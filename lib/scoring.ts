// Deterministic scoring. The model supplies pillar scores; this file does all arithmetic.
import rubric from "./rubric.json";

export type Status = "scored" | "partial" | "not_applicable" | "needs_data" | "could_not_test";
export type PageType = keyof typeof rubric.weights;
export interface PillarIn { id: number; status: Status; score?: number | null; evidence_ids?: string[]; interpretation?: string }
export interface PillarOut extends PillarIn { name: string; weight: number; score: number | null; evidence_ids: string[] }

export const PAGE_TYPES = Object.keys(rubric.weights) as PageType[];
export const PILLAR_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(rubric.pillars).map(([k, v]) => [k, (v as { name: string }).name]));
export const ANCHORS = rubric.pillars;
export { rubric };

const LEVELS = ["low", "medium", "high"] as const;
type Level = (typeof LEVELS)[number];

export class ScoringError extends Error {}

export function computeScore(pageType: PageType, pillars: PillarIn[], opts: { downgrade?: string[]; forceLow?: boolean } = {}) {
  const weights = rubric.weights[pageType] as Record<string, number>;
  if (!weights) throw new ScoringError(`Unknown page type ${pageType}`);
  let total = 0, scoredWeight = 0;
  const out: PillarOut[] = [];
  for (const id of Object.keys(weights).sort((a, b) => +a - +b)) {
    const p = pillars.find((x) => x.id === +id);
    if (!p) throw new ScoringError(`Pillar ${id} has no status`);
    const w = weights[id];
    let status: Status = w === 0 ? "not_applicable" : p.status;
    if (id === "8") status = "needs_data"; // public audit only: behaviour is never guessed
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
  const overall = Math.floor(total / scoredWeight + 0.5);
  const coverage = scoredWeight;

  // Public mode never exceeds Medium. Each listed reason lowers confidence one level.
  let level = coverage >= rubric.confidence.medium_min_coverage ? 1 : 0;
  const reasons: string[] = ["Public mode never exceeds Medium"];
  if (coverage < rubric.confidence.medium_min_coverage) reasons.push(`Coverage ${coverage}% is under ${rubric.confidence.medium_min_coverage}%`);
  for (const d of opts.downgrade ?? []) { level = Math.max(0, level - 1); reasons.push(`Lowered one level: ${d}`); }
  if (opts.forceLow) { level = 0; reasons.push("Forced Low: a tool failed on a heavily weighted pillar"); }
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
export function priority(r: { impact: string; evidence: string; severity: number; effort: string; brand_risk: string }) {
  const t = rubric.priority as P;
  const num = (t.impact as any)[r.impact] * (t.evidence as any)[r.evidence] * (t.severity as any)[String(r.severity)];
  const den = (t.effort as any)[r.effort] + (t.brand_risk as any)[r.brand_risk];
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) throw new ScoringError("Invalid priority input");
  return Math.round((num / den) * 10) / 10;
}

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
