// Agent-Ops Cockpit — ein Modul, kein Framework, kein Build.
// Anmeldung über Discord (Cookie-Session); der Bearer-Token bleibt als Fallback für Umgebungen ohne Discord.

import { mountProjectMap, fmtDuration, fmtTokens } from "/map.js";

const STEPS = ["plan", "code", "test", "review", "gate", "ship"];
const SOUL_STEPS = ["plan", "code", "test", "review", "ship"];
// OpenClaws Thinking-Level — im Cockpit „Effort“. Was ein Modell davon kann, entscheidet OpenClaw beim Lauf.
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"];
const thinkingOptions = (current, fallbackLabel) => `<option value=""${!current ? " selected" : ""}>${esc(fallbackLabel)}</option>` + THINKING.map((t) => `<option value="${t}"${t === current ? " selected" : ""}>${t}</option>`).join("");
const HALTED = new Set(["failed", "blocked", "lost", "cancelled"]);
const NAV = [
  { route: "", title: "Dashboard", icon: "dashboard" },
  { route: "flows", title: "Flows", icon: "workflow" },
  { route: "gates", title: "Freigaben", icon: "shield", badge: "gates" },
  { route: "agents", title: "Agenten", icon: "cpu" },
  { route: "costs", title: "Kosten", icon: "coins" },
];
const LOGIN_ERRORS = {
  state: "Die Anmeldung ist abgelaufen oder wurde verändert. Bitte noch einmal.",
  exchange: "Discord hat die Anmeldung abgelehnt. Bitte noch einmal.",
  token: "Discord hat kein Zugriffstoken geliefert. Bitte noch einmal.",
  profile: "Dein Discord-Profil konnte nicht gelesen werden. Bitte noch einmal.",
  "not-provisioned": "Dieses Discord-Konto hat keinen Zugang. Es muss in der Allowlist stehen.",
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (name, cls = "icon") => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const app = $("#app");

const store = {
  get token() { try { return localStorage.getItem("agentops.token") ?? ""; } catch { return ""; } },
  set token(v) { try { v ? localStorage.setItem("agentops.token", v) : localStorage.removeItem("agentops.token"); } catch {} },
};
let me = null;

class ApiError extends Error { constructor(m, status) { super(m); this.status = status; } }
async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (store.token) headers.Authorization = `Bearer ${store.token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: "same-origin" });
  if (res.status === 401) throw new ApiError("Nicht angemeldet", 401);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new ApiError(data?.error ?? data?.detail ?? data?.title ?? `Fehler ${res.status}`, res.status);
  return data;
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`; el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

// ---------- Format ----------
const fmtDate = (v) => { const d = typeof v === "number" ? new Date(v) : new Date(v); return isNaN(d) ? "" : d.toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); };
const timeAgo = (v) => {
  const t = typeof v === "number" ? v : new Date(v).getTime(); if (!t) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "gerade eben"; const m = Math.round(s / 60); if (m < 60) return `vor ${m} min`;
  const h = Math.round(m / 60); if (h < 24) return `vor ${h} h`; const d = Math.round(h / 24); return `vor ${d} d`;
};
const usd = (v) => `${(Number(v) || 0).toFixed(2).replace(".", ",")} $`;
const short = (id) => String(id ?? "").slice(0, 8);

function strip(flow, big = false) {
  const cur = flow.stage || ""; const idx = STEPS.indexOf(cur);
  const done = flow.status === "succeeded"; const halted = HALTED.has(flow.status);
  return `<div class="strip${big ? " strip--big" : ""}" role="img" aria-label="Schritt ${esc(cur || "–")}, ${esc(flow.status)}">${STEPS.map((s, i) => {
    let cls = "seg";
    if (done || (idx >= 0 && i < idx)) cls += " done";
    if (!done && i === idx) cls += halted ? " failed" : (s === "gate" && flow.gateOpen ? " gate" : " current");
    return `<div class="${cls}"><div class="bar"></div><div class="lbl">${s}</div></div>`;
  }).join("")}</div>`;
}
const statusDot = (s) => `<span class="status-dot ${esc(s)}">${esc(s)}</span>`;
const card = (title, iconName, body, link = "") => `<section class="card"><div class="card__header"><div class="card__title">${icon(iconName)}${esc(title)}</div>${link}</div>${body}</section>`;

// ---------- Login ----------
async function renderLogin() {
  const err = new URLSearchParams(location.hash.split("?")[1] ?? "").get("error");
  let ready = null;
  try { ready = (await api("/auth/discord/status")).oauthReady; } catch { ready = false; }
  app.innerHTML = `
    <div class="login"><section class="card"><div class="login__body">
      <div class="login__brand">
        <div class="logo">${icon("activity")}</div>
        <div><h1>Agent-Ops</h1><p>Anmeldung zum Cockpit</p></div>
      </div>
      ${err ? `<div class="alert alert--danger">${icon("alert")}<span>${esc(LOGIN_ERRORS[err] ?? "Anmeldung fehlgeschlagen. Bitte noch einmal.")}</span></div>` : ""}
      ${ready ? `<button class="btn btn--discord" id="btn-discord" type="button">${icon("discord")}Mit Discord anmelden</button>`
              : `<div class="login__note">Discord-Anmeldung ist noch nicht eingerichtet. Solange geht es mit dem API-Token.</div>
                 <form id="token-form" class="field"><label class="field__label" for="token">API-Token</label><input class="input mono" id="token" autocomplete="off" spellcheck="false" required><div class="actions" style="margin-top:6px"><button class="btn btn--primary" type="submit">Weiter</button></div></form>`}
    </div></section></div>`;
  $("#btn-discord")?.addEventListener("click", () => { location.href = "/api/auth/discord/login"; });
  $("#token-form")?.addEventListener("submit", (e) => { e.preventDefault(); store.token = $("#token").value.trim(); boot(); });
}

