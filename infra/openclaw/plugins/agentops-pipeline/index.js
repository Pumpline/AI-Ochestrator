// Agent-Ops Pipeline — ein OpenClaw-Plugin.
//
// Die Pipeline ist ein Graph je Projekt (§5, Variante B): Knoten sind Agenten und Gates, Kanten führen von einem
// Knoten zum nächsten — Standardkanten immer, Verzweigungen nur bei einem Urteil in der letzten Zeile der
// Übergabedatei (z.B. REQUEST_CHANGES → zurück zu code, höchstens max-mal). Der Graph steht in
// <repo>/.agentops/flow.json; fehlt die Datei, gilt der Standard-Flow plan → code → test → review → Gate → ship.
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
const MODEL_ID = /^[a-z0-9][a-z0-9_-]{0,40}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;   // provider/model
// OpenClaws Thinking-Level ("Effort") — je Agent als thinkingDefault
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"];
const TOOL_ID = /^[a-z0-9_:-]{1,60}$/;
const NODE_ID = /^[a-z][a-z0-9_-]{0,30}$/;
const END_NODES = ["done", "halt"];   // Pseudo-Ziele: Flow beenden / Flow scheitern lassen

// Agenten sind projekt-scoped: jedes Projekt bekommt seine eigenen Agenten (agents.entries.<prefix><projekt>-<knoten>),
// angelegt vom Plugin beim ersten Lauf, danach mit Modell, Effort und Tools aus flow.json synchron gehalten.
// Die globalen Schritt-Agenten (<prefix><step>) sind die Vorlagen: ihre Werte gelten, wo das Projekt nichts sagt.
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "projekt";
const projectAgentId = (prefix, repo, node) => `${prefix}${slug(repo)}-${node}`;

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
// "nach dem Gate" (after: "gate") in ihrer Reihenfolge.
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

