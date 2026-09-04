namespace AgentOps.Events;

/// <summary>
/// Metadaten, die jedes Event trägt (docs/architektur.html §9). Correlation = FlowId, steht im Event selbst
/// und zusätzlich in Martens Session-Metadaten; recorded_at ist Martens eigener timestamp.
/// </summary>
public sealed record EventMeta(
    string ActorType,            // human | agent | automation
    string ActorId,              // Pseudonym — nie ein Klarname (§9, Betriebsregel 2)
    string? CausationId,         // IdempotencyKey des auslösenden Events
    string IdempotencyKey,       // "a1:4" (flow_id:revision) oder "apr-a1-1:granted"
    DateTimeOffset OccurredAt,   // Domänenzeit
    int SchemaVersion = 1);

// Der Katalog für Tag 1 (§9). Streams: task:{flowId} für die ersten beiden, approval:{flowId} für die übrigen.

public sealed record StageEntered(string FlowId, string Stage, string? Previous, int Revision, EventMeta Meta);

public sealed record Halted(string FlowId, string Status, int Revision, string? Reason, EventMeta Meta);

public sealed record GatePending(string FlowId, string ApprovalId, string Stage, EventMeta Meta);

public sealed record ApprovalGranted(string FlowId, string ApprovalId, string? ActorRef, EventMeta Meta);

public sealed record ApprovalDenied(string FlowId, string ApprovalId, string? ActorRef, string? Reason, EventMeta Meta);

public static class Streams
{
    public static string Task(string flowId) => $"task:{flowId}";
    public static string Approval(string flowId) => $"approval:{flowId}";
}
