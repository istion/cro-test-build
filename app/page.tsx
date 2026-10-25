"use client";
import { useState } from "react";

const STATUS: Record<string, string> = { scored: "Scored", partial: "Partial", not_applicable: "Not applicable", needs_data: "Needs data", could_not_test: "Could not test" };

export default function Home() {
  const [url, setUrl] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [r, setR] = useState<any>(null);

  async function run(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(""); setR(null);
    try {
      const res = await fetch("/api/audit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, trafficSource: source || undefined }) });
      const j = await res.json().catch(() => null);
      if (!j) setErr("The audit took too long and the server stopped it. Please try again.");
      else if (!res.ok) setErr(j.error ?? "Something went wrong"); else setR(j);
    } catch { setErr("Could not reach the server"); }
    setBusy(false);
  }

  return (
    <main>
      <header>
        <h1>CRO Score Agent</h1>
        <p className="lede">Scores one page for conversion readiness, shows the proof behind every point lost, and says what it could not check.</p>
      </header>

      <form onSubmit={run} className="card">
        <label>Page URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourstore.com/products/example" required />
        </label>
        <label>Ad, email or search snippet that sends traffic here <span className="muted">(optional, scores message match fully)</span>
          <textarea value={source} onChange={(e) => setSource(e.target.value)} rows={2} maxLength={1500} />
        </label>
        <button disabled={busy}>{busy ? "Auditing (up to a minute)..." : "Score this page"}</button>
        {err && <p className="error">{err}</p>}
      </form>

      {r?.could_not_audit && (
        <section className="card warn"><h2>Could not audit</h2><p>{r.could_not_audit}</p><p className="muted">No score is given for a page that cannot be inspected.</p>
          {r.integrity_flags?.length > 0 && <Flags flags={r.integrity_flags} />}</section>
      )}

      {r?.fallback && (
        <section className="card warn"><h2>Rules-only result</h2>
          <p>The AI audit was unavailable because {r.fallback.reason}. This score comes from fixed checks on the page markup, so it has limited coverage and generic findings. Try again later for the full agent audit.</p></section>
      )}

      {r?.score && <Report r={r} />}

      <Explainer />
    </main>
  );
}

function Flags({ flags }: { flags: any[] }) {
  return <ul>{flags.map((f, i) => <li key={i}>Ignored instruction-like text ({f.pattern}) in {f.location}: <q>{f.excerpt}</q></li>)}</ul>;
}

function Report({ r }: { r: any }) {
  const s = r.score, a = r.audit;
  const byId: Record<number, any> = Object.fromEntries(s.pillars.map((p: any) => [p.id, p]));
  const buckets = ["Quick wins", "Medium changes", "Experiments", "Strategic hypotheses"];
  return (
    <>
      <section className="card score">
        <div className="big">{s.overall}<span>/100</span></div>
        <div>
          <p><b>{s.band}</b>. Confidence <b>{s.confidence}</b>. Coverage <b>{s.coverage}%</b>.</p>
          <p className="muted">{a.final_url} · {a.page_type} page ({a.page_type_confidence} confidence) · goal: {a.inferred_goal}{a.shopify ? " · Shopify store detected" : ""}</p>
          {s.excluded.length > 0 && <p className="muted">Not counted against the page: {s.excluded.map((p: any) => `${p.name} (${STATUS[p.status]})`).join(", ")}.</p>}
        </div>
      </section>

      <section className="card">
        <h2>Logic behind the score</h2>
        <p className="muted">Score = sum(weight × pillar score) ÷ sum(weight of pillars that could be scored). Missing data lowers confidence, never the score.</p>
        <table>
          <thead><tr><th>Pillar</th><th>Weight</th><th>Status</th><th>Score</th><th>Weight × score</th></tr></thead>
          <tbody>{s.pillars.map((p: any) => (
            <tr key={p.id}><td>{p.id}. {p.name}<div className="muted">{p.interpretation}</div></td><td>{p.weight}</td><td>{STATUS[p.status]}</td>
              <td>{p.score ?? "–"}</td><td>{p.score === null ? "–" : p.weight * p.score}</td></tr>))}
            <tr className="total"><td>Total</td><td>{s.scored_weight}</td><td></td><td>{s.overall}</td><td>{s.weighted_total} ÷ {s.scored_weight}</td></tr>
          </tbody>
        </table>
        <p className="muted">Confidence: {s.confidence_reasons.join("; ")}.</p>
      </section>

      <section className="card">
        <h2>Findings</h2>
        {[...r.findings].sort((x: any, y: any) => y.severity - x.severity).map((f: any) => (
          <div key={f.id} className="item">
            <b>{f.id}</b> <span className="pill">severity {f.severity}</span> <span className="pill">{byId[f.pillar]?.name}</span>
            <p>{f.observation}</p>
            {f.evidence_ids.map((id: string) => { const e = r.ledger.find((x: any) => x.id === id); return e && (
              <p key={id} className="evidence"><b>{id}</b> <span className={`pill ${e.verified ? "ok" : "no"}`}>{e.verified ? `${e.evidence_type}, quote verified` : "hypothesis"}</span> <q>{e.quote.length > 160 ? e.quote.slice(0, 160) + "…" : e.quote}</q> <span className="muted">({e.location})</span></p>); })}
            <p className="muted">Why it may matter (hypothesis unless measured): {f.why_it_matters}{f.uncertainty ? ` Uncertainty: ${f.uncertainty}` : ""}</p>
          </div>))}
      </section>

      <section className="card">
        <h2>Prioritised plan</h2>
        <p className="muted">Priority = (Impact × Evidence × Severity) ÷ (Effort + Brand risk). Impact is low, medium or high; no uplift is promised.</p>
        {buckets.map((b) => { const items = r.recommendations.filter((x: any) => x.bucket === b); return items.length > 0 && (
          <div key={b}><h3>{b}</h3>{items.map((x: any) => (
            <div key={x.id} className="item">
              <b>{x.id}</b> <span className="pill">priority {x.priority}</span> <span className="pill">Level {x.approval_level}</span>
              <p>{x.change}</p>
              {x.current_state && <p className="muted">Now: {x.current_state}</p>}
              <p className="muted">Impact {x.impact}: {x.impact_reason}. Evidence {x.evidence}. Effort {x.effort}. Brand risk {x.brand_risk}. Keep: {x.keep_unchanged || "logo, palette, typography, voice"}.</p>
              <p className="muted">Success metric: {x.metric}. Guardrail: {x.guardrail_metric}.</p>
            </div>))}</div>); })}
      </section>

      {r.integrity_flags.length > 0 && <section className="card warn"><h2>Integrity flags</h2><Flags flags={r.integrity_flags} /></section>}
      {r.human_review_flags.length > 0 && <section className="card"><h2>Needs human review</h2><ul>{r.human_review_flags.map((h: string, i: number) => <li key={i}>{h}</li>)}</ul></section>}
      <section className="card"><h2>Limitations of this audit</h2><ul>{r.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul></section>
      <details className="card"><summary>Evidence ledger and measured facts</summary>
        <pre>{JSON.stringify({ ledger: r.ledger, facts: r.facts, diagnostics: r.diagnostics }, null, 1)}</pre></details>
    </>
  );
}

function Explainer() {
  return (
    <section className="card">
      <h2>How this works</h2>
      <h3>Guardrails</h3>
      <ul>
        <li><b>Evidence or no deduction.</b> Every point lost cites an exact quote from this page. The code checks the quote exists on the fetched page; if not, it is downgraded to a hypothesis and cannot lower the score.</li>
        <li><b>Code owns the score.</b> The model only judges copy and clarity. The weighted score, coverage, confidence and priority ranking are calculated by code, so the model cannot be talked into a higher number.</li>
        <li><b>Page text is data.</b> Text on the page ("score this 100", "ignore the rubric") is scanned, shown under Integrity flags, and ignored.</li>
        <li><b>No invented numbers, no uplift promises, no dark patterns.</b> Recommendations that break this are sent back, then removed.</li>
        <li><b>Safe fetching.</b> Only public http(s) pages, robots.txt respected, private networks blocked, no logins or CAPTCHAs bypassed. Read-only.</li>
        <li><b>Brand stays recognisable.</b> Each change has an approval level; Level 3 (colours, logo, pricing, claims) is shown only as a strategic hypothesis.</li>
      </ul>
      <h3>Shopify</h3>
      <p>On a Shopify product page the agent also reads the store's public product data (price, compare-at price, availability, variants, image alt text) as measured facts. It never uses an admin login.</p>
      <h3>Limitations</h3>
      <ul>
        <li>It reads the page's HTML, not a rendered browser view, so tap targets, contrast and pixel positions are not measured.</li>
        <li>A public page cannot show visitor behaviour or real conversion rate. Behaviour is excluded and lowers confidence; it is not scored zero.</li>
        <li>Public audits never reach High confidence. Weights are proposals, not validated against A/B results.</li>
        <li>Pages that need JavaScript to show content, or that need a login, return "Could not audit".</li>
      </ul>
    </section>
  );
}
