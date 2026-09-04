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
        long? CreatedAt, long? UpdatedAt, long? EndedAt);

    public sealed record ApprovalRow(
        string ApprovalId, string? FlowId, string? Kind, string Status, string? Decision, string? ResolverKind,
        string? ResolverId, string? TerminalReason, long? CreatedAtMs, long? UpdatedAtMs, long? ResolvedAtMs);

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
            select flow_id, revision, status, current_step, blocked_summary, wait_json, created_at, updated_at, ended_at
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
                Str(r, 3), Str(r, 4), Str(r, 5),
                Long(r, 6), Long(r, 7), Long(r, 8)));
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
                   a.terminal_reason, a.created_at_ms, a.updated_at_ms, a.resolved_at_ms
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
                Long(r, 8), Long(r, 9), Long(r, 10)));
        }
        return rows;
    }

    private static string? Str(SqliteDataReader r, int i) => r.IsDBNull(i) ? null : r.GetString(i);
    private static long? Long(SqliteDataReader r, int i) => r.IsDBNull(i) ? null : r.GetInt64(i);
}
