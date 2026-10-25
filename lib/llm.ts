// One structured-output call, two providers. Claude if ANTHROPIC_API_KEY is set, else Gemini (free tier) with GEMINI_API_KEY.
import Anthropic from "@anthropic-ai/sdk";

/** Which model vendor answers the audit. */
export type Provider = "anthropic" | "gemini";
/** A function the model is forced to call; its JSON schema is how we get structured output instead of free text. */
export interface Tool { name: string; description: string; input_schema: any }

/**
 * Chooses the provider from the environment: LLM_PROVIDER wins if its key exists, otherwise Anthropic when its key is set,
 * otherwise Gemini. Returns null when no key is configured (the API route then reports a setup error).
 */
export function pickProvider(): Provider | null {
  const forced = process.env.LLM_PROVIDER;
  if (forced === "anthropic" && process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (forced === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return null;
}

/** Primary model name, used only for display. For Gemini this is the first model in GEMINI_MODEL. */
export function modelName(p: Provider) {
  return p === "anthropic" ? process.env.CRO_MODEL || "claude-sonnet-5-5" : (process.env.GEMINI_MODEL || "gemini-3.1-pro-preview,gemini-3.6-flash").split(",")[0].trim();
}

/**
 * Converts our JSON Schema to the subset Gemini accepts. Gemini rejects `enum` on integers and the keys
 * `additionalProperties` / `$schema`, so integer enums become minimum/maximum plus a "One of ..." hint in the description.
 */
export function toGeminiSchema(s: any): any {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== "object") return s;
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === "additionalProperties" || k === "$schema") continue;
    out[k] = toGeminiSchema(v);
  }
  if (out.type === "integer" && Array.isArray(out.enum)) {
    const nums = out.enum as number[];
    out.minimum = Math.min(...nums); out.maximum = Math.max(...nums);
    out.description = `${out.description ? out.description + " " : ""}One of ${nums.join(", ")}.`;
    delete out.enum;
  }
  return out;
}

/**
 * Makes one structured-output model call and returns the tool arguments (the audit JSON).
 *
 * Anthropic: a single call with the tool forced.
 * Gemini: tries each model in the chain (twice around), inside one shared time budget, and moves on when a model is
 * rate limited (429), busy (500/503), missing (404), slow (timeout) or returns no function call.
 * Throws Error("RATE_LIMITED" | "MODEL_BUSY" | "TIMEOUT" | message) when every attempt fails; runAudit turns those into the rules-only fallback.
 *
 * @param opts.deadline  absolute time (ms since epoch) by which all attempts must be finished
 */
export async function callStructured(opts: { provider: Provider; system: string; user: string; tool: Tool; deadline?: number }): Promise<any> {
  const { provider, system, user, tool } = opts;
  if (provider === "anthropic") {
    const client = new Anthropic();
    const resp = await client.messages.create({
      model: modelName(provider), max_tokens: 12000, system, tools: [tool as any],
      tool_choice: { type: "tool", name: tool.name }, messages: [{ role: "user", content: user }],
    });
    const call = resp.content.find((b) => b.type === "tool_use") as Anthropic.ToolUseBlock | undefined;
    if (!call) throw new Error("The model did not return an audit");
    return JSON.parse(JSON.stringify(call.input));
  }

  // Free-tier Gemini is often busy or slow. Try each model in turn within one shared time budget.
  // Optional reasoning effort for Gemini. Only sent when set, because an unsupported value would make every call fail.
  const thinking = process.env.GEMINI_THINKING; // optional, e.g. "low"; only sent when set so a wrong value cannot break calls
  // Same request for every model in the chain: forced function call (mode ANY, one allowed name), low temperature for steadier scores.
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    tools: [{ functionDeclarations: [{ name: tool.name, description: tool.description, parameters: toGeminiSchema(tool.input_schema) }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool.name] } },
    generationConfig: { temperature: 0.2, maxOutputTokens: 12000, ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}) },
  });
  // Default budget when the caller gives none.
  const deadline = opts.deadline ?? Date.now() + 100_000;
  const base = geminiModels();
  // 503s are usually momentary and return in seconds, so cycle through the models twice before giving up.
  const models = [...base, ...base];
  // Reason reported if every attempt fails.
  let last = "MODEL_BUSY";
  for (let i = 0; i < models.length; i++) {
    // Time left in the shared budget. Under 8 s is not enough for a real answer.
    const remaining = deadline - Date.now();
    if (remaining < 8000) break;
    // The first model gets at most 65% of what is left so a slow model cannot starve its fallback.
    // The last attempt gets everything left; earlier ones get at most 65% (and at least 25 s) so one slow model cannot starve its fallback.
    const budget = i === models.length - 1 ? remaining : Math.min(remaining, Math.max(25_000, remaining * 0.65));
    const t0 = Date.now();
    try {
      // AbortSignal.timeout needs a whole number of milliseconds.
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
        signal: AbortSignal.timeout(Math.floor(budget)), body,
      });
      // One log line per attempt: this is how slow or failing models are spotted in the Vercel logs.
      console.log(`gemini ${models[i]} -> HTTP ${res.status} in ${Date.now() - t0}ms (budget ${Math.floor(budget)}ms)`);
      // Quota or rate limit: try the next model.
      if (res.status === 429) { last = "RATE_LIMITED"; continue; }
      // Overloaded: pause briefly, then try the next attempt.
      if (res.status === 503 || res.status === 500) { last = "MODEL_BUSY"; await new Promise((r) => setTimeout(r, 1500)); continue; }
      // This key cannot use that model name: try the next one.
      if (res.status === 404) { last = `Model ${models[i]} is not available to this key`; continue; }
      // Anything else (for example 400 invalid key or bad request) is a real error and is surfaced.
      if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      // The audit is the arguments of the function call in the first candidate.
      const part = data.candidates?.[0]?.content?.parts?.find((p: any) => p.functionCall);
      if (!part) { last = "The model did not return an audit"; continue; }
      // Remember which model answered so the report can say so.
      usedModel = models[i];
      return part.functionCall.args;
    } catch (e) {
      if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") { console.log(`gemini ${models[i]} -> timed out after ${Date.now() - t0}ms`); last = "TIMEOUT"; continue; }
      throw e;
    }
  }
  throw new Error(last);
}

/** Name of the Gemini model that produced the latest answer (module-level, set by callStructured). */
export let usedModel = "";
/**
 * The Gemini model chain from GEMINI_MODEL (comma-separated), best first.
 * Default: Pro first for quality, Flash as the fallback.
 */
export function geminiModels(): string[] {
  return (process.env.GEMINI_MODEL || "gemini-3.1-pro-preview,gemini-3.6-flash").split(",").map((m) => m.trim()).filter(Boolean);
}
