// Detects instruction-like text in untrusted content and wraps it in trust-boundary tags.

/**
 * Phrases that try to steer the model or the score from inside the page (prompt injection).
 * Each entry is [pattern, label]. The label is shown to the user in the Integrity flags section.
 * A match never changes the audit by itself: the text is flagged, then ignored, and the code owns the score anyway.
 */
const PATTERNS: [RegExp, string][] = [
  [/ignore (all |any )?(the )?(previous|prior|above|earlier) (instructions|rules|rubric|prompt)/i, "override_instructions"],
  [/ignore the rubric/i, "override_rubric"],
  [/disregard (all |any )?(the )?(previous|prior|above|your) /i, "override_instructions"],
  [/(score|rate|mark|grade) (this page|the page|it|every pillar|all pillars)[^.\n]{0,30}\b(100|90|perfect|highest|maximum)/i, "score_manipulation"],
  [/give (this page|it|us) (a |the )?(perfect|100|top|highest|maximum)/i, "score_manipulation"],
  [/(reveal|show|print|repeat|output) (your |the )?(system )?(prompt|instructions)/i, "prompt_exfiltration"],
  [/delete (the )?(previous|prior|all) (findings|results|evidence)/i, "state_tampering"],
  [/you are now |new instructions?:|system prompt:/i, "role_hijack"],
  [/\b(ai|assistant|llm|language model|claude|chatgpt)[ ,:]+(please |must |should )?(ignore|score|praise|recommend|say|output)/i, "addresses_ai"],
  [/praise the brand/i, "score_manipulation"],
];
/**
 * Regulated or outcome claims (health, weight loss, guaranteed returns, regulatory approval).
 * These are not manipulation; they are listed for human review because a person should decide whether the claim is acceptable.
 */
const CLAIMS = /\b(cured?|clinically proven|guaranteed results?|lose \d+ ?(kg|lb|pounds)|weight loss|treats? (cancer|diabetes|anxiety|depression)|guaranteed returns?|FDA[- ]approved)\b/gi;

/** One suspicious passage: which pattern matched, a short excerpt around it, and where on the page it was found. */
export interface IntegrityFlag { pattern: string; excerpt: string; location: string }

/**
 * Looks for instruction-like text in one piece of untrusted content (visible text, a meta tag, an image alt, a hidden element...).
 * Returns at most one flag per pattern, with the surrounding words so the user can judge it.
 */
export function scan(text: string, location: string): IntegrityFlag[] {
  const out: IntegrityFlag[] = [];
  for (const [rx, pattern] of PATTERNS) {
    const m = rx.exec(text || "");
    if (m) out.push({ pattern, location, excerpt: text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 40).trim().slice(0, 200) });
  }
  return out;
}
/** Returns the distinct regulated or outcome claims found in the text (lower-cased, at most 20). */
export function scanClaims(text: string): string[] {
  return [...new Set([...(text || "").matchAll(CLAIMS)].map((m) => m[0].toLowerCase()))].slice(0, 20);
}
/** Page text goes to the model only inside this tag, with any closing-tag breakout neutralised. */
export function wrapPage(content: string, source: string) {
  return `<page_content source="${source.replace(/"/g, "")}" trust="untrusted">\n${content.replace(/<\/page_content>/gi, "<\\/page_content>")}\n</page_content>`;
}
