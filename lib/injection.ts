// Detects instruction-like text in untrusted content and wraps it in trust-boundary tags.
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
const CLAIMS = /\b(cured?|clinically proven|guaranteed results?|lose \d+ ?(kg|lb|pounds)|weight loss|treats? (cancer|diabetes|anxiety|depression)|guaranteed returns?|FDA[- ]approved)\b/gi;

export interface IntegrityFlag { pattern: string; excerpt: string; location: string }

export function scan(text: string, location: string): IntegrityFlag[] {
  const out: IntegrityFlag[] = [];
  for (const [rx, pattern] of PATTERNS) {
    const m = rx.exec(text || "");
    if (m) out.push({ pattern, location, excerpt: text.slice(Math.max(0, m.index - 20), m.index + m[0].length + 40).trim().slice(0, 200) });
  }
  return out;
}
export function scanClaims(text: string): string[] {
  return [...new Set([...(text || "").matchAll(CLAIMS)].map((m) => m[0].toLowerCase()))].slice(0, 20);
}
/** Page text goes to the model only inside this tag, with any closing-tag breakout neutralised. */
export function wrapPage(content: string, source: string) {
  return `<page_content source="${source.replace(/"/g, "")}" trust="untrusted">\n${content.replace(/<\/page_content>/gi, "<\\/page_content>")}\n</page_content>`;
}