// ---------- Shell ----------
function renderShell() {
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <a class="sidebar__brand" href="#/"><div class="logo">${icon("activity")}</div><div><div class="sidebar__title">Agent-Ops</div><div class="sidebar__sub">Kontrollebene</div></div></a>
        <div class="sidebar__group" id="nav-main">${NAV.map((n) => `<a class="nav-item" data-route="${n.route}" href="#/${n.route}">${icon(n.icon)}<span>${esc(n.title)}</span>${n.badge ? `<span class="count warn" id="badge-${n.badge}" hidden>0</span>` : ""}</a>`).join("")}</div>
        <div class="sidebar__label">Projekte</div>
        <div class="sidebar__group" id="nav-projects"></div>
        <div class="sidebar__foot">
          <div class="avatar">${me?.avatarUrl ? `<img src="${esc(me.avatarUrl)}" alt="">` : esc((me?.displayName ?? "?").slice(0, 2).toUpperCase())}</div>
          <div class="sidebar__user"><div class="name">${esc(me?.displayName ?? "API-Token")}</div><div class="role">${me ? (me.root ? "Root" : "Operator") : "ohne Session"}</div></div>
          <button class="btn btn--ghost btn--sm" id="btn-logout" type="button" title="Abmelden">${icon("logout")}</button>
        </div>
      </aside>
      <div class="content">
        <header class="topbar"><span class="topbar__title" id="page-title">Dashboard</span><span class="topbar__crumb" id="page-crumb"></span><div class="topbar__right"><span class="live" id="live">verbunden</span></div></header>
        <main class="page"><div class="container" id="page"></div></main>
      </div>
    </div>`;
  $("#btn-logout").addEventListener("click", async () => {
    try { await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }); } catch {}
    store.token = ""; me = null; location.hash = "#/login"; boot();
  });
}
const page = () => $("#page");
function setTitle(title, crumb = "") { $("#page-title").textContent = title; $("#page-crumb").textContent = crumb; document.title = `${title} · Agent-Ops`; }
function markActive(route) {
  document.querySelectorAll(".nav-item").forEach((a) => { const r = a.dataset.route; a.classList.toggle("is-active", r === "" ? route === "" : route.startsWith(r)); });
}

async function loadRail() {
  try {
    const [projects, gates] = await Promise.all([api("/projects"), api("/gates")]);
    $("#nav-projects").innerHTML = projects.map((p) => `<a class="nav-item" data-route="projects/${esc(p.name)}" href="#/projects/${esc(p.name)}">${icon("folder")}<span>${esc(p.name)}</span></a>`).join("") || `<div class="dim" style="padding:6px 10px;font-size:12px">Kein Repo unter /repos</div>`;
    const b = $("#badge-gates"); b.textContent = String(gates.length); b.hidden = gates.length === 0;
    markActive(location.hash.replace(/^#\//, "").split("?")[0]);
  } catch (e) { if (e.status === 401) return boot(); }
}

// ---------- Seiten ----------
async function pipelineIndex() {
  const p = await api("/pipeline/flows").catch(() => ({ flows: [] }));
  return new Map((p.flows ?? []).map((f) => [f.flowId, f]));
}

async function pageDashboard() {
  setTitle("Dashboard");
  const [flows, gates, costs, byId] = await Promise.all([api("/flows"), api("/gates"), api("/costs").catch(() => null), pipelineIndex()]);
  const running = flows.filter((f) => f.status === "running").length;
  const halted = flows.filter((f) => HALTED.has(f.status)).length;
  const week = (costs?.byAgent7d ?? []).reduce((a, x) => a + x.usd, 0);
  const recent = [...flows].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 6);
  page().innerHTML = `
    <div class="metrics">
      <a class="metric" href="#/flows"><div class="metric__label">${icon("workflow")}Flows</div><div class="metric__value">${flows.length}</div><div class="metric__sub">${running} laufen</div></a>
      <a class="metric" href="#/gates"><div class="metric__label">${icon("shield")}Freigaben offen</div><div class="metric__value">${gates.length}</div><div class="metric__sub ${gates.length ? "warn" : ""}">${gates.length ? "warten auf dich" : "nichts wartet"}</div></a>
      <a class="metric" href="#/flows"><div class="metric__label">${icon("alert")}Stehen geblieben</div><div class="metric__value">${halted}</div><div class="metric__sub ${halted ? "bad" : ""}">${halted ? "brauchen einen Blick" : "alles läuft"}</div></a>
      <a class="metric" href="#/costs"><div class="metric__label">${icon("coins")}Kosten 7 Tage</div><div class="metric__value">${esc(usd(week))}</div><div class="metric__sub">seit Start ${esc(usd(costs?.totalSinceStart))}</div></a>
    </div>
    <div style="display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(380px,1fr))">
      ${card("Letzte Flows", "workflow", recent.length ? `<div class="card__body card__body--flush"><table class="table"><tbody>${recent.map((f) => flowRow(f, byId)).join("")}</tbody></table></div>` : `<div class="empty">Noch kein Flow. Starte eine Pipeline in einem Projekt.</div>`, `<a class="card__link" href="#/flows">Alle ${icon("arrow", "icon icon--sm")}</a>`)}
      ${card("Freigaben", "shield", gates.length ? `<div class="card__body card__body--flush"><table class="table"><tbody>${gates.map((f) => flowRow(f, byId)).join("")}</tbody></table></div>` : `<div class="empty">Nichts wartet. Gates erscheinen hier, sobald eine Pipeline vor ship steht.</div>`, `<a class="card__link" href="#/gates">Alle ${icon("arrow", "icon icon--sm")}</a>`)}
    </div>`;
  bindRows();
}

function flowRow(f, byId) {
  const p = byId.get(f.id); const goal = p?.goal ?? `Flow ${short(f.id)}`;
  return `<tr class="link" data-href="#/flows/${esc(f.id)}"><td style="width:240px">${strip(f)}</td><td class="strong cell-goal" title="${esc(goal)}">${esc(goal)}<span class="sub">${esc(p?.state?.repo ?? short(f.id))}</span></td><td>${statusDot(f.status)}</td><td class="num dim">${esc(timeAgo(f.updatedAt))}</td></tr>`;
}
function bindRows() { page().querySelectorAll("tr.link").forEach((tr) => tr.addEventListener("click", () => { location.hash = tr.dataset.href; })); }

async function pageFlows() {
  setTitle("Flows");
  const [flows, byId] = await Promise.all([api("/flows"), pipelineIndex()]);
  page().innerHTML = card("Alle Flows", "workflow", flows.length
    ? `<div class="card__body card__body--flush"><table class="table"><thead><tr><th>Pipeline</th><th>Ziel</th><th>Status</th><th class="num">Aktualisiert</th></tr></thead><tbody>${flows.map((f) => flowRow(f, byId)).join("")}</tbody></table></div>`
    : `<div class="empty">Noch kein Flow. Starte eine Pipeline in einem Projekt links.</div>`,
    `<span class="dim" style="font-size:12px">${flows.length} im Log</span>`);
  bindRows();
}

async function pageGates() {
  setTitle("Freigaben");
  const [gates, byId] = await Promise.all([api("/gates"), pipelineIndex()]);
  page().innerHTML = card("Wartet auf dich", "shield", gates.length
    ? `<div class="card__body card__body--flush"><table class="table"><tbody>${gates.map((f) => flowRow(f, byId)).join("")}</tbody></table></div>`
    : `<div class="empty">Nichts wartet. Gates erscheinen hier, sobald eine Pipeline vor <span class="mono">ship</span> steht.</div>`);
  bindRows();
}

// Ein Schritt eines Laufs: Frage (die Aufgabe an den Agenten), Antwort (seine Abschlussnachricht), Dauer, Tokens, Kosten.
function stepRow(s) {
  const tok = s.tokens; const running = s.startedAt && !s.endedAt;
  const ms = s.durationMs ?? (running ? Date.now() - s.startedAt : null);
  const verdictCls = s.verdict === "fail" || s.verdict === "request_changes" ? "badge--warning" : "badge--success";
  return `<details class="step" data-key="${esc(s.step)}-${esc(s.attempt)}"><summary>
      <span class="step__name mono">${esc(s.step)}${s.attempt > 1 ? `<span class="badge badge--accent">Versuch ${esc(s.attempt)}</span>` : ""}${running ? `<span class="badge badge--accent">läuft</span>` : ""}</span>
      <span class="step__meta">${s.model ? `<span>${esc(s.model)}</span>` : ""}${s.thinking ? `<span title="Effort (Thinking-Level) aus dem Projekt">effort ${esc(s.thinking)}</span>` : ""}<span>${esc(fmtDuration(ms))}</span><span>${tok ? `${esc(fmtTokens(tok.total))} tok` : "–"}</span><span>${s.cost != null ? esc(usd(s.cost)) : ""}</span>${s.verdict ? `<span class="badge ${verdictCls}">${esc(s.verdict)}</span>` : ""}${s.outcome && s.outcome !== "ok" ? `<span class="badge badge--danger">${esc(s.outcome)}</span>` : ""}</span>
    </summary>
    <div class="step__body">
      ${tok ? `<div class="step__tokens mono">Eingabe ${tok.input.toLocaleString("de-DE")} · Ausgabe ${tok.output.toLocaleString("de-DE")} · Cache ${(tok.cacheRead + tok.cacheWrite).toLocaleString("de-DE")} · ${esc(s.calls)} Modellaufrufe${s.soulOverride ? " · Projekt-Soul" : ""}</div>` : `<div class="step__tokens">Keine Tokens gefunden — das Transkript des Agenten ist nicht erreichbar oder der Lauf ist noch offen.</div>`}
      <div class="qa"><div class="qa__k">Frage</div><pre class="qa__v">${esc(s.prompt ?? "– (Lauf nicht mehr in OpenClaws subagent_runs)")}</pre></div>
      <div class="qa"><div class="qa__k">Antwort</div><pre class="qa__v">${esc(s.answer ?? (running ? "… arbeitet noch" : "– (keine Abschlussnachricht)"))}</pre></div>
    </div></details>`;
}
const gateRow = (g) => `<div class="step step--gate"><div class="step__sum"><span class="step__name mono">gate</span><span class="step__meta"><span>${esc(fmtDuration(g.waitMs))} gewartet</span>${g.by ? `<span>${g.decision === "allow" ? "freigegeben" : "abgelehnt"} von ${esc(g.by)}</span>` : `<span class="badge badge--warning">offen</span>`}</span></div></div>`;

async function pageFlow(id) {
  // Beim Auffrischen bleibt die Karte stehen (das Canvas zieht in die neue Seite um) und offene Schritte bleiben offen.
  const keepMap = liveMap?.id === id ? $("#map") : null;
  if (!keepMap) disposeMap();
  const wasOpen = new Set([...page().querySelectorAll("details.step[open]")].map((d) => d.dataset.key));
  const [logged, events, p, detail] = await Promise.all([
    api(`/flows/${encodeURIComponent(id)}`).catch((e) => { if (e.status === 404) return null; throw e; }),
    api(`/flows/${encodeURIComponent(id)}/events`).catch(() => []),
    api(`/pipeline/flows/${encodeURIComponent(id)}`).catch(() => null),
    api(`/flows/${encodeURIComponent(id)}/steps`).catch(() => null),
  ]);
  // Frisch gestartet: der Connector holt den Flow erst beim nächsten Poll in den Log — bis dahin zeigt die Seite den Plugin-Stand
  const flow = logged ?? (p ? { id, status: p.status, stage: p.currentStep, revision: p.revision, gateOpen: p.status === "waiting" && p.wait?.kind === "gate", updatedAt: p.updatedAt } : null);
  if (!flow) throw new ApiError("Flow nicht gefunden", 404);
  const goal = p?.goal ?? `Flow ${short(id)}`; const state = p?.state ?? {};
  const steps = detail?.steps ?? []; const gate = detail?.gate ?? null;
  const sum = (k) => steps.reduce((a, s) => a + (k(s) ?? 0), 0);
  const totals = steps.length ? `${esc(fmtDuration(sum((s) => s.durationMs)))} Arbeit · ${esc(fmtTokens(sum((s) => s.tokens?.total)))} Tokens · ${esc(usd(sum((s) => s.cost)))}` : "Dauer und Tokens je Bogen";
  setTitle("Flow", short(id));
  page().innerHTML = `
    <div class="detail-head">
      <h1>${esc(goal)}</h1>
      <div class="detail-meta"><span>${esc(state.repo ?? "")}</span><span>${esc(id)}</span><span>Revision ${esc(flow.revision)}</span>${statusDot(flow.status)}</div>
    </div>
    ${strip(flow, true)}
    ${p ? card("Karte", "activity", `<div class="map map--flow" id="map"></div>`, `<span class="dim" style="font-size:12px">${totals}</span>`) : ""}
    ${card("Schritte", "cpu", steps.length ? `<div class="steps">${steps.map(stepRow).join("")}${gate ? gateRow(gate) : ""}</div>` : `<div class="empty">Kein Schrittprotokoll — der Flow lief vor dieser Version des Plugins.</div>`, `<span class="dim" style="font-size:12px">Frage, Antwort, Dauer, Tokens je Schritt</span>`)}
    ${flow.gateOpen ? `<div class="alert alert--warning">${icon("shield")}<div style="flex:1"><div style="color:var(--text);margin-bottom:8px">${p?.wait?.review === "request_changes_unresolved" ? `Die Review verlangt nach ${esc(p?.state?.reviewRounds ?? 2)} Runden immer noch Änderungen — jetzt entscheidest du.` : `Review ist durch${(p?.state?.reviewRounds ?? 0) > 0 ? ` nach ${esc(p.state.reviewRounds + 1)} Runden` : ""} — die Pipeline wartet vor <span class="mono">ship</span>.`} Sieh dir <span class="mono">.agentops/review.md</span> an, dann entscheide.</div><div class="actions"><button class="btn btn--success btn--sm" id="btn-allow" type="button">${icon("check", "icon icon--sm")}Freigeben</button><button class="btn btn--danger btn--sm" id="btn-deny" type="button">${icon("x", "icon icon--sm")}Ablehnen</button><span class="dim" style="font-size:12px">als ${esc(me?.displayName ?? "API-Token")}</span></div></div></div>` : ""}
    ${HALTED.has(flow.status) ? `<div class="alert alert--danger">${icon("alert")}<span>Stehen geblieben${p?.blockedSummary ? `: ${esc(p.blockedSummary)}` : ""}.</span></div>` : ""}
    ${(flow.status === "running" || flow.status === "waiting") && p ? `<div class="actions">${flow.status === "running" ? `<button class="btn btn--secondary btn--sm" id="btn-advance" type="button">${icon("play", "icon icon--sm")}Schritt als beendet behandeln</button>` : ""}<button class="btn btn--secondary btn--sm" id="btn-cancel" type="button">${icon("x", "icon icon--sm")}Abbrechen</button><span class="dim" style="font-size:12px">Eingriffe des Operators — nur wenn etwas hängt oder falsch läuft</span></div>` : ""}
    ${card("Zeitleiste", "clock", events.length ? `<div class="events">${events.map((e) => {
      const d = e.data ?? {};
      const kind = e.stream?.startsWith("approval") ? "approval" : e.type === "flow_completed" ? "done" : e.type === "halted" ? "halt" : "";
      const detail = d.stage ?? d.approvalId ?? d.status ?? "";
      return `<div class="seq">${e.sequence}</div><div>${esc(fmtDate(e.recordedAt))}</div><div class="type ${kind}">${esc(e.type)}</div><div class="detail">${esc(detail)}${d.meta?.actorId ? ` · ${esc(d.meta.actorId)}` : ""}${d.reason ? ` — ${esc(d.reason)}` : ""}</div>`;
    }).join("")}</div>` : `<div class="empty">Noch keine Events.</div>`, `<span class="dim" style="font-size:12px">${events.length} Events</span>`)}`;
  $("#btn-allow")?.addEventListener("click", () => decide(id, "allow"));
  $("#btn-deny")?.addEventListener("click", () => decide(id, "deny"));
  $("#btn-advance")?.addEventListener("click", async () => {
    if (!confirm("Den aktuellen Schritt als beendet behandeln?")) return;
    try { await api(`/pipeline/flows/${encodeURIComponent(id)}/advance`, { method: "POST", body: {} }); toast("Schritt weitergeschaltet"); setTimeout(route, 800); }
    catch (e) { toast(e.message, "error"); }
  });
  $("#btn-cancel")?.addEventListener("click", async () => {
    if (!confirm("Flow abbrechen? Ein laufender Schritt läuft noch aus, sein Ergebnis wird ignoriert.")) return;
    try { await api(`/pipeline/flows/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} }); toast("Flow abgebrochen"); setTimeout(route, 800); }
    catch (e) { toast(e.message, "error"); }
  });
  page().querySelectorAll("details.step").forEach((d) => { if (wasOpen.has(d.dataset.key)) d.open = true; });
  if (p) {
    // Die Karte dieses einen Laufs: Dauer und Tokens auf den Bögen; Klick auf eine Soul führt zu ihr im Projekt
    if (keepMap) $("#map").replaceWith(keepMap);
    else {
      liveMap = mountProjectMap($("#map"), { onSelect: (step) => {
        if (SOUL_STEPS.includes(step) && state.repo) { pageProject.tab = step; location.hash = `#/projects/${encodeURIComponent(state.repo)}`; }
        else if (step === "gate") location.hash = "#/gates";
      } });
      liveMap.id = id;
    }
    liveMap.update([p], { steps: steps.map((s) => ({ step: s.step, attempt: s.attempt, durationMs: s.durationMs ?? (s.startedAt && !s.endedAt ? Date.now() - s.startedAt : null), tokens: s.tokens?.total ?? null })), gate });
  }
  return flow.status === "running" || flow.status === "waiting";
}

