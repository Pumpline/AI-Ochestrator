// Agent-Ops Pipeline — ein OpenClaw-Plugin.
//
// Die Reihenfolge plan → code → test → review → Gate → ship steht hier im Code (§5, Variante B).
// Jeder Schritt ist ein Subagent-Lauf mit eigener Soul und minimalem Kontext; die Übergabe zwischen
// den Schritten läuft über Dateien in .agentops/ im Repo, nicht über ein Modell in der Mitte.
// Der Flow ist ein managed TaskFlow — OpenClaw schreibt ihn nach flow_runs, der Connector liest ihn.
// Das Gate vor ship ist ein waiting-Zustand mit waitJson.kind = "gate"; freigegeben wird per HTTP.
// Dazu: Modell je Agent lesen und setzen — über OpenClaws eigene CLI (validierter Schreibvorgang, Hot-Reload).

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AsyncResource } from "node:async_hooks";

const execFileAsync = promisify(execFile);
const CONTROLLER_ID = "agentops-pipeline";
const STEPS = ["plan", "code", "test", "review", "ship"];
const GATE_BEFORE = "ship";
const ROUTE = "/plugins/agentops-pipeline";
const MAX_REVIEW_ROUNDS = 2;   // review → code → test → review, höchstens so oft; danach entscheidet der Mensch am Gate
const MODEL_ID = /^[a-z0-9][a-z0-9_-]{0,40}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;   // provider/model

// Die Schritte sprechen über Dateien im Repo (§16). Ihr Urteil steht in der letzten nicht-leeren Zeile:
// test.md → TESTS PASS | TESTS FAIL, review.md → APPROVE | REQUEST_CHANGES.
function lastLine(cwd, file) {
  try {
    const text = readFileSync(path.join(cwd, ".agentops", file), "utf8");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1].toUpperCase() : "";
  } catch {
    return "";
  }
}

// Die Souls sind eigene OpenClaw-Agenten (agents.entries.pipeline-<step>) mit SOUL.md im Workspace —
// infra/openclaw/souls/<step>.md ist die Quelle. Ein Projekt kann sie überschreiben:
// <repo>/.agentops/souls/<step>.md wird als extraSystemPrompt oben draufgelegt.
function projectSoul(cwd, step) {
  const file = path.join(cwd, ".agentops", "souls", `${step}.md`);
  try {
    return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
  } catch {
    return undefined;
  }
}

