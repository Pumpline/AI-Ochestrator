// Agent-Ops Cockpit — ein Modul, kein Framework, kein Build.
// Anmeldung über Discord (Cookie-Session); der Bearer-Token bleibt als Fallback für Umgebungen ohne Discord.

import { mountProjectMap } from "/map.js";

const STEPS = ["plan", "code", "test", "review", "gate", "ship"];
const SOUL_STEPS = ["plan", "code", "test", "review", "ship"];
const HALTED = new Set(["failed", "blocked", "lost", "cancelled"]);
const NAV = [
  { route: "", title: "Dashboard", icon: "dashboard" },
  { route: "flows", title: "Flows", icon: "workflow" },
  { route: "gates", title: "Freigaben", icon: "shield", badge: "gates" },
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

async function pageFlow(id) {
  const [flow, events, p] = await Promise.all([api(`/flows/${encodeURIComponent(id)}`), api(`/flows/${encodeURIComponent(id)}/events`), api(`/pipeline/flows/${encodeURIComponent(id)}`).catch(() => null)]);
  const goal = p?.goal ?? `Flow ${short(id)}`; const state = p?.state ?? {};
  setTitle("Flow", short(id));
  page().innerHTML = `
    <div class="detail-head">
      <h1>${esc(goal)}</h1>
      <div class="detail-meta"><span>${esc(state.repo ?? "")}</span><span>${esc(id)}</span><span>Revision ${esc(flow.revision)}</span>${statusDot(flow.status)}</div>
    </div>
    ${strip(flow, true)}
    ${flow.gateOpen ? `<div class="alert alert--warning">${icon("shield")}<div style="flex:1"><div style="color:var(--text);margin-bottom:8px">${p?.wait?.review === "request_changes_unresolved" ? `Die Review verlangt nach ${esc(p?.state?.reviewRounds ?? 2)} Runden immer noch Änderungen — jetzt entscheidest du.` : `Review ist durch${(p?.state?.reviewRounds ?? 0) > 0 ? ` nach ${esc(p.state.reviewRounds + 1)} Runden` : ""} — die Pipeline wartet vor <span class="mono">ship</span>.`} Sieh dir <span class="mono">.agentops/review.md</span> an, dann entscheide.</div><div class="actions"><button class="btn btn--success btn--sm" id="btn-allow" type="button">${icon("check", "icon icon--sm")}Freigeben</button><button class="btn btn--danger btn--sm" id="btn-deny" type="button">${icon("x", "icon icon--sm")}Ablehnen</button><span class="dim" style="font-size:12px">als ${esc(me?.displayName ?? "API-Token")}</span></div></div></div>` : ""}
    ${HALTED.has(flow.status) ? `<div class="alert alert--danger">${icon("alert")}<span>Stehen geblieben${p?.blockedSummary ? `: ${esc(p.blockedSummary)}` : ""}.</span></div>` : ""}
    ${flow.status === "running" && p ? `<div class="actions"><button class="btn btn--secondary btn--sm" id="btn-advance" type="button">${icon("play", "icon icon--sm")}Schritt als beendet behandeln</button><span class="dim" style="font-size:12px">nur wenn ein Schritt hängt</span></div>` : ""}
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
  const [souls, byId] = await Promise.all([api(`/projects/${encodeURIComponent(name)}/souls`), pipelineIndex()]);
  const mine = () => [...byId.values()].filter((f) => f.state?.repo === name);
  const runs = mine().sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 6);
  const active = SOUL_STEPS.includes(pageProject.tab) ? pageProject.tab : "plan";
  page().innerHTML = `
    ${card("Karte", "activity", `<div class="map" id="map"><div class="map__legend"><span><i style="background:#4b57dd"></i>arbeitet</span><span><i style="background:#22c55e"></i>erledigt</span><span><i style="background:#f59e0b"></i>Gate offen</span><span><i style="background:#ef4444"></i>gestoppt</span></div><div class="map__hint">ziehen dreht · Rad zoomt</div></div>`, `<span class="dim" style="font-size:12px">${runs.filter((f) => f.status === "running").length} Flows arbeiten</span>`)}
    ${card("Pipeline starten", "play", `<div class="card__body"><form id="run-form" class="field"><label class="field__label" for="goal">Was soll die Pipeline in <span class="mono">${esc(name)}</span> tun?</label><textarea class="textarea" id="goal" required placeholder="Zum Beispiel: Add divide(a, b) with a test for division by zero"></textarea><div class="actions" style="margin-top:4px"><button class="btn btn--primary" type="submit">${icon("play", "icon icon--sm")}Pipeline starten</button><span class="dim" style="font-size:12px">plan → code → test → review → Gate → ship</span></div></form></div>`)}
    ${card("Letzte Läufe", "workflow", runs.length ? `<div class="card__body card__body--flush"><table class="table"><tbody>${runs.map((f) => `<tr class="link" data-href="#/flows/${esc(f.flowId)}"><td style="width:240px">${strip({ stage: f.currentStep, status: f.status, gateOpen: f.status === "waiting" && f.wait?.kind === "gate" })}</td><td class="strong cell-goal">${esc(f.goal)}</td><td>${statusDot(f.status)}</td><td class="num dim">${esc(timeAgo(f.updatedAt))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Noch kein Lauf in diesem Projekt.</div>`)}
    <section class="card">
      <div class="card__header"><div class="card__title">${icon("folder")}Souls</div><span class="dim" style="font-size:12px">Projekt-Override wird nach <span class="mono">.agentops/souls/</span> committet</span></div>
      <div class="tabs">${SOUL_STEPS.map((s) => `<button class="tab${s === active ? " is-active" : ""}" type="button" data-tab="${s}">${s}${souls[s]?.override != null ? `<span class="dot" title="Projekt-Override"></span>` : ""}</button>`).join("")}</div>
      <div class="card__body" id="soul-body"></div>
    </section>`;
  const renderSoul = (s) => {
    const d = souls[s] ?? {}; const has = d.override != null;
    $("#soul-body").innerHTML = `
      <div class="field">
        <div style="display:flex;justify-content:space-between;align-items:baseline"><span class="field__label">Soul für <span class="mono">${s}</span></span><span class="soul-tag ${has ? "override" : ""}">${has ? "Projekt-Override aktiv" : "Standard des Agenten"}</span></div>
        <textarea class="textarea textarea--mono" id="soul-text" spellcheck="false">${esc(has ? d.override : (d.default ?? ""))}</textarea>
        <div class="actions"><button class="btn btn--primary btn--sm" id="soul-save" type="button">Soul speichern</button>${has ? `<button class="btn btn--secondary btn--sm" id="soul-reset" type="button">Override entfernen</button>` : ""}</div>
      </div>`;
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
  renderSoul(active);
  // 3D-Karte: Souls als Knoten, Flows als Impulse — alle 5 s frisch, ohne die Seite neu zu bauen
  const mapEl = $("#map");
  liveMap = mountProjectMap(mapEl);
  liveMap.update(mine());
  liveMap.timer = setInterval(async () => {
    try { const idx = await pipelineIndex(); liveMap?.update([...idx.values()].filter((f) => f.state?.repo === name)); } catch {}
  }, 5000);
  const origDispose = liveMap.dispose; liveMap.dispose = () => { clearInterval(liveMap.timer); origDispose(); };
  page().querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { page().querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === b)); pageProject.tab = b.dataset.tab; renderSoul(b.dataset.tab); }));
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
    else if (p === "flows" && arg) { await pageFlow(arg); refresh = setInterval(() => pageFlow(arg).catch(() => {}), 10000); }
    else if (p === "flows") { await pageFlows(); refresh = setInterval(() => pageFlows().catch(() => {}), 10000); }
    else if (p === "gates") { await pageGates(); refresh = setInterval(() => pageGates().catch(() => {}), 10000); }
    else if (p === "projects" && arg) await pageProject(arg);
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