async function decide(id, decision) {
  if (!confirm(decision === "allow" ? "Freigeben und ship starten?" : "Ablehnen? Der Flow endet dann.")) return;
  try { await api(`/flows/${encodeURIComponent(id)}/gate`, { method: "POST", body: { decision } }); toast(decision === "allow" ? "Freigegeben — ship läuft" : "Abgelehnt"); setTimeout(route, 800); }
  catch (e) { toast(e.message, "error"); }
}

let liveMap = null;
function disposeMap() { if (liveMap) { liveMap.dispose(); liveMap = null; } }

async function pageProject(name) {
  setTitle("Projekt", name);
  disposeMap();
  const [souls, byId, agents, global, toolCatalog] = await Promise.all([
    api(`/projects/${encodeURIComponent(name)}/souls`), pipelineIndex(),
    api(`/projects/${encodeURIComponent(name)}/agents`).catch(() => ({})),
    api("/agents").catch(() => ({ agents: [], models: [] })),
    api("/tools").catch(() => ({ groups: [] })),
  ]);
  const toolGroups = (toolCatalog.groups ?? []).filter((g) => g.tools?.length);
  const models = global.models ?? []; const known = (key) => models.some((m) => m.key === key);
  const byProvider = new Map(); for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  const globalModel = (s) => (global.agents ?? []).find((a) => a.step === s)?.model ?? null;
  const globalThinking = (s) => { const a = (global.agents ?? []).find((x) => x.step === s); return a?.thinking ?? a?.thinkingDefault ?? null; };
  const modelOptions = (current, fallback) => `<option value=""${!current ? " selected" : ""}>Standard-Agent${fallback ? ` — ${esc(fallback)}` : ""}</option>`
    + [...byProvider.keys()].sort().map((p) => `<optgroup label="${esc(p)}">${byProvider.get(p).map((m) => `<option value="${esc(m.key)}"${m.key === current ? " selected" : ""}${m.available ? "" : " disabled"}>${esc(m.name)} — ${esc(m.key)}${m.available ? "" : " (kein Zugang)"}</option>`).join("")}</optgroup>`).join("")
    + `<option value="__other"${current && !known(current) ? " selected" : ""}>Anderes Modell (ID eingeben)…</option>`;
  const mine = () => [...byId.values()].filter((f) => f.state?.repo === name);
  const runs = mine().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 6);
  const active = SOUL_STEPS.includes(pageProject.tab) ? pageProject.tab : "plan";
  page().innerHTML = `
    ${card("Karte", "activity", `<div class="map" id="map"><div class="map__legend"><span><i style="background:#4b57dd"></i>arbeitet</span><span><i style="background:#22c55e"></i>erledigt</span><span><i style="background:#f59e0b"></i>Gate offen</span><span><i style="background:#ef4444"></i>gestoppt</span></div><div class="map__hint">ziehen dreht · Strg+Rad zoomt · Klick öffnet die Soul</div></div>`, `<span class="dim" id="map-count" style="font-size:12px">${runs.filter((f) => f.status === "running").length} Flows arbeiten</span>`)}
    ${card("Pipeline starten", "play", `<div class="card__body"><form id="run-form" class="field"><label class="field__label" for="goal">Was soll die Pipeline in <span class="mono">${esc(name)}</span> tun?</label><textarea class="textarea" id="goal" required placeholder="Zum Beispiel: Add divide(a, b) with a test for division by zero"></textarea><div class="actions" style="margin-top:4px"><button class="btn btn--primary" type="submit">${icon("play", "icon icon--sm")}Pipeline starten</button><span class="dim" style="font-size:12px">plan → code → test → review → Gate → ship</span></div></form></div>`)}
    ${card("Letzte Läufe", "workflow", runs.length ? `<div class="card__body card__body--flush"><table class="table"><tbody>${runs.map((f) => `<tr class="link" data-href="#/flows/${esc(f.flowId)}"><td style="width:240px">${strip({ stage: f.currentStep, status: f.status, gateOpen: f.status === "waiting" && f.wait?.kind === "gate" })}</td><td class="strong cell-goal">${esc(f.goal)}</td><td>${statusDot(f.status)}</td><td class="num dim">${esc(timeAgo(f.updatedAt))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Noch kein Lauf in diesem Projekt.</div>`)}
    <section class="card">
      <div class="card__header"><div class="card__title">${icon("cpu")}Agenten des Projekts</div><span class="dim" style="font-size:12px">eigene Agenten je Schritt: Modell, Effort, Tools, Soul — liegt in <span class="mono">.agentops/</span> und wird committet</span></div>
      <div class="tabs">${SOUL_STEPS.map((s) => `<button class="tab${s === active ? " is-active" : ""}" type="button" data-tab="${s}">${s}${souls[s]?.override != null || agents[s]?.model || agents[s]?.thinking || agents[s]?.tools?.length ? `<span class="dot" title="Projekt-Einstellung"></span>` : ""}</button>`).join("")}</div>
      <div class="card__body" id="soul-body"></div>
    </section>`;
  const renderAgent = (s) => {
    const d = souls[s] ?? {}; const has = d.override != null;
    const proj = agents[s]?.model ?? null; const fallback = globalModel(s); const projThinking = agents[s]?.thinking ?? null; const projTools = agents[s]?.tools ?? [];
    $("#soul-body").innerHTML = `
      <div class="field" style="margin-bottom:16px">
        <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="field__label">Modell für <span class="mono">${s}</span> in diesem Projekt</span><span class="soul-tag ${proj ? "override" : ""}">${proj ? "Projekt-Modell aktiv" : "Standard-Agent"}</span></div>
        <div class="model-row"><select class="select" id="agent-model">${modelOptions(proj, fallback)}</select><input class="input mono" id="agent-other" placeholder="anbieter/modell" value="${esc(proj ?? "")}"${!proj || known(proj) ? " hidden" : ""}></div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:6px"><span class="field__label">Effort (Thinking-Level) für <span class="mono">${s}</span> in diesem Projekt</span><span class="soul-tag ${projThinking ? "override" : ""}">${projThinking ? "Projekt-Effort aktiv" : "Standard-Agent"}</span></div>
        <div class="model-row"><select class="select select--narrow" id="agent-thinking">${thinkingOptions(projThinking, `Standard-Agent${globalThinking(s) ? ` — ${globalThinking(s)}` : ""}`)}</select></div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:6px"><span class="field__label">Tools für <span class="mono">${s}</span> in diesem Projekt</span><span class="soul-tag ${projTools.length ? "override" : ""}">${projTools.length ? `${projTools.length} Tools erlaubt` : "Standard-Agent — alle Tools der Vorlage"}</span></div>
        <div class="tools" id="agent-tools">${toolGroups.map((g) => `<div class="tools__group"><div class="tools__label">${esc(g.label)}</div>${g.tools.map((t) => `<label class="tools__item" title="${esc(t.description)}"><input type="checkbox" value="${esc(t.id)}"${projTools.includes(t.id) ? " checked" : ""}><span class="mono">${esc(t.id)}</span></label>`).join("")}</div>`).join("") || `<div class="dim" style="font-size:12px">Tool-Katalog nicht erreichbar.</div>`}</div>
        <div class="actions"><button class="btn btn--primary btn--sm" id="agent-save" type="button">Modell, Effort und Tools speichern</button><span class="dim" style="font-size:12px">keine Tools angehakt = Vorlage; angehakt = nur diese Tools</span></div>
      </div>
      <div class="field">
        <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="field__label">Soul für <span class="mono">${s}</span></span><span class="soul-tag ${has ? "override" : ""}">${has ? "Projekt-Override aktiv" : "Standard des Agenten"}</span></div>
        <textarea class="textarea textarea--mono" id="soul-text" spellcheck="false">${esc(has ? d.override : (d.default ?? ""))}</textarea>
        <div class="actions"><button class="btn btn--primary btn--sm" id="soul-save" type="button">Soul speichern</button>${has ? `<button class="btn btn--secondary btn--sm" id="soul-reset" type="button">Override entfernen</button>` : ""}</div>
      </div>`;
    const sel = $("#agent-model"), other = $("#agent-other");
    sel.addEventListener("change", () => { other.hidden = sel.value !== "__other"; if (sel.value !== "__other") other.value = sel.value; else other.focus(); });
    $("#agent-save").addEventListener("click", async () => {
      const model = (sel.value === "__other" ? other.value : sel.value).trim();
      const thinking = $("#agent-thinking").value;
      const tools = [...page().querySelectorAll("#agent-tools input:checked")].map((i) => i.value);
      const btn = $("#agent-save"); btn.disabled = true;
      try {
        const r = await api(`/projects/${encodeURIComponent(name)}/agents/${s}`, { method: "PUT", body: { model, thinking, tools } });
        const v = r.view ?? {};
        toast(v.model || v.thinking || v.tools?.length ? `${s}: ${[v.model, v.thinking ? `Effort ${v.thinking}` : "", v.tools?.length ? `${v.tools.length} Tools` : ""].filter(Boolean).join(" · ")}, Commit ${r.commit}` : `${s}: wieder Standard-Agent`);
        pageProject.tab = s; pageProject(name);
      } catch (e) { toast(e.message, "error"); btn.disabled = false; }
    });
    $("#soul-save").addEventListener("click", async () => {
      try { const r = await api(`/projects/${encodeURIComponent(name)}/souls/${s}`, { method: "PUT", body: { text: $("#soul-text").value } }); toast(`Soul ${s} gespeichert, Commit ${r.commit}`); pageProject.tab = s; pageProject(name); }
      catch (e) { toast(e.message, "error"); }
    });
    $("#soul-reset")?.addEventListener("click", async () => {
      if (!confirm(`Override für ${s} entfernen? Danach gilt wieder die Standard-Soul.`)) return;
      try { await api(`/projects/${encodeURIComponent(name)}/souls/${s}`, { method: "DELETE" }); toast(`Override ${s} entfernt`); pageProject.tab = s; pageProject(name); }
      catch (e) { toast(e.message, "error"); }
    });
  };
  renderAgent(active);
  // 3D-Karte: Souls als Knoten, Flows als Impulse — alle 5 s frisch, ohne die Seite neu zu bauen
  const mapEl = $("#map");
  liveMap = mountProjectMap(mapEl, { onSelect: (step) => {
    // Klick auf eine Soul in der Karte → ihr Editor unten; das Gate → die offenen Freigaben
    if (SOUL_STEPS.includes(step)) { page().querySelector(`.tab[data-tab="${step}"]`)?.click(); $("#soul-body")?.scrollIntoView({ behavior: "smooth", block: "center" }); }
    else if (step === "gate") location.hash = "#/gates";
  } });
  liveMap.update(mine());
  liveMap.timer = setInterval(async () => {
    try { const idx = await pipelineIndex(); const cur = [...idx.values()].filter((f) => f.state?.repo === name); liveMap?.update(cur); const c = $("#map-count"); if (c) c.textContent = `${cur.filter((f) => f.status === "running").length} Flows arbeiten`; } catch {}
  }, 5000);
  const origDispose = liveMap.dispose; liveMap.dispose = () => { clearInterval(liveMap.timer); origDispose(); };
  page().querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { page().querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === b)); pageProject.tab = b.dataset.tab; renderAgent(b.dataset.tab); }));
  $("#run-form").addEventListener("submit", async (e) => {
    e.preventDefault(); const btn = $("#run-form button"); btn.disabled = true;
    try { const flow = await api(`/projects/${encodeURIComponent(name)}/runs`, { method: "POST", body: { goal: $("#goal").value } }); toast("Pipeline gestartet"); location.hash = `#/flows/${flow.flowId}`; }
    catch (err) { toast(err.message, "error"); btn.disabled = false; }
  });
  bindRows();
}

