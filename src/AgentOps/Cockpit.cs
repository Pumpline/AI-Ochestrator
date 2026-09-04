using System.Diagnostics;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

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
        api.MapPost("/pipeline/flows/{id}/advance", async (PluginClient plugin, string id, GateBody body, CancellationToken ct) =>
            await plugin.RelayAsync(HttpMethod.Post, $"/{Uri.EscapeDataString(id)}/advance", new { by = string.IsNullOrWhiteSpace(body.By) ? "cockpit" : body.By.Trim() }, ct));

        api.MapPost("/flows/{id}/gate", async (PluginClient plugin, string id, GateBody body, CancellationToken ct) =>
        {
            if (body.Decision is not ("allow" or "deny")) return Results.BadRequest(new { error = "decision: allow | deny" });
            var by = string.IsNullOrWhiteSpace(body.By) ? "cockpit" : body.By.Trim();
            return await plugin.RelayAsync(HttpMethod.Post, $"/{Uri.EscapeDataString(id)}/gate", new { decision = body.Decision, by }, ct);
        });

        api.MapGet("/costs", async (CostsClient costs, CancellationToken ct) => Results.Ok(await costs.SummaryAsync(ct)));
    }

    public sealed record SoulBody(string? Text);
    public sealed record RunBody(string? Goal);
    public sealed record GateBody(string? Decision, string? By);

    private static string SoulPath(string repo, string step) => Path.Combine(repo, ".agentops", "souls", $"{step}.md");

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
