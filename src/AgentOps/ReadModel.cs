using AgentOps.Events;
using Marten;
using Marten.Events.Projections;
using Npgsql;

namespace AgentOps.ReadModel;

/// <summary>
/// Das eine Read-Model für Tag 1: ein Dokument pro Flow. Wegwerfbar — entsteht nur aus dem Log (Abb. 4).
/// Marten legt es als readmodel.mt_doc_flows ab; die View readmodel.flows (unten) macht daraus Spalten für Grafana.
/// </summary>
public sealed class FlowView
{
    public string Id { get; set; } = default!;      // FlowId
    public string Stage { get; set; } = "";
    public string Status { get; set; } = "queued";  // running | waiting | failed | lost | blocked | ...
    public int Revision { get; set; }
    public bool GateOpen { get; set; }
    public string? OpenApprovalId { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}

/// <summary>
/// Multi-Stream: task:{id} und approval:{id} fließen in dasselbe Dokument, Schlüssel ist die FlowId.
/// Läuft asynchron im Daemon — dem Single-Writer aus Abb. 4.
/// </summary>
public sealed class FlowViewProjection : MultiStreamProjection<FlowView, string>
{
    public const string Key = "FlowView";

    public FlowViewProjection()
    {
        Name = Key;
        Identity<StageEntered>(e => e.FlowId);
        Identity<Halted>(e => e.FlowId);
        Identity<GatePending>(e => e.FlowId);
        Identity<ApprovalGranted>(e => e.FlowId);
        Identity<ApprovalDenied>(e => e.FlowId);
    }

    public FlowView Create(StageEntered e) => new()
    {
        Id = e.FlowId, Stage = e.Stage, Status = "running", Revision = e.Revision, UpdatedAt = e.Meta.OccurredAt
    };

    public void Apply(StageEntered e, FlowView v)
    {
        v.Stage = e.Stage;
        v.Status = "running";
        v.Revision = e.Revision;
        v.GateOpen = false;
        v.OpenApprovalId = null;
        v.UpdatedAt = e.Meta.OccurredAt;
    }

    public void Apply(Halted e, FlowView v)
    {
        v.Status = e.Status;
        v.Revision = e.Revision;
        v.GateOpen = false;
        v.OpenApprovalId = null;
        v.UpdatedAt = e.Meta.OccurredAt;
    }

    public void Apply(GatePending e, FlowView v)
    {
        v.Status = "waiting";
        v.GateOpen = true;
        v.OpenApprovalId = e.ApprovalId;
        v.UpdatedAt = e.Meta.OccurredAt;
    }

    public void Apply(ApprovalGranted e, FlowView v)
    {
        v.Status = "running";
        v.GateOpen = false;
        v.OpenApprovalId = null;
        v.UpdatedAt = e.Meta.OccurredAt;
    }

    public void Apply(ApprovalDenied e, FlowView v)
    {
        v.Status = "running";   // der nächste StageEntered setzt die Stufe (Findings → zurück in code, Abb. 5)
        v.GateOpen = false;
        v.OpenApprovalId = null;
        v.UpdatedAt = e.Meta.OccurredAt;
    }
}

/// <summary>
/// Marten legt Tabellen selbst an; nur die Grafana-View ist Handarbeit. Idempotent, läuft bei jedem Start.
/// </summary>
public static class ReadModelSchema
{
    private const string FlowsView = """
        create or replace view readmodel.flows as
        select id                                  as flow_id,
               data->>'stage'                      as stage,
               data->>'status'                     as status,
               (data->>'revision')::int            as revision,
               (data->>'gateOpen')::boolean        as gate_open,
               data->>'openApprovalId'             as open_approval_id,
               (data->>'updatedAt')::timestamptz   as updated_at
        from readmodel.mt_doc_flows
        """;

    public static async Task EnsureAsync(IDocumentStore store, CancellationToken ct)
    {
        await store.Storage.ApplyAllConfiguredChangesToDatabaseAsync();
        await using var conn = store.Storage.Database.CreateConnection();
        await conn.OpenAsync(ct);
        await using var cmd = new NpgsqlCommand(FlowsView, (NpgsqlConnection)conn);
        await cmd.ExecuteNonQueryAsync(ct);
    }
}
