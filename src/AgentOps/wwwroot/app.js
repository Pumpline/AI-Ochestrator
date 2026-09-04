// Agent-Ops Cockpit — ein Modul, kein Framework, kein Build.
// Liest die Read-API, spricht drei Schreibpfade an: Gate, Pipeline starten, Soul committen.

const STEPS = ["plan", "code", "test", "review", "gate", "ship"];
const SOUL_STEPS = ["plan", "code", "test", "review", "ship"];
const HALTED = new Set(["failed", "blocked", "lost", "cancelled"]);

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const main = $("#main");

// ---------- Token und Name ----------
const store = {
  get token() { try { return localStorage.getItem("agentops.token") ?? ""; } catch { return ""; } },
  set token(v) { try { localStorage.setItem("agentops.token", v); } catch {} },
  get name() { try { return localStorage.getItem("agentops.name") ?? ""; } catch { return ""; } },
  set name(v) { try { localStorage.setItem("agentops.name", v); } catch {} },
};

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${store.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new ApiError("Token abgelehnt", 401);
  if (res.status === 503) throw new ApiError("Der Dienst ist nicht bereit (503).", 503);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new ApiError(data?.error ?? data?.detail ?? data?.title ?? `Fehler ${res.status}`, res.status);
  return data;
}
class ApiError extends Error { constructor(m, status) { super(m); this.status = status; } }

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

function askToken(message = "") {
  main.innerHTML = `
    <div class="gate-screen">
      <h1>Agent-Ops</h1>
      <p>${esc(message || "Das Cockpit braucht einmalig den API-Token des AgentOps-Dienstes. Er bleibt in diesem Browser.")}</p>
      <form id="token-form" class="field">
        <label for="token">API-Token</label>
        <input type="text" id="token" autocomplete="off" spellcheck="false" required>
        <label for="name" style="margin-top:10px">Dein Name für Freigaben</label>
        <input type="text" id="name" value="${esc(store.name)}" required>
        <div class="actions" style="margin-top:12px"><button class="btn primary" type="submit">Weiter</button></div>
      </form>
    </div>`;
  $("#token-form").addEventListener("submit", (e) => {
    e.preventDefault();
    store.token = $("#token").value.trim();
    store.name = $("#name").value.trim();
    route();
  });
  $("#token").focus();
}

// ---------- Darstellung ----------
const fmtTime = (iso) => iso ? new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
const fmtUsd = (v) => `${(Number(v) || 0).toFixed(2).replace(".", ",")} $`;
const short = (id) => String(id ?? "").slice(0, 8);

function strip(flow, big = false) {
  const cur = flow.stage || "";
  const idx = STEPS.indexOf(cur);
  const done = flow.status === "succeeded";
  const halted = HALTED.has(flow.status);
  return `<div class="strip${big ? " big" : ""}" role="img" aria-label="Schritt ${esc(cur || "–")}, Status ${esc(flow.status)}">${STEPS.map((s, i) => {
    let cls = "seg";
    if (done || (idx >= 0 && i < idx)) cls += " done";
    if (!done && i === idx) cls += halted ? " failed" : (s === "gate" && flow.gateOpen ? " gate-open" : " current");
    return `<div class="${cls}"><div class="bar"></div><div class="lbl">${s}</div></div>`;
  }).join("")}</div>`;
}

const statusPill = (s) => `<span class="status ${esc(s)}">${esc(s)}</span>`;

// ---------- Seiten ----------
async function pageFlows() {
  const [flows, pipeline] = await Promise.all([api("/flows"), api("/pipeline/flows").catch(() => ({ flows: [] }))]);
  const byId = new Map((pipeline.flows ?? []).map((f) => [f.flowId, f]));
  main.innerHTML = `<h1>Flows</h1><p class="sub">${flows.length} Flows im Log, ${flows.filter((f) => f.gateOpen).length} warten auf dich</p>`;
  if (!flows.length) {
    main.innerHTML += `<div class="empty">Noch kein Flow. Starte eine Pipeline in einem Projekt links — der erste Schritt erscheint hier innerhalb von zehn Sekunden.</div>`;
    return;
  }
  main.innerHTML += `<div class="ledger">${flows.map((f) => {
    const p = byId.get(f.id);
    const goal = p?.goal ?? `Flow ${short(f.id)}`;
    const repo = p?.state?.repo ?? "";
    return `<a class="row" href="#/flows/${esc(f.id)}">
      ${strip(f)}
      <div><div class="goal" title="${esc(goal)}">${esc(goal)}</div><div class="project">${esc(repo || short(f.id))}</div></div>
      <div class="meta">${statusPill(f.status)}<br>${esc(fmtTime(f.updatedAt))}</div>
    </a>`;
  }).join("")}</div>`;
}

