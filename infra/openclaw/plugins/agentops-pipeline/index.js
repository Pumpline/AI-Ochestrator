// Agent-Ops Pipeline — ein OpenClaw-Plugin.
//
// Die Pipeline ist ein Graph je Projekt (§5, Variante B): Knoten sind Agenten und Gates, Kanten führen von einem
// Knoten zum nächsten — Standardkanten immer, Verzweigungen nur bei einem Urteil in der letzten Zeile der
// Übergabedatei (z.B. REQUEST_CHANGES → zurück zu code, höchstens max-mal). Der Graph steht in
// <repo>/.agentops/flow.json; fehlt die Datei, gilt der Standard-Flow plan → code → test → review → Gate → ship.
// Im Master-Modus entscheidet statt der Kanten ein Master-Agent, welcher Agent als nächstes dran ist.
// Ein Agent kann selbst ein Flow sein (Sub-Flow, <repo>/.agentops/flows/<name>.json): dann läuft dieser Flow als ein
// Schritt des äußeren, im Code erzwungen, und sein letztes Urteil ist das Urteil des Knotens nach außen.
// Jeder Schritt ist ein Subagent-Lauf eines Projekt-Agenten mit eigener Soul und minimalem Kontext; die Übergabe
// zwischen den Schritten läuft über Dateien in .agentops/ im Repo, nicht über ein Modell in der Mitte.
// Der Flow ist ein managed TaskFlow — OpenClaw schreibt ihn nach flow_runs, der Connector liest ihn.
// Ein Gate ist ein waiting-Zustand mit waitJson.kind = "gate"; freigegeben wird per HTTP, von einem Menschen.

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AsyncResource } from "node:async_hooks";

const execFileAsync = promisify(execFile);
const CONTROLLER_ID = "agentops-pipeline";
const ROUTE = "/plugins/agentops-pipeline";
const TEMPLATE_STEPS = ["master", "plan", "code", "test", "review", "ship"];   // die Vorlagen-Agenten <prefix><step>
const MASTER = "master";                 // der Knoten, der im Master-Modus entscheidet
const MASTER_MAX_STEPS = 8;              // Entscheidungen je Flow, wenn flow.json nichts sagt
const MAX_DEPTH = 3;                     // Sub-Flows in Sub-Flows — so tief, nicht tiefer
const MODEL_ID = /^[a-z0-9][a-z0-9_-]{0,40}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;   // provider/model
// OpenClaws Thinking-Level ("Effort") — je Agent als thinkingDefault
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"];
const TOOL_ID = /^[a-z0-9_:-]{1,60}$/;
const NODE_ID = /^[a-z][a-z0-9_-]{0,30}$/;
const END_NODES = ["done", "halt"];   // Pseudo-Ziele: Flow beenden / Flow scheitern lassen

// Agenten sind projekt-scoped: jedes Projekt bekommt seine eigenen Agenten (agents.entries.<prefix><projekt>-<knoten>),
// angelegt vom Plugin beim ersten Lauf, danach mit Modell, Effort und Tools aus flow.json synchron gehalten.
// Die globalen Schritt-Agenten (<prefix><step>) sind die Vorlagen: ihre Werte gelten, wo das Projekt nichts sagt.
// Knoten eines Sub-Flows heißen <subflow-knoten>/<knoten> (z.B. coding/pr) — als Agent pipeline-<projekt>-coding-pr.
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "projekt";
const projectAgentId = (prefix, repo, node) => `${prefix}${slug(repo)}-${node.replace(/\//g, "-")}`;
const localOf = (node) => node.split("/").pop();   // der Name innerhalb seines Flows

// ---------- Flow-Definition ----------

// Der Standard-Flow — genau die Pipeline der ersten Fassung
function defaultFlow() {
  return {
    start: "plan",
    agents: { plan: {}, code: {}, test: {}, review: {}, ship: {} },
    gates: ["gate"],
    edges: [
      ["plan", "code"], ["code", "test"], ["test", "review"], ["review", "gate"], ["gate", "ship"],
      { from: "test", on: "TESTS FAIL", to: "halt" },
      { from: "review", on: "REQUEST_CHANGES", to: "code", max: 2 },
    ],
  };
}

// Eine Definition in ihre feste Form bringen: gültige Knoten, Kanten als {from, to, on, max}, Start, Modus.
// Modus "graph" (Stufe 1): die Kanten führen. Modus "master" (Stufe 2): der Master wählt aus den Agenten, bis er
// "done" sagt; Pflicht-Agenten (required) laufen vorher automatisch nach, dann das Gate, dann die Agenten
// "nach dem Gate" (after: "gate") in ihrer Reihenfolge. Ein Agent mit "flow" ist ein Sub-Flow (Stufe 3).
function normalizeFlow(def) {
  const mode = def?.mode === "master" ? "master" : "graph";
  const agents = {};
  for (const [id, cfg] of Object.entries(def?.agents ?? {})) {
    if (!NODE_ID.test(id) || END_NODES.includes(id)) continue;
    const c = cfg && typeof cfg === "object" ? cfg : {};
    agents[id] = {
      ...(typeof c.model === "string" && MODEL_ID.test(c.model) ? { model: c.model } : {}),
      ...(typeof c.thinking === "string" && THINKING_LEVELS.includes(c.thinking) ? { thinking: c.thinking } : {}),
      ...(Array.isArray(c.tools) && c.tools.some((t) => typeof t === "string" && TOOL_ID.test(t)) ? { tools: c.tools.filter((t) => typeof t === "string" && TOOL_ID.test(t)) } : {}),
      ...(typeof c.description === "string" && c.description.trim() ? { description: c.description.trim().slice(0, 200) } : {}),
      ...(c.required === true ? { required: true } : {}),
      ...(c.after === "gate" ? { after: "gate" } : {}),
      ...(typeof c.flow === "string" && NODE_ID.test(c.flow) ? { flow: c.flow } : {}),
    };
  }
  if (mode === "master" && !agents[MASTER]) agents[MASTER] = {};
  const master = { maxSteps: Number.isInteger(def?.master?.maxSteps) && def.master.maxSteps > 0 ? Math.min(def.master.maxSteps, 30) : MASTER_MAX_STEPS };
  const gates = [...new Set((Array.isArray(def?.gates) ? def.gates : []).filter((g) => typeof g === "string" && NODE_ID.test(g) && !agents[g] && !END_NODES.includes(g)))];
  const edges = [];
  for (const e of Array.isArray(def?.edges) ? def.edges : []) {
    const edge = Array.isArray(e) ? { from: e[0], to: e[1] } : e && typeof e === "object" ? e : null;
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    edges.push({
      from: edge.from, to: edge.to,
      on: typeof edge.on === "string" && edge.on.trim() ? edge.on.trim().toUpperCase() : null,
      max: Number.isInteger(edge.max) && edge.max > 0 ? edge.max : null,
    });
  }
  const ids = Object.keys(agents).filter((id) => id !== MASTER);
  const start = mode === "master" ? MASTER : typeof def?.start === "string" && agents[def.start] ? def.start : ids[0] ?? null;
  return { mode, start, agents, gates, edges, master };
}

// Master-Modus: der Pool (Agenten, aus denen der Master wählt), die Pflicht-Agenten und die Agenten nach dem Gate
const poolAgents = (flow) => Object.entries(flow.agents).filter(([id, a]) => id !== MASTER && a.after !== "gate").map(([id]) => id);
const requiredAgents = (flow) => poolAgents(flow).filter((id) => flow.agents[id].required);
const tailAgents = (flow) => Object.entries(flow.agents).filter(([id, a]) => id !== MASTER && a.after === "gate").map(([id]) => id);