// Prüfung: Knoten bekannt, Start vorhanden, der Hauptweg (Standardkanten ab Start) erreicht ein Gate vor dem Ende
function validateFlow(flow) {
  if (flow.mode === "master") {
    if (!poolAgents(flow).length) return "Der Master braucht mindestens einen Agenten, den er aufrufen kann.";
    if (!flow.gates.length) return "Kein Gate — vor dem Ende muss ein Mensch freigeben.";
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
  if (!gated) return "Kein Gate auf dem Hauptweg — vor dem Ende muss ein Mensch freigeben.";
  return null;
}

// Der Hauptweg: Knoten in Reihenfolge der Standardkanten ab Start, danach die nur über Verzweigungen erreichbaren.
// Im Master-Modus: Master, dann der Pool in Definitionsreihenfolge (gelaufene zuerst, wenn ein Zustand bekannt ist),
// dann die Gates, dann die Agenten nach dem Gate.
function flowPath(flow, state = null) {
  if (flow.mode === "master") {
    const tail = tailAgents(flow);
    const ran = []; for (const s of state?.steps ?? []) if (s.step !== MASTER && flow.agents[s.step] && !tail.includes(s.step) && !ran.includes(s.step)) ran.push(s.step);
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

// Die Flow-Definition eines Projekts von der Platte: flow.json, sonst der Standard-Flow
function loadFlow(cwd) {
  let def = null; let source = "default";
  const file = path.join(cwd, ".agentops", "flow.json");
  try {
    if (existsSync(file)) { def = JSON.parse(readFileSync(file, "utf8")); source = "flow.json"; }
  } catch (error) {
    return { flow: normalizeFlow(defaultFlow()), source: "default", error: `flow.json ist kein gültiges JSON: ${error?.message ?? error}` };
  }
  const flow = normalizeFlow(def && typeof def === "object" && !Array.isArray(def) ? def : defaultFlow());
  for (const [id, cfg] of Object.entries(legacyAgents(cwd))) if (flow.agents[id] && cfg && typeof cfg === "object") flow.agents[id] = { ...normalizeFlow({ agents: { [id]: cfg } }).agents[id], ...flow.agents[id] };
  return { flow, source, error: validateFlow(flow) };
}

// Nach einem Schritt: welche Kante? Erst eine Verzweigung, deren Urteil in der letzten Zeile steht und deren
// Obergrenze noch nicht erreicht ist, sonst die Standardkante, sonst das Ende.
function nextEdge(flow, state, node, line) {
  const counts = state.edgeCounts ?? {};
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

function buildMessage(state, node, attempt = 1) {
  const pathNodes = state.path ?? Object.keys(state.flow?.agents ?? {});
  const i = pathNodes.indexOf(node);
  return [
    `Goal: ${state.goal}`,
    `Repository (working directory): ${state.cwd}`,
    `Pipeline step: ${node}${i >= 0 ? ` (${i + 1}/${pathNodes.length})` : ""}. Pipeline: ${pathNodes.join(" → ")}. Notes of earlier steps are in .agentops/.`,
    `Write your notes to .agentops/${node}.md; if this step gives a verdict, put it in the last line.`,
    attempt > 1 ? `Attempt ${attempt} of this step — earlier notes and findings are in .agentops/.` : null,
    `Work only inside the repository. When you are done, stop.`,
  ].filter(Boolean).join("\n");
}

// Was ein Agent tut — für die Liste, aus der der Master wählt: description aus flow.json, sonst die erste Textzeile seiner Soul
function describeAgent(cwd, templateWorkspace, id, cfg) {
  if (cfg?.description) return cfg.description;
  for (const file of [path.join(cwd, ".agentops", "souls", `${id}.md`), templateWorkspace ? path.join(templateWorkspace, "SOUL.md") : null]) {
    try {
      if (!file || !existsSync(file)) continue;
      const line = readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#") && !l.startsWith("_"));
      if (line) return line.slice(0, 200);
    } catch {}
  }
  return `the ${id} agent`;
}

// Die Frage an den Master: Ziel, die Agenten mit Beschreibung und Verlauf, die Regeln — Antwort ist die letzte Zeile von .agentops/master.md
function buildMasterMessage(state, flow, descriptions) {
  const steps = (state.steps ?? []).filter((s) => s.step !== MASTER && s.endedAt != null);
  const used = (state.master?.decisions ?? []).length;
  const pool = poolAgents(flow); const required = requiredAgents(flow); const tail = tailAgents(flow);
  const lines = pool.map((id) => {
    const runs = steps.filter((s) => s.step === id);
    const last = runs.at(-1);
    return `- ${id}: ${descriptions[id] ?? id}${required.includes(id) ? " [required before the gate]" : ""}${runs.length ? ` — ran ${runs.length}×${last?.verdict ? `, last verdict: ${last.verdict}` : ""} (notes in .agentops/${id}.md)` : " — not run yet"}`;
  });
  return [
    `Goal: ${state.goal}`,
    `Repository (working directory): ${state.cwd}`,
    `You are the master of this pipeline: you decide which agent works next. Agents you can call:`,
    ...lines,
    `Sequence so far: ${steps.length ? steps.map((s) => s.step).join(" → ") : "nothing has run yet"}.`,
    `Rules: call an agent when its work is needed for the goal; agents may run more than once. Required agents you do not call will run automatically before the human gate. ${tail.length ? `After the gate the pipeline runs ${tail.join(", ")} on its own. ` : ""}You have ${flow.master.maxSteps - used} decision${flow.master.maxSteps - used === 1 ? "" : "s"} left; when the goal is done and verified, say done.`,
    `Read the notes in .agentops/ before deciding. Write 2–5 lines of reasoning to .agentops/master.md and end that file with exactly one line: NEXT: <agent> or NEXT: done`,
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
  description: "Deterministische Pipeline als Graph je Projekt (Agenten, Kanten, Gates) als managed TaskFlow.",
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
        const open = [...(f.stateJson?.steps ?? [])].reverse().find((s) => s.step === step && s.endedAt == null);
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
    const flowOf = (state) => state.flow ?? normalizeFlow(defaultFlow());   // ältere Flows kennen nur den Standard

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

    // Die Agenten eines Projekts anlegen und mit Vorlage + flow.json abgleichen. Liefert knoten → agentId.
    // Wird vor jedem Schritt aufgerufen; ohne Änderung ist es ein config get (~1 s), sonst ein Patch mit Hot-Reload.
    async function ensureProjectAgents(repo, cwd, flow) {
      const agents = JSON.parse(await cli("config", "get", "agents"));
      const entries = agents.entries ?? {};
      const patch = {}; const creations = []; const ids = {}; const resolved = {};
      for (const [node, pa] of Object.entries(flow.agents)) {
        const id = projectAgentId(agentPrefix, repo, node); ids[node] = id;
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
        log.info?.(`[pipeline] agents of ${repo} updated: ${Object.entries(patch).map(([id, d]) => `${id} ${Object.keys(d).join("+")}`).join(", ")}`);
      }
      // Die Soul der Vorlage ist die Soul des Projekt-Agenten; ohne Vorlage eine knappe Standard-Soul (nur wenn keine da ist).
      // Die Projekt-Soul (.agentops/souls/<knoten>.md) kommt in beiden Fällen als extraSystemPrompt obendrauf.
      for (const [node, r] of Object.entries(resolved)) {
        try {
          mkdirSync(r.workspace, { recursive: true });
          const dst = path.join(r.workspace, "SOUL.md");
          const src = r.templateWorkspace ? path.join(r.templateWorkspace, "SOUL.md") : null;
          if (src && existsSync(src)) copyFileSync(src, dst);
          // agents add legt OpenClaws eigene Bootstrap-Soul ab ("Who You Are") — die ersetzt die knappe Pipeline-Soul, nichts anderes
          else if (!existsSync(dst) || !readFileSync(dst, "utf8").startsWith("# SOUL — ")) writeFileSync(dst, genericSoul(node));
        } catch (error) { log.warn?.(`[pipeline] soul sync ${node}: ${error?.message ?? error}`); }
      }
      return { ids, resolved };
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

    async function startStep(flowId, node, patch = {}) {
      const flow0 = latest(flowId);
      const state = { ...(flow0.stateJson ?? {}), ...patch };
      const flow = flowOf(state);
      if (!flow.agents[node]) throw new Error(`${node} is not an agent of this flow`);
      const attempt = (state.attempts?.[node] ?? 0) + 1;

      const override = projectSoul(state.cwd, node);
      // Der Agent dieses Projekts für diesen Knoten — mit Modell, Effort und Tools aus flow.json
      const { ids, resolved } = await ensureProjectAgents(state.repo, state.cwd, flow);
      const agentId = ids[node];
      const { model, thinking, tools } = resolved[node];
      const sessionKey = runSessionKey(agentId, flowId, attempt);
      const message = node === MASTER && flow.mode === "master"
        ? buildMasterMessage(state, flow, Object.fromEntries(poolAgents(flow).map((id) => [id, describeAgent(state.cwd, resolved[id]?.templateWorkspace, id, flow.agents[id])])))
        : buildMessage(state, node, attempt);
      const run = await api.runtime.subagent.run({
        sessionKey,
        message,
        ...(override ? { extraSystemPrompt: override } : {}),
        promptMode: "minimal",
        lightContext: true,
        deliver: false,
        cwd: state.cwd,
        lane: `pipeline:${flowId}`,
        idempotencyKey: `${flowId}:${node}:${attempt}`,
      });

      // Kein flows.runTask(): OpenClaw verknüpft Kind-Tasks nur, wenn der Lauf demselben Owner gehört wie der
      // Flow. Die Schritte laufen aber als eigene Agenten, der Flow gehört main — "Task backing ownership could
      // not be verified". Die Verknüpfung Lauf ↔ Flow steht deshalb im Flow selbst (stateJson.runs[knoten] = runId).
      const revision = latest(flowId).revision;
      const nextState = {
        ...state,
        runs: { ...(state.runs ?? {}), [node]: run.runId },
        attempts: { ...(state.attempts ?? {}), [node]: attempt },
        steps: [...(state.steps ?? []), { step: node, attempt, runId: run.runId, sessionKey, agent: agentId, soulOverride: Boolean(override), model, thinking, tools, startedAt: Date.now() }],
      };
      if (flow.mode === "master") nextState.path = flowPath(flow, nextState);   // der Streifen folgt dem, was der Master tut
      const result = flows.resume({ flowId, expectedRevision: revision, status: "running", currentStep: node, stateJson: nextState });
      if (result && result.applied === false) log.warn?.(`[pipeline] ${flowId.slice(0, 8)}: step ${node} not recorded (${result.reason ?? "unknown"})`);
      log.info?.(`[pipeline] ${flowId.slice(0, 8)} → ${node} (agent ${agentId}, run ${run.runId}${model ? `, model ${model}` : ""}${thinking ? `, thinking ${thinking}` : ""}${tools ? `, tools ${tools.join("/")}` : ""})`);
      return run;
    }

    // Einen Zielknoten betreten: Agent starten, am Gate warten, beenden oder scheitern
    async function enter(flowId, target, patch, note) {
      const flow0 = latest(flowId);
      const state = { ...(flow0.stateJson ?? {}), ...patch };
      const flow = flowOf(state);
      if (target === "done") {
        flows.finish({ flowId, expectedRevision: flow0.revision, stateJson: { ...state, finishedAt: Date.now() } });
        log.info?.(`[pipeline] ${flowId.slice(0, 8)} finished`);
        return;
      }
      if (target === "halt") {
        flows.fail({ flowId, expectedRevision: flow0.revision, blockedSummary: note ?? "halt", stateJson: { ...state, failedStep: state.steps?.at?.(-1)?.step ?? null, failedAt: Date.now() } });
        log.warn?.(`[pipeline] ${flowId.slice(0, 8)} halted: ${note ?? "halt"}`);
        return;
      }
      if (flow.gates.includes(target)) {
        const after = flow.mode === "master" ? tailAgents(flow)[0] ?? "done" : flow.edges.find((e) => e.from === target && !e.on)?.to ?? "done";
        flows.setWaiting({
          flowId,
          expectedRevision: flow0.revision,
          currentStep: target,
          waitJson: { kind: "gate", gate: target, step: after, requestedAt: Date.now(), review: state.lastUnresolved ? "request_changes_unresolved" : (state.lastVerdict ?? null), unresolved: state.lastUnresolved ?? null },
          stateJson: { ...state, gate: { status: "pending", gate: target, step: after, requestedAt: Date.now() } },
        });
        log.info?.(`[pipeline] ${flowId.slice(0, 8)} waiting at ${target} before ${after}`);
        return;
      }
      await startStep(flowId, target, patch);
    }

    // Master-Modus: nach jedem Schritt entscheidet der Master — außer die Pflicht-Agenten laufen gerade nach oder der
    // Flow ist schon hinter dem Gate; dann ist die Reihenfolge fest.
    async function masterNext(flowId, node, event, flow, state) {
      const tail = tailAgents(flow);
      if (tail.includes(node)) {   // hinter dem Gate: der nächste Agent nach dem Gate, sonst fertig
        const next = tail[tail.indexOf(node) + 1];
        const steps = closeStep(state, node, event, null);
        await enter(flowId, next ?? "done", { steps }, null);
        return;
      }
      if (node === MASTER) {
        const line = lastLine(state.cwd, "master.md");
        const m = /NEXT:\s*([A-Z0-9_-]+)/.exec(line);
        const choice = m ? m[1].toLowerCase() : "done";
        const decisions = [...(state.master?.decisions ?? []), { at: Date.now(), next: choice, line: line.slice(0, 120) }];
        const patch = { steps: closeStep(state, node, event, choice === "done" ? "done" : `next: ${choice}`), master: { ...(state.master ?? {}), decisions, phase: "master" } };
        const pool = poolAgents(flow);
        if (choice !== "done" && !pool.includes(choice)) log.warn?.(`[pipeline] ${flowId.slice(0, 8)} master chose unknown agent "${choice}" — treating as done`);
        if (choice !== "done" && pool.includes(choice) && decisions.length < flow.master.maxSteps) {
          log.info?.(`[pipeline] ${flowId.slice(0, 8)} master → ${choice} (${decisions.length}/${flow.master.maxSteps})`);
          await startStep(flowId, choice, patch);
          return;
        }
        if (choice !== "done" && pool.includes(choice)) log.warn?.(`[pipeline] ${flowId.slice(0, 8)} master step limit ${flow.master.maxSteps} reached — finishing`);
        await finishMasterPhase(flowId, flow, { ...state, ...patch }, patch);
        return;
      }
      // Ein Agent aus dem Pool ist fertig: Urteil merken, dann zurück zum Master — oder die Pflicht-Agenten weiter
      const line = lastLine(state.cwd, `${node}.md`);
      const verdict = /\bPASS\b/.test(line) ? "pass" : /\bAPPROVE\b/.test(line) ? "approve" : /\b(FAIL|REQUEST_CHANGES|BLOCK)\b/.test(line) ? line.toLowerCase().replace(/\s+/g, "_").slice(0, 40) : null;
      const patch = { steps: closeStep(state, node, event, verdict), lastVerdict: verdict };
      if (state.master?.phase === "required") { await finishMasterPhase(flowId, flow, { ...state, ...patch }, patch); return; }
      await startStep(flowId, MASTER, patch);
    }

    // Nach dem letzten Wort des Masters: Pflicht-Agenten nachholen, die noch nicht gelaufen sind, dann das Gate
    async function finishMasterPhase(flowId, flow, state, patch) {
      const ran = new Set((state.steps ?? []).filter((s) => s.endedAt != null).map((s) => s.step));
      const pending = requiredAgents(flow).filter((id) => !ran.has(id));
      if (pending.length) {
        log.info?.(`[pipeline] ${flowId.slice(0, 8)} required agents pending: ${pending.join(", ")}`);
        await startStep(flowId, pending[0], { ...patch, master: { ...(state.master ?? {}), phase: "required" } });
        return;
      }
      await enter(flowId, flow.gates[0], { ...patch, master: { ...(state.master ?? {}), phase: "gate" } }, null);
    }

    async function onStepEnded(flowId, node, event) {
      const flow0 = latest(flowId);
      const state = flow0.stateJson ?? {};
      const flow = flowOf(state);
      if (event.outcome !== "ok") {
        flows.fail({
          flowId,
          expectedRevision: flow0.revision,
          blockedSummary: `${node} failed (${event.outcome ?? "unknown"})`,
          stateJson: { ...state, steps: closeStep(state, node, event), failedStep: node, failedAt: Date.now() },
        });
        log.warn?.(`[pipeline] ${flowId.slice(0, 8)} failed at ${node}`);
        return;
      }
      if (flow.mode === "master") { await masterNext(flowId, node, event, flow, state); return; }
      // Das Urteil des Schritts — deterministisch, aus der letzten Zeile der Übergabedatei, nicht aus dem Modell
      const line = lastLine(state.cwd, `${node}.md`);
      const { edge, exhausted } = nextEdge(flow, state, node, line);
      const verdict = edge.on ? edge.on.toLowerCase().replace(/\s+/g, "_") : exhausted ? exhausted.on.toLowerCase().replace(/\s+/g, "_") : /\bPASS\b/.test(line) ? "pass" : /\bAPPROVE\b/.test(line) ? "approve" : null;
      const key = `${edge.from}>${edge.to}`;
      const patch = {
        steps: closeStep(state, node, event, verdict),
        edgeCounts: { ...(state.edgeCounts ?? {}), [key]: (state.edgeCounts?.[key] ?? 0) + 1 },
        loops: (state.loops ?? 0) + (edge.on && flow.agents[edge.to] ? 1 : 0),
        lastVerdict: verdict,
        lastUnresolved: exhausted ? `${node}: ${exhausted.on} (${exhausted.max}× erreicht)` : null,
      };
      if (edge.on) log.info?.(`[pipeline] ${flowId.slice(0, 8)} ${node}: ${edge.on} → ${edge.to}${edge.max ? ` (${patch.edgeCounts[key]}/${edge.max})` : ""}`);
      else if (exhausted) log.info?.(`[pipeline] ${flowId.slice(0, 8)} ${node}: ${exhausted.on} again, limit ${exhausted.max} reached → ${edge.to}`);
      await enter(flowId, edge.to, patch, edge.to === "halt" ? `${node}: ${line.slice(0, 80)} — siehe .agentops/${node}.md` : null);
    }

    async function decideGate(flowId, decision, by) {
      const flow0 = latest(flowId);
      if (flow0.status !== "waiting" || flow0.waitJson?.kind !== "gate") throw new Error("flow is not waiting at a gate");
      if (decision !== "allow" && decision !== "deny") throw new Error("decision must be allow or deny");
      const after = flow0.waitJson.step ?? "done";
      const gate = { ...(flow0.stateJson?.gate ?? {}), status: decision === "allow" ? "allowed" : "denied", decision, by, decidedAt: Date.now() };
      const state = { ...(flow0.stateJson ?? {}), gate, lastUnresolved: null };
      if (decision === "allow") {
        flows.resume({ flowId, expectedRevision: flow0.revision, status: "running", currentStep: after === "done" ? flow0.currentStep : after, stateJson: state });
        await enter(flowId, after, {}, null);
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

          // Der Flow eines Projekts, wie das Plugin ihn liest: flow.json (mit agents.json-Altbestand) oder Standard, geprüft
          if (req.method === "GET" && rest[0] === "projects" && rest.length === 3 && rest[2] === "flow") {
            const cwd = repoDir(rest[1]);
            if (!cwd) return json(res, 404, { error: `repo not found: ${rest[1]}` });
            const { flow, source, error } = loadFlow(cwd);
            return json(res, 200, { flow, path: flowPath(flow), source, error, templates: TEMPLATE_STEPS });
          }
          // Eine Definition prüfen, ohne sie zu speichern — das Cockpit fragt vor dem Commit
          if (req.method === "POST" && rest[0] === "flow" && rest.length === 2 && rest[1] === "validate") {
            const body = await readJson(req);
            const flow = normalizeFlow(body);
            return json(res, 200, { flow, path: flowPath(flow), error: validateFlow(flow) });
          }
          // Die Agenten eines Projekts anlegen/abgleichen, ohne einen Lauf — z.B. nach einer Änderung im Cockpit
          if (req.method === "POST" && rest[0] === "projects" && rest.length === 3 && rest[2] === "sync") {
            const cwd = repoDir(rest[1]);
            if (!cwd) return json(res, 404, { error: `repo not found: ${rest[1]}` });
            const { flow, error } = loadFlow(cwd);
            if (error) return json(res, 400, { error });
            const { ids, resolved } = await ensureProjectAgents(rest[1], cwd, flow);
            return json(res, 200, { agents: Object.keys(flow.agents).map((n) => ({ step: n, id: ids[n], model: resolved[n].model, thinking: resolved[n].thinking, tools: resolved[n].tools })) });
          }

          if (req.method === "POST" && rest[0] === "start" && rest.length === 1) {
            const body = await readJson(req);
            const repo = String(body.repo ?? "").trim();
            const goal = String(body.goal ?? "").trim();
            const cwd = repoDir(repo);
            if (!cwd) return json(res, 404, { error: `repo not found: ${repo}` });
            if (!goal) return json(res, 400, { error: "goal required" });
            const { flow, error } = loadFlow(cwd);
            if (error) return json(res, 400, { error: `flow.json: ${error}` });
            const created = flows.createManaged({
              controllerId: CONTROLLER_ID,
              goal,
              status: "running",
              currentStep: flow.start,
              notifyPolicy: "silent",
              stateJson: { repo, cwd, goal, runs: {}, attempts: {}, steps: [], edgeCounts: {}, loops: 0, flow, path: flowPath(flow), startedAt: Date.now() },
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
