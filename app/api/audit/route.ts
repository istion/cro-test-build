import { NextRequest, NextResponse } from "next/server";
import { runAudit } from "@/lib/audit";
import { pickProvider } from "@/lib/llm";

/** Vercel may run this function for up to 180 seconds: a Pro audit takes one to two minutes. */
export const maxDuration = 180;
/** Never cache: every call is a fresh audit. */
export const dynamic = "force-dynamic";

/** Best-effort limiter kept in memory of one serverless instance. It protects the API key from casual abuse, not from a determined attacker. */
const hits = new Map<string, number[]>();
const LIMIT = 5, WINDOW_MS = 10 * 60_000;

/**
 * POST /api/audit with { url, trafficSource? }.
 *
 * Quick problems (no model key, too many requests, bad input) return normal JSON errors. Otherwise the reply is streamed:
 * a space right away and every 8 seconds, then the JSON result, so a long audit is not cut off by a network that drops silent connections.
 * Because the status line is sent first, later failures arrive as { error } in the body.
 */
export async function POST(req: NextRequest) {
  if (!pickProvider())
    return NextResponse.json({ error: "The server has no model key configured (set GEMINI_API_KEY or ANTHROPIC_API_KEY)." }, { status: 500 });

  // Rate limit: at most 5 audits per IP in any 10 minutes.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return NextResponse.json({ error: "Too many audits from this address. Try again in a few minutes." }, { status: 429 });
  hits.set(ip, [...recent, now]);

  // Validate the input before spending any time or model quota.
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url || url.length > 2000) return NextResponse.json({ error: "Enter a page URL" }, { status: 400 });

  // An audit takes one to two minutes. A silent request that long is dropped by many proxies and corporate networks,
  // which the page reports as "Could not reach the server". So the reply starts at once and sends a space every few
  // seconds; JSON ignores leading whitespace, and the real result follows. Errors travel in the body for the same reason.
  // Reply as a stream so the response begins at once instead of after the whole audit.
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    // Runs once: sends the first byte, keeps the connection warm, then waits for the audit.
    async start(c) {
      c.enqueue(enc.encode(" "));
      // A single space every 8 seconds. Leading whitespace is valid before JSON, so the client can still parse the body.
      const beat = setInterval(() => { try { c.enqueue(enc.encode(" ")); } catch { /* client went away */ } }, 8000);
      // Either the audit result or { error }.
      let out: any;
      try {
        // Add https:// when the user typed a bare domain.
        out = await runAudit({
          url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
          trafficSource: typeof body.trafficSource === "string" ? body.trafficSource : undefined,
          goal: typeof body.goal === "string" ? body.goal.slice(0, 300) : undefined,
        });
      // Turn known failures into friendly messages; log anything unexpected.
      } catch (e) {
        const m = (e as Error).message;
        if (m === "RATE_LIMITED") out = { error: "The Gemini quota is used up for now. Please try again later." };
        else if (m === "MODEL_BUSY") out = { error: "The model is overloaded right now. Please try again in a minute." };
        else if (m === "TIMEOUT" || (e as Error).name === "TimeoutError") out = { error: "The model took too long to answer. Please try again." };
        else { console.error("audit failed", e); out = { error: "The audit failed. Please try again." }; }
      }
      // Stop the heartbeat, then send the final JSON and close.
      clearInterval(beat);
      try { c.enqueue(enc.encode(JSON.stringify(out))); c.close(); } catch { /* client went away */ }
    },
  });
  // no-store: the result must never be cached by a proxy.
  return new Response(stream, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
