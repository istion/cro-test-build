"use client";
import { useEffect, useState } from "react";

const STATUS: Record<string, string> = { scored: "Scored", partial: "Partial", not_applicable: "Not applicable", needs_data: "Needs data", could_not_test: "Could not test" };

const STEPS = ["Fetching the page and checking robots.txt", "Reading the page facts and Shopify data", "Measuring speed", "Judging the eight pillars with evidence", "Verifying every quote and scoring in code"];
const PILLARS = ["Value proposition", "Message match", "CTA and friction", "Offer and pricing", "Trust", "Hierarchy, mobile, accessibility", "Speed", "Behaviour data"];

function useElapsed(on: boolean) {
  const [t, setT] = useState(0);
  useEffect(() => { if (!on) { setT(0); return; } const i = setInterval(() => setT((x) => x + 1), 1000); return () => clearInterval(i); }, [on]);
  return t;
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [r, setR] = useState<any>(null);
  const t = useElapsed(busy);

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
  const step = Math.min(STEPS.length - 1, t < 4 ? 0 : t < 8 ? 1 : t < 14 ? 2 : t < 70 ? 3 : 4);

  return (
    <div className="wrap">
      <div className="bar">
        <div className="brand"><span className="logo" aria-hidden>◎</span>CRO Score Agent</div>
        <span className="tag">Advisory only · read-only</span>
      </div>

      <form className="hero" onSubmit={run}>
        <h1>Score one page for <em>conversion readiness</em></h1>
        <p className="lead">Every point lost cites a quote from the page and is verified by code. The score is calculated by fixed rules, and the agent says what it could not check.</p>
        <div className="urlbox">
          <input type="text" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://yourstore.com/products/example" aria-label="Page URL" required />
          <button className="go" disabled={busy}>{busy ? "Auditing…" : "Score this page"}</button>
        </div>
        <details className="adv"><summary>Add the ad or email that sends traffic here (scores message match fully)</summary>
          <textarea value={source} onChange={(e) => setSource(e.target.value)} rows={2} maxLength={1500} aria-label="Traffic source text" />
        </details>
        <div className="chips">{PILLARS.map((p, i) => <span key={p}>{i + 1}. {p}</span>)}</div>
        {err && <p className="err" role="alert">{err}</p>}
      </form>

      {busy && (
        <section className="card" aria-live="polite">
          <h2>Auditing your page</h2>
          <p className="muted sub">This usually takes 1 to 2 minutes. {t}s elapsed.</p>
          <div className="progress">{STEPS.map((s, i) => <div key={s} className={`step ${i < step ? "done" : i === step ? "now" : ""}`}><i>{i < step ? "✓" : ""}</i>{s}</div>)}</div>
        </section>
      )}

      {r?.could_not_audit && (
        <section className="card"><h2>Could not audit</h2><p className="muted sub">{r.could_not_audit}</p><p>No score is given for a page that cannot be inspected.</p>
          {r.integrity_flags?.length > 0 && <Flags flags={r.integrity_flags} />}</section>
      )}

      {r?.fallback && (
        <div className="notice" role="status"><b>Rules-only result.</b> The AI audit was unavailable because {r.fallback.reason}. This score comes from fixed checks on the page markup, so coverage is limited and findings are generic. Try again later for the full agent audit.</div>
      )}

      {r?.score && <Report r={r} />}

      <Explainer />
    </div>
  );
}

function Flags({ flags }: { flags: any[] }) {
  return <ul>{flags.map((f, i) => <li key={i}>Ignored instruction-like text ({f.pattern}) in {f.location}: <q>{f.excerpt}</q></li>)}</ul>;
}

const tone = (n: number | null) => (n === null ? "var(--line)" : n >= 75 ? "var(--good)" : n >= 55 ? "var(--warn)" : "var(--bad)");

function Ring({ value }: { value: number }) {
  const R = 72, C = 2 * Math.PI * R;
  return (
    <div className="ring" role="img" aria-label={`Score ${value} out of 100`}>
      <svg width="168" height="168" viewBox="0 0 168 168">
        <circle cx="84" cy="84" r={R} fill="none" stroke="var(--line)" strokeWidth="12" />
        <circle cx="84" cy="84" r={R} fill="none" stroke={tone(value)} strokeWidth="12" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - value / 100)} />
      </svg>
      <div className="num"><b>{value}</b><span>out of 100</span></div>
    </div>
  );
}