async function pageCosts() {
  setTitle("Kosten");
  const c = await api("/costs");
  const rows = (c.byAgent ?? []).map((a) => ({ agent: a.agent, total: a.usd, week: (c.byAgent7d ?? []).find((x) => x.agent === a.agent)?.usd ?? 0 })).sort((a, b) => b.total - a.total);
  const week = rows.reduce((a, r) => a + r.week, 0);
  page().innerHTML = `
    <div class="metrics">
      <div class="metric"><div class="metric__label">${icon("coins")}Kosten 7 Tage</div><div class="metric__value">${esc(usd(week))}</div><div class="metric__sub">alle Agenten</div></div>
      <div class="metric"><div class="metric__label">${icon("coins")}Seit Gateway-Start</div><div class="metric__value">${esc(usd(c.totalSinceStart))}</div><div class="metric__sub">Zähler, springt bei Neustart auf 0</div></div>
      <div class="metric"><div class="metric__label">${icon("activity")}Prompt-Tokens</div><div class="metric__value">${Math.round((c.tokens ?? []).find((t) => t.kind === "prompt")?.count ?? 0).toLocaleString("de-DE")}</div><div class="metric__sub">der gesamte Kontext je Aufruf — die Kostenstelle</div></div>
    </div>
    ${card("Je Soul", "coins", rows.length ? `<div class="card__body card__body--flush"><table class="table"><thead><tr><th>Agent</th><th class="num">7 Tage</th><th class="num">seit Start</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="strong mono">${esc(r.agent)}</td><td class="num">${esc(usd(r.week))}</td><td class="num">${esc(usd(r.total))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Noch keine Kosten gemessen.</div>`)}
    ${card("Tokens nach Art", "activity", (c.tokens ?? []).length ? `<div class="card__body card__body--flush"><table class="table"><thead><tr><th>Art</th><th class="num">Tokens</th></tr></thead><tbody>${c.tokens.map((t) => `<tr><td class="mono">${esc(t.kind)}</td><td class="num">${Math.round(t.count).toLocaleString("de-DE")}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Keine Daten.</div>`)}`;
}

// Modell je Agent — main (der Master) und die fünf Schritt-Agenten. Die Liste kommt aus OpenClaws Katalog:
// nur Anbieter, deren Schlüssel auf dem Server liegt. Andere IDs per Freitext.
async function pageAgents() {
  setTitle("Agenten");
  const [d, toolCatalog] = await Promise.all([api("/agents"), api("/tools").catch(() => ({ groups: [] }))]);
  const models = d.models ?? []; const agents = d.agents ?? [];
  const toolGroups = (toolCatalog.groups ?? []).filter((g) => g.tools?.length);
  const toolPicker = (current) => `<details class="toolpick"><summary>${current?.length ? `${current.length} Tools erlaubt` : "Standard-Policy — alle Tools"}</summary><div class="tools tools--compact">${toolGroups.map((g) => `<div class="tools__group"><div class="tools__label">${esc(g.label)}</div>${g.tools.map((t) => `<label class="tools__item" title="${esc(t.description)}"><input type="checkbox" value="${esc(t.id)}"${current?.includes(t.id) ? " checked" : ""}><span class="mono">${esc(t.id)}</span></label>`).join("")}</div>`).join("") || `<div class="dim" style="font-size:12px">Katalog nicht erreichbar.</div>`}</div></details>`;
  const byProvider = new Map();
  for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);
  const providers = [...byProvider.keys()].sort();
  const known = (key) => models.some((m) => m.key === key);
  const options = (current) => providers.map((p) => `<optgroup label="${esc(p)}">${byProvider.get(p).map((m) => `<option value="${esc(m.key)}"${m.key === current ? " selected" : ""}${m.available ? "" : " disabled"}>${esc(m.name)} — ${esc(m.key)}${m.available ? "" : " (kein Zugang)"}</option>`).join("")}</optgroup>`).join("")
    + `<option value="__other"${current && !known(current) ? " selected" : ""}>Anderes Modell (ID eingeben)…</option>`;
  page().innerHTML = `
    <div class="alert alert--info">${icon("alert")}<span>Das sind die <strong>Vorlagen</strong>. Jedes Projekt bekommt eigene Agenten je Schritt, die Modell, Effort und Tools von hier erben, solange das Projekt nichts anderes sagt — Projektseite, „Agenten des Projekts“, als Commit in <span class="mono">.agentops/</span> des Repos. Eine Tool-Liste ist eine absolute Allowlist: nichts angehakt heißt OpenClaws Standard-Policy.</span></div>
    ${card("Standard-Modell je Agent", "cpu", `<div class="card__body card__body--flush"><table class="table"><thead><tr><th>Agent</th><th>Rolle</th><th>Modell</th><th>Effort</th><th>Tools</th><th></th></tr></thead><tbody>${agents.map((a) => `
      <tr data-agent="${esc(a.id)}"><td class="strong mono">${esc(a.id)}</td><td>${a.role === "master" ? "Master — OpenClaws Hauptagent (Chat, Delegation)" : `Pipeline-Schritt <span class="mono">${esc(a.step)}</span>`}</td>
      <td><div class="model-pick"><select class="select" data-model>${options(a.model)}</select><input class="input mono" data-other placeholder="anbieter/modell" value="${esc(a.model ?? "")}"${!a.model || known(a.model) ? " hidden" : ""}></div><span class="sub">${a.explicit ? "im Agenten gesetzt" : "Laufzeit-Standard von OpenClaw"}${a.runtime ? ` · Laufzeit ${esc(a.runtime)}` : ""}</span></td>
      <td><select class="select select--narrow" data-thinking>${thinkingOptions(a.thinking, `Standard${a.thinkingDefault ? ` — ${a.thinkingDefault}` : ""}`)}</select></td>
      <td data-tools>${toolPicker(a.tools)}</td>
      <td class="num"><button class="btn btn--primary btn--sm" data-save type="button">Speichern</button></td></tr>`).join("")}</tbody></table></div>`,
      `<span class="dim" style="font-size:12px">${models.length} Modelle von ${providers.length} Anbieter${providers.length === 1 ? "" : "n"}</span>`)}
    <div class="alert alert--info">${icon("alert")}<span>Zur Auswahl stehen die Modelle der Anbieter, deren Schlüssel in der <span class="mono">.env</span> auf dem Server liegt — <span class="mono">OPENAI_API_KEY</span>, <span class="mono">ANTHROPIC_API_KEY</span>, <span class="mono">GEMINI_API_KEY</span>, <span class="mono">OPENROUTER_API_KEY</span> —, danach <span class="mono">docker compose --profile openclaw up -d openclaw</span>. Eine Änderung gilt ab dem nächsten Lauf; OpenClaw lädt die Konfiguration ohne Neustart.${me && !me.root ? " Ändern darf nur Root." : ""}</span></div>`;
  page().querySelectorAll("tr[data-agent]").forEach((tr) => {
    const sel = tr.querySelector("[data-model]"), other = tr.querySelector("[data-other]");
    sel.addEventListener("change", () => { other.hidden = sel.value !== "__other"; if (sel.value !== "__other") other.value = sel.value; else other.focus(); });
    tr.querySelector("[data-save]").addEventListener("click", async () => {
      const model = (sel.value === "__other" ? other.value : sel.value).trim();
      const thinking = tr.querySelector("[data-thinking]").value;
      const tools = [...tr.querySelectorAll("[data-tools] input:checked")].map((i) => i.value);
      if (!model) return toast("Modell-ID fehlt", "error");
      try { await api(`/agents/${encodeURIComponent(tr.dataset.agent)}`, { method: "PUT", body: { model, thinking, tools } }); toast(`${tr.dataset.agent} → ${model}${thinking ? `, Effort ${thinking}` : ""}${tools.length ? `, ${tools.length} Tools` : ", alle Tools"}`); pageAgents(); }
      catch (e) { toast(e.message, "error"); }
    });
  });
}

// ---------- Routing ----------
let refresh = null;
async function route() {
  clearInterval(refresh);
  disposeMap();
  const raw = location.hash.replace(/^#\//, ""); const [path] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const [p, arg] = [parts[0] ?? "", parts[1] ? decodeURIComponent(parts[1]) : undefined];
  if (p === "login") return renderLogin();
  if (!$(".shell")) renderShell();
  markActive(path);
  try {
    if (p === "") { await pageDashboard(); refresh = setInterval(() => pageDashboard().catch(() => {}), 10000); }
    else if (p === "flows" && arg) { if (await pageFlow(arg)) refresh = setInterval(async () => { if (!(await pageFlow(arg).catch(() => true))) clearInterval(refresh); }, 10000); }
    else if (p === "flows") { await pageFlows(); refresh = setInterval(() => pageFlows().catch(() => {}), 10000); }
    else if (p === "gates") { await pageGates(); refresh = setInterval(() => pageGates().catch(() => {}), 10000); }
    else if (p === "projects" && arg) await pageProject(arg);
    else if (p === "agents") await pageAgents();
    else if (p === "costs") await pageCosts();
    else { location.hash = "#/"; return; }
    loadRail();
  } catch (e) {
    if (e.status === 401) { location.hash = "#/login"; return renderLogin(); }
    page().innerHTML = `<div class="alert alert--danger">${icon("alert")}<span>${esc(e.message)}</span></div>`;
  }
}

async function boot() {
  me = null;
  try { me = await api("/auth/me"); } catch (e) { if (e.status !== 401) toast(e.message, "error"); }
  if (!me && !store.token) { location.hash = "#/login"; return renderLogin(); }
  if (location.hash.startsWith("#/login")) location.hash = "#/";
  app.innerHTML = ""; route();
}

window.addEventListener("hashchange", route);
boot();
