// One structured-output call, two providers. Claude if ANTHROPIC_API_KEY is set, else Gemini (free tier) with GEMINI_API_KEY.
import Anthropic from "@anthropic-ai/sdk";

export type Provider = "anthropic" | "gemini";
export interface Tool { name: string; description: string; input_schema: any }

export function pickProvider(): Provider | null {
  const forced = process.env.LLM_PROVIDER;
  if (forced === "anthropic" && process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (forced === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return null;
}

export function modelName(p: Provider) {
  return p === "anthropic" ? process.env.CRO_MODEL || "claude-sonnet-5-5" : (process.env.GEMINI_MODEL || "gemini-3.6-flash,gemini-3.5-flash,gemini-3.8-flash,gemini-3.7-flash").split(",")[0].trim();
}

/** Gemini's schema subset rejects enum on integers and some JSON Schema keys. Convert to equivalent constraints. */
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
  const thinking = process.env.GEMINI_THINKING; // optional, e.g. "low"; only sent when set so a wrong value cannot break calls
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    tools: [{ functionDeclarations: [{ name: tool.name, description: tool.description, parameters: toGeminiSchema(tool.input_schema) }] }],
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool.name] } },
    generationConfig: { temperature: 0.2, maxOutputTokens: 12000, ...(thinking ? { thinkingConfig: { thinkingLevel: thinking } } : {}) },
  });
  const deadline = opts.deadline ?? Date.now() + 100_000;
  const models = geminiModels();
  let last = "MODEL_BUSY";
  for (let i = 0; i < models.length; i++) {
    const remaining = deadline - Date.now();
    if (remaining < 8000) break;
    // The first model gets at most 60% of what is left so a slow model cannot starve its fallback.
    const budget = i === models.length - 1 ? remaining : Math.min(remaining, Math.max(25_000, remaining * 0.6));
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:generateContent`, {
        method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
        signal: AbortSignal.timeout(Math.floor(budget)), body,
      });
      if (res.status === 429) { last = "RATE_LIMITED"; continue; }
      if (res.status === 503 || res.status === 500) { last = "MODEL_BUSY"; continue; }
      if (res.status === 404) { last = `Model ${models[i]} is not available to this key`; continue; }
      if (!res.ok) throw new Error(`Gemini returned HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const part = data.candidates?.[0]?.content?.parts?.find((p: any) => p.functionCall);
      if (!part) { last = "The model did not return an audit"; continue; }
      usedModel = models[i];
      return part.functionCall.args;
    } catch (e) {
      if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") { last = "TIMEOUT"; continue; }
      throw e;
    }
  }
  throw new Error(last);
}

export let usedModel = "";
export function geminiModels(): string[] {
  return (process.env.GEMINI_MODEL || "gemini-3.6-flash,gemini-3.5-flash,gemini-3.8-flash,gemini-3.7-flash").split(",").map((m) => m.trim()).filter(Boolean);
}