// Prüfung: Knoten bekannt, Start vorhanden, der Hauptweg (Standardkanten ab Start) erreicht ein Gate vor dem Ende.
// Ein Sub-Flow braucht kein Gate — das Gate des äußeren Flows genügt.
function validateFlow(flow, { sub = false } = {}) {
  if (flow.mode === "master") {
    if (!poolAgents(flow).length) return "Der Master braucht mindestens einen Agenten, den er aufrufen kann.";
    if (!sub && !flow.gates.length) return "Kein Gate — vor dem Ende muss ein Mensch freigeben.";
    return null;
  }
  if (!flow.start) return "Der Flow hat keinen Agenten.";
  const known = new Set([...Object.keys(flow.agents), ...flow.gates, ...END_NODES]);
  for (const e of flow.edges) {
    if (!known.has(e.from) || !known.has(e.to)) return `Kante ${e.from} → ${e.to}: unbekannter Knoten.`;
    if (END_NODES.includes(e.from)) return `Kante von ${e.from}: von einem Ende führt nichts weiter.`;
  }
  for (const id of [...Object.keys(flow.agents), ...flow.gates]) {
    const defaults = flow.edges.filter((e) => e.from === id && !e.on).length;
    if (defaults > 1) return `${id} hat ${defaults} Standardkanten — erlaubt ist eine.`;
  }
  const seen = new Set(); let cur = flow.start; let gated = false;
  while (cur && !END_NODES.includes(cur)) {
    if (seen.has(cur)) return `Der Hauptweg dreht sich im Kreis bei ${cur}.`;
    seen.add(cur);
    if (flow.gates.includes(cur)) gated = true;
    cur = flow.edges.find((e) => e.from === cur && !e.on)?.to ?? "done";
  }
  if (cur === "halt") return "Der Hauptweg endet in halt.";
  if (!sub && !gated) return "Kein Gate auf dem Hauptweg — vor dem Ende muss ein Mensch freigeben.";
  return null;
}

// Der Hauptweg: Knoten in Reihenfolge der Standardkanten ab Start, danach die nur über Verzweigungen erreichbaren.
// Im Master-Modus: Master, dann der Pool in Definitionsreihenfolge (gelaufene zuerst, wenn ein Zustand bekannt ist),
// dann die Gates, dann die Agenten nach dem Gate.
function flowPath(flow, state = null, prefix = "") {
  if (flow.mode === "master") {
    const tail = tailAgents(flow);
    const ran = []; for (const s of state?.steps ?? []) { const l = s.step.startsWith(prefix) && !s.step.slice(prefix.length).includes("/") ? s.step.slice(prefix.length) : null; if (l && l !== MASTER && flow.agents[l] && !tail.includes(l) && !ran.includes(l)) ran.push(l); }
    const rest = poolAgents(flow).filter((id) => !ran.includes(id));
    return [MASTER, ...ran, ...rest, ...flow.gates, ...tail];
  }
  const out = []; const seen = new Set(); let cur = flow.start;
  while (cur && !END_NODES.includes(cur) && !seen.has(cur)) { seen.add(cur); out.push(cur); cur = flow.edges.find((e) => e.from === cur && !e.on)?.to; }
  for (const id of [...Object.keys(flow.agents), ...flow.gates]) if (!seen.has(id)) out.push(id);
  return out;
}