async function pageGates() {
  const gates = await api("/gates");
  const pipeline = await api("/pipeline/flows").catch(() => ({ flows: [] }));
  const byId = new Map((pipeline.flows ?? []).map((f) => [f.flowId, f]));
  main.innerHTML = `<h1>Wartet auf dich</h1><p class="sub">${gates.length} offene Gates</p>`;
  if (!gates.length) { main.innerHTML += `<div class="empty">Nichts wartet. Gates erscheinen hier, sobald eine Pipeline vor <span class="mono">ship</span> steht.</div>`; return; }
  main.innerHTML += `<div class="ledger">${gates.map((f) => {
    const p = byId.get(f.id);
    return `<a class="row" href="#/flows/${esc(f.id)}">${strip(f)}<div><div class="goal">${esc(p?.goal ?? short(f.id))}</div><div class="project">${esc(p?.state?.repo ?? "")}</div></div><div class="meta">seit ${esc(fmtTime(f.updatedAt))}</div></a>`;
  }).join("")}</div>`;
}

async function pageFlow(id) {
  const [flow, events, p] = await Promise.all([
    api(`/flows/${encodeURIComponent(id)}`),
    api(`/flows/${encodeURIComponent(id)}/events`),
    api(`/pipeline/flows/${encodeURIComponent(id)}`).catch(() => null),
  ]);
  const goal = p?.goal ?? `Flow ${short(id)}`;
  const state = p?.state ?? {};
  main.innerHTML = `
    <div class="head">
      <h1>${esc(goal)}</h1>
      <p class="sub" style="margin:0">${esc(state.repo ?? "")} &nbsp; ${esc(id)} &nbsp; Revision ${esc(flow.revision)} &nbsp; ${statusPill(flow.status)}</p>
    </div>
    ${strip(flow, true)}
    ${flow.gateOpen ? `
      <div class="gatebox">
        <p>Review ist durch, die Pipeline wartet vor <span class="mono">ship</span>. Prüfe <span class="mono">.agentops/review.md</span> im Repo, dann entscheide.</p>
        <div class="actions">
          <button class="btn primary" id="btn-allow" type="button">Freigeben</button>
          <button class="btn danger" id="btn-deny" type="button">Ablehnen</button>
          <span class="muted">als ${esc(store.name || "cockpit")}</span>
        </div>
      </div>` : ""}
    ${flow.status === "running" && p ? `<div class="actions" style="margin:14px 0"><button class="btn" id="btn-advance" type="button">Schritt als beendet behandeln</button><span class="muted">nur wenn ein Schritt hängt</span></div>` : ""}
    ${flow.status === "failed" || flow.status === "blocked" ? `<div class="error">Stehen geblieben${p?.blockedSummary ? `: ${esc(p.blockedSummary)}` : ""}.</div>` : ""}
    <h2>Zeitleiste</h2>
    ${events.length ? `<div class="events">${events.map((e) => {
      const d = e.data ?? {};
      const kind = e.stream?.startsWith("approval") ? "approval" : (e.type === "flow_completed" ? "flow" : "");
      const detail = d.stage ?? d.approvalId ?? d.status ?? "";
      const actor = d.meta?.actorId ? ` · ${esc(d.meta.actorId)}` : "";
      return `<div class="seq">${e.sequence}</div><div>${esc(fmtTime(e.recordedAt))}</div><div class="type ${kind}">${esc(e.type)}</div><div class="detail">${esc(detail)}${actor}${d.reason ? ` — ${esc(d.reason)}` : ""}</div>`;
    }).join("")}</div>` : `<div class="empty">Noch keine Events.</div>`}`;

  $("#btn-allow")?.addEventListener("click", () => decide(id, "allow"));
  $("#btn-deny")?.addEventListener("click", () => decide(id, "deny"));
  $("#btn-advance")?.addEventListener("click", async () => {
    if (!confirm("Den aktuellen Schritt als beendet behandeln?")) return;
    try {
      await api(`/pipeline/flows/${encodeURIComponent(id)}/advance`, { method: "POST", body: { by: store.name || "cockpit" } });
      toast("Schritt weitergeschaltet"); setTimeout(route, 800);
    } catch (e) { toast(e.message); }
  });
}

