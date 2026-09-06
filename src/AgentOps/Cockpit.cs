using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using AgentOps.OpenClaw;
using Microsoft.Data.Sqlite;

namespace AgentOps;

/// <summary>
/// Die Schreibseite des Cockpits — bewusst drei Verben, sonst nichts (§12):
///   Gate entscheiden und Pipeline starten (Relais zum Pipeline-Plugin am Gateway),
///   Soul pro Projekt speichern (Datei im Repo + Commit — der Weg ist ein Commit).
/// Dazu lesend: Projekte, Souls, Kosten aus Prometheus.
/// </summary>
public static class Cockpit
{
    public static readonly string[] Steps = ["plan", "code", "test", "review", "ship"];
    private static readonly Regex SafeName = new("^[A-Za-z0-9._-]{1,80}$", RegexOptions.Compiled);

    public static void Map(RouteGroupBuilder api, IConfiguration config)
    {
        var reposRoot = config["Repos:Root"] ?? "/repos";
        var defaultsDir = config["Souls:DefaultsDir"] ?? "/souls-default";

        api.MapGet("/projects", () =>
        {
            if (!Directory.Exists(reposRoot)) return Results.Ok(Array.Empty<object>());
            var projects = Directory.GetDirectories(reposRoot)
                .Where(d => Directory.Exists(Path.Combine(d, ".git")))
                .Select(d => new
                {
                    Name = Path.GetFileName(d),
                    Souls = FlowNodes(d).ToDictionary(s => s, s => File.Exists(SoulPath(d, s))),
                    Flow = File.Exists(FlowPath(d)),
                })
                .OrderBy(p => p.Name);
            return Results.Ok(projects);
        });

        // Souls je Knoten des Projekt-Flows: Standard = Vorlage (plan, code, …) oder die knappe Standard-Soul für eigene Knoten
        api.MapGet("/projects/{name}/souls", (string name) =>
        {
            if (!TryRepo(reposRoot, name, out var repo)) return Results.NotFound();
            var souls = FlowNodes(repo).ToDictionary(s => s, s => new
            {
                Override = File.Exists(SoulPath(repo, s)) ? File.ReadAllText(SoulPath(repo, s)) : null,
                Default = File.Exists(Path.Combine(defaultsDir, $"{s}.md")) ? File.ReadAllText(Path.Combine(defaultsDir, $"{s}.md")) : GenericSoul(s),
                Template = File.Exists(Path.Combine(defaultsDir, $"{s}.md")),
            });
            return Results.Ok(souls);
        });

        // Knoten eines Sub-Flows heißen coding/pr — die Soul liegt dann unter .agentops/souls/coding/pr.md
        api.MapPut("/projects/{name}/souls/{**step}", async (string name, string step, SoulBody body, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo) || !SafeStep.IsMatch(step) || !FlowNodes(repo).Contains(step)) return Results.NotFound();
            var text = (body.Text ?? "").Replace("\r\n", "\n").TrimEnd() + "\n";
            var path = SoulPath(repo, step);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllTextAsync(path, text, ct);
            var commit = await GitCommitAsync(repo, $".agentops/souls/{step}.md", $"Soul {step}: im Cockpit bearbeitet", ct);
            return Results.Ok(new { step, commit });
        });

        api.MapDelete("/projects/{name}/souls/{**step}", async (string name, string step, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo) || !SafeStep.IsMatch(step) || !FlowNodes(repo).Contains(step)) return Results.NotFound();
            var path = SoulPath(repo, step);
            if (!File.Exists(path)) return Results.NoContent();
            File.Delete(path);
            var commit = await GitCommitAsync(repo, $".agentops/souls/{step}.md", $"Soul {step}: Projekt-Override entfernt", ct);
            return Results.Ok(new { step, commit });
        });

        // Der Flow eines Projekts: <repo>/.agentops/flow.json — Agenten (Modell, Effort, Tools), Kanten, Gates, Start.
        // Gelesen und geprüft vom Plugin (dieselbe Logik, die die Läufe steuert); geschrieben und committet vom Cockpit.
        // Fehlt die Datei, zeigt das Plugin den Standard-Flow; der erste Schreibvorgang legt sie an und faltet ein
        // altes .agentops/agents.json hinein.
        api.MapGet("/projects/{name}/flow", async (PluginClient plugin, string name, CancellationToken ct) =>
            !TryRepo(reposRoot, name, out _) ? Results.NotFound() : await plugin.RelayAsync(HttpMethod.Get, $"/projects/{Uri.EscapeDataString(name)}/flow", null, ct));

        api.MapPut("/projects/{name}/flow", async (PluginClient plugin, string name, JsonObject body, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo)) return Results.NotFound();
            var (flow, path, error) = await ValidateFlowAsync(plugin, body, ct);
            if (flow is null) return Results.Problem("Plugin nicht erreichbar — der Flow wurde nicht geprüft und nicht gespeichert.", statusCode: StatusCodes.Status502BadGateway);
            if (error is not null) return Results.BadRequest(new { error });
            var commit = await WriteProjectFlowAsync(repo, flow, "Flow: im Cockpit bearbeitet", ct);
            _ = await plugin.RelayAsync(HttpMethod.Post, $"/projects/{Uri.EscapeDataString(name)}/sync", new { }, ct);
            return Results.Ok(new { commit, flow, path });
        });

        // Sub-Flows: <repo>/.agentops/flows/<name>.json — vollständige Flows, die ein Agent des Haupt- oder eines anderen
        // Sub-Flows mit "flow": "<name>" als einen Schritt ausführt. Gelesen roh (das Cockpit bearbeitet die Datei), geprüft vom Plugin.
        api.MapGet("/projects/{name}/flows", (string name) =>
        {
            if (!TryRepo(reposRoot, name, out var repo)) return Results.NotFound();
            var dir = Path.Combine(repo, ".agentops", "flows");
            var used = WalkFlows(repo).SelectMany(w => (w.Flow["agents"] as JsonObject ?? new JsonObject())
                .Where(p => p.Value is JsonObject a && a["flow"] is JsonValue)
                .Select(p => new { Sub = ((JsonValue)((JsonObject)p.Value!)["flow"]!).GetValue<string>(), By = w.Prefix + p.Key }))
                .GroupBy(x => x.Sub).ToDictionary(g => g.Key, g => g.Select(x => x.By).ToArray());
            var files = Directory.Exists(dir) ? Directory.GetFiles(dir, "*.json").OrderBy(f => f).ToArray() : [];
            var subs = files.Select(f => Path.GetFileNameWithoutExtension(f)).Where(n => SafeName.IsMatch(n)).Select(n => new
            {
                name = n,
                flow = ReadFlowFile(SubflowPath(repo, n)),
                usedBy = used.GetValueOrDefault(n, []),
            });
            return Results.Ok(subs);
        });

        api.MapPut("/projects/{name}/flows/{sub}", async (PluginClient plugin, string name, string sub, JsonObject body, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo) || !SafeStep.IsMatch(sub) || sub.Contains('/')) return Results.NotFound();
            body["repo"] = name; body["sub"] = true; body["name"] = sub;
            var (flow, path, error) = await ValidateFlowAsync(plugin, body, ct);
            if (flow is null) return Results.Problem("Plugin nicht erreichbar — der Sub-Flow wurde nicht geprüft und nicht gespeichert.", statusCode: StatusCodes.Status502BadGateway);
            if (error is not null) return Results.BadRequest(new { error });
            var commit = await WriteFlowFileAsync(repo, $".agentops/flows/{sub}.json", flow, $"Sub-Flow {sub}: im Cockpit bearbeitet", ct);
            _ = await plugin.RelayAsync(HttpMethod.Post, $"/projects/{Uri.EscapeDataString(name)}/sync", new { }, ct);
            return Results.Ok(new { name = sub, commit, flow, path });
        });

        api.MapDelete("/projects/{name}/flows/{sub}", async (string name, string sub, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo) || !SafeStep.IsMatch(sub) || sub.Contains('/')) return Results.NotFound();
            var users = WalkFlows(repo).SelectMany(w => (w.Flow["agents"] as JsonObject ?? new JsonObject()).Where(p => p.Value is JsonObject a && a["flow"] is JsonValue v && v.TryGetValue<string>(out var s) && s == sub).Select(p => w.Prefix + p.Key)).ToArray();
            if (users.Length > 0) return Results.BadRequest(new { error = $"Sub-Flow {sub} wird noch benutzt von {string.Join(", ", users)}." });
            var file = SubflowPath(repo, sub);
            if (!File.Exists(file)) return Results.NoContent();
            File.Delete(file);
            var commit = await GitCommitAsync(repo, $".agentops/flows/{sub}.json", $"Sub-Flow {sub}: entfernt", ct);
            return Results.Ok(new { name = sub, commit });
        });

        // Agenten des Projekts: alle Knoten aus Haupt- und Sub-Flows — Modell, Effort, Tools je Knoten (Sub-Flow-Knoten nur mit ihrem Verweis)
        api.MapGet("/projects/{name}/agents", async (PluginClient plugin, string name, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo)) return Results.NotFound();
            var main = await LoadFlowAsync(plugin, name, ct);
            if (main is null) return Results.Problem("Plugin nicht erreichbar.", statusCode: StatusCodes.Status502BadGateway);
            var result = new Dictionary<string, object>();
            foreach (var (prefix, flow, _) in WalkFlows(repo, main))
                foreach (var p in flow["agents"] as JsonObject ?? new JsonObject())
                    result[prefix + p.Key] = AgentView(p.Value as JsonObject);
            return Results.Ok(result);
        });

        // PUT setzt model, thinking und/oder tools eines Knotens (auch coding/pr); ein leerer Wert nimmt die Einstellung zurück (dann gilt die Vorlage).
        // Das Plugin gleicht die Projekt-Agenten danach ab (sync), damit die Änderung nicht erst beim nächsten Lauf sichtbar wird.
        api.MapPut("/projects/{name}/agents/{**step}", async (PluginClient plugin, string name, string step, ModelBody body, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo) || !SafeStep.IsMatch(step)) return Results.NotFound();
            if (body.Model is null && body.Thinking is null && body.Tools is null) return Results.BadRequest(new { error = "model, thinking oder tools fehlt" });
            var model = body.Model?.Trim(); var thinking = body.Thinking?.Trim();
            var tools = body.Tools?.Select(t => t.Trim()).Where(t => t != "").Distinct().ToArray();
            if (!string.IsNullOrEmpty(model) && !ModelId.IsMatch(model)) return Results.BadRequest(new { error = "model: anbieter/modell" });
            if (!string.IsNullOrEmpty(thinking) && !ThinkingLevels.Contains(thinking)) return Results.BadRequest(new { error = $"thinking: {string.Join(" | ", ThinkingLevels)}" });
            if (tools is not null && tools.Any(t => !ToolId.IsMatch(t))) return Results.BadRequest(new { error = "tools: Kennungen wie read, write, exec" });
            var main = await LoadFlowAsync(plugin, name, ct);
            if (main is null) return Results.Problem("Plugin nicht erreichbar.", statusCode: StatusCodes.Status502BadGateway);
            var (flow, relPath, local, resolveError) = ResolveAgentFlow(repo, step, main);
            if (flow is null) return Results.NotFound(new { error = resolveError });
            if (flow["agents"] is not JsonObject agents || agents[local!] is not JsonObject entry) return Results.NotFound(new { error = $"{step} ist kein Agent dieses Flows" });
            var changes = new List<string>();
            if (model is not null) { if (model == "") { if (entry.Remove("model")) changes.Add("Modell → Vorlage"); } else { entry["model"] = model; changes.Add($"Modell {model}"); } }
            if (thinking is not null) { if (thinking == "") { if (entry.Remove("thinking")) changes.Add("Effort → Vorlage"); } else { entry["thinking"] = thinking; changes.Add($"Effort {thinking}"); } }
            if (tools is not null)
            {
                var before = entry["tools"]?.ToJsonString();
                if (tools.Length == 0) { if (entry.Remove("tools")) changes.Add("Tools → Vorlage"); }
                else { entry["tools"] = new JsonArray(tools.Select(t => (JsonNode)t).ToArray()); if (entry["tools"]!.ToJsonString() != before) changes.Add($"Tools {string.Join("/", tools)}"); }
            }
            if (changes.Count == 0) return Results.Ok(new { step, view = AgentView(entry), commit = "unverändert" });
            var commit = await WriteFlowFileAsync(repo, relPath!, flow, $"Agent {step}: {string.Join(", ", changes)} (im Cockpit gesetzt)", ct);
            _ = await plugin.RelayAsync(HttpMethod.Post, $"/projects/{Uri.EscapeDataString(name)}/sync", new { }, ct);
            return Results.Ok(new { step, view = AgentView(entry), commit });
        });

        // Die Agenten eines Projekts bei OpenClaw anlegen/abgleichen (ohne Lauf) und zeigen, was gilt
        api.MapPost("/projects/{name}/agents/sync", async (PluginClient plugin, string name, CancellationToken ct) =>
            !TryRepo(reposRoot, name, out _) ? Results.NotFound() : await plugin.RelayAsync(HttpMethod.Post, $"/projects/{Uri.EscapeDataString(name)}/sync", new { }, ct));

        api.MapGet("/tools", async (PluginClient plugin, CancellationToken ct) => await plugin.RelayAsync(HttpMethod.Get, "/tools", null, ct));

        // Relais zum Pipeline-Plugin: start und gate. Das Cockpit entscheidet nichts — ein Mensch hat geklickt.
        api.MapGet("/pipeline/flows", async (PluginClient plugin, CancellationToken ct) =>
            await plugin.RelayAsync(HttpMethod.Get, "", null, ct));

        api.MapGet("/pipeline/flows/{id}", async (PluginClient plugin, string id, CancellationToken ct) =>
            await plugin.RelayAsync(HttpMethod.Get, $"/{Uri.EscapeDataString(id)}", null, ct));

        api.MapPost("/projects/{name}/runs", async (PluginClient plugin, string name, RunBody body, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out _)) return Results.NotFound();
            if (string.IsNullOrWhiteSpace(body.Goal)) return Results.BadRequest(new { error = "goal fehlt" });
            return await plugin.RelayAsync(HttpMethod.Post, "/start", new { repo = name, goal = body.Goal.Trim() }, ct);
        });

        // Operator-Eingriff, wenn ein Schritt hängt (das Plugin hat das Ende eines Laufs verpasst).
        api.MapPost("/pipeline/flows/{id}/advance", async (HttpContext ctx, PluginClient plugin, string id, GateBody body, CancellationToken ct) =>
            await plugin.RelayAsync(HttpMethod.Post, $"/{Uri.EscapeDataString(id)}/advance", new { by = Auth.ActorName(ctx, body.By) }, ct));

        api.MapPost("/pipeline/flows/{id}/cancel", async (HttpContext ctx, PluginClient plugin, string id, GateBody body, CancellationToken ct) =>
            await plugin.RelayAsync(HttpMethod.Post, $"/{Uri.EscapeDataString(id)}/cancel", new { by = Auth.ActorName(ctx, body.By) }, ct));

        // Wer entscheidet, steht in der Session (Discord-Anzeigename); nur ohne Session zählt der übergebene Name.
        api.MapPost("/flows/{id}/gate", async (HttpContext ctx, PluginClient plugin, string id, GateBody body, CancellationToken ct) =>
        {
            if (body.Decision is not ("allow" or "deny")) return Results.BadRequest(new { error = "decision: allow | deny" });
            return await plugin.RelayAsync(HttpMethod.Post, $"/{Uri.EscapeDataString(id)}/gate", new { decision = body.Decision, by = Auth.ActorName(ctx, body.By) }, ct);
        });

        api.MapGet("/costs", async (CostsClient costs, CancellationToken ct) => Results.Ok(await costs.SummaryAsync(ct)));

        // Agenten und ihre Modelle: lesen dürfen alle, setzen nur Root (oder ein Skript mit Bearer-Token).
        // Das Plugin schreibt über OpenClaws CLI — validiert, mit Hot-Reload; das Cockpit hält keine Konfig.
        api.MapGet("/agents", async (PluginClient plugin, CancellationToken ct) =>
            await plugin.RelayAsync(HttpMethod.Get, "/agents", null, ct));

        api.MapPut("/agents/{id}", async (HttpContext ctx, Auth.Options auth, PluginClient plugin, string id, ModelBody body, CancellationToken ct) =>
        {
            if (!Auth.MayConfigure(ctx, auth)) return Results.Json(new { error = "Standard-Agenten ändert nur Root." }, statusCode: StatusCodes.Status403Forbidden);
            if (body.Model is null && body.Thinking is null && body.Tools is null) return Results.BadRequest(new { error = "model, thinking oder tools fehlt" });
            if (body.Model is not null && !ModelId.IsMatch(body.Model.Trim())) return Results.BadRequest(new { error = "model: anbieter/modell" });
            if (body.Thinking is not null && body.Thinking.Trim() != "" && !ThinkingLevels.Contains(body.Thinking.Trim())) return Results.BadRequest(new { error = $"thinking: {string.Join(" | ", ThinkingLevels)}" });
            var tools = body.Tools?.Select(t => t.Trim()).Where(t => t != "").Distinct().ToArray();
            if (tools is not null && tools.Any(t => !ToolId.IsMatch(t))) return Results.BadRequest(new { error = "tools: Kennungen wie read, write, exec" });
            if (!SafeName.IsMatch(id)) return Results.NotFound();
            return await plugin.RelayAsync(HttpMethod.Put, $"/agents/{Uri.EscapeDataString(id)}", new { model = body.Model?.Trim(), thinking = body.Thinking?.Trim(), tools }, ct);
        });

        // Je Schritt eines Laufs: Frage, Antwort, Dauer, Tokens, Kosten. Quellen: der Lebenslauf im Flow-Zustand des
        // Plugins (stateJson.steps), OpenClaws subagent_runs (Aufgabe, Abschlussnachricht, Zeiten) und das Transkript
        // des Schritt-Agenten (usage je Assistant-Nachricht, mit Run-ID). Alles nur gelesen.
        var statePath = config["OpenClaw:StatePath"] ?? "/openclaw/state/openclaw.sqlite";
        var agentsDir = config["OpenClaw:AgentsDir"] ?? "/openclaw/agents";
        var agentPrefix = config["Pipeline:AgentPrefix"] ?? "pipeline-";
        api.MapGet("/flows/{id}/steps", async (PluginClient plugin, string id, CancellationToken ct) =>
        {
            using var doc = await plugin.GetJsonAsync($"/{Uri.EscapeDataString(id)}", ct);
            if (doc is null) return Results.NotFound();
            var state = OpenClawState.Obj(doc.RootElement, "state");
            var entries = new List<StepEntry>();
            if (state.TryGetProperty("steps", out var steps) && steps.ValueKind == JsonValueKind.Array)
            {
                foreach (var s in steps.EnumerateArray())
                    entries.Add(new(OpenClawState.StrOf(s, "step") ?? "?", (int)(OpenClawState.LongOf(s, "attempt") ?? 1), OpenClawState.StrOf(s, "runId") ?? "",
                        OpenClawState.LongOf(s, "startedAt"), OpenClawState.LongOf(s, "endedAt"), OpenClawState.StrOf(s, "outcome"), OpenClawState.StrOf(s, "verdict"),
                        s.TryGetProperty("soulOverride", out var so) && so.ValueKind == JsonValueKind.True, OpenClawState.StrOf(s, "thinking"), OpenClawState.StrOf(s, "agent"), OpenClawState.StrOf(s, "kind"), OpenClawState.StrOf(s, "flow")));
            }
            else if (state.TryGetProperty("runs", out var runs) && runs.ValueKind == JsonValueKind.Object)
            {
                // Ältere Flows ohne Lebenslauf: nur der letzte Versuch je Schritt ist bekannt
                var attempts = OpenClawState.Obj(state, "attempts");
                foreach (var pr in runs.EnumerateObject())
                    entries.Add(new(pr.Name, (int)(OpenClawState.LongOf(attempts, pr.Name) ?? 1), pr.Value.GetString() ?? "", null, null, null, null, false, null, null, null, null));
                entries.Sort((a, b) => Array.IndexOf(Steps, a.Step).CompareTo(Array.IndexOf(Steps, b.Step)));
            }

            var result = new List<object>();
            SqliteConnection? conn = null;
            try
            {
                if (File.Exists(statePath)) { conn = OpenClawState.Open(statePath); await conn.OpenAsync(ct); }
                foreach (var e in entries)
                {
                    var run = conn is null || e.RunId == "" ? null : await OpenClawState.ReadSubagentRunAsync(conn, e.RunId, ct);
                    // Das Transkript liegt beim Agenten des Laufs — Projekt-Agent, sonst (ältere Flows) der globale Schritt-Agent
                    var agentId = !string.IsNullOrEmpty(e.Agent) && SafeName.IsMatch(e.Agent) ? e.Agent : agentPrefix + e.Step;
                    var usage = e.RunId == "" ? null : await OpenClawState.ReadRunUsageAsync(Path.Combine(agentsDir, agentId, "agent", "openclaw-agent.sqlite"), e.RunId, ct);
                    var started = e.StartedAt ?? run?.StartedAt;
                    var ended = e.EndedAt ?? run?.EndedAt;
                    result.Add(new
                    {
                        step = e.Step, attempt = e.Attempt, runId = e.RunId, startedAt = started, endedAt = ended,
                        durationMs = run?.ElapsedMs ?? (started is not null && ended is not null ? ended - started : null),
                        outcome = e.Outcome ?? run?.Outcome, verdict = e.Verdict, soulOverride = e.SoulOverride, thinking = e.Thinking, agent = e.Kind == "flow" ? null : agentId, kind = e.Kind, flow = e.Flow,
                        prompt = run?.Task, answer = run?.ResultText,
                        model = usage?.Model,
                        tokens = usage is null ? null : new { input = usage.Input, output = usage.Output, cacheRead = usage.CacheRead, cacheWrite = usage.CacheWrite, total = usage.Total },
                        cost = usage?.Cost, calls = usage?.Calls,
                    });
                }
            }
            finally { if (conn is not null) await conn.DisposeAsync(); }

            object? gate = null;
            var g = OpenClawState.Obj(state, "gate");
            if (g.ValueKind == JsonValueKind.Object)
            {
                var requested = OpenClawState.LongOf(g, "requestedAt");
                var decided = OpenClawState.LongOf(g, "decidedAt");
                gate = new
                {
                    status = OpenClawState.StrOf(g, "status"), by = OpenClawState.StrOf(g, "by"), decision = OpenClawState.StrOf(g, "decision"),
                    requestedAt = requested, decidedAt = decided,
                    waitMs = requested is null ? null : (decided ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) - requested,
                };
            }
            return Results.Ok(new { steps = result, gate });
        });
    }

    public sealed record SoulBody(string? Text);
    public sealed record RunBody(string? Goal);
    public sealed record GateBody(string? Decision, string? By);
    public sealed record ModelBody(string? Model, string? Thinking, string[]? Tools);
    private sealed record StepEntry(string Step, int Attempt, string RunId, long? StartedAt, long? EndedAt, string? Outcome, string? Verdict, bool SoulOverride, string? Thinking, string? Agent, string? Kind, string? Flow);

    private static string SoulPath(string repo, string step) => Path.Combine(repo, ".agentops", "souls", $"{step}.md");
    private static string FlowPath(string repo) => Path.Combine(repo, ".agentops", "flow.json");
    private static string SubflowPath(string repo, string sub) => Path.Combine(repo, ".agentops", "flows", $"{sub}.json");
    private static string LegacyAgentsPath(string repo) => Path.Combine(repo, ".agentops", "agents.json");
    // Ein Knoten: master, plan, coding/pr, … — bis zu drei Ebenen Sub-Flow
    private static readonly Regex SafeStep = new("^[a-z][a-z0-9_-]{0,30}(/[a-z][a-z0-9_-]{0,30}){0,3}$", RegexOptions.Compiled);

    private static JsonObject? ReadFlowFile(string path)
    {
        if (!File.Exists(path)) return null;
        try { return JsonNode.Parse(File.ReadAllText(path)) as JsonObject; }
        catch (JsonException) { return null; }
    }

    private static JsonObject DefaultFlowObject() =>
        new() { ["agents"] = new JsonObject(Steps.Select(s => KeyValuePair.Create<string, JsonNode?>(s, new JsonObject()))), ["gates"] = new JsonArray("gate") };

    /// <summary>Haupt- und Sub-Flows eines Projekts mit ihrem Präfix ("", "coding/", …) — Sub-Flow-Verweise werden bis zu drei Ebenen tief verfolgt.</summary>
    private static IEnumerable<(string Prefix, JsonObject Flow, string RelPath)> WalkFlows(string repo, JsonObject? main = null)
    {
        var root = main ?? ReadFlowFile(FlowPath(repo)) ?? DefaultFlowObject();
        var queue = new Queue<(string, JsonObject, string, int)>();
        queue.Enqueue(("", root, ".agentops/flow.json", 0));
        var seen = new HashSet<string>();
        while (queue.Count > 0)
        {
            var (prefix, flow, rel, depth) = queue.Dequeue();
            yield return (prefix, flow, rel);
            if (depth >= 3 || flow["agents"] is not JsonObject agents) continue;
            foreach (var p in agents)
            {
                if (p.Value is not JsonObject a || a["flow"] is not JsonValue fv || !fv.TryGetValue<string>(out var sub) || !SafeName.IsMatch(sub) || !seen.Add(prefix + p.Key)) continue;
                var subFlow = ReadFlowFile(SubflowPath(repo, sub));
                if (subFlow is not null) queue.Enqueue(($"{prefix}{p.Key}/", subFlow, $".agentops/flows/{sub}.json", depth + 1));
            }
        }
    }

    /// <summary>Den Flow (Datei) finden, in dem ein Knoten wie coding/pr steht — für Änderungen an Modell, Effort, Tools.</summary>
    private static (JsonObject? Flow, string? RelPath, string? Local, string? Error) ResolveAgentFlow(string repo, string step, JsonObject main)
    {
        var parts = step.Split('/');
        var flow = main; var rel = ".agentops/flow.json";
        for (var i = 0; i < parts.Length - 1; i++)
        {
            if (flow["agents"] is not JsonObject ag || ag[parts[i]] is not JsonObject a || a["flow"] is not JsonValue fv || !fv.TryGetValue<string>(out var sub) || !SafeName.IsMatch(sub))
                return (null, null, null, $"{string.Join("/", parts.Take(i + 1))} ist kein Sub-Flow");
            var subFlow = ReadFlowFile(SubflowPath(repo, sub));
            if (subFlow is null) return (null, null, null, $"Sub-Flow {sub} fehlt oder ist kein gültiges JSON");
            flow = subFlow; rel = $".agentops/flows/{sub}.json";
        }
        return (flow, rel, parts[^1], null);
    }
    private static readonly Regex ModelId = new(@"^[a-z0-9][a-z0-9_-]{0,40}/[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$", RegexOptions.Compiled);
    private static readonly Regex ToolId = new("^[a-z0-9_:-]{1,60}$", RegexOptions.Compiled);

    // OpenClaws Thinking-Level, im Cockpit "Effort"
    public static readonly string[] ThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"];

    /// <summary>Die Agenten-Knoten des Projekts mit Präfix (plan, coding/pr, …) — aus Haupt- und Sub-Flows; ohne flow.json die fünf Schritte des Standard-Flows.</summary>
    private static string[] FlowNodes(string repo)
    {
        var ids = new List<string>();
        foreach (var (prefix, flow, _) in WalkFlows(repo))
        {
            // Im Master-Modus ist der Master ein Knoten mit eigener Soul, auch wenn die Datei ihn nicht aufführt
            if (flow["mode"] is JsonValue m && m.TryGetValue<string>(out var mode) && mode == "master" && !((flow["agents"] as JsonObject)?.ContainsKey("master") ?? false)) ids.Add(prefix + "master");
            foreach (var p in flow["agents"] as JsonObject ?? new JsonObject())
                if (Regex.IsMatch(p.Key, "^[a-z][a-z0-9_-]{0,30}$") && !(p.Value is JsonObject a && a["flow"] is JsonValue)) ids.Add(prefix + p.Key);
        }
        return ids.Count > 0 ? [.. ids] : Steps;
    }

    /// <summary>Soul für einen Knoten ohne Vorlage — dieselbe knappe Fassung, die das Plugin in den Workspace schreibt.</summary>
    private static string GenericSoul(string node) =>
        $"# SOUL — {node}\n\nYou are the \"{node}\" agent of a deterministic pipeline. Read the notes of the earlier steps in .agentops/ and the relevant code, do exactly your part of the work for the goal, and write a short note to .agentops/{node}.md. If your step decides something, end that file with a single verdict line in capitals (for example APPROVE or REQUEST_CHANGES) — the pipeline reads only the last line. Change nothing outside the repository. Be brief.\n";

    private static object AgentView(JsonObject? entry) => new
    {
        model = entry?["model"] is JsonValue m && m.TryGetValue<string>(out var ms) ? ms : null,
        thinking = entry?["thinking"] is JsonValue t && t.TryGetValue<string>(out var ts) ? ts : null,
        tools = entry?["tools"] is JsonArray a ? a.Select(x => x is JsonValue v && v.TryGetValue<string>(out var s) ? s : null).Where(s => s is not null).Select(s => s!).ToArray() : null,
        flow = entry?["flow"] is JsonValue f && f.TryGetValue<string>(out var fs) ? fs : null,
    };

    /// <summary>Der geprüfte Flow des Projekts vom Plugin (flow.json mit Altbestand, sonst Standard) — als bearbeitbares JsonObject.</summary>
    private static async Task<JsonObject?> LoadFlowAsync(PluginClient plugin, string name, CancellationToken ct)
    {
        using var doc = await plugin.GetJsonAsync($"/projects/{Uri.EscapeDataString(name)}/flow", ct);
        if (doc is null || !doc.RootElement.TryGetProperty("flow", out var flow)) return null;
        return JsonNode.Parse(flow.GetRawText()) as JsonObject;
    }

    private static async Task<(JsonObject? Flow, JsonNode? Path, string? Error)> ValidateFlowAsync(PluginClient plugin, JsonObject body, CancellationToken ct)
    {
        using var doc = await plugin.PostJsonAsync("/flow/validate", body, ct);
        if (doc is null) return (null, null, null);
        var error = doc.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        var flow = doc.RootElement.TryGetProperty("flow", out var f) ? JsonNode.Parse(f.GetRawText()) as JsonObject : null;
        var path = doc.RootElement.TryGetProperty("path", out var p) ? JsonNode.Parse(p.GetRawText()) : null;
        return (flow ?? new JsonObject(), path, error);
    }

    /// <summary>flow.json schreiben und committen; ein altes agents.json ist damit hineingefaltet und verschwindet im selben Commit.</summary>
    private static Task<string> WriteProjectFlowAsync(string repo, JsonObject flow, string message, CancellationToken ct) =>
        WriteFlowFileAsync(repo, ".agentops/flow.json", flow, message, ct);

    /// <summary>Eine Flow-Datei (Hauptflow oder .agentops/flows/&lt;name&gt;.json) schreiben und committen.</summary>
    private static async Task<string> WriteFlowFileAsync(string repo, string relPath, JsonObject flow, string message, CancellationToken ct)
    {
        var path = Path.Combine(repo, relPath);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, flow.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n", ct);
        var paths = new List<string> { relPath };
        // git add scheitert an einem Pfad, den es nie gab — das alte agents.json nur mitnehmen, wenn es da war
        if (relPath == ".agentops/flow.json" && File.Exists(LegacyAgentsPath(repo))) { File.Delete(LegacyAgentsPath(repo)); paths.Add(".agentops/agents.json"); }
        return await GitCommitAsync(repo, [.. paths], message, ct);
    }

    private static bool TryRepo(string root, string name, out string repo)
    {
        repo = "";
        if (!SafeName.IsMatch(name)) return false;
        var candidate = Path.Combine(root, name);
        if (!Directory.Exists(Path.Combine(candidate, ".git"))) return false;
        repo = candidate;
        return true;
    }

    /// <summary>git add + commit für genau diese Dateien. Läuft im Container als uid des Repo-Besitzers.</summary>
    private static Task<string> GitCommitAsync(string repo, string relPath, string message, CancellationToken ct) => GitCommitAsync(repo, [relPath], message, ct);

    private static async Task<string> GitCommitAsync(string repo, string[] relPaths, string message, CancellationToken ct)
    {
        await Git(repo, ["add", "-A", "--", .. relPaths], ct);
        var status = await Git(repo, ["status", "--porcelain", "--", .. relPaths], ct);
        if (string.IsNullOrWhiteSpace(status)) return "unverändert";
        await Git(repo, ["-c", "user.name=AgentOps Cockpit", "-c", "user.email=cockpit@agentops.local", "commit", "-q", "-m", message, "--", .. relPaths], ct);
        return (await Git(repo, ["rev-parse", "--short", "HEAD"], ct)).Trim();
    }

    private static async Task<string> Git(string repo, string[] args, CancellationToken ct)
    {
        var psi = new ProcessStartInfo("git") { WorkingDirectory = repo, RedirectStandardOutput = true, RedirectStandardError = true };
        psi.ArgumentList.Add("-c"); psi.ArgumentList.Add("safe.directory=*");
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("git nicht gefunden");
        var stdout = await p.StandardOutput.ReadToEndAsync(ct);
        var stderr = await p.StandardError.ReadToEndAsync(ct);
        await p.WaitForExitAsync(ct);
        if (p.ExitCode != 0) throw new InvalidOperationException($"git {args[0]}: {stderr.Trim()}");
        return stdout;
    }
}

