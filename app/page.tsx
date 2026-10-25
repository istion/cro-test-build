"use client";
import { useEffect, useState } from "react";

/** Display names for the pillar statuses the score engine returns. */
const STATUS: Record<string, string> = { scored: "Scored", partial: "Partial", not_applicable: "Not applicable", needs_data: "Needs data", could_not_test: "Could not test" };

/** Progress steps shown while an audit runs. They are an estimate by elapsed time, not live server events. */
const STEPS = ["Fetching the page and checking robots.txt", "Reading the page facts", "Measuring speed", "Judging the eight pillars with evidence", "Verifying every quote and scoring in code"];
/** Short pillar names shown as chips in the hero (same order as pillars 1 to 8). */
const PILLARS = ["Value proposition", "Message match", "CTA and friction", "Offer and pricing", "Trust", "Hierarchy, mobile, accessibility", "Speed", "Behaviour data"];

/** Counts whole seconds while `on` is true and resets to 0 when it turns off. Drives the elapsed timer and the progress steps. */
function useElapsed(on: boolean) {
  const [t, setT] = useState(0);
  useEffect(() => { if (!on) { setT(0); return; } const i = setInterval(() => setT((x) => x + 1), 1000); return () => clearInterval(i); }, [on]);
  return t;
}


/** History settings. Reports are kept in this browser's localStorage under HKEY for 72 hours (TTL), at most MAX_ENTRIES of them. */
const HKEY = "cro-history-v1", TTL = 72 * 3600_000, MAX_ENTRIES = 12;
/** Reasons offered before a new model run is allowed for a page that already has a saved report. */
const REASONS = ["The page has changed since the last audit", "I am testing a different traffic source or goal", "The earlier result looked wrong", "Another reason"];
/** One saved report: the normalised page key, the URL shown, when it was saved, why a re-run was requested (if it was), and the full result. */
type Entry = { key: string; url: string; at: number; reason?: string; r: any };