async function decide(id, decision) {
  const verb = decision === "allow" ? "Freigeben" : "Ablehnen";
  if (!confirm(`${verb}?`)) return;
  try {
    await api(`/flows/${encodeURIComponent(id)}/gate`, { method: "POST", body: { decision, by: store.name || "cockpit" } });
    toast(decision === "allow" ? "Freigegeben — ship läuft" : "Abgelehnt");
    setTimeout(route, 800);
  } catch (e) { toast(e.message); }
}

async function pageProject(name) {
  const [souls, pipeline] = await Promise.all([api(`/projects/${encodeURIComponent(name)}/souls`), api("/pipeline/flows").catch(() => ({ flows: [] }))]);
  const runs = (pipeline.flows ?? []).filter((f) => f.state?.repo === name).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 5);
  main.innerHTML = `
    <h1>${esc(name)}</h1>
    <p class="sub">/repos/${esc(name)}</p>
    <form id="run-form" class="field">
      <label for="goal">Was soll die Pipeline in diesem Repo tun?</label>
      <textarea id="goal" required style="min-height:74px" placeholder="Zum Beispiel: Add divide(a, b) with a test for division by zero"></textarea>
      <div class="actions"><button class="btn primary" type="submit">Pipeline starten</button><span class="muted">plan → code → test → review → Gate → ship</span></div>
    </form>
    ${runs.length ? `<h2>Letzte Läufe</h2><div class="ledger">${runs.map((f) => `<a class="row" href="#/flows/${esc(f.flowId)}">${strip({ stage: f.currentStep, status: f.status, gateOpen: f.status === "waiting" && f.wait?.kind === "gate" })}<div><div class="goal">${esc(f.goal)}</div></div><div class="meta">${statusPill(f.status)}</div></a>`).join("")}</div>` : ""}
    <h2>Souls</h2>
    <p class="muted" style="max-width:64ch;margin:0 0 16px">Jeder Schritt hat eine Standard-Soul im Agenten. Was du hier speicherst, gilt nur für dieses Projekt und wird als <span class="mono">.agentops/souls/&lt;schritt&gt;.md</span> ins Repo committet.</p>
    ${SOUL_STEPS.map((s) => {
      const d = souls[s] ?? {};
      const hasOverride = d.override != null;
      return `<section class="soul" data-step="${s}">
        <h3>${s} <span class="tag ${hasOverride ? "override" : ""}">${hasOverride ? "Projekt-Override" : "Standard des Agenten"}</span></h3>
        <textarea id="soul-${s}" spellcheck="false">${esc(hasOverride ? d.override : (d.default ?? ""))}</textarea>
        <div class="actions">
          <button class="btn" type="button" data-save="${s}">Soul speichern</button>
          ${hasOverride ? `<button class="btn" type="button" data-reset="${s}">Override entfernen</button>` : ""}
        </div>
      </section>`;
    }).join("")}`;

  $("#run-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#run-form button"); btn.disabled = true;
    try {
      const flow = await api(`/projects/${encodeURIComponent(name)}/runs`, { method: "POST", body: { goal: $("#goal").value } });
      toast("Pipeline gestartet"); location.hash = `#/flows/${flow.flowId}`;
    } catch (err) { toast(err.message); btn.disabled = false; }
  });
  main.querySelectorAll("[data-save]").forEach((b) => b.addEventListener("click", async () => {
    const s = b.dataset.save;
    try {
      const r = await api(`/projects/${encodeURIComponent(name)}/souls/${s}`, { method: "PUT", body: { text: $(`#soul-${s}`).value } });
      toast(`Soul ${s} gespeichert, Commit ${r.commit}`); pageProject(name);
    } catch (err) { toast(err.message); }
  }));
  main.querySelectorAll("[data-reset]").forEach((b) => b.addEventListener("click", async () => {
    const s = b.dataset.reset;
    if (!confirm(`Override für ${s} entfernen? Danach gilt wieder die Standard-Soul.`)) return;
    try { await api(`/projects/${encodeURIComponent(name)}/souls/${s}`, { method: "DELETE" }); toast(`Override ${s} entfernt`); pageProject(name); }
    catch (err) { toast(err.message); }
  }));
}