/// <summary>Relais zum Pipeline-Plugin am OpenClaw-Gateway. Der Gateway-Token bleibt im Container.</summary>
public sealed class PluginClient(HttpClient http, IConfiguration config)
{
    /// <summary>Eine Antwort des Plugins als JSON — null, wenn das Relais aus ist, das Gateway nicht antwortet oder der Status nicht 2xx ist.</summary>
    public Task<JsonDocument?> GetJsonAsync(string path, CancellationToken ct) => SendJsonAsync(HttpMethod.Get, path, null, ct);
    public Task<JsonDocument?> PostJsonAsync(string path, object body, CancellationToken ct) => SendJsonAsync(HttpMethod.Post, path, body, ct);

    private async Task<JsonDocument?> SendJsonAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var token = config["OpenClaw:GatewayToken"];
        if (string.IsNullOrEmpty(token)) return null;
        var gateway = (config["OpenClaw:GatewayUrl"] ?? "ws://openclaw:18789").Replace("ws://", "http://").Replace("wss://", "https://").TrimEnd('/');
        using var req = new HttpRequestMessage(method, $"{gateway}/plugins/agentops-pipeline{path}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null) req.Content = new StringContent(body is JsonNode n ? n.ToJsonString() : JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        try
        {
            using var res = await http.SendAsync(req, ct);
            if (!res.IsSuccessStatusCode) return null;
            return JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        {
            return null;
        }
    }

    public async Task<IResult> RelayAsync(HttpMethod method, string path, object? body, CancellationToken ct)
    {
        var token = config["OpenClaw:GatewayToken"];
        if (string.IsNullOrEmpty(token))
            return Results.Problem("OpenClaw:GatewayToken nicht gesetzt — Pipeline-Relais aus.", statusCode: StatusCodes.Status503ServiceUnavailable);

        var gateway = (config["OpenClaw:GatewayUrl"] ?? "ws://openclaw:18789").Replace("ws://", "http://").Replace("wss://", "https://").TrimEnd('/');
        using var req = new HttpRequestMessage(method, $"{gateway}/plugins/agentops-pipeline{path}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        try
        {
            using var res = await http.SendAsync(req, ct);
            var text = await res.Content.ReadAsStringAsync(ct);
            return Results.Content(text, "application/json", Encoding.UTF8, (int)res.StatusCode);
        }
        catch (HttpRequestException ex)
        {
            return Results.Problem($"Gateway nicht erreichbar: {ex.Message}", statusCode: StatusCodes.Status502BadGateway);
        }
    }
}

/// <summary>Kosten und Tokens aus Prometheus — dieselben Zähler wie im Grafana-Board.</summary>
public sealed class CostsClient(HttpClient http, IConfiguration config, ILogger<CostsClient> log)
{
    public async Task<object> SummaryAsync(CancellationToken ct)
    {
        var url = (config["Prometheus:Url"] ?? "http://prometheus:9090").TrimEnd('/');
        // last_over_time: der letzte bekannte Zählerstand, auch wenn seit Minuten kein neuer Wert kam.
        // increase über 7 Tage übersteht Gateway-Neustarts (Zähler-Resets), verliert aber den ersten Sprung einer Serie.
        var byAgent = await QueryAsync(url, "sum by (openclaw_agent) (last_over_time(openclaw_cost_usd_total[24h]))", ct);
        var byAgent7d = await QueryAsync(url, "sum by (openclaw_agent) (increase(openclaw_cost_usd_total[7d]))", ct);
        var tokens = await QueryAsync(url, "sum by (openclaw_token) (last_over_time(openclaw_tokens_total[24h]))", ct);
        var total = await QueryAsync(url, "sum(last_over_time(openclaw_cost_usd_total[24h]))", ct);
        return new
        {
            totalSinceStart = total.FirstOrDefault().Value,
            byAgent = byAgent.Select(kv => new { agent = kv.Key.GetValueOrDefault("openclaw_agent", "?"), usd = kv.Value }),
            byAgent7d = byAgent7d.Select(kv => new { agent = kv.Key.GetValueOrDefault("openclaw_agent", "?"), usd = kv.Value }),
            tokens = tokens.Select(kv => new { kind = kv.Key.GetValueOrDefault("openclaw_token", "?"), count = kv.Value }),
        };
    }

    private async Task<List<KeyValuePair<Dictionary<string, string>, double>>> QueryAsync(string url, string query, CancellationToken ct)
    {
        var result = new List<KeyValuePair<Dictionary<string, string>, double>>();
        try
        {
            using var res = await http.GetAsync($"{url}/api/v1/query?query={Uri.EscapeDataString(query)}", ct);
            if (!res.IsSuccessStatusCode)
            {
                log.LogWarning("Prometheus {Status} für {Query}: {Body}", (int)res.StatusCode, query, (await res.Content.ReadAsStringAsync(ct))[..Math.Min(200, (int)(res.Content.Headers.ContentLength ?? 200))]);
                return result;
            }
            using var doc = JsonDocument.Parse(await res.Content.ReadAsStringAsync(ct));
            foreach (var r in doc.RootElement.GetProperty("data").GetProperty("result").EnumerateArray())
            {
                var labels = r.GetProperty("metric").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetString() ?? "");
                var value = double.Parse(r.GetProperty("value")[1].GetString() ?? "0", System.Globalization.CultureInfo.InvariantCulture);
                result.Add(new(labels, value));
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException or KeyNotFoundException or InvalidOperationException)
        {
            log.LogWarning(ex, "Prometheus-Abfrage fehlgeschlagen: {Query}", query);
        }
        return result;
    }
}
