using System.Text.Json;
using AgentOps.Events;
using Marten;

namespace AgentOps;

/// <summary>
/// Hängt fixtures/*.jsonl als Events an — Tag 1 ohne Orchestrator (§14 Schritt 4).
/// Idempotent auf Stream-Ebene: Streams, die schon Events haben, werden übersprungen.
/// Ein Event pro Session, damit Martens Correlation/Causation-Metadaten pro Event stimmen.
/// </summary>
public static class FixtureLoader
{
    public static async Task<(int appended, int skipped)> LoadAsync(IDocumentStore store, string path, ILogger log, CancellationToken ct)
    {
        var appended = 0;
        var skipped = 0;
        var streamExisted = new Dictionary<string, bool>();

        await foreach (var line in File.ReadLinesAsync(path, ct))
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            using var doc = JsonDocument.Parse(line);
            var r = doc.RootElement;
            var stream = r.GetProperty("stream_id").GetString()!;

            if (!streamExisted.TryGetValue(stream, out var existed))
            {
                await using var q = store.QuerySession();
                var state = await q.Events.FetchStreamStateAsync(stream, ct);
                existed = state is not null && state.Version > 0;
                streamExisted[stream] = existed;
            }
            if (existed) { skipped++; continue; }

            var meta = new EventMeta(
                r.GetProperty("actor_type").GetString()!,
                r.GetProperty("actor_id").GetString()!,
                Str(r, "causation_id"),
                r.GetProperty("idempotency_key").GetString()!,
                r.GetProperty("occurred_at").GetDateTimeOffset(),
                r.TryGetProperty("schema_version", out var sv) ? sv.GetInt32() : 1);

            var flowId = r.GetProperty("correlation_id").GetString()!;
            var p = r.GetProperty("payload");
            var type = r.GetProperty("type").GetString();

            object evt = type switch
            {
                "StageEntered"    => new StageEntered(flowId, p.GetProperty("stage").GetString()!, Str(p, "previous"), p.GetProperty("revision").GetInt32(), meta),
                "Halted"          => new Halted(flowId, p.GetProperty("status").GetString()!, p.GetProperty("revision").GetInt32(), Str(p, "reason"), meta),
                "GatePending"     => new GatePending(flowId, p.GetProperty("approval_id").GetString()!, p.GetProperty("stage").GetString()!, meta),
                "ApprovalGranted" => new ApprovalGranted(flowId, p.GetProperty("approval_id").GetString()!, Str(p, "actor_ref"), meta),
                "ApprovalDenied"  => new ApprovalDenied(flowId, p.GetProperty("approval_id").GetString()!, Str(p, "actor_ref"), Str(p, "reason"), meta),
                _ => throw new InvalidOperationException($"Unbekannter Event-Typ '{type}' in {path}")
            };

            await using var s = store.LightweightSession();
            s.CorrelationId = flowId;
            s.CausationId = meta.CausationId;
            s.Events.Append(stream, evt);
            await s.SaveChangesAsync(ct);
            appended++;
        }

        log.LogInformation("Fixture {Path}: {Appended} Events angehängt, {Skipped} übersprungen (Stream existierte schon)", path, appended, skipped);
        return (appended, skipped);
    }

    private static string? Str(JsonElement o, string name) =>
        o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