async function pageCosts() {
  const c = await api("/costs");
  const rows = (c.byAgent ?? []).map((a) => ({ agent: a.agent, total: a.usd, week: (c.byAgent7d ?? []).find((x) => x.agent === a.agent)?.usd ?? 0 }))
    .sort((a, b) => b.total - a.total);
  main.innerHTML = `
    <h1>Kosten</h1>
    <p class="sub">aus Prometheus, Zähler seit dem letzten Gateway-Start</p>
    <div class="kpi">${esc(fmtUsd(c.totalSinceStart))}<small>seit Gateway-Start</small></div>
    <h2>Je Soul</h2>
    ${rows.length ? `<table><thead><tr><th>Agent</th><th class="num">7 Tage</th><th class="num">seit Start</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="mono">${esc(r.agent)}</td><td class="num">${esc(fmtUsd(r.week))}</td><td class="num">${esc(fmtUsd(r.total))}</td></tr>`).join("")}</tbody></table>` : `<div class="empty">Noch keine Kosten gemessen.</div>`}
    <h2>Tokens nach Art</h2>
    ${(c.tokens ?? []).length ? `<table><thead><tr><th>Art</th><th class="num">Tokens</th></tr></thead><tbody>${c.tokens.map((t) => `<tr><td class="mono">${esc(t.kind)}</td><td class="num">${Math.round(t.count).toLocaleString("de-DE")}</td></tr>`).join("")}</tbody></table>` : ""}
    <p class="muted" style="max-width:60ch;margin-top:18px">„prompt" ist der gesamte Kontext je Modellaufruf. Er ist die Kostenstelle, nicht die Antwort — kurze Souls und kurze Tool-Listen sind der Hebel.</p>`;
}

// ---------- Rail und Routing ----------
async function loadRail() {
  try {
    const [projects, gates] = await Promise.all([api("/projects"), api("/gates")]);
    $("#rail-projects").innerHTML = projects.map((p) => `<a class="nav" data-route="projects/${esc(p.name)}" href="#/projects/${esc(p.name)}">${esc(p.name)}</a>`).join("") || `<div class="muted" style="padding:6px 10px;font-size:12px">Kein Repo unter /repos</div>`;
    const gc = $("#gate-count"); gc.textContent = String(gates.length); gc.hidden = gates.length === 0;
    markActive();
  } catch (e) { if (e.status === 401) askToken("Der gespeicherte Token wurde abgelehnt. Bitte neu eingeben."); }
}

function markActive() {
  const h = location.hash.replace(/^#\//, "");
  document.querySelectorAll(".nav").forEach((a) => a.classList.toggle("active", h.startsWith(a.dataset.route)));
}

let refresh = null;
async function route() {
  clearInterval(refresh);
  if (!store.token) return askToken();
  const parts = location.hash.replace(/^#\//, "").split("/").filter(Boolean);
  const [page, arg] = [parts[0] || "flows", parts[1] ? decodeURIComponent(parts[1]) : undefined];
  markActive();
  try {
    if (page === "flows" && arg) { await pageFlow(arg); refresh = setInterval(() => pageFlow(arg).catch(() => {}), 10000); }
    else if (page === "flows") { await pageFlows(); refresh = setInterval(() => pageFlows().catch(() => {}), 10000); }
    else if (page === "gates") { await pageGates(); refresh = setInterval(() => pageGates().catch(() => {}), 10000); }
    else if (page === "projects" && arg) await pageProject(arg);
    else if (page === "costs") await pageCosts();
    else { location.hash = "#/flows"; return; }
    loadRail();
  } catch (e) {
    if (e.status === 401) return askToken("Der gespeicherte Token wurde abgelehnt. Bitte neu eingeben.");
    main.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

window.addEventListener("hashchange", route);
$("#btn-token").addEventListener("click", () => askToken("Neuen Token eingeben."));
route();
