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
                    Souls = Steps.ToDictionary(s => s, s => File.Exists(SoulPath(d, s))),
                })
                .OrderBy(p => p.Name);
            return Results.Ok(projects);
        });

        api.MapGet("/projects/{name}/souls", (string name) =>
        {
            if (!TryRepo(reposRoot, name, out var repo)) return Results.NotFound();
            var souls = Steps.ToDictionary(s => s, s => new
            {
                Override = File.Exists(SoulPath(repo, s)) ? File.ReadAllText(SoulPath(repo, s)) : null,
                Default = File.Exists(Path.Combine(defaultsDir, $"{s}.md")) ? File.ReadAllText(Path.Combine(defaultsDir, $"{s}.md")) : null,
            });
            return Results.Ok(souls);
        });

        api.MapPut("/projects/{name}/souls/{step}", async (string name, string step, SoulBody body, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo) || !Steps.Contains(step)) return Results.NotFound();
            var text = (body.Text ?? "").Replace("\r\n", "\n").TrimEnd() + "\n";
            var path = SoulPath(repo, step);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            await File.WriteAllTextAsync(path, text, ct);
            var commit = await GitCommitAsync(repo, $".agentops/souls/{step}.md", $"Soul {step}: im Cockpit bearbeitet", ct);
            return Results.Ok(new { step, commit });
        });

        api.MapDelete("/projects/{name}/souls/{step}", async (string name, string step, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo) || !Steps.Contains(step)) return Results.NotFound();
            var path = SoulPath(repo, step);
            if (!File.Exists(path)) return Results.NoContent();
            File.Delete(path);
            var commit = await GitCommitAsync(repo, $".agentops/souls/{step}.md", $"Soul {step}: Projekt-Override entfernt", ct);
            return Results.Ok(new { step, commit });
        });

        // Agenten je Projekt: <repo>/.agentops/agents.json — Modell je Schritt, committet wie die Souls.
        // Das Plugin liest die Datei beim Start eines Schritts; fehlt ein Eintrag, gilt der globale Schritt-Agent.
        api.MapGet("/projects/{name}/agents", (string name) =>
        {
            if (!TryRepo(reposRoot, name, out var repo)) return Results.NotFound();
            var cfg = ReadProjectAgents(repo);
            return Results.Ok(Steps.ToDictionary(s => s, s => new { model = ProjectField(cfg, s, "model"), thinking = ProjectField(cfg, s, "thinking") }));
        });

        // PUT setzt model und/oder thinking; ein leerer Wert nimmt die Einstellung zurück (dann gilt der Standard-Agent).
        api.MapPut("/projects/{name}/agents/{step}", async (string name, string step, ModelBody body, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo) || !Steps.Contains(step)) return Results.NotFound();
            if (body.Model is null && body.Thinking is null) return Results.BadRequest(new { error = "model oder thinking fehlt" });
            var model = body.Model?.Trim(); var thinking = body.Thinking?.Trim();
            if (!string.IsNullOrEmpty(model) && !ModelId.IsMatch(model)) return Results.BadRequest(new { error = "model: anbieter/modell" });
            if (!string.IsNullOrEmpty(thinking) && !ThinkingLevels.Contains(thinking)) return Results.BadRequest(new { error = $"thinking: {string.Join(" | ", ThinkingLevels)}" });
            var cfg = ReadProjectAgents(repo);
            if (cfg[step] is not JsonObject entry) { entry = new JsonObject(); cfg[step] = entry; }
            var changes = new List<string>();
            if (model is not null) { if (model == "") { if (entry.Remove("model")) changes.Add("Modell → Standard"); } else { entry["model"] = model; changes.Add($"Modell {model}"); } }
            if (thinking is not null) { if (thinking == "") { if (entry.Remove("thinking")) changes.Add("Effort → Standard"); } else { entry["thinking"] = thinking; changes.Add($"Effort {thinking}"); } }
            if (entry.Count == 0) cfg.Remove(step);
            if (changes.Count == 0) return Results.Ok(new { step, model = ProjectField(cfg, step, "model"), thinking = ProjectField(cfg, step, "thinking"), commit = "unverändert" });
            var commit = await WriteProjectAgentsAsync(repo, cfg, $"Agent {step}: {string.Join(", ", changes)} (im Cockpit gesetzt)", ct);
            return Results.Ok(new { step, model = ProjectField(cfg, step, "model"), thinking = ProjectField(cfg, step, "thinking"), commit });
        });

        api.MapDelete("/projects/{name}/agents/{step}", async (string name, string step, CancellationToken ct) =>
        {
            if (!TryRepo(reposRoot, name, out var repo) || !Steps.Contains(step)) return Results.NotFound();
            var cfg = ReadProjectAgents(repo);
            if (cfg[step] is null) return Results.NoContent();
            cfg.Remove(step);
            var commit = await WriteProjectAgentsAsync(repo, cfg, $"Agent {step}: Projekt-Einstellungen entfernt", ct);
            return Results.Ok(new { step, commit });
        });

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
            if (body.Model is null && body.Thinking is null) return Results.BadRequest(new { error = "model oder thinking fehlt" });
            if (body.Model is not null && !ModelId.IsMatch(body.Model.Trim())) return Results.BadRequest(new { error = "model: anbieter/modell" });
            if (body.Thinking is not null && body.Thinking.Trim() != "" && !ThinkingLevels.Contains(body.Thinking.Trim())) return Results.BadRequest(new { error = $"thinking: {string.Join(" | ", ThinkingLevels)}" });
            if (!SafeName.IsMatch(id)) return Results.NotFound();
            return await plugin.RelayAsync(HttpMethod.Put, $"/agents/{Uri.EscapeDataString(id)}", new { model = body.Model?.Trim(), thinking = body.Thinking?.Trim() }, ct);
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
                        s.TryGetProperty("soulOverride", out var so) && so.ValueKind == JsonValueKind.True, OpenClawState.StrOf(s, "thinking")));
            }
            else if (state.TryGetProperty("runs", out var runs) && runs.ValueKind == JsonValueKind.Object)
            {
                // Ältere Flows ohne Lebenslauf: nur der letzte Versuch je Schritt ist bekannt
                var attempts = OpenClawState.Obj(state, "attempts");
                foreach (var pr in runs.EnumerateObject())
                    entries.Add(new(pr.Name, (int)(OpenClawState.LongOf(attempts, pr.Name) ?? 1), pr.Value.GetString() ?? "", null, null, null, null, false, null));
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
                    var usage = e.RunId == "" ? null : await OpenClawState.ReadRunUsageAsync(Path.Combine(agentsDir, agentPrefix + e.Step, "agent", "openclaw-agent.sqlite"), e.RunId, ct);
                    var started = e.StartedAt ?? run?.StartedAt;
                    var ended = e.EndedAt ?? run?.EndedAt;
                    result.Add(new
                    {
                        step = e.Step, attempt = e.Attempt, runId = e.RunId, startedAt = started, endedAt = ended,
                        durationMs = run?.ElapsedMs ?? (started is not null && ended is not null ? ended - started : null),
                        outcome = e.Outcome ?? run?.Outcome, verdict = e.Verdict, soulOverride = e.SoulOverride, thinking = e.Thinking,
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
    public sealed record ModelBody(string? Model, string? Thinking);
    private sealed record StepEntry(string Step, int Attempt, string RunId, long? StartedAt, long? EndedAt, string? Outcome, string? Verdict, bool SoulOverride, string? Thinking);

    private static string SoulPath(string repo, string step) => Path.Combine(repo, ".agentops", "souls", $"{step}.md");
    private static readonly Regex ModelId = new(@"^[a-z0-9][a-z0-9_-]{0,40}/[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$", RegexOptions.Compiled);
    private static string AgentsPath(string repo) => Path.Combine(repo, ".agentops", "agents.json");

    /// <summary>{ "&lt;step&gt;": { "model": "provider/model", … } } — andere Felder bleiben unangetastet, nur model wird gelesen und gesetzt.</summary>
    private static JsonObject ReadProjectAgents(string repo)
    {
        var path = AgentsPath(repo);
        if (!File.Exists(path)) return new JsonObject();
        try { return JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? new JsonObject(); }
        catch (JsonException) { return new JsonObject(); }
    }

    // OpenClaws Thinking-Level, im Cockpit "Effort"
    public static readonly string[] ThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"];

    private static string? ProjectField(JsonObject cfg, string step, string field) =>
        cfg[step] is JsonObject o && o[field] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static async Task<string> WriteProjectAgentsAsync(string repo, JsonObject cfg, string message, CancellationToken ct)
    {
        var path = AgentsPath(repo);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (cfg.Count == 0) { if (File.Exists(path)) File.Delete(path); }
        else await File.WriteAllTextAsync(path, cfg.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n", ct);
        return await GitCommitAsync(repo, ".agentops/agents.json", message, ct);
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

    /// <summary>git add + commit für genau eine Datei. Läuft im Container als uid des Repo-Besitzers.</summary>
    private static async Task<string> GitCommitAsync(string repo, string relPath, string message, CancellationToken ct)
    {
        await Git(repo, ["add", "-A", "--", relPath], ct);
        var status = await Git(repo, ["status", "--porcelain", "--", relPath], ct);
        if (string.IsNullOrWhiteSpace(status)) return "unverändert";
        await Git(repo, ["-c", "user.name=AgentOps Cockpit", "-c", "user.email=cockpit@agentops.local", "commit", "-q", "-m", message, "--", relPath], ct);
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
    public async Task<JsonDocument?> GetJsonAsync(string path, CancellationToken ct)
    {
        var token = config["OpenClaw:GatewayToken"];
        if (string.IsNullOrEmpty(token)) return null;
        var gateway = (config["OpenClaw:GatewayUrl"] ?? "ws://openclaw:18789").Replace("ws://", "http://").Replace("wss://", "https://").TrimEnd('/');
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{gateway}/plugins/agentops-pipeline{path}");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
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
