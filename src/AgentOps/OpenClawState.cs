using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace AgentOps.OpenClaw;

/// <summary>
/// Lesender Zugriff auf OpenClaws State-Datei (Version 2026.9.1, Schema 15 — docs/architektur.html §14, "geklärt").
/// Strikt read-only auf Verbindungsebene; die Datei liegt im WAL-Modus, deshalb ist das Verzeichnis rw gemountet (§10).
/// </summary>
public static class OpenClawState
{
    public sealed record FlowRow(
        string FlowId, int Revision, string Status, string? CurrentStep, string? BlockedSummary, string? WaitJson,
        string? StateJson, long? CreatedAt, long? UpdatedAt, long? EndedAt);

    public sealed record ApprovalRow(
        string ApprovalId, string? FlowId, string? Kind, string Status, string? Decision, string? ResolverKind,
        string? ResolverId, string? TerminalReason, long? CreatedAtMs, long? UpdatedAtMs, long? ResolvedAtMs,
        string? SourceRunId = null);

    public static SqliteConnection Open(string path)
    {
        var conn = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadOnly,
            Cache = SqliteCacheMode.Shared,
            DefaultTimeout = 5   // Busy-Timeout in Sekunden — wir blockieren OpenClaws Schreiber nie, wir warten
        }.ToString());
        return conn;
    }

    /// <summary>Alle Flows, die noch laufen oder in den letzten 24 h geendet sind.</summary>
    public static async Task<List<FlowRow>> ReadFlowsAsync(SqliteConnection conn, long nowMs, CancellationToken ct)
    {
        const string sql = """
            select flow_id, revision, status, current_step, blocked_summary, wait_json, state_json, created_at, updated_at, ended_at
            from flow_runs
            where ended_at is null or ended_at > @recent
            order by updated_at
            """;
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("@recent", nowMs - 24L * 3600 * 1000);
        var rows = new List<FlowRow>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            rows.Add(new FlowRow(
                r.GetString(0),
                r.IsDBNull(1) ? 0 : r.GetInt32(1),
                r.IsDBNull(2) ? "" : r.GetString(2),
                Str(r, 3), Str(r, 4), Str(r, 5), Str(r, 6),
                Long(r, 7), Long(r, 8), Long(r, 9)));
        }
        return rows;
    }

    /// <summary>
    /// Freigaben mit dem Flow, zu dem sie gehören: operator_approvals.source_run_id → task_runs.run_id → parent_flow_id.
    /// </summary>
    public static async Task<List<ApprovalRow>> ReadApprovalsAsync(SqliteConnection conn, long nowMs, CancellationToken ct)
    {
        const string sql = """
            select a.approval_id, t.parent_flow_id, a.kind, a.status, a.decision, a.resolver_kind, a.resolver_id,
                   a.terminal_reason, a.created_at_ms, a.updated_at_ms, a.resolved_at_ms, a.source_run_id
            from operator_approvals a
            left join (select run_id, max(parent_flow_id) as parent_flow_id from task_runs group by run_id) t
                   on t.run_id = a.source_run_id
            where a.resolved_at_ms is null or a.resolved_at_ms > @recent
            order by a.created_at_ms
            """;
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.AddWithValue("@recent", nowMs - 24L * 3600 * 1000);
        var rows = new List<ApprovalRow>();
        await using var r = await cmd.ExecuteReaderAsync(ct);
        while (await r.ReadAsync(ct))
        {
            rows.Add(new ApprovalRow(
                r.GetString(0), Str(r, 1), Str(r, 2),
                r.IsDBNull(3) ? "" : r.GetString(3),
                Str(r, 4), Str(r, 5), Str(r, 6), Str(r, 7),
                Long(r, 8), Long(r, 9), Long(r, 10), Str(r, 11)));
        }
        return rows;
    }

    public sealed record SubagentRun(string RunId, string? Task, string? ResultText, long? StartedAt, long? EndedAt, long? ElapsedMs, string? Outcome, string? ChildSessionKey);

    /// <summary>Ein Subagent-Lauf: die Aufgabe (die Frage), die Abschlussnachricht (die Antwort) und die Zeiten — aus subagent_runs.payload_json.</summary>
    public static async Task<SubagentRun?> ReadSubagentRunAsync(SqliteConnection conn, string runId, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "select child_session_key, payload_json from subagent_runs where run_id = @id";
        cmd.Parameters.AddWithValue("@id", runId);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct)) return null;
        var key = Str(r, 0);
        var payload = Str(r, 1);
        if (payload is null) return new SubagentRun(runId, null, null, null, null, null, null, key);
        try
        {
            using var doc = JsonDocument.Parse(payload);
            var root = doc.RootElement;
            var exec = Obj(root, "execution");
            var outcome = Obj(exec, "outcome");
            return new SubagentRun(runId,
                StrOf(root, "task"),
                StrOf(Obj(root, "completion"), "resultText"),
                LongOf(outcome, "startedAt") ?? LongOf(exec, "startedAt"),
                LongOf(outcome, "endedAt") ?? LongOf(exec, "endedAt"),
                LongOf(outcome, "elapsedMs"),
                StrOf(outcome, "status"),
                key);
        }
        catch (JsonException)
        {
            return new SubagentRun(runId, null, null, null, null, null, null, key);
        }
    }

    public sealed record RunUsage(string? Model, long Input, long Output, long CacheRead, long CacheWrite, double Cost, int Calls)
    {
        public long Total => Input + Output + CacheRead + CacheWrite;
    }

    /// <summary>
    /// Tokens und Kosten eines Laufs aus dem Transkript des Agenten: jede Assistant-Nachricht trägt usage und die
    /// Run-ID (message.__openclaw.runId). Die Datei liegt je Agent unter agents/&lt;id&gt;/agent/openclaw-agent.sqlite.
    /// </summary>
    public static async Task<RunUsage?> ReadRunUsageAsync(string agentDbPath, string runId, CancellationToken ct)
    {
        if (!File.Exists(agentDbPath)) return null;
        await using var conn = Open(agentDbPath);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            select max(json_extract(event_json, '$.message.provider') || '/' || json_extract(event_json, '$.message.model')),
                   sum(coalesce(json_extract(event_json, '$.message.usage.input'), 0)),
                   sum(coalesce(json_extract(event_json, '$.message.usage.output'), 0)),
                   sum(coalesce(json_extract(event_json, '$.message.usage.cacheRead'), 0)),
                   sum(coalesce(json_extract(event_json, '$.message.usage.cacheWrite'), 0)),
                   sum(coalesce(json_extract(event_json, '$.message.usage.cost.total'), 0)),
                   count(*)
            from transcript_events
            where json_extract(event_json, '$.message.role') = 'assistant'
              and json_extract(event_json, '$.message.__openclaw.runId') = @run
            """;
        cmd.Parameters.AddWithValue("@run", runId);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct) || r.IsDBNull(6) || r.GetInt32(6) == 0) return null;
        return new RunUsage(Str(r, 0), r.GetInt64(1), r.GetInt64(2), r.GetInt64(3), r.GetInt64(4), r.IsDBNull(5) ? 0 : r.GetDouble(5), r.GetInt32(6));
    }

    public static JsonElement Obj(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : default;
    public static string? StrOf(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
    public static long? LongOf(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var l) ? l : null;

    private static string? Str(SqliteDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);
    private static long? Long(SqliteDataReader r, int i) => r.IsDBNull(i) ? null : r.GetInt64(i);
}
