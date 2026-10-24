import { NextRequest, NextResponse } from "next/server";
import { runAudit } from "@/lib/audit";
import { pickProvider } from "@/lib/llm";

export const maxDuration = 60;
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

  try {
    const result = await runAudit({
      url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
      trafficSource: typeof body.trafficSource === "string" ? body.trafficSource : undefined,
      goal: typeof body.goal === "string" ? body.goal.slice(0, 300) : undefined,
    });
    return NextResponse.json(result);
  } catch (e) {
    if ((e as Error).message === "RATE_LIMITED")
      return NextResponse.json({ error: "The free model quota is used up for now. Wait a minute and try again." }, { status: 429 });
    const m = (e as Error).message;
    if (m === "MODEL_BUSY")
      return NextResponse.json({ error: "The model is overloaded right now. Please try again in a minute." }, { status: 503 });
    if ((e as Error).name === "TimeoutError")
      return NextResponse.json({ error: "The model took too long to answer (over the 60 second limit). Try again, or ask the owner to switch to a faster model." }, { status: 504 });
    console.error("audit failed", e);
    return NextResponse.json({ error: "The audit failed. Please try again." }, { status: 500 });
  }
}