/** Same page, however it was typed: no www, no hash, no tracking parameters, no trailing slash. */
function pageKey(u: string) {
  try {
    const x = new URL(/^https?:\/\//i.test(u.trim()) ? u.trim() : `https://${u.trim()}`);
    [...x.searchParams.keys()].filter((k) => /^(utm_|fbclid|gclid|mc_)/i.test(k)).forEach((k) => x.searchParams.delete(k));
    return x.host.toLowerCase().replace(/^www\./, "") + (x.pathname.replace(/\/+$/, "") || "") + x.search;
  } catch { return u.trim().toLowerCase(); }
}
/** Reads saved reports, dropping any older than 72 hours. Returns [] if storage is empty, blocked or corrupt. */
function loadHistory(): Entry[] {
  try { const a = JSON.parse(localStorage.getItem(HKEY) ?? "[]") as Entry[]; return a.filter((e) => Date.now() - e.at < TTL); } catch { return []; }
}
/** Writes the newest reports first. If the browser's storage is full, drops the oldest entry until the write succeeds. */
function saveHistory(list: Entry[]) {
  let l = list.slice(0, MAX_ENTRIES);
  while (l.length) { try { localStorage.setItem(HKEY, JSON.stringify(l)); return; } catch { l = l.slice(0, -1); } }
  try { localStorage.removeItem(HKEY); } catch { /* storage unavailable */ }
}
/** Plain-language age such as "5 minutes ago", "3 hours ago" or "2 days ago". */
function ago(ms: number) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hour${h === 1 ? "" : "s"} ago` : `${Math.round(h / 24)} days ago`;
}
/**
 * Opens the browser print window so the user can choose "Save as PDF". The page title becomes the suggested file name
 * (CRO report <host> <date>) and is restored afterwards. The print stylesheet in globals.css shapes the output.
 */
function printReport(url: string) {
  const old = document.title;
  let host = "page"; try { host = new URL(url).host.replace(/^www\./, ""); } catch { /* keep default */ }
  document.title = `CRO report ${host} ${new Date().toISOString().slice(0, 10)}`;
  const restore = () => { document.title = old; window.removeEventListener("afterprint", restore); };
  window.addEventListener("afterprint", restore);
  window.print();
}

/**
 * The whole page: the URL form, progress, saved-report notice, history list and the audit report, with the explainer at the bottom.
 *
 * Submitting a page that was audited in the last 72 hours shows the saved report instead of calling the model; a new run needs a reason.
 */
export default function Home() {
  const [url, setUrl] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [r, setR] = useState<any>(null);
  const [hist, setHist] = useState<Entry[]>([]);
  const [saved, setSaved] = useState<Entry | null>(null); // set while the report on screen comes from history
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const t = useElapsed(busy);
  // Read saved reports after the first render (localStorage does not exist during server rendering).
  useEffect(() => { setHist(loadHistory()); }, []);

  /**
   * Runs a new audit through the API and shows the result.
   * Only full model audits with a score are saved to history; rules-only and could-not-audit results are not, so they never block a proper run.
   * @param why  the reason the user gave for re-running, stored with the new entry
   */
  async function audit(why?: string) {
    setBusy(true); setErr(""); setR(null); setSaved(null); setAsking(false);
    try {
      const res = await fetch("/api/audit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, trafficSource: source || undefined }) });
      // The body can begin with heartbeat spaces, which JSON.parse ignores. An unreadable body means the server was cut off.
      const j = await res.text().then((t) => JSON.parse(t)).catch(() => null);
      if (!j) setErr("The audit took too long and the server stopped it. Please try again.");
      else if (!res.ok || j.error) setErr(j.error ?? "Something went wrong");
      else {
        setR(j);
        // Only full model audits are kept. A rules-only or could-not-audit result should not block a proper run.
        if (j.score && !j.fallback) {
          const key = pageKey(url);
          const next = [{ key, url: j.audit?.final_url ?? url, at: Date.now(), reason: why, r: j }, ...loadHistory().filter((e) => e.key !== key)];
          saveHistory(next); setHist(loadHistory());
        }
      }
    } catch { setErr("The connection dropped before the audit finished. Please try again; if it keeps happening, your network may be cutting long requests."); }
    setBusy(false);
  }

  /** Form submit. If the same page (however typed) has a saved report from the last 72 hours, show it and do not call the API. */
  function run(e: React.FormEvent) {
    e.preventDefault();
    const hit = loadHistory().find((x) => x.key === pageKey(url));
    if (hit) { setErr(""); setR(hit.r); setSaved(hit); setAsking(false); setReason(""); return; }
    audit();
  }

  /** Opens a saved report from the history list without any model call. */
  function open(en: Entry) { setUrl(en.url); setErr(""); setR(en.r); setSaved(en); setAsking(false); setReason(""); window.scrollTo({ top: 0, behavior: "smooth" }); }
  /** Deletes every saved report from this browser. */
  function clearHistory() { try { localStorage.removeItem(HKEY); } catch { /* ignore */ } setHist([]); }
  // Which progress step is active, chosen by elapsed seconds; the last step stays active until the result arrives.
  const step = Math.min(STEPS.length - 1, t < 4 ? 0 : t < 8 ? 1 : t < 14 ? 2 : t < 70 ? 3 : 4);

  return (
    <div className="wrap">
      {/* Top bar */}
      <div className="bar">
        <div className="brand"><span className="logo" aria-hidden>◎</span>CRO Score Agent</div>
        <span className="tag">Advisory only · read-only</span>
      </div>

      {/* Hero: headline, URL box, optional traffic-source text, pillar chips and any error */}
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

      {/* Recent audits: click one to reopen it without a model run */}
      {!busy && hist.length > 0 && (
        <section className="card noprint">
          <div className="row"><h2>Recent audits</h2><button className="link" onClick={clearHistory}>Clear history</button></div>
          <p className="muted sub">Saved in this browser for 72 hours. Opening one does not use the model.</p>
          <div className="hlist">{hist.map((e) => (
            <button key={e.key} className="hrow" onClick={() => open(e)}>
              <span className="hurl">{e.url.replace(/^https?:\/\/(www\.)?/, "")}</span>
              <span className="chip">{e.r.score.overall}/100</span>
              <span className="muted small">{ago(Date.now() - e.at)}</span>
            </button>))}</div>
        </section>
      )}

      {/* Notice shown while the report on screen is a saved one, with the reason prompt for a new run */}
      {saved && !busy && (
        <div className="notice noprint" role="status">
          <b>Showing the saved report from {ago(Date.now() - saved.at)}.</b> This page was audited within the last 72 hours, so no new model run was started.
          {!asking && <div className="actions"><button className="btn" onClick={() => setAsking(true)}>Run a new audit</button></div>}
          {asking && (
            <div className="ask">
              <p>A new run uses the model and can change the score. Why do you need one?</p>
              <select value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for a new audit">
                <option value="">Choose a reason</option>{REASONS.map((x) => <option key={x}>{x}</option>)}
              </select>
              <div className="actions">
                <button className="btn primary" disabled={!reason} onClick={() => audit(reason)}>Yes, run a new audit</button>
                <button className="btn" onClick={() => setAsking(false)}>Keep this report</button>
              </div>
            </div>)}
        </div>
      )}

      {/* Progress card while the audit runs */}
      {busy && (
        <section className="card" aria-live="polite">
          <h2>Auditing your page</h2>
          <p className="muted sub">This usually takes 1 to 2 minutes. {t}s elapsed.</p>
          <div className="progress">{STEPS.map((s, i) => <div key={s} className={`step ${i < step ? "done" : i === step ? "now" : ""}`}><i>{i < step ? "✓" : ""}</i>{s}</div>)}</div>
        </section>
      )}

      {/* The page could not be read: no score, only the reason */}
      {r?.could_not_audit && (
        <section className="card"><h2>Could not audit</h2><p className="muted sub">{r.could_not_audit}</p><p>No score is given for a page that cannot be inspected.</p>
          {r.integrity_flags?.length > 0 && <Flags flags={r.integrity_flags} />}</section>
      )}

      {/* Rules-only result notice */}
      {r?.fallback && (
        <div className="notice" role="status"><b>Rules-only result.</b> The AI audit was unavailable because {r.fallback.reason}. This score comes from fixed checks on the page markup, so coverage is limited and findings are generic. Try again later for the full agent audit.</div>
      )}

      {/* The report */}
      {r?.score && <Report r={r} at={saved?.at} />}

      {/* How the agent works, guardrails and limitations */}
      <Explainer />
    </div>
  );
}

/** Lists the instruction-like passages found on the page. They were flagged and ignored, never obeyed. */
function Flags({ flags }: { flags: any[] }) {
  return <ul>{flags.map((f, i) => <li key={i}>Ignored instruction-like text ({f.pattern}) in {f.location}: <q>{f.excerpt}</q></li>)}</ul>;
}

/** Colour for a score: green from 75, amber from 55, red below; grey when the pillar has no score. */
const tone = (n: number | null) => (n === null ? "var(--line)" : n >= 75 ? "var(--good)" : n >= 55 ? "var(--warn)" : "var(--bad)");

/** Circular score gauge drawn in SVG. The arc length is the score's share of the circle's circumference. */
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

/**
 * The audit report: score and pillar cards, the logic table, findings with verified quotes, the prioritised plan, flags and limitations.
 * @param at  when a saved report was produced, shown in the PDF header (defaults to now)
 */
function Report({ r, at }: { r: any; at?: number }) {
  // s = score engine output, a = audit details (URL, page type, goal).
  const s = r.score, a = r.audit;
  // Pillar lookup so a finding can show its pillar's name.
  const byId: Record<number, any> = Object.fromEntries(s.pillars.map((p: any) => [p.id, p]));
  // Display order of the plan groups.
  const buckets = ["Quick wins", "Medium changes", "Experiments", "Strategic hypotheses"];
  // Colour of the confidence chip.
  const conf = s.confidence === "High" ? "good" : s.confidence === "Medium" ? "info" : "warn";
  return (
    <>
      {/* Header that only appears in the printed or PDF version */}
      <div className="printhead"><b>CRO Score Agent report</b><span>{a.final_url} · {new Date(at ?? Date.now()).toLocaleString()}</span></div>
      {/* PDF button (hidden when printing) */}
      <div className="exportbar noprint"><button className="btn" onClick={() => printReport(a.final_url)}>Download as PDF</button><span className="muted small">Opens your browser&apos;s print window. Choose &quot;Save as PDF&quot;.</span></div>
      <section className="card">
        {/* Score ring and headline facts */}
        <div className="scorecard">
          <Ring value={s.overall} />
          <div>
            <div className="verdict">{s.band}</div>
            <div className="meta">
              <span className={`chip ${conf}`}>Confidence {s.confidence}</span>
              <span className="chip">Coverage {s.coverage}%</span>
              <span className="chip">{a.page_type} page ({a.page_type_confidence} confidence)</span>
            </div>
            <p className="muted small url">{a.final_url}</p>
            <p className="muted small">Goal: {a.inferred_goal}</p>
            {s.excluded.length > 0 && <p className="muted small">Not counted against the page: {s.excluded.map((p: any) => `${p.name} (${STATUS[p.status]})`).join(", ")}.</p>}
          </div>
        </div>
        {/* One card per pillar: score, bar, status, weight and what was judged */}
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
        {/* Shows every number behind the total so the score can be checked by hand */}
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
        {/* Most severe first; each cites the quote it rests on and whether code found that quote on the page */}
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
        {/* Recommendations grouped by effort bucket, ranked by the priority formula */}
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

      {/* Manipulation attempts found on the page */}
      {r.integrity_flags.length > 0 && <section className="card"><h2>Integrity flags</h2><Flags flags={r.integrity_flags} /></section>}
      {/* Human-review items and limitations side by side */}
      <div className="cols">
        {r.human_review_flags.length > 0 && <section className="card"><h2>Needs human review</h2><ul>{r.human_review_flags.map((h: string, i: number) => <li key={i}>{h}</li>)}</ul></section>}
        <section className="card"><h2>Limitations of this audit</h2><ul>{r.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul></section>
      </div>
      {/* Raw evidence for anyone who wants to check the audit (not in the PDF) */}
      <details className="card noprint"><summary>Evidence ledger and measured facts</summary>
        <pre>{JSON.stringify({ ledger: r.ledger, facts: r.facts, diagnostics: r.diagnostics }, null, 1)}</pre></details>
    </>
  );
}

/** Static explanation of the design: why this is an agent, how it differs from a generic CRO prompt, the guardrails, the score logic and the limitations. */
function Explainer() {
  return (
    <section className="card noprint" id="how">
      <h2>How this agent works, and why it is built this way</h2>
      <p className="muted sub">Each section below answers one question about the design.</p>

      <div className="qa">
        <h3>1. Why is this an agent and not just a prompt?</h3>
        <p>It does a job end to end: it fetches the page safely, reads the page and the store&apos;s public data, measures speed, asks the model to judge the parts that need judgement, checks the model&apos;s answers against what was actually fetched, scores the result with fixed rules, and ranks what to fix first. The model is one step in that chain, not the whole thing. It is a fixed pipeline with one correction pass, not an open-ended loop that browses on its own, which keeps every run predictable and auditable.</p>
      </div>

      <div className="qa">
        <h3>2. Why is it better than a generic CRO chatbot?</h3>
        <div className="tablewrap"><table className="cmp">
          <thead><tr><th></th><th>A generic CRO prompt</th><th>This agent</th></tr></thead>
          <tbody>
            <tr><td>Where the score comes from</td><td>The model picks a number, so it changes between runs</td><td>Code calculates it from pillar scores and published weights</td></tr>
            <tr><td>Advice</td><td>&quot;Improve your CTA&quot; and other tips that fit any site</td><td>Each finding quotes this page, for example the exact button label</td></tr>
            <tr><td>Proof</td><td>Claims you must trust</td><td>Every quote is searched for on the fetched page; failures become hypotheses</td></tr>
            <tr><td>Missing data</td><td>Guesses, or silently scores low</td><td>Marked &quot;needs data&quot; and lowers confidence, not the score</td></tr>
            <tr><td>Page type</td><td>One rubric for everything</td><td>Weights differ for product, collection, landing, homepage, checkout and lead pages</td></tr>
            <tr><td>Prioritising</td><td>A long list</td><td>Ranked by impact, evidence, severity, effort and brand risk, with an approval level</td></tr>
            <tr><td>Manipulation</td><td>Obeys text hidden on the page</td><td>Page text is treated as data; instruction-like text is flagged and ignored</td></tr>
            <tr><td>Honesty</td><td>Sounds certain</td><td>States what it could not check and never promises an uplift</td></tr>
          </tbody>
        </table></div>
      </div>

      <div className="qa">
        <h3>3. Guardrails</h3>
        <ul>
          <li><b>Evidence or no deduction.</b> Every point lost cites an exact quote. Code confirms the quote exists on the fetched page; if not, it is downgraded to a hypothesis and cannot lower the score.</li>
          <li><b>Code owns the score.</b> The model only judges copy and clarity. The weighted total, coverage, confidence and priority ranking are calculated by code, so the model cannot be talked into a higher number. Scores are snapped to steps of 5 as the rubric defines.</li>
          <li><b>Page text is data.</b> Text on the page such as &quot;score this 100&quot; or &quot;ignore the rubric&quot; is scanned, wrapped as untrusted, shown under Integrity flags, and ignored.</li>
          <li><b>No invented numbers, uplift promises or dark patterns.</b> A recommendation that promises a percentage lift, suggests fake urgency, pre-ticked boxes or hidden costs is sent back, then removed.</li>
          <li><b>Safe fetching.</b> Public http(s) pages only. robots.txt is respected, private and internal addresses are blocked, redirects are checked, size and time are capped, and no login or CAPTCHA is bypassed. The agent is read-only.</li>
          <li><b>Brand stays recognisable.</b> Each change has an approval level. Level 3 changes (colours, logo, pricing, offer terms, claims) are shown only as strategic hypotheses for the owner to approve.</li>
          <li><b>Regulated claims go to a person.</b> Health, financial and &quot;guaranteed&quot; claims are flagged for human review. The agent does not rule on legality.</li>
          <li><b>Never a silent failure.</b> If the page cannot be read, it says &quot;Could not audit&quot; instead of guessing. If the model is unavailable, a rules-only result is returned and clearly labelled.</li>
        </ul>
      </div>

      <div className="qa">
        <h3>4. Logic behind the score</h3>
        <ul>
          <li><b>Eight pillars:</b> value proposition, message match, CTA and friction, offer and pricing, trust, hierarchy and accessibility, speed, and behaviour data. Each pillar has written anchors for 0, 50 and 100.</li>
          <li><b>Weights depend on the page type.</b> For example, CTA and friction weighs 16 on a product page but 32 on checkout, and message match is 0 on checkout.</li>
          <li><b>Formula:</b> score = sum(weight × pillar score) ÷ sum(weight of pillars that could be scored). A pillar with no data is left out of both sides, so missing data cannot drag the score down.</li>
          <li><b>Speed is scored by code</b> from Core Web Vitals bands (LCP, CLS, INP) when PageSpeed data is available. Behaviour data is never scored on a public page.</li>
          <li><b>Confidence is separate from the score.</b> It falls when coverage is low, the page type is unclear, A/B tooling or a consent banner is present, or only static HTML was read. Public audits are capped at Medium.</li>
          <li><b>Priority</b> = (Impact × Evidence × Severity) ÷ (Effort + Brand risk). Measured evidence outranks observed, which outranks hypothesis. The table above shows every number used.</li>
        </ul>
      </div>

      <div className="qa">
        <h3>5. Limitations</h3>
        <ul>
          <li><b>Static HTML only.</b> Pages that need JavaScript to show content return &quot;Could not audit&quot;. Tap targets, contrast, screenshots and pixel positions are not measured.</li>
          <li><b>No visitor data.</b> A public page cannot show real conversion rate or where people drop off, so the behaviour pillar is excluded and confidence stays at Medium or below.</li>
          <li><b>Judgement is the model&apos;s.</b> Pillar scores for copy and clarity come from a language model and can vary between runs on the same page, even though the arithmetic is fixed. Treat the score as a prioritisation aid, not a verdict.</li>
          <li><b>Weights are proposals.</b> They are not validated against expert audits or A/B results. A score does not predict revenue, and only a valid experiment shows what raises conversion.</li>
          <li><b>Message match needs your ad or email text.</b> Without it, that pillar is only partly scored.</li>
          <li><b>Access and speed.</b> Some sites block automated requests. An audit takes about one to two minutes, and when the model is busy you get the rules-only result.</li>
          <li><b>Advisory only.</b> A person should review the output before it goes to a client, and Level 2 and 3 changes need the owner&apos;s approval.</li>
        </ul>
      </div>
    </section>
  );
}