// Agenten je Projekt: <repo>/.agentops/agents.json — { "<step>": { "model": "provider/model" } }.
// Fehlt ein Eintrag, gilt der globale Schritt-Agent (agents.entries.<prefix><step>) mit seinem Modell.
function projectAgents(cwd) {
  const file = path.join(cwd, ".agentops", "agents.json");
  try {
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

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

function buildMessage(state, step, attempt = 1) {
  const i = STEPS.indexOf(step);
  const round = (state.reviewRounds ?? 0) + 1;
  return [
    `Goal: ${state.goal}`,
    `Repository (working directory): ${state.cwd}`,
    `Pipeline step: ${step} (${i + 1}/${STEPS.length}). Notes of earlier steps are in .agentops/.`,
    step === "review" ? `Review round: ${round}.` : attempt > 1 ? `Attempt ${attempt} of this step — earlier notes and review findings are in .agentops/.` : null,
    `Work only inside the repository. When you are done, stop.`,
  ].filter(Boolean).join("\n");
}

// Modell eines Agenten aus der Konfiguration: Eintrag, sonst Default, sonst OpenClaws Laufzeit-Standard.
function modelOf(entry, defaults) {
  const pick = (m) => (typeof m === "string" ? m : m?.primary ?? null);
  return pick(entry?.model) ?? pick(defaults?.model) ?? null;
}

export default definePluginEntry({
  id: CONTROLLER_ID,
  name: "Agent-Ops Pipeline",
  description: "Deterministische Pipeline plan → code → test → review → Gate → ship als managed TaskFlow.",
  register(api) {
    const cfg = api.pluginConfig ?? {};
    const ownerSessionKey = cfg.ownerSessionKey ?? "agent:main:main";
    const reposRoot = cfg.reposRoot ?? "/home/node/repos";
    const agentPrefix = cfg.agentPrefix ?? "pipeline-";   // agents.entries.<prefix><step>
    const cliPath = cfg.cliPath ?? "/app/openclaw.mjs";    // OpenClaws CLI im Container — für config get/set und models list
    const log = api.logger ?? console;
    const flows = api.runtime.tasks.managedFlows.bindSession({ sessionKey: ownerSessionKey });

    // Ein Modell je Lauf erlaubt OpenClaw einem Plugin nur außerhalb eines Gateway-Requests (dann gilt
    // plugins.entries.<id>.subagent.allowModelOverride). Aus einem HTTP-Handler heraus zählt stattdessen der
    // Client des Requests, und der hat keinen Admin-Scope. Deshalb starten Schritte, die ein HTTP-Aufruf auslöst
    // (start, gate, advance), im Async-Kontext der Registrierung — außerhalb jedes Requests.
    const outsideRequest = new AsyncResource("agentops-pipeline");
    const detached = (fn) => outsideRequest.runInAsyncScope(fn);

    // Kein Zustand im Plugin: OpenClaw lädt Plugin-Instanzen mehrfach und neu. Welcher Lauf zu welchem
    // Flow gehört, steht im Flow selbst (stateJson.runs[currentStep]) und im Session-Schlüssel des Laufs.
    // Jeder Versuch eines Schritts bekommt eine frische Session — der zweite code-Lauf soll nicht den
    // ganzen Kontext des ersten mitschleppen, er liest die Übergabedateien.
    const runSessionKey = (flowId, step, attempt = 1) => `agent:${agentPrefix}${step}:subagent:pipeline-${flowId.slice(0, 8)}${attempt > 1 ? `-${attempt}` : ""}`;

    function resolveRun(event) {
      for (const f of mine()) {
        if (f.status !== "running" || !f.currentStep) continue;
        const step = f.currentStep;
        const expectedRun = f.stateJson?.runs?.[step];
        const attempt = f.stateJson?.attempts?.[step] ?? 1;
        if ((event.runId && expectedRun === event.runId) || (event.targetSessionKey && event.targetSessionKey === runSessionKey(f.flowId, step, attempt))) {
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

    // OpenClaws CLI im selben Container: config get/set schreiben validiert und lösen den Hot-Reload aus.
    async function cli(...args) {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { env: process.env, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    }
    const agentIds = () => ["main", ...STEPS.map((s) => `${agentPrefix}${s}`)];

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
          role: id === "main" ? "master" : "step",
          step: id === "main" ? null : id.slice(agentPrefix.length),
          model,
          explicit: entry.model != null,
          runtime: entry.agentRuntime?.id ?? (model ? agents.defaults?.models?.[model]?.agentRuntime?.id : null) ?? null,
          workspace: entry.workspace ?? null,
        };
      });
    }

    // OpenAI-Modelle würden standardmäßig den Codex-Harness nehmen, dessen Binary im Image fehlt — deshalb
    // die eingebettete Laufzeit festnageln. Das geht nur je Modell (agents.defaults.models), nicht je Agent,
    // und gilt auch für Modelle, die ein Projekt in .agentops/agents.json wählt.
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

    async function startStep(flowId, step, patch = {}) {
      const flow = latest(flowId);
      const state = { ...(flow.stateJson ?? {}), ...patch };
      const attempt = (state.attempts?.[step] ?? 0) + 1;

      const override = projectSoul(state.cwd, step);
      // Modell je Projekt: braucht plugins.entries.agentops-pipeline.subagent.allowModelOverride = true (README)
      const wanted = projectAgents(state.cwd)[step]?.model;
      const model = typeof wanted === "string" && MODEL_ID.test(wanted) ? wanted : null;
      if (model) await ensureRuntimePin(model);
      const sessionKey = runSessionKey(flowId, step, attempt);
      const run = await api.runtime.subagent.run({
        sessionKey,
        message: buildMessage(state, step, attempt),
        ...(override ? { extraSystemPrompt: override } : {}),
        ...(model ? { provider: model.slice(0, model.indexOf("/")), model: model.slice(model.indexOf("/") + 1) } : {}),
        promptMode: "minimal",
        lightContext: true,
        deliver: false,
        cwd: state.cwd,
        lane: `pipeline:${flowId}`,
        idempotencyKey: `${flowId}:${step}:${attempt}`,
      });

      // Kein flows.runTask(): OpenClaw verknüpft Kind-Tasks nur, wenn der Lauf demselben Owner gehört wie der
      // Flow. Die Schritte laufen aber als eigene Agenten (agent:pipeline-<step>), der Flow gehört main —
      // "Task backing ownership could not be verified". Die Verknüpfung Lauf ↔ Flow steht deshalb im Flow
      // selbst (stateJson.runs[step] = runId); der Connector liest sie von dort.
      const revision = latest(flowId).revision;
      const nextState = {
        ...state,
        runs: { ...(state.runs ?? {}), [step]: run.runId },
        attempts: { ...(state.attempts ?? {}), [step]: attempt },
        steps: [...(state.steps ?? []), { step, attempt, runId: run.runId, sessionKey, agent: `${agentPrefix}${step}`, soulOverride: Boolean(override), model, startedAt: Date.now() }],
      };
      const result = flows.resume({ flowId, expectedRevision: revision, status: "running", currentStep: step, stateJson: nextState });
      if (result && result.applied === false) log.warn?.(`[pipeline] ${flowId.slice(0, 8)}: step ${step} not recorded (${result.reason ?? "unknown"})`);
      log.info?.(`[pipeline] ${flowId.slice(0, 8)} → ${step} (run ${run.runId}${model ? `, model ${model}` : ""})`);
      return run;
    }

    async function onStepEnded(flowId, step, event) {
      const flow = latest(flowId);
      const state = flow.stateJson ?? {};
      if (event.outcome !== "ok") {
        flows.fail({
          flowId,
          expectedRevision: flow.revision,
          blockedSummary: `${step} failed (${event.outcome ?? "unknown"})`,
          stateJson: { ...state, steps: closeStep(state, step, event), failedStep: step, failedAt: Date.now() },
        });
        log.warn?.(`[pipeline] ${flowId.slice(0, 8)} failed at ${step}`);
        return;
      }
      // Urteile der Schritte lesen — deterministisch, aus den Übergabedateien, nicht aus dem Modell.
      let verdict = null;
      if (step === "test") {
        const line = lastLine(state.cwd, "test.md");
        verdict = line.includes("TESTS FAIL") ? "fail" : line.includes("TESTS PASS") ? "pass" : null;
        if (verdict === "fail") {
          flows.fail({
            flowId,
            expectedRevision: flow.revision,
            blockedSummary: "test: TESTS FAIL — siehe .agentops/test.md",
            stateJson: { ...state, steps: closeStep(state, step, event, verdict), failedStep: step, failedAt: Date.now(), lastTest: "fail" },
          });
          log.warn?.(`[pipeline] ${flowId.slice(0, 8)} halted: tests fail`);
          return;
        }
      }
      if (step === "review") {
        const line = lastLine(state.cwd, "review.md");
        verdict = line.includes("REQUEST_CHANGES") ? "request_changes" : line.includes("APPROVE") ? "approve" : null;
      }
      const steps = closeStep(state, step, event, verdict);

      if (step === "review") {
        const rounds = (state.reviewRounds ?? 0) + 1;
        if (verdict === "request_changes" && rounds <= MAX_REVIEW_ROUNDS) {
          // Zurück nach code: der Code-Agent liest review.md, dann test und review erneut.
          log.info?.(`[pipeline] ${flowId.slice(0, 8)} review requested changes (round ${rounds}/${MAX_REVIEW_ROUNDS}) → code`);
          await startStep(flowId, "code", { steps, reviewRounds: rounds, lastReview: "request_changes" });
          return;
        }
        flows.resume({ flowId, expectedRevision: flow.revision, status: "running", currentStep: step, stateJson: { ...state, steps, reviewRounds: rounds, lastReview: verdict === "request_changes" ? "request_changes_unresolved" : "approve" } });
      }

      const current = latest(flowId);
      const next = STEPS[STEPS.indexOf(step) + 1];
      if (!next) {
        flows.finish({ flowId, expectedRevision: current.revision, stateJson: { ...current.stateJson, steps, finishedAt: Date.now() } });
        log.info?.(`[pipeline] ${flowId.slice(0, 8)} finished`);
        return;
      }
      if (next === GATE_BEFORE) {
        flows.setWaiting({
          flowId,
          expectedRevision: current.revision,
          currentStep: "gate",
          waitJson: { kind: "gate", step: next, requestedAt: Date.now(), review: current.stateJson?.lastReview ?? null },
          stateJson: { ...current.stateJson, steps, gate: { status: "pending", step: next, requestedAt: Date.now() } },
        });
        log.info?.(`[pipeline] ${flowId.slice(0, 8)} waiting at gate before ${next}`);
        return;
      }
      await startStep(flowId, next, { steps });
    }

    async function decideGate(flowId, decision, by) {
      const flow = latest(flowId);
      if (flow.status !== "waiting" || flow.waitJson?.kind !== "gate") throw new Error("flow is not waiting at a gate");
      if (decision !== "allow" && decision !== "deny") throw new Error("decision must be allow or deny");
      const step = flow.waitJson.step;
      const gate = { ...(flow.stateJson?.gate ?? {}), status: decision === "allow" ? "allowed" : "denied", decision, by, decidedAt: Date.now() };
      const state = { ...(flow.stateJson ?? {}), gate };
      if (decision === "allow") {
        flows.resume({ flowId, expectedRevision: flow.revision, status: "running", currentStep: step, stateJson: state });
        await startStep(flowId, step);
      } else {
        flows.fail({ flowId, expectedRevision: flow.revision, blockedSummary: `gate denied by ${by}`, stateJson: state });
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

    api.registerHttpRoute({
      path: ROUTE,
      auth: "gateway",
      match: "prefix",
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://local");
          const rest = url.pathname.slice(ROUTE.length).split("/").filter(Boolean);

          if (req.method === "GET" && rest.length === 0) return json(res, 200, { flows: mine().map(view) });

          // Agenten und ihre Modelle — main (der Master) und die Schritt-Agenten
          if (req.method === "GET" && rest[0] === "agents" && rest.length === 1) {
            const [agents, models] = await Promise.all([listAgents(), listModels().catch((e) => { log.warn?.(`[pipeline] models list: ${e.message}`); return []; })]);
            // Ohne eigenen Eintrag gilt OpenClaws Laufzeit-Standard — der Katalog markiert ihn mit dem Tag "default".
            const fallback = models.find((m) => m.tags.includes("default"))?.key ?? null;
            for (const a of agents) if (a.model == null) a.model = fallback;
            return json(res, 200, { agents, models });
          }
          if (req.method === "PUT" && rest[0] === "agents" && rest.length === 2) {
            const body = await readJson(req);
            await setAgentModel(rest[1], String(body.model ?? "").trim());
            return json(res, 200, (await listAgents()).find((a) => a.id === rest[1]));
          }

          if (req.method === "POST" && rest[0] === "start" && rest.length === 1) {
            const body = await readJson(req);
            const repo = String(body.repo ?? "").trim();
            const goal = String(body.goal ?? "").trim();
            if (!repo || repo.includes("..") || repo.includes("/")) return json(res, 400, { error: "repo: name of a directory under reposRoot" });
            if (!goal) return json(res, 400, { error: "goal required" });
            const cwd = path.join(reposRoot, repo);
            if (!existsSync(cwd)) return json(res, 404, { error: `repo not found: ${cwd}` });
            const created = flows.createManaged({
              controllerId: CONTROLLER_ID,
              goal,
              status: "running",
              currentStep: "plan",
              notifyPolicy: "silent",
              stateJson: { repo, cwd, goal, runs: {}, attempts: {}, steps: [], startedAt: Date.now() },
            });
            const flow = created?.flow ?? created;
            if (!flow?.flowId) return json(res, 500, { error: "createManaged returned no flow", detail: created });
            try {
              await detached(() => startStep(flow.flowId, "plan"));
            } catch (error) {
              // Der Flow existiert schon — nicht als Leiche stehen lassen
              flows.fail({ flowId: flow.flowId, expectedRevision: latest(flow.flowId).revision, blockedSummary: `plan could not start: ${error?.message ?? error}`, stateJson: { ...(latest(flow.flowId).stateJson ?? {}), failedStep: "plan", failedAt: Date.now() } });
              throw error;
            }
            return json(res, 201, view(latest(flow.flowId)));
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