function Report({ r }: { r: any }) {
  const s = r.score, a = r.audit;
  const byId: Record<number, any> = Object.fromEntries(s.pillars.map((p: any) => [p.id, p]));
  const buckets = ["Quick wins", "Medium changes", "Experiments", "Strategic hypotheses"];
  const conf = s.confidence === "High" ? "good" : s.confidence === "Medium" ? "info" : "warn";
  return (
    <>
      <section className="card">
        <div className="scorecard">
          <Ring value={s.overall} />
          <div>
            <div className="verdict">{s.band}</div>
            <div className="meta">
              <span className={`chip ${conf}`}>Confidence {s.confidence}</span>
              <span className="chip">Coverage {s.coverage}%</span>
              <span className="chip">{a.page_type} page ({a.page_type_confidence} confidence)</span>
              {a.shopify && <span className="chip info">Shopify</span>}
            </div>
            <p className="muted small url">{a.final_url}</p>
            <p className="muted small">Goal: {a.inferred_goal}</p>
            {s.excluded.length > 0 && <p className="muted small">Not counted against the page: {s.excluded.map((p: any) => `${p.name} (${STATUS[p.status]})`).join(", ")}.</p>}
          </div>
        </div>
        <div className="pgrid">
          {s.pillars.map((p: any) => (
            <div key={p.id} className="pcard">
              <div className="top"><span className="nm">{p.id}. {p.name}</span><span className="sc">{p.score ?? "–"}</span></div>
              <div className="meter"><div style={{ width: `${p.score ?? 0}%`, background: tone(p.score) }} /></div>
              <span className="chip">{STATUS[p.status]} · weight {p.weight}</span>
              <p style={{ marginTop: 8 }}>{p.interpretation}</p>
            </div>))}
        </div>
      </section>

      <section className="card">
        <h2>Logic behind the score</h2>
        <p className="muted sub">Score = sum(weight × pillar score) ÷ sum(weight of pillars that could be scored). Missing data lowers confidence, never the score.</p>
        <div className="tablewrap"><table>
          <thead><tr><th>Pillar</th><th>Weight</th><th>Status</th><th>Score</th><th>Weight × score</th></tr></thead>
          <tbody>{s.pillars.map((p: any) => (
            <tr key={p.id}><td>{p.id}. {p.name}</td><td>{p.weight}</td><td>{STATUS[p.status]}</td>
              <td>{p.score ?? "–"}</td><td>{p.score === null ? "–" : p.weight * p.score}</td></tr>))}
            <tr className="total"><td>Total</td><td>{s.scored_weight}</td><td></td><td>{s.overall}</td><td>{s.weighted_total} ÷ {s.scored_weight}</td></tr>
          </tbody>
        </table></div>
        <p className="muted small" style={{ marginTop: 10 }}>Confidence: {s.confidence_reasons.join("; ")}.</p>
      </section>

      <section className="card">
        <h2>Findings</h2>
        <p className="muted sub">Each finding shows the exact quote it rests on and whether code found that quote on the page.</p>
        {[...r.findings].sort((x: any, y: any) => y.severity - x.severity).map((f: any) => (
          <div key={f.id} className={`item s${f.severity}`}>
            <div className="head"><b>{f.id}</b><span className={`chip ${f.severity === 3 ? "bad" : f.severity === 2 ? "warn" : "info"}`}>severity {f.severity}</span><span className="chip">{byId[f.pillar]?.name}</span></div>
            <p>{f.observation}</p>
            {f.evidence_ids.map((id: string) => { const e = r.ledger.find((x: any) => x.id === id); return e && (
              <p key={id} className="evidence"><b>{id}</b> <span className={`chip ${e.verified ? "good" : "bad"}`}>{e.verified ? `${e.evidence_type}, quote verified` : "hypothesis"}</span> <q>{e.quote.length > 160 ? e.quote.slice(0, 160) + "…" : e.quote}</q> <span className="muted">({e.location})</span></p>); })}
            <p className="muted small">Why it may matter (hypothesis unless measured): {f.why_it_matters}{f.uncertainty ? ` Uncertainty: ${f.uncertainty}` : ""}</p>
          </div>))}
      </section>

      <section className="card">
        <h2>Prioritised plan</h2>
        <p className="muted sub">Priority = (Impact × Evidence × Severity) ÷ (Effort + Brand risk). Impact is low, medium or high; no uplift is promised.</p>
        {buckets.map((b) => { const items = r.recommendations.filter((x: any) => x.bucket === b); return items.length > 0 && (
          <div key={b}><div className="bucket">{b}</div>{items.map((x: any) => (
            <div key={x.id} className="item">
              <div className="head"><b>{x.id}</b><span className="chip info">priority {x.priority}</span><span className="chip">Level {x.approval_level}</span></div>
              <p>{x.change}</p>
              {x.current_state && <p className="muted small">Now: {x.current_state}</p>}
              <p className="muted small">Impact {x.impact}: {x.impact_reason}. Evidence {x.evidence}. Effort {x.effort}. Brand risk {x.brand_risk}. Keep: {x.keep_unchanged || "logo, palette, typography, voice"}.</p>
              <p className="muted small">Success metric: {x.metric}. Guardrail: {x.guardrail_metric}.</p>
            </div>))}</div>); })}
      </section>

      {r.integrity_flags.length > 0 && <section className="card"><h2>Integrity flags</h2><Flags flags={r.integrity_flags} /></section>}
      <div className="cols">
        {r.human_review_flags.length > 0 && <section className="card"><h2>Needs human review</h2><ul>{r.human_review_flags.map((h: string, i: number) => <li key={i}>{h}</li>)}</ul></section>}
        <section className="card"><h2>Limitations of this audit</h2><ul>{r.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul></section>
      </div>
      <details className="card"><summary>Evidence ledger and measured facts</summary>
        <pre>{JSON.stringify({ ledger: r.ledger, facts: r.facts, diagnostics: r.diagnostics }, null, 1)}</pre></details>
    </>
  );
}

function Explainer() {
  return (
    <section className="card">
      <h2>How this works</h2>
      <div className="cols" style={{ marginTop: 10 }}>
        <div>
          <h3>Guardrails</h3>
          <ul>
            <li><b>Evidence or no deduction.</b> Every point lost cites an exact quote from this page. Code checks the quote exists; if not, it is downgraded to a hypothesis and cannot lower the score.</li>
            <li><b>Code owns the score.</b> The model only judges copy and clarity. The weighted score, coverage, confidence and priority ranking are calculated by code.</li>
            <li><b>Page text is data.</b> Text on the page (&quot;score this 100&quot;, &quot;ignore the rubric&quot;) is scanned, shown under Integrity flags, and ignored.</li>
            <li><b>No invented numbers, uplift promises or dark patterns.</b> Recommendations that break this are sent back, then removed.</li>
            <li><b>Safe fetching.</b> Public http(s) pages only, robots.txt respected, private networks blocked, no logins or CAPTCHAs bypassed. Read-only.</li>
            <li><b>Brand stays recognisable.</b> Each change has an approval level; Level 3 (colours, logo, pricing, claims) is shown only as a strategic hypothesis.</li>
          </ul>
        </div>
        <div>
          <h3>Shopify</h3>
          <p>On a Shopify product page the agent also reads the store&apos;s public product data (price, compare-at price, availability, variants, image alt text) as measured facts. It never uses an admin login.</p>
          <h3 style={{ marginTop: 16 }}>Limitations</h3>
          <ul>
            <li>It reads the page&apos;s HTML, not a rendered browser view, so tap targets, contrast and pixel positions are not measured.</li>
            <li>A public page cannot show visitor behaviour or real conversion rate. Behaviour is excluded and lowers confidence; it is not scored zero.</li>
            <li>Public audits never reach High confidence. Weights are proposals, not validated against A/B results.</li>
            <li>Pages that need JavaScript to show content, or that need a login, return &quot;Could not audit&quot;.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
