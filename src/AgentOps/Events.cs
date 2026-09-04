namespace AgentOps.Events;

/// <summary>
/// Metadaten, die jedes Event trägt (docs/architektur.html §9). Correlation = FlowId, steht im Event selbst
/// und zusätzlich in Martens Session-Metadaten; recorded_at ist Martens eigener timestamp.
/// </summary>
public sealed record EventMeta(
    string ActorType,            // human | agent | automation
    string ActorId,              // Pseudonym — nie ein Klarname (§9, Betriebsregel 2)
    string? CausationId,         // IdempotencyKey des auslösenden Events
    string IdempotencyKey,       // "a1:4:stage" (flow_id:revision:art) oder "apr-a1-1:granted"
    DateTimeOffset OccurredAt,   // Domänenzeit
    int SchemaVersion = 1);

// Der Katalog (§9). Streams: task:{flowId} für Flow-Ereignisse, approval:{flowId} für Freigaben.

public sealed record StageEntered(string FlowId, string Stage, string? Previous, int Revision, EventMeta Meta);

/// <summary>status ∈ failed | lost | blocked | cancelled (OpenClaw-Flow-Status, §11).</summary>
public sealed record Halted(string FlowId, string Status, int Revision, string? Reason, EventMeta Meta);

/// <summary>Der Flow ist regulär zu Ende (OpenClaw-Status succeeded). Sechster Typ, seit dem Connector.</summary>
public sealed record FlowCompleted(string FlowId, int Revision, EventMeta Meta);

/// <summary>ApprovalId ist null, wenn OpenClaw das Warten nicht an eine operator_approval bindet.</summary>
public sealed record GatePending(string FlowId, string? ApprovalId, string Stage, EventMeta Meta);

public sealed record ApprovalGranted(string FlowId, string ApprovalId, string? ActorRef, EventMeta Meta);

public sealed record ApprovalDenied(string FlowId, string ApprovalId, string? ActorRef, string? Reason, EventMeta Meta);

public static class Streams
{
    public static string Task(string flowId) => $"task:{flowId}";
    public static string Approval(string flowId) => $"approval:{flowId}";
}
