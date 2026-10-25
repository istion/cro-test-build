import { NextRequest, NextResponse } from "next/server";
import { runAudit } from "@/lib/audit";
import { pickProvider } from "@/lib/llm";

export const maxDuration = 180;
export const dynamic = "force-dynamic";

// Best-effort limiter (per serverless instance). It protects the API key from casual abuse, not from a determined attacker.
const hits = new Map<string, number[]>();
const LIMIT = 5, WINDOW_MS = 10 * 60_000;

export async function POST(req: NextRequest) {
  if (!pickProvider())
    return NextResponse.json({ error: "The server has no model key configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY)." }, { status: 500 });

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return NextResponse.json({ error: "Too many audits from this address. Try again in a few minutes." }, { status: 429 });
  hits.set(ip, [...recent, now]);

  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url || url.length > 2000) return NextResponse.json({ error: "Enter a page URL" }, { status: 400 });

  // An audit takes one to two minutes. A silent request that long is dropped by many proxies and corporate networks,
  // which the page reports as "Could not reach the server". So the reply starts at once and sends a space every few
  // seconds; JSON ignores leading whitespace, and the real result follows. Errors travel in the body for the same reason.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      c.enqueue(enc.encode(" "));
      const beat = setInterval(() => { try { c.enqueue(enc.encode(" ")); } catch { /* client went away */ } }, 8000);
      let out: any;
      try {
        out = await runAudit({
          url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
          trafficSource: typeof body.trafficSource === "string" ? body.trafficSource : undefined,
          goal: typeof body.goal === "string" ? body.goal.slice(0, 300) : undefined,
        });
      } catch (e) {
        const m = (e as Error).message;
        if (m === "RATE_LIMITED") out = { error: "The Gemini quota is used up for now. Please try again later." };
        else if (m === "MODEL_BUSY") out = { error: "The model is overloaded right now. Please try again in a minute." };
        else if (m === "TIMEOUT" || (e as Error).name === "TimeoutError") out = { error: "The model took too long to answer. Please try again." };
        else { console.error("audit failed", e); out = { error: "The audit failed. Please try again." }; }
      }
      clearInterval(beat);
      try { c.enqueue(enc.encode(JSON.stringify(out))); c.close(); } catch { /* client went away */ }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
