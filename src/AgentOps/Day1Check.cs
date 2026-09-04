using AgentOps.ReadModel;
using Marten;
using Npgsql;

namespace AgentOps;

/// <summary>
/// §14 Schritt 4 und 5 als ein Kommando: Fixture laden → projizieren → Prüfsumme → Rebuild → Prüfsumme → Vergleich.
/// Dazu ein zweiter Load als Idempotenz-Probe. Exit-Code 0 nur, wenn beides stimmt — der Stopp-Kriterium aus §14.
/// Läuft lokal (dotnet run) und im Container identisch; braucht kein psql.
/// </summary>
public static class Day1Check
{
    private const string ChecksumSql =
        "select coalesce(md5(string_agg(f::text, '|' order by f.flow_id)), '(leer)') from readmodel.flows f";

    private const string RowsSql =
        "select flow_id, stage, status, gate_open, coalesce(open_approval_id, ''), revision from readmodel.flows order by flow_id";

    public static async Task<bool> VerifyAsync(IDocumentStore store, string fixture, ILogger log, CancellationToken ct)
    {
        await FixtureLoader.LoadAsync(store, fixture, log, ct);
        await ProjectOnceAsync(store);
        await PrintRowsAsync(store, log, ct);

        var before = await ChecksumAsync(store, ct);
        await RebuildAsync(store, ct);
        var after = await ChecksumAsync(store, ct);
        var (again, _) = await FixtureLoader.LoadAsync(store, fixture, log, ct);

        var same = before == after;
        var idempotent = again == 0;
        log.LogInformation("Prüfsumme vor Rebuild {Before}, nach Rebuild {After} — {Result}", before, after, same ? "identisch" : "UNTERSCHIEDLICH");
        log.LogInformation("Zweiter Load: {Again} Events angehängt — {Result}", again, idempotent ? "idempotent" : "NICHT idempotent");

        var pass = same && idempotent;
        if (pass) log.LogInformation("TAG 1: BESTANDEN");
        else log.LogError("TAG 1: NICHT BESTANDEN — das Event-Modell ist unehrlich (Abb. 4). Billig jetzt, teuer später.");
        return pass;
    }

    /// <summary>Einmal durch den Daemon projizieren, wie im Betrieb — nicht per Rebuild.</summary>
    public static async Task ProjectOnceAsync(IDocumentStore store)
    {
        using var daemon = await store.BuildProjectionDaemonAsync();
        await daemon.StartAllAsync();
        await daemon.WaitForNonStaleData(TimeSpan.FromSeconds(30));
        await daemon.StopAllAsync();
    }

    /// <summary>Read-Model leeren, Cursor auf 0, Log neu abspielen (Abb. 4).</summary>
    public static async Task RebuildAsync(IDocumentStore store, CancellationToken ct)
    {
        using var daemon = await store.BuildProjectionDaemonAsync();
        await daemon.RebuildProjectionAsync(FlowViewProjection.Key, ct);
    }

    public static async Task<string> ChecksumAsync(IDocumentStore store, CancellationToken ct)
    {
        await using var conn = store.Storage.Database.CreateConnection();
        await conn.OpenAsync(ct);
        await using var cmd = new NpgsqlCommand(ChecksumSql, (NpgsqlConnection)conn);
        return (string)(await cmd.ExecuteScalarAsync(ct))!;
    }

    public static async Task PrintRowsAsync(IDocumentStore store, ILogger log, CancellationToken ct)
    {
        await using var conn = store.Storage.Database.CreateConnection();
        await conn.OpenAsync(ct);
        await using var cmd = new NpgsqlCommand(RowsSql, (NpgsqlConnection)conn);
        await using var r = await cmd.ExecuteReaderAsync(ct);
        log.LogInformation("{FlowId,-8} {Stage,-8} {Status,-8} {Gate,-6} {Approval,-10} {Rev}", "flow_id", "stage", "status", "gate", "approval", "rev");
        while (await r.ReadAsync(ct))
        {
            log.LogInformation("{FlowId,-8} {Stage,-8} {Status,-8} {Gate,-6} {Approval,-10} {Rev}",
                r.GetString(0), r.GetString(1), r.GetString(2), r.GetBoolean(3), r.GetString(4), r.GetInt32(5));
        }
    }
}