// Ältere Projekte: .agentops/agents.json trägt Modell, Effort, Tools je Schritt — wird in den Flow gemischt, flow.json gewinnt
function legacyAgents(cwd) {
  const file = path.join(cwd, ".agentops", "agents.json");
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readJsonFile(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

// Ein Sub-Flow von der Platte: <repo>/.agentops/flows/<name>.json
function loadSubflow(cwd, name) {
  const file = path.join(cwd, ".agentops", "flows", `${name}.json`);
  if (!NODE_ID.test(name) || !existsSync(file)) return { flow: null, error: `Sub-Flow ${name}: Datei .agentops/flows/${name}.json fehlt.` };
  try {
    const flow = normalizeFlow(readJsonFile(file) ?? {});
    return { flow, error: validateFlow(flow, { sub: true }) };
  } catch (error) {
    return { flow: null, error: `Sub-Flow ${name}: kein gültiges JSON (${error?.message ?? error}).` };
  }
}

// Sub-Flow-Verweise prüfen: Datei da, gültig, keine Zyklen, nicht tiefer als MAX_DEPTH. Liefert alle Sub-Flows (Name → Definition).
function checkSubflows(cwd, flow, chain = [], out = {}) {
  for (const [id, a] of Object.entries(flow.agents)) {
    if (!a.flow) continue;
    if (chain.includes(a.flow)) return { error: `Sub-Flow ${a.flow} ruft sich selbst (${[...chain, a.flow].join(" → ")}).`, subflows: out };
    if (chain.length + 1 >= MAX_DEPTH) return { error: `Sub-Flow ${a.flow} in ${id}: tiefer als ${MAX_DEPTH} Ebenen geht nicht.`, subflows: out };
    const { flow: sub, error } = loadSubflow(cwd, a.flow);
    if (error) return { error, subflows: out };
    out[a.flow] = sub;
    const deeper = checkSubflows(cwd, sub, [...chain, a.flow], out);
    if (deeper.error) return deeper;
  }
  return { error: null, subflows: out };
}

// Die Flow-Definition eines Projekts von der Platte: flow.json, sonst der Standard-Flow — samt Sub-Flows
function loadFlow(cwd) {
  let def = null; let source = "default";
  const file = path.join(cwd, ".agentops", "flow.json");
  try {
    if (existsSync(file)) { def = readJsonFile(file); source = "flow.json"; }
  } catch (error) {
    return { flow: normalizeFlow(defaultFlow()), source: "default", subflows: {}, error: `flow.json ist kein gültiges JSON: ${error?.message ?? error}` };
  }
  const flow = normalizeFlow(def ?? defaultFlow());
  for (const [id, cfg] of Object.entries(legacyAgents(cwd))) if (flow.agents[id] && cfg && typeof cfg === "object") flow.agents[id] = { ...normalizeFlow({ agents: { [id]: cfg } }).agents[id], ...flow.agents[id] };
  const own = validateFlow(flow);
  const subs = checkSubflows(cwd, flow);
  return { flow, source, subflows: subs.subflows, error: own ?? subs.error };
}

// Nach einem Schritt: welche Kante? Erst eine Verzweigung, deren Urteil in der letzten Zeile steht und deren
// Obergrenze noch nicht erreicht ist, sonst die Standardkante, sonst das Ende.
function nextEdge(flow, ctx, node, line) {
  const counts = ctx.edgeCounts ?? {};
  const matching = flow.edges.filter((e) => e.from === node && e.on && line.includes(e.on));
  const branch = matching.find((e) => e.max == null || (counts[`${e.from}>${e.to}`] ?? 0) < e.max);
  const edge = branch ?? flow.edges.find((e) => e.from === node && !e.on) ?? { from: node, to: "done", on: null, max: null };
  return { edge, exhausted: !branch && matching.length > 0 ? matching[0] : null };
}

// ---------- Dateien im Repo ----------

// Die Schritte sprechen über Dateien im Repo (§16). Ihr Urteil steht in der letzten nicht-leeren Zeile von .agentops/<knoten>.md.
function lastLine(cwd, file) {
  try {
    const text = readFileSync(path.join(cwd, ".agentops", file), "utf8");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1].toUpperCase() : "";
  } catch {
    return "";
  }
}

// Ein Projekt kann die Soul eines Agenten überschreiben: <repo>/.agentops/souls/<knoten>.md wird als extraSystemPrompt oben draufgelegt.
function projectSoul(cwd, node) {
  const file = path.join(cwd, ".agentops", "souls", `${node}.md`);
  try {
    return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

// Soul für einen Knoten ohne Vorlage — knapp, mit der einen Regel, die die Pipeline braucht: das Urteil in der letzten Zeile
const genericSoul = (node) => `# SOUL — ${node}

You are the "${node}" agent of a deterministic pipeline. Read the notes of the earlier steps in .agentops/ and the relevant code, do exactly your part of the work for the goal, and write a short note to .agentops/${node}.md. If your step decides something, end that file with a single verdict line in capitals (for example APPROVE or REQUEST_CHANGES) — the pipeline reads only the last line. Change nothing outside the repository. Be brief.
`;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

// Die Aufgabe an einen Schritt-Agenten. prefix ist "" im Hauptflow, "coding/" in einem Sub-Flow — die Notizen liegen dort.
function buildMessage(state, ctx, prefix, node, attempt = 1) {
  const pathNodes = ctx.path ?? Object.keys(ctx.flow?.agents ?? {});
  const i = pathNodes.indexOf(node);
  const dir = `.agentops/${prefix}`;
  return [
    `Goal: ${state.goal}`,
    `Repository (working directory): ${state.cwd}`,
    prefix ? `You work inside the sub-pipeline "${prefix.slice(0, -1)}" of a larger pipeline; the notes of the outer pipeline are in .agentops/.` : null,
    `Pipeline step: ${node}${i >= 0 ? ` (${i + 1}/${pathNodes.length})` : ""}. Pipeline: ${pathNodes.join(" → ")}. Notes of earlier steps are in ${dir}.`,
    `Write your notes to ${dir}${node}.md; if this step gives a verdict, put it in the last line.`,
    attempt > 1 ? `Attempt ${attempt} of this step — earlier notes and findings are in ${dir}.` : null,
    `Work only inside the repository. When you are done, stop.`,
  ].filter(Boolean).join("\n");
}

// Was ein Agent tut — für die Liste, aus der der Master wählt: description aus flow.json, sonst die erste Textzeile seiner Soul
function describeAgent(cwd, templateWorkspace, node, cfg, subflows) {
  if (cfg?.description) return cfg.description;
  if (cfg?.flow) { const sub = subflows?.[cfg.flow]; return `a sub-pipeline (${sub ? flowPath(sub).join(" → ") : cfg.flow}) that runs as one step`; }
  for (const file of [path.join(cwd, ".agentops", "souls", `${node}.md`), templateWorkspace ? path.join(templateWorkspace, "SOUL.md") : null]) {
    try {
      if (!file || !existsSync(file)) continue;
      const line = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("_"));
      if (line) return line.slice(0, 200);
    } catch {}
  }
  return `the ${localOf(node)} agent`;
}

// Die Frage an den Master: Ziel, die Agenten mit Beschreibung und Verlauf, die Regeln — Antwort ist die letzte Zeile von master.md
function buildMasterMessage(state, ctx, prefix, flow, descriptions) {
  const dir = `.agentops/${prefix}`;
  const steps = (state.steps ?? []).filter((s) => s.step.startsWith(prefix) && !s.step.slice(prefix.length).includes("/") && localOf(s.step) !== MASTER && s.endedAt != null);
  const used = (ctx.master?.decisions ?? []).length;
  const pool = poolAgents(flow); const required = requiredAgents(flow); const tail = tailAgents(flow);
  const lines = pool.map((id) => {
    const runs = steps.filter((s) => localOf(s.step) === id);
    const last = runs.at(-1);
    return `- ${id}: ${descriptions[id] ?? id}${required.includes(id) ? " [required before the gate]" : ""}${runs.length ? ` — ran ${runs.length}×${last?.verdict ? `, last verdict: ${last.verdict}` : ""} (notes in ${dir}${id}.md)` : " — not run yet"}`;
  });
  return [
    `Goal: ${state.goal}`,
    `Repository (working directory): ${state.cwd}`,
    prefix ? `You are the master of the sub-pipeline "${prefix.slice(0, -1)}" inside a larger pipeline; the notes of the outer pipeline are in .agentops/.` : `You are the master of this pipeline: you decide which agent works next.`,
    `Agents you can call:`,
    ...lines,
    `Sequence so far: ${steps.length ? steps.map((s) => localOf(s.step)).join(" → ") : "nothing has run yet"}.`,
    `Rules: call an agent when its work is needed for the goal; agents may run more than once. Required agents you do not call will run automatically${flow.gates.length ? " before the human gate" : " at the end"}. ${tail.length ? `After the gate the pipeline runs ${tail.join(", ")} on its own. ` : ""}You have ${flow.master.maxSteps - used} decision${flow.master.maxSteps - used === 1 ? "" : "s"} left; when the goal is done and verified, say done.`,
    `Read the notes in ${dir} before deciding. Write 2–5 lines of reasoning to ${dir}master.md and end that file with exactly one line: NEXT: <agent> or NEXT: done`,
    `Do not change any other file. When you are done, stop.`,
  ].join("\n");
}

// Modell eines Agenten aus der Konfiguration: Eintrag, sonst Default, sonst OpenClaws Laufzeit-Standard.
function modelOf(entry, defaults) {
  const pick = (m) => (typeof m === "string" ? m : m?.primary ?? null);
  return pick(entry?.model) ?? pick(defaults?.model) ?? null;
}

export default definePluginEntry({
  id: CONTROLLER_ID,
  name: "Agent-Ops Pipeline",
  description: "Deterministische Pipeline als Graph je Projekt (Agenten, Kanten, Gates, Sub-Flows, Master) als managed TaskFlow.",
  register(api) {
    const cfg = api.pluginConfig ?? {};
    const ownerSessionKey = cfg.ownerSessionKey ?? "agent:main:main";
    const reposRoot = cfg.reposRoot ?? "/home/node/repos";
    const agentPrefix = cfg.agentPrefix ?? "pipeline-";   // agents.entries.<prefix><step>
    const cliPath = cfg.cliPath ?? "/app/openclaw.mjs";    // OpenClaws CLI im Container — für config get/set und models list
    const homeDir = cfg.homeDir ?? process.env.OPENCLAW_HOME ?? "/home/node/.openclaw";   // Workspaces der Projekt-Agenten liegen hier
    const log = api.logger ?? console;
    const flows = api.runtime.tasks.managedFlows.bindSession({ sessionKey: ownerSessionKey });

    // Schritte, die ein HTTP-Aufruf auslöst (start, gate, advance), starten im Async-Kontext der Registrierung —
    // außerhalb jedes Gateway-Requests. Innerhalb eines Requests gälten die Scopes des HTTP-Clients (ohne Admin);
    // so bleibt der Lauf ein Plugin-Subagent-Lauf wie die aus dem subagent_ended-Hook.
    const outsideRequest = new AsyncResource("agentops-pipeline");
    const detached = (fn) => outsideRequest.runInAsyncScope(fn);

    // Kein Zustand im Plugin: OpenClaw lädt Plugin-Instanzen mehrfach und neu. Welcher Lauf zu welchem
    // Flow gehört, steht im Flow selbst (stateJson.runs[currentStep], stateJson.steps[].sessionKey).
    // Jeder Versuch eines Schritts bekommt eine frische Session — der zweite code-Lauf soll nicht den
    // ganzen Kontext des ersten mitschleppen, er liest die Übergabedateien.
    const runSessionKey = (agentId, flowId, attempt = 1) => `agent:${agentId}:subagent:pipeline-${flowId.slice(0, 8)}${attempt > 1 ? `-${attempt}` : ""}`;

    function resolveRun(event) {
      for (const f of mine()) {
        if (f.status !== "running" || !f.currentStep) continue;
        const step = f.currentStep;
        const expectedRun = f.stateJson?.runs?.[step];
        const open = [...(f.stateJson?.steps ?? [])].reverse().find((s) => s.step === step && s.endedAt == null && s.kind !== "flow");
        if ((event.runId && expectedRun === event.runId) || (event.targetSessionKey && open && event.targetSessionKey === open.sessionKey)) {
          return { flowId: f.flowId, step };
        }
      }
      return null;
    }

    const latest = (flowId) => {
      const f = flows.get(flowId);
      if (!f) throw new Error(`flow ${flowId} not found`);
      return f;
    };

    const view = (f) => ({
      flowId: f.flowId,
      status: f.status,
      currentStep: f.currentStep ?? null,
      revision: f.revision,
      goal: f.goal,
      state: f.stateJson ?? null,
      wait: f.waitJson ?? null,
      blockedSummary: f.blockedSummary ?? null,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
      endedAt: f.endedAt ?? null,
    });

    const mine = () => flows.list().filter((f) => f.controllerId === CONTROLLER_ID);

    // ---------- Rahmen: der Flow, in dem gerade gearbeitet wird ----------
    // Der Hauptflow lebt direkt im Zustand (flow, path, edgeCounts, loops, master, lastVerdict, lastUnresolved);
    // jeder Sub-Flow ist ein Rahmen auf stateJson.stack mit denselben Feldern plus node (sein Knoten außen) und prefix.
    const frameOf = (state) => state.stack?.length ? state.stack.at(-1) : null;
    const ctxOf = (state) => frameOf(state) ?? state;
    const prefixOf = (state) => frameOf(state)?.prefix ?? "";
    const flowOf = (state) => ctxOf(state).flow ?? normalizeFlow(defaultFlow());   // ältere Flows kennen nur den Standard
    // Zustand fortschreiben: root-Felder (steps, gate, …) am Wurzelzustand, ctx-Felder im innersten Rahmen
    function apply(state, root = {}, ctx = {}) {
      const frame = frameOf(state);
      if (!frame) return { ...state, ...root, ...ctx };
      const stack = [...state.stack]; stack[stack.length - 1] = { ...frame, ...ctx };
      return { ...state, ...root, stack };
    }
    const subflowOf = (state, name) => state.subflows?.[name] ?? null;

    // OpenClaws CLI im selben Container: config get/set schreiben validiert und lösen den Hot-Reload aus.
    async function cli(...args) {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { env: process.env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    }
    const agentIds = () => ["main", ...TEMPLATE_STEPS.map((s) => `${agentPrefix}${s}`)];

    // Gateway-Methoden über die CLI (api.runtime.gateway.request bleibt gebündelten Plugins vorbehalten).
    async function gatewayCall(method, params) {
      const token = process.env.OPENCLAW_GATEWAY_TOKEN;
      const out = await cli("gateway", "call", method, "--params", JSON.stringify(params), "--json", "--url", cfg.gatewayUrl ?? "ws://127.0.0.1:18789", ...(token ? ["--token", token] : []));
      try { return JSON.parse(out); } catch { return out; }
    }

    let modelCache = { at: 0, models: [] };
    async function listModels() {
      if (Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache.models;
      const parsed = JSON.parse(await cli("models", "list", "--json"));
      const models = (parsed.models ?? []).map((m) => ({ key: m.key, name: m.name ?? m.key, provider: String(m.key).split("/")[0], available: m.available !== false && !m.missing, contextWindow: m.contextWindow ?? null, tags: m.tags ?? [] }));
      modelCache = { at: Date.now(), models };
      return models;
    }

    async function listAgents() {
      const agents = JSON.parse(await cli("config", "get", "agents"));
      const entries = agents.entries ?? {};
      return agentIds().map((id) => {
        const entry = entries[id] ?? {};
        const model = modelOf(entry, agents.defaults);
        return {
          id,
          role: id === "main" ? "main" : id === `${agentPrefix}${MASTER}` ? "master" : "step",
          step: id === "main" ? null : id.slice(agentPrefix.length),
          model,
          explicit: entry.model != null,
          thinking: entry.thinkingDefault ?? null,
          thinkingDefault: agents.defaults?.thinkingDefault ?? null,
          tools: Array.isArray(entry.tools?.allow) ? entry.tools.allow : null,
          toolsProfile: entry.tools?.profile ?? agents.defaults?.tools?.profile ?? null,
          runtime: entry.agentRuntime?.id ?? (model ? agents.defaults?.models?.[model]?.agentRuntime?.id : null) ?? null,
          workspace: entry.workspace ?? null,
        };
      });
    }

    // OpenAI-Modelle würden standardmäßig den Codex-Harness nehmen, dessen Binary im Image fehlt — deshalb
    // die eingebettete Laufzeit festnageln. Das geht nur je Modell (agents.defaults.models), nicht je Agent,
    // und gilt auch für Modelle, die ein Projekt in flow.json wählt.
    let pinned = null;
    async function ensureRuntimePin(model) {
      if (!model.startsWith("openai/")) return;
      if (pinned == null) {
        try {
          const models = JSON.parse(await cli("config", "get", "agents.defaults.models"));
          pinned = new Set(Object.entries(models).filter(([, v]) => v?.agentRuntime?.id === "openclaw").map(([k]) => k));
        } catch {
          pinned = new Set();
        }
      }
      if (pinned.has(model)) return;
      await cli("config", "set", `agents.defaults.models["${model}"].agentRuntime.id`, "openclaw");
      pinned.add(model);
    }

    async function setAgentModel(id, model) {
      if (!agentIds().includes(id)) throw new Error(`unknown agent: ${id}`);
      if (!MODEL_ID.test(model)) throw new Error("model must look like provider/model");
      await ensureRuntimePin(model);
      await cli("config", "set", `agents.entries.${id}.model`, model);
      log.info?.(`[pipeline] model of ${id} → ${model}`);
    }

    // Effort je Agent: agents.entries.<id>.thinkingDefault; leer = OpenClaws Standard
    async function setAgentThinking(id, level) {
      if (!agentIds().includes(id)) throw new Error(`unknown agent: ${id}`);
      if (!level) { await cli("config", "unset", `agents.entries.${id}.thinkingDefault`).catch(() => {}); log.info?.(`[pipeline] thinking of ${id} → default`); return; }
      if (!THINKING_LEVELS.includes(level)) throw new Error(`thinking must be one of ${THINKING_LEVELS.join(", ")}`);
      await cli("config", "set", `agents.entries.${id}.thinkingDefault`, level);
      log.info?.(`[pipeline] thinking of ${id} → ${level}`);
    }

    // Tool-Liste je Agent: agents.entries.<id>.tools.allow (absolute Allowlist); leer = OpenClaws Standard-Policy.
    // Für die Vorlagen pipeline-<step> gilt sie auch für alle Projekt-Agenten ohne eigene Liste (Abgleich vor dem Schritt).
    async function setAgentTools(id, list) {
      if (!agentIds().includes(id)) throw new Error(`unknown agent: ${id}`);
      const tools = list.filter((t) => typeof t === "string" && TOOL_ID.test(t));
      await configPatch({ agents: { entries: { [id]: { tools: tools.length ? { allow: tools } : null } } } });
      log.info?.(`[pipeline] tools of ${id} → ${tools.length ? tools.join("/") : "default"}`);
    }

    // Mehrere Werte in einem validierten Schreibvorgang: config patch (Objekte mergen, null löscht).
    async function configPatch(patch) {
      const file = path.join(os.tmpdir(), `agentops-patch-${process.pid}-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(patch));
      try { return await cli("config", "patch", "--file", file); }
      finally { try { unlinkSync(file); } catch {} }
    }

    // Der Tool-Katalog (Kern-Tools nach Gruppen), fürs Cockpit; 10 Minuten gecacht.
    let toolCache = { at: 0, groups: [] };
    async function listTools() {
      if (Date.now() - toolCache.at < 10 * 60 * 1000) return toolCache.groups;
      const res = await gatewayCall("tools.catalog", { agentId: `${agentPrefix}plan` });
      const groups = (res?.result?.groups ?? res?.groups ?? []).map((g) => ({
        id: g.id, label: g.label ?? g.id, source: g.source ?? null,
        tools: (g.tools ?? []).map((t) => ({ id: t.id, label: t.label ?? t.id, description: t.description ?? "", defaultProfiles: t.defaultProfiles ?? [] })),
      }));
      toolCache = { at: Date.now(), groups };
      return groups;
    }

    // Die Agenten eines Flows anlegen und mit Vorlage + Definition abgleichen. prefix = "" (Hauptflow) oder "coding/".
    // Liefert knoten → agentId. Sub-Flow-Knoten selbst sind keine Agenten. Wird vor jedem Schritt aufgerufen;
    // ohne Änderung ist es ein config get (~1 s), sonst ein Patch mit Hot-Reload.
    async function ensureProjectAgents(repo, cwd, flow, prefix = "") {
      const agents = JSON.parse(await cli("config", "get", "agents"));
      const entries = agents.entries ?? {};
      const patch = {}; const creations = []; const ids = {}; const resolved = {};
      for (const [node, pa] of Object.entries(flow.agents)) {
        if (pa.flow) continue;
        const id = projectAgentId(agentPrefix, repo, prefix + node); ids[node] = id;
        const template = entries[`${agentPrefix}${node}`] ?? null;   // nur die bekannten Schritte haben eine Vorlage
        const model = pa.model ?? modelOf(template ?? {}, agents.defaults);
        const thinking = pa.thinking ?? template?.thinkingDefault ?? null;
        const tools = pa.tools?.length ? { allow: pa.tools } : template?.tools ?? null;
        const workspace = `${homeDir}/workspace-${id}`;
        resolved[node] = { model, thinking, tools: tools?.allow ?? null, workspace, templateWorkspace: template ? template.workspace ?? `${homeDir}/workspace-${agentPrefix}${node}` : null };
        if (model) await ensureRuntimePin(model);
        const current = entries[id];
        if (!current) creations.push({ id, workspace, model });
        const diff = {};
        if ((current?.model ?? null) !== (model ?? null)) diff.model = model ?? null;
        if ((current?.thinkingDefault ?? null) !== (thinking ?? null)) diff.thinkingDefault = thinking ?? null;
        if (JSON.stringify(current?.tools ?? null) !== JSON.stringify(tools ?? null)) diff.tools = tools ?? null;
        if (!current) { delete diff.model; if (diff.thinkingDefault === null) delete diff.thinkingDefault; if (diff.tools === null) delete diff.tools; }
        if (Object.keys(diff).length) patch[id] = diff;
      }
      for (const c of creations) {
        mkdirSync(c.workspace, { recursive: true });
        await cli("agents", "add", c.id, "--workspace", c.workspace, ...(c.model ? ["--model", c.model] : []), "--non-interactive");
        log.info?.(`[pipeline] agent ${c.id} created (workspace ${c.workspace})`);
      }
      if (Object.keys(patch).length) {
        await configPatch({ agents: { entries: patch } });
        log.info?.(`[pipeline] agents of ${repo}${prefix ? ` (${prefix.slice(0, -1)})` : ""} updated: ${Object.entries(patch).map(([id, d]) => `${id} ${Object.keys(d).join("+")}`).join(", ")}`);
      }
      // Die Soul der Vorlage ist die Soul des Projekt-Agenten; ohne Vorlage eine knappe Standard-Soul.
      // Die Projekt-Soul (.agentops/souls/<knoten>.md) kommt in beiden Fällen als extraSystemPrompt obendrauf.
      for (const [node, r] of Object.entries(resolved)) {
        try {
          mkdirSync(r.workspace, { recursive: true });
          const dst = path.join(r.workspace, "SOUL.md");
          const src = r.templateWorkspace ? path.join(r.templateWorkspace, "SOUL.md") : null;
          if (src && existsSync(src)) copyFileSync(src, dst);
          // agents add legt OpenClaws eigene Bootstrap-Soul ab ("Who You Are") — die ersetzt die knappe Pipeline-Soul, nichts anderes
          else if (!existsSync(dst) || !readFileSync(dst, "utf8").startsWith("# SOUL — ")) writeFileSync(dst, genericSoul(prefix + node));
        } catch (error) { log.warn?.(`[pipeline] soul sync ${prefix}${node}: ${error?.message ?? error}`); }
      }
      return { ids, resolved };
    }

    // Alle Agenten eines Projekts: Hauptflow und jeder Sub-Flow
    async function ensureAllAgents(repo, cwd, flow, subflows) {
      const out = [];
      const walk = async (f, prefix) => {
        const { ids, resolved } = await ensureProjectAgents(repo, cwd, f, prefix);
        for (const node of Object.keys(f.agents)) {
          if (f.agents[node].flow) { out.push({ step: prefix + node, id: null, flow: f.agents[node].flow }); const sub = subflows[f.agents[node].flow]; if (sub) await walk(sub, `${prefix}${node}/`); }
          else out.push({ step: prefix + node, id: ids[node], model: resolved[node].model, thinking: resolved[node].thinking, tools: resolved[node].tools });
        }
      };
      await walk(flow, "");
      return out;
    }

    // Lebenslauf eines Schritts: stateJson.steps ist eine Liste aller Versuche mit Anfang, Ende, Ausgang und Urteil.
    // Daraus liest das Cockpit Dauer je Schritt; Frage und Antwort stehen bei OpenClaw (subagent_runs).
    function closeStep(state, step, event, verdict) {
      let done = false;
      const steps = [...(state.steps ?? [])].reverse().map((s) => {
        if (done || s.step !== step || s.endedAt != null) return s;
        done = true;
        return { ...s, endedAt: event.endedAt ?? Date.now(), outcome: event.outcome ?? "ok", ...(verdict ? { verdict } : {}) };
      }).reverse();
      return steps;
    }

    // Einen Agenten-Knoten des aktuellen Rahmens starten (node ist lokal, z.B. "pr"; der Schritt heißt "coding/pr")
    async function startStep(flowId, node, root = {}, ctxPatch = {}) {
      const flow0 = latest(flowId);
      const state = apply(flow0.stateJson ?? {}, root, ctxPatch);
      const ctx = ctxOf(state); const flow = flowOf(state); const prefix = prefixOf(state);
      if (!flow.agents[node]) throw new Error(`${prefix}${node} is not an agent of this flow`);
      if (flow.agents[node].flow) { await startSubflow(flowId, node, state); return; }
      const step = prefix + node;
      const attempt = (state.attempts?.[step] ?? 0) + 1;

      const override = projectSoul(state.cwd, step);
      // Der Agent dieses Projekts für diesen Knoten — mit Modell, Effort und Tools aus der Flow-Definition
      const { ids, resolved } = await ensureProjectAgents(state.repo, state.cwd, flow, prefix);
      const agentId = ids[node];
      const { model, thinking, tools } = resolved[node];
      const sessionKey = runSessionKey(agentId, flowId, attempt);
      const message = node === MASTER && flow.mode === "master"
        ? buildMasterMessage(state, ctx, prefix, flow, Object.fromEntries(poolAgents(flow).map((id) => [id, describeAgent(state.cwd, resolved[id]?.templateWorkspace, prefix + id, flow.agents[id], state.subflows)])))
        : buildMessage(state, ctx, prefix, node, attempt);
      const run = await api.runtime.subagent.run({
        sessionKey,
        message,
        ...(override ? { extraSystemPrompt: override } : {}),
        promptMode: "minimal",
        lightContext: true,
        deliver: false,
        cwd: state.cwd,
        lane: `pipeline:${flowId}`,
        idempotencyKey: `${flowId}:${step}:${attempt}`,
      });

      // Kein flows.runTask(): OpenClaw verknüpft Kind-Tasks nur, wenn der Lauf demselben Owner gehört wie der
      // Flow. Die Schritte laufen aber als eigene Agenten, der Flow gehört main — "Task backing ownership could
      // not be verified". Die Verknüpfung Lauf ↔ Flow steht deshalb im Flow selbst (stateJson.runs[schritt] = runId).
      const revision = latest(flowId).revision;
      let nextState = {
        ...state,
        runs: { ...(state.runs ?? {}), [step]: run.runId },
        attempts: { ...(state.attempts ?? {}), [step]: attempt },
        steps: [...(state.steps ?? []), { step, attempt, runId: run.runId, sessionKey, agent: agentId, soulOverride: Boolean(override), model, thinking, tools, startedAt: Date.now() }],
      };
      if (flow.mode === "master") nextState = apply(nextState, {}, { path: flowPath(flow, nextState, prefix) });   // der Streifen folgt dem, was der Master tut
      const result = flows.resume({ flowId, expectedRevision: revision, status: "running", currentStep: step, stateJson: nextState });
      if (result && result.applied === false) log.warn?.(`[pipeline] ${flowId.slice(0, 8)}: step ${step} not recorded (${result.reason ?? "unknown"})`);
      log.info?.(`[pipeline] ${flowId.slice(0, 8)} → ${step} (agent ${agentId}, run ${run.runId}${model ? `, model ${model}` : ""}${thinking ? `, thinking ${thinking}` : ""}${tools ? `, tools ${tools.join("/")}` : ""})`);
      return run;
    }

    // Einen Sub-Flow betreten: neuer Rahmen auf dem Stack, ein Schritt "flow" für den Knoten außen, dann sein Start
    async function startSubflow(flowId, node, state) {
      const flow = flowOf(state); const prefix = prefixOf(state);
      const name = flow.agents[node].flow;
      const sub = subflowOf(state, name);
      if (!sub) throw new Error(`Sub-Flow ${name} fehlt im Zustand des Flows`);
      if ((state.stack?.length ?? 0) >= MAX_DEPTH) throw new Error(`Sub-Flow ${name}: tiefer als ${MAX_DEPTH} Ebenen geht nicht`);
      const step = prefix + node;
      mkdirSync(path.join(state.cwd, ".agentops", step), { recursive: true });
      const frame = { node: step, name, flow: sub, path: flowPath(sub), prefix: `${step}/`, edgeCounts: {}, loops: 0, master: null, lastVerdict: null, lastUnresolved: null, startedAt: Date.now() };
      const nextState = {
        ...state,
        attempts: { ...(state.attempts ?? {}), [step]: (state.attempts?.[step] ?? 0) + 1 },
        steps: [...(state.steps ?? []), { step, attempt: (state.attempts?.[step] ?? 0) + 1, kind: "flow", flow: name, startedAt: Date.now() }],
        stack: [...(state.stack ?? []), frame],
      };
      flows.resume({ flowId, expectedRevision: latest(flowId).revision, status: "running", currentStep: step, stateJson: nextState });
      log.info?.(`[pipeline] ${flowId.slice(0, 8)} ↳ ${step} = sub-flow ${name} (${frame.path.join(" → ")})`);
      await startStep(flowId, sub.mode === "master" ? MASTER : sub.start);
    }

    // Ein Sub-Flow ist fertig (done oder halt): Übergabedatei für außen schreiben, Rahmen abbauen, außen weiterrouten
    async function finishSubflow(flowId, state, halted, note) {
      const frame = frameOf(state); const sub = frame.flow;
      const verdictLine = halted ? `HALT: ${note ?? "halt"}` : (frame.lastVerdict ? frame.lastVerdict.toUpperCase().replace(/_/g, " ") : "DONE");
      const inner = (state.steps ?? []).filter((s) => s.step.startsWith(frame.prefix));
      try {
        writeFileSync(path.join(state.cwd, ".agentops", `${frame.node}.md`), [
          `# ${frame.node} — sub-pipeline ${frame.name}`,
          ``,
          `Steps: ${inner.map((s) => `${s.step.slice(frame.prefix.length)}${s.verdict ? ` (${s.verdict})` : ""}`).join(" → ") || "none"}`,
          `Notes: .agentops/${frame.prefix}*.md`,
          ``,
          verdictLine,
          ``,
        ].join("\n"));
      } catch (error) { log.warn?.(`[pipeline] ${flowId.slice(0, 8)}: summary of ${frame.node} not written (${error?.message ?? error})`); }
      const steps = closeStep(state, frame.node, { outcome: halted ? "halt" : "ok" }, halted ? "halt" : (frame.lastVerdict ?? "done"));
      const popped = { ...state, steps, stack: state.stack.slice(0, -1) };
      // Den abgebauten Rahmen festschreiben, bevor außen weitergeroutet wird — startStep und enter lesen den letzten Zustand neu
      flows.resume({ flowId, expectedRevision: latest(flowId).revision, status: "running", currentStep: frame.node, stateJson: popped });
      log.info?.(`[pipeline] ${flowId.slice(0, 8)} ↰ ${frame.node} ${halted ? "halted" : "done"} (${verdictLine})`);
      await routeAfter(flowId, popped, localOf(frame.node), verdictLine, halted);
    }

    // Einen Zielknoten des aktuellen Rahmens betreten: Agent starten, am Gate warten, beenden oder scheitern.
    // Ende oder halt in einem Sub-Flow beenden nur den Sub-Flow — außen geht es mit seinem Urteil weiter.
    async function enter(flowId, target, root = {}, ctxPatch = {}, note = null) {
      const flow0 = latest(flowId);
      const state = apply(flow0.stateJson ?? {}, root, ctxPatch);
      const ctx = ctxOf(state); const flow = flowOf(state); const prefix = prefixOf(state);
      if (target === "done" || target === "halt") {
        if (frameOf(state)) { await finishSubflow(flowId, state, target === "halt", note); return; }
        if (target === "done") {
          flows.finish({ flowId, expectedRevision: flow0.revision, stateJson: { ...state, finishedAt: Date.now() } });
          log.info?.(`[pipeline] ${flowId.slice(0, 8)} finished`);
        } else {
          flows.fail({ flowId, expectedRevision: flow0.revision, blockedSummary: note ?? "halt", stateJson: { ...state, failedStep: state.steps?.at?.(-1)?.step ?? null, failedAt: Date.now() } });
          log.warn?.(`[pipeline] ${flowId.slice(0, 8)} halted: ${note ?? "halt"}`);
        }
        return;
      }
      if (flow.gates.includes(target)) {
        const after = flow.mode === "master" ? tailAgents(flow)[0] ?? "done" : flow.edges.find((e) => e.from === target && !e.on)?.to ?? "done";
        const gateName = prefix + target;
        flows.setWaiting({
          flowId,
          expectedRevision: flow0.revision,
          currentStep: gateName,
          waitJson: { kind: "gate", gate: gateName, step: after, requestedAt: Date.now(), review: ctx.lastUnresolved ? "request_changes_unresolved" : (ctx.lastVerdict ?? null), unresolved: ctx.lastUnresolved ?? null },
          stateJson: { ...state, gate: { status: "pending", gate: gateName, step: after, requestedAt: Date.now() } },
        });
        log.info?.(`[pipeline] ${flowId.slice(0, 8)} waiting at ${gateName} before ${after}`);
        return;
      }
      await startStep(flowId, target, root, ctxPatch);
    }

    // Master-Modus: nach jedem Schritt entscheidet der Master — außer die Pflicht-Agenten laufen gerade nach oder der
    // Flow ist schon hinter dem Gate; dann ist die Reihenfolge fest.
    async function masterNext(flowId, node, verdict, line, state, steps) {
      const ctx = ctxOf(state); const flow = flowOf(state); const prefix = prefixOf(state);
      const tail = tailAgents(flow);
      if (tail.includes(node)) {   // hinter dem Gate: der nächste Agent nach dem Gate, sonst fertig
        await enter(flowId, tail[tail.indexOf(node) + 1] ?? "done", { steps }, {}, null);
        return;
      }
      if (node === MASTER) {
        const m = /NEXT:\s*([A-Z0-9_-]+)/.exec(line);
        const choice = m ? m[1].toLowerCase() : "done";
        const decisions = [...(ctx.master?.decisions ?? []), { at: Date.now(), next: choice, line: line.slice(0, 120) }];
        const pool = poolAgents(flow);
        const ctxPatch = { master: { ...(ctx.master ?? {}), decisions, phase: "master" } };
        if (choice !== "done" && !pool.includes(choice)) log.warn?.(`[pipeline] ${flowId.slice(0, 8)} ${prefix}master chose unknown agent "${choice}" — treating as done`);
        if (choice !== "done" && pool.includes(choice) && decisions.length < flow.master.maxSteps) {
          log.info?.(`[pipeline] ${flowId.slice(0, 8)} ${prefix}master → ${choice} (${decisions.length}/${flow.master.maxSteps})`);
          await startStep(flowId, choice, { steps }, ctxPatch);
          return;
        }
        if (choice !== "done" && pool.includes(choice)) log.warn?.(`[pipeline] ${flowId.slice(0, 8)} ${prefix}master step limit ${flow.master.maxSteps} reached — finishing`);
        await finishMasterPhase(flowId, apply(state, { steps }, ctxPatch));
        return;
      }
      // Ein Agent aus dem Pool ist fertig: zurück zum Master — oder die Pflicht-Agenten weiter
      const ctxPatch = { lastVerdict: verdict };
      if (ctx.master?.phase === "required") { await finishMasterPhase(flowId, apply(state, { steps }, ctxPatch)); return; }
      await startStep(flowId, MASTER, { steps }, ctxPatch);
    }

    // Nach dem letzten Wort des Masters: Pflicht-Agenten nachholen, die noch nicht gelaufen sind, dann das Gate (oder das Ende im Sub-Flow)
    async function finishMasterPhase(flowId, state) {
      const ctx = ctxOf(state); const flow = flowOf(state); const prefix = prefixOf(state);
      const ran = new Set((state.steps ?? []).filter((s) => s.endedAt != null && s.step.startsWith(prefix)).map((s) => s.step.slice(prefix.length)));
      const pending = requiredAgents(flow).filter((id) => !ran.has(id));
      const master = { ...(ctx.master ?? {}), phase: pending.length ? "required" : "gate" };
      const patched = apply(state, {}, { master });
      if (pending.length) {
        log.info?.(`[pipeline] ${flowId.slice(0, 8)} ${prefix}required agents pending: ${pending.join(", ")}`);
        flows.resume({ flowId, expectedRevision: latest(flowId).revision, status: "running", currentStep: latest(flowId).currentStep, stateJson: patched });
        await startStep(flowId, pending[0]);
        return;
      }
      flows.resume({ flowId, expectedRevision: latest(flowId).revision, status: "running", currentStep: latest(flowId).currentStep, stateJson: patched });
      await enter(flowId, flow.gates[0] ?? "done", {}, {}, null);
    }

    // Weiterrouten, nachdem ein Knoten des aktuellen Rahmens fertig ist (Agent oder Sub-Flow). node ist lokal.
    async function routeAfter(flowId, state, node, line, halted = false) {
      const ctx = ctxOf(state); const flow = flowOf(state); const prefix = prefixOf(state);
      const steps = state.steps;
      if (flow.mode === "master") {
        const verdict = halted ? "halt" : /\bPASS\b/.test(line) ? "pass" : /\bAPPROVE\b/.test(line) ? "approve" : /\b(FAIL|REQUEST_CHANGES|BLOCK)\b/.test(line) ? line.toLowerCase().replace(/\s+/g, "_").slice(0, 40) : null;
        await masterNext(flowId, node, verdict, line, state, steps);
        return;
      }
      const { edge, exhausted } = nextEdge(flow, ctx, node, line);
      if (halted && !edge.on) {   // ein gescheiterter Sub-Flow ohne passende Kante reißt den äußeren Flow mit
        await enter(flowId, "halt", { steps }, {}, `${prefix}${node}: ${line.slice(0, 80)}`);
        return;
      }
      const verdict = edge.on ? edge.on.toLowerCase().replace(/\s+/g, "_") : exhausted ? exhausted.on.toLowerCase().replace(/\s+/g, "_") : /\bPASS\b/.test(line) ? "pass" : /\bAPPROVE\b/.test(line) ? "approve" : null;
      const key = `${edge.from}>${edge.to}`;
      const ctxPatch = {
        edgeCounts: { ...(ctx.edgeCounts ?? {}), [key]: (ctx.edgeCounts?.[key] ?? 0) + 1 },
        loops: (ctx.loops ?? 0) + (edge.on && flow.agents[edge.to] ? 1 : 0),
        lastVerdict: verdict,
        lastUnresolved: exhausted ? `${prefix}${node}: ${exhausted.on} (${exhausted.max}× erreicht)` : null,
      };
      if (edge.on) log.info?.(`[pipeline] ${flowId.slice(0, 8)} ${prefix}${node}: ${edge.on} → ${edge.to}${edge.max ? ` (${ctxPatch.edgeCounts[key]}/${edge.max})` : ""}`);
      else if (exhausted) log.info?.(`[pipeline] ${flowId.slice(0, 8)} ${prefix}${node}: ${exhausted.on} again, limit ${exhausted.max} reached → ${edge.to}`);
      await enter(flowId, edge.to, { steps }, ctxPatch, edge.to === "halt" ? `${prefix}${node}: ${line.slice(0, 80)} — siehe .agentops/${prefix}${node}.md` : null);
    }

    async function onStepEnded(flowId, step, event) {
      const flow0 = latest(flowId);
      const state = flow0.stateJson ?? {};
      const prefix = prefixOf(state);
      const node = step.startsWith(prefix) ? step.slice(prefix.length) : localOf(step);
      if (event.outcome !== "ok") {
        flows.fail({
          flowId,
          expectedRevision: flow0.revision,
          blockedSummary: `${step} failed (${event.outcome ?? "unknown"})`,
          stateJson: { ...state, steps: closeStep(state, step, event), failedStep: step, failedAt: Date.now() },
        });
        log.warn?.(`[pipeline] ${flowId.slice(0, 8)} failed at ${step}`);
        return;
      }
      // Das Urteil des Schritts — deterministisch, aus der letzten Zeile der Übergabedatei, nicht aus dem Modell
      const line = lastLine(state.cwd, `${step}.md`);
      const flow = flowOf(state);
      const verdict = flow.mode === "master" && node === MASTER
        ? (/NEXT:\s*DONE/.test(line) ? "done" : `next: ${(/NEXT:\s*([A-Z0-9_-]+)/.exec(line)?.[1] ?? "?").toLowerCase()}`)
        : /\bPASS\b/.test(line) ? "pass" : /\bAPPROVE\b/.test(line) ? "approve" : /\b(FAIL|REQUEST_CHANGES|BLOCK)\b/.test(line) ? line.toLowerCase().replace(/\s+/g, "_").slice(0, 40) : null;
      await routeAfter(flowId, { ...state, steps: closeStep(state, step, event, verdict) }, node, line, false);
    }

    async function decideGate(flowId, decision, by) {
      const flow0 = latest(flowId);
      if (flow0.status !== "waiting" || flow0.waitJson?.kind !== "gate") throw new Error("flow is not waiting at a gate");
      if (decision !== "allow" && decision !== "deny") throw new Error("decision must be allow or deny");
      const after = flow0.waitJson.step ?? "done";
      const gate = { ...(flow0.stateJson?.gate ?? {}), status: decision === "allow" ? "allowed" : "denied", decision, by, decidedAt: Date.now() };
      const state = apply({ ...(flow0.stateJson ?? {}), gate }, {}, { lastUnresolved: null });
      if (decision === "allow") {
        flows.resume({ flowId, expectedRevision: flow0.revision, status: "running", currentStep: flow0.currentStep, stateJson: state });
        await enter(flowId, after, {}, {}, null);
      } else {
        flows.fail({ flowId, expectedRevision: flow0.revision, blockedSummary: `gate denied by ${by}`, stateJson: state });
      }
    }

    api.on("subagent_ended", async (event) => {
      const entry = resolveRun(event);
      if (!entry) return;
      log.info?.(`[pipeline] ${entry.flowId.slice(0, 8)}: ${entry.step} ended (${event.outcome ?? "?"})`);
      try {
        await onStepEnded(entry.flowId, entry.step, event);
      } catch (error) {
        log.error?.(`[pipeline] ${entry.flowId.slice(0, 8)}/${entry.step}: ${error?.message ?? error}`);
      }
    });

    const repoDir = (repo) => {
      if (!repo || repo.includes("..") || repo.includes("/")) return null;
      const cwd = path.join(reposRoot, repo);
      return existsSync(cwd) ? cwd : null;
    };

    api.registerHttpRoute({
      path: ROUTE,
      auth: "gateway",
      match: "prefix",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://local");
          const rest = url.pathname.slice(ROUTE.length).split("/").filter(Boolean);

          if (req.method === "GET" && rest.length === 0) return json(res, 200, { flows: mine().map(view) });

          // Vorlagen-Agenten und ihre Modelle — main (der Master) und die Schritt-Agenten
          if (req.method === "GET" && rest[0] === "agents" && rest.length === 1) {
            const [agents, models] = await Promise.all([listAgents(), listModels().catch((e) => { log.warn?.(`[pipeline] models list: ${e.message}`); return []; })]);
            // Ohne eigenen Eintrag gilt OpenClaws Laufzeit-Standard — der Katalog markiert ihn mit dem Tag "default".
            const fallback = models.find((m) => m.tags.includes("default"))?.key ?? null;
            for (const a of agents) if (a.model == null) a.model = fallback;
            return json(res, 200, { agents, models });
          }
          if (req.method === "PUT" && rest[0] === "agents" && rest.length === 2) {
            const body = await readJson(req);
            if (body.model != null) await setAgentModel(rest[1], String(body.model).trim());
            if (body.thinking != null) await setAgentThinking(rest[1], String(body.thinking).trim());
            if (Array.isArray(body.tools)) await setAgentTools(rest[1], body.tools);
            return json(res, 200, (await listAgents()).find((a) => a.id === rest[1]));
          }
          // Der Tool-Katalog fürs Cockpit (Kern-Tools nach Gruppen)
          if (req.method === "GET" && rest[0] === "tools" && rest.length === 1) {
            return json(res, 200, { groups: await listTools() });
          }

          // Der Flow eines Projekts, wie das Plugin ihn liest: flow.json (mit agents.json-Altbestand) oder Standard, geprüft, samt Sub-Flows
          if (req.method === "GET" && rest[0] === "projects" && rest.length === 3 && rest[2] === "flow") {
            const cwd = repoDir(rest[1]);
            if (!cwd) return json(res, 404, { error: `repo not found: ${rest[1]}` });
            const { flow, source, subflows, error } = loadFlow(cwd);
            return json(res, 200, { flow, path: flowPath(flow), source, error, templates: TEMPLATE_STEPS, subflows: Object.fromEntries(Object.entries(subflows).map(([n, f]) => [n, { flow: f, path: flowPath(f) }])) });
          }
          // Eine Definition prüfen, ohne sie zu speichern — das Cockpit fragt vor dem Commit. Mit repo werden Sub-Flow-Verweise gegen die Platte geprüft.
          if (req.method === "POST" && rest[0] === "flow" && rest.length === 2 && rest[1] === "validate") {
            const body = await readJson(req);
            const flow = normalizeFlow(body);
            let error = validateFlow(flow, { sub: body.sub === true });
            if (!error && body.repo) { const cwd = repoDir(String(body.repo)); if (cwd) error = checkSubflows(cwd, flow, body.sub === true && typeof body.name === "string" ? [body.name] : []).error; }
            return json(res, 200, { flow, path: flowPath(flow), error });
          }
          // Die Agenten eines Projekts anlegen/abgleichen, ohne einen Lauf — z.B. nach einer Änderung im Cockpit
          if (req.method === "POST" && rest[0] === "projects" && rest.length === 3 && rest[2] === "sync") {
            const cwd = repoDir(rest[1]);
            if (!cwd) return json(res, 404, { error: `repo not found: ${rest[1]}` });
            const { flow, subflows, error } = loadFlow(cwd);
            if (error) return json(res, 400, { error });
            return json(res, 200, { agents: await ensureAllAgents(rest[1], cwd, flow, subflows) });
          }

          if (req.method === "POST" && rest[0] === "start" && rest.length === 1) {
            const body = await readJson(req);
            const repo = String(body.repo ?? "").trim();
            const goal = String(body.goal ?? "").trim();
            const cwd = repoDir(repo);
            if (!cwd) return json(res, 404, { error: `repo not found: ${repo}` });
            if (!goal) return json(res, 400, { error: "goal required" });
            const { flow, subflows, error } = loadFlow(cwd);
            if (error) return json(res, 400, { error: `flow.json: ${error}` });
            const created = flows.createManaged({
              controllerId: CONTROLLER_ID,
              goal,
              status: "running",
              currentStep: flow.start,
              notifyPolicy: "silent",
              stateJson: { repo, cwd, goal, runs: {}, attempts: {}, steps: [], edgeCounts: {}, loops: 0, flow, subflows, path: flowPath(flow), stack: [], startedAt: Date.now() },
            });
            const created0 = created?.flow ?? created;
            if (!created0?.flowId) return json(res, 500, { error: "createManaged returned no flow", detail: created });
            try {
              await detached(() => startStep(created0.flowId, flow.start));
            } catch (error) {
              // Der Flow existiert schon — nicht als Leiche stehen lassen
              flows.fail({ flowId: created0.flowId, expectedRevision: latest(created0.flowId).revision, blockedSummary: `${flow.start} could not start: ${error?.message ?? error}`, stateJson: { ...(latest(created0.flowId).stateJson ?? {}), failedStep: flow.start, failedAt: Date.now() } });
              throw error;
            }
            return json(res, 201, view(latest(created0.flowId)));
          }

          // Operator-Eingriff: Flow abbrechen (ein laufender Schritt läuft aus, sein Ergebnis wird ignoriert)
          if (req.method === "POST" && rest.length === 2 && rest[1] === "cancel") {
            const body = await readJson(req);
            const flow = latest(rest[0]);
            if (flow.status !== "running" && flow.status !== "waiting") return json(res, 409, { error: `flow is ${flow.status}` });
            const by = String(body.by ?? "operator");
            flows.fail({ flowId: flow.flowId, expectedRevision: flow.revision, blockedSummary: `cancelled by ${by}`, stateJson: { ...(flow.stateJson ?? {}), steps: closeStep(flow.stateJson ?? {}, flow.currentStep, { outcome: "cancelled" }), cancelledBy: by, cancelledAt: Date.now() } });
            log.warn?.(`[pipeline] ${flow.flowId.slice(0, 8)}: cancelled at ${flow.currentStep} by ${by}`);
            return json(res, 200, view(latest(rest[0])));
          }

          if (req.method === "GET" && rest.length === 1) {
            const f = flows.get(rest[0]);
            return f && f.controllerId === CONTROLLER_ID ? json(res, 200, view(f)) : json(res, 404, { error: "flow not found" });
          }

          if (req.method === "POST" && rest.length === 2 && rest[1] === "gate") {
            const body = await readJson(req);
            await detached(() => decideGate(rest[0], body.decision, String(body.by ?? "operator")));
            return json(res, 200, view(latest(rest[0])));
          }

          // Operator-Eingriff: den aktuellen Schritt als beendet behandeln (z.B. Ende während eines Neustarts verpasst).
          if (req.method === "POST" && rest.length === 2 && rest[1] === "advance") {
            const body = await readJson(req);
            const flow = latest(rest[0]);
            if (flow.status !== "running" || !flow.currentStep) return json(res, 409, { error: `flow is ${flow.status}, not running` });
            log.warn?.(`[pipeline] ${flow.flowId.slice(0, 8)}: manual advance from ${flow.currentStep} by ${body.by ?? "operator"}`);
            await detached(() => onStepEnded(flow.flowId, flow.currentStep, { outcome: body.outcome ?? "ok" }));
            return json(res, 200, view(latest(rest[0])));
          }

          return json(res, 404, { error: "unknown route" });
        } catch (error) {
          log.error?.(`[pipeline] http: ${error?.message ?? error}`);
          return json(res, 500, { error: String(error?.message ?? error) });
        }
      },
    });

    log.info?.(`[pipeline] registered ${ROUTE} (owner ${ownerSessionKey}, repos ${reposRoot})`);
  },
});
