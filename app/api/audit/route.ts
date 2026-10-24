import { NextRequest, NextResponse } from "next/server";
import { runAudit } from "@/lib/audit";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Best-effort limiter (per serverless instance). It protects the API key from casual abuse, not from a determined attacker.
const hits = new Map<string, number[]>();
const LIMIT = 5, WINDOW_MS = 10 * 60_000;

export async function POST(req: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY)
    return NextResponse.json({ error: "The server has no ANTHROPIC_API_KEY configured." }, { status: 500 });

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
    console.error("audit failed", e);
    return NextResponse.json({ error: "The audit failed. Please try again." }, { status: 500 });
  }
}
