using AgentOps.Events;
using AgentOps.OpenClaw;
using Marten;

namespace AgentOps;

/// <summary>
/// Cursor pro Flow: was der Connector zuletzt gesehen hat. Liegt als Marten-Dokument im Schema agentops und wird
/// in derselben Transaktion wie die Events geschrieben — deshalb schreibt ein Neustart nichts doppelt.
/// Wegwerfbar: aus dem Log rekonstruierbar (letztes Event je Flow), nur nicht automatisch.
/// </summary>
public sealed class FlowCursor
{
    public string Id { get; set; } = default!;   // FlowId
    public int Revision { get; set; }
    public string? Step { get; set; }
    public string Status { get; set; } = "";
    public string? LastKey { get; set; }         // IdempotencyKey des letzten Events → CausationId des nächsten
    public string? GateApprovalId { get; set; }  // offenes Plugin-Gate (waitJson.kind = "gate"), bis entschieden
}

public sealed class ApprovalCursor
{
    public string Id { get; set; } = default!;   // ApprovalId
    public string Status { get; set; } = "";
    public string? Decision { get; set; }
    public string? FlowId { get; set; }
    public string? LastKey { get; set; }
}

/// <summary>
/// Liest OpenClaws State-Datei und schreibt Events — sonst nichts (§10). Ein Poll = ein Durchlauf über
/// flow_runs und operator_approvals; pro Flow eine Session, damit Correlation/Causation stimmen.
/// Der WebSocket als Beschleuniger für Freigaben ist bewusst noch nicht drin: die Datei hält auch die Approvals.
/// </summary>
public static class OpenClawConnector
{
    private static readonly HashSet<string> HaltedStatuses = ["failed", "lost", "blocked", "cancelled"];

    public static async Task<int> PollOnceAsync(IDocumentStore store, string statePath, ILogger log, CancellationToken ct)
    {
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        await using var conn = OpenClawState.Open(statePath);
        await conn.OpenAsync(ct);
        var flows = await OpenClawState.ReadFlowsAsync(conn, nowMs, ct);
        var approvals = await OpenClawState.ReadApprovalsAsync(conn, nowMs, ct);
        await conn.CloseAsync();

        // In der Reihenfolge, in der es in OpenClaw passiert ist — nicht Flows zuerst, dann Approvals.
        // Innerhalb eines Poll-Intervalls kann beides liegen; bei gleicher Zeit zuerst die Freigabe,
        // weil der nächste Schritt eines Flows die Folge der Entscheidung ist, nicht umgekehrt.
        // Lauf → Flow: für Flows der Pipeline steht die Zuordnung im Flow selbst (stateJson.runs[step] = runId),
        // weil OpenClaws eigene Kind-Task-Verknüpfung bei Schritt-Agenten mit eigenem Owner nicht greift.
        var runToFlow = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var f in flows)
            foreach (var runId in ReadRunIds(f.StateJson))
                runToFlow.TryAdd(runId, f.FlowId);

        var work = new List<(long ts, int order, Func<Task<int>> run)>();
        foreach (var a0 in approvals)
        {
            var a = a0.FlowId is null && a0.SourceRunId is { } rid && runToFlow.TryGetValue(rid, out var viaState) ? a0 with { FlowId = viaState } : a0;
            work.Add((a.ResolvedAtMs ?? a.UpdatedAtMs ?? a.CreatedAtMs ?? 0, 0, () => ProjectApprovalAsync(store, a, log, ct)));
        }
        foreach (var f in flows)
            work.Add((f.UpdatedAt ?? f.CreatedAt ?? 0, 1, () => ProjectFlowAsync(store, f, log, ct)));

        var emitted = 0;
        foreach (var (_, _, run) in work.OrderBy(w => w.ts).ThenBy(w => w.order))
            emitted += await run();
        return emitted;
    }

    private static async Task<int> ProjectFlowAsync(IDocumentStore store, OpenClawState.FlowRow f, ILogger log, CancellationToken ct)
    {
        await using var s = store.LightweightSession();
        var cursor = await s.LoadAsync<FlowCursor>(f.FlowId, ct) ?? new FlowCursor { Id = f.FlowId };
        if (f.Revision <= cursor.Revision) return 0;

        var at = DateTimeOffset.FromUnixTimeMilliseconds(f.UpdatedAt ?? f.CreatedAt ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        var stream = Streams.Task(f.FlowId);
        var n = 0;
        // Martens Causation ist sessionweit: die Ursache des ganzen Batches ist das, was vor ihm kam.
        // Die Ursache je Event steht im Payload (Meta.CausationId).
        s.CausationId = cursor.LastKey;

        // 1) Ein geschlossenes Plugin-Gate zuerst — die Entscheidung geht dem nächsten Schritt voraus.
        //    Plugin-Gate (agentops-pipeline): waiting mit waitJson.kind = "gate" öffnet es,
        //    das Verlassen von waiting mit stateJson.gate.decision schließt es — mit dem Freigebenden aus gate.by.
        var gateStream = Streams.Approval(f.FlowId);
        if (cursor.GateApprovalId is { } openGate && f.Status != "waiting")
        {
            var (decision, by) = ReadGateDecision(f.StateJson);
            var actor = string.IsNullOrWhiteSpace(by) ? "operator" : by;
            if (decision == "allow")
            {
                var key = $"{openGate}:granted";
                s.Events.Append(gateStream, new ApprovalGranted(f.FlowId, openGate, actor, Meta(cursor.LastKey, key, at, "human", actor)));
                cursor.LastKey = key;
                n++;
            }
            else
            {
                var key = $"{openGate}:denied";
                s.Events.Append(gateStream, new ApprovalDenied(f.FlowId, openGate, actor, decision is null ? f.Status : "gate denied",
                    Meta(cursor.LastKey, key, at, "human", actor)));
                cursor.LastKey = key;
                n++;
            }
            cursor.GateApprovalId = null;
        }

        // 2) Schrittwechsel
        if (!string.IsNullOrEmpty(f.CurrentStep) && f.CurrentStep != cursor.Step)
        {
            var key = $"{f.FlowId}:{f.Revision}:stage";
            s.Events.Append(stream, new StageEntered(f.FlowId, f.CurrentStep, cursor.Step, f.Revision,
                Meta(cursor.LastKey, key, at)));
            cursor.Step = f.CurrentStep;
            cursor.LastKey = key;
            n++;
        }

        // 3) Ein neu geöffnetes Plugin-Gate — nach dem Schritt "gate", der es ankündigt
        if (f.Status == "waiting" && cursor.Status != "waiting" && cursor.GateApprovalId is null
            && TryReadGate(f.WaitJson, out var gateStep))
        {
            var approvalId = $"gate:{f.FlowId}:{gateStep}";
            var key = $"{approvalId}:pending";
            s.Events.Append(gateStream, new GatePending(f.FlowId, approvalId, gateStep, Meta(cursor.LastKey, key, at)));
            cursor.GateApprovalId = approvalId;
            cursor.LastKey = key;
            n++;
        }

        // 4) Statuswechsel, soweit der Katalog ihn kennt
        if (f.Status != cursor.Status)
        {
            if (HaltedStatuses.Contains(f.Status))
            {
                var key = $"{f.FlowId}:{f.Revision}:halted";
                s.Events.Append(stream, new Halted(f.FlowId, f.Status, f.Revision, f.BlockedSummary, Meta(cursor.LastKey, key, at)));
                cursor.LastKey = key;
                n++;
            }
            else if (f.Status == "succeeded")
            {
                var key = $"{f.FlowId}:{f.Revision}:completed";
                s.Events.Append(stream, new FlowCompleted(f.FlowId, f.Revision, Meta(cursor.LastKey, key, at)));
                cursor.LastKey = key;
                n++;
            }
            // queued | running | waiting: kein eigenes Event — waiting wird über operator_approvals sichtbar
            cursor.Status = f.Status;
        }

        cursor.Revision = f.Revision;
        s.CorrelationId = f.FlowId;
        s.Store(cursor);
        await s.SaveChangesAsync(ct);
        if (n > 0) log.LogInformation("Flow {FlowId} rev {Revision}: {Count} Event(s), Schritt {Step}, Status {Status}", f.FlowId, f.Revision, n, f.CurrentStep, f.Status);
        return n;
    }

    private static async Task<int> ProjectApprovalAsync(IDocumentStore store, OpenClawState.ApprovalRow a, ILogger log, CancellationToken ct)
    {
        await using var s = store.LightweightSession();
        var cursor = await s.LoadAsync<ApprovalCursor>(a.ApprovalId, ct) ?? new ApprovalCursor { Id = a.ApprovalId, FlowId = a.FlowId };
        if (a.Status == cursor.Status && a.Decision == cursor.Decision) return 0;

        var flowId = a.FlowId ?? cursor.FlowId;
        if (flowId is null)
        {
            log.LogWarning("Approval {ApprovalId} ({Kind}) gehört zu keinem Flow (source_run_id ohne task_runs.parent_flow_id) — übersprungen", a.ApprovalId, a.Kind);
            return 0;
        }

        var stream = Streams.Approval(flowId);
        var flowCursor = await s.LoadAsync<FlowCursor>(flowId, ct);
        var stage = flowCursor?.Step ?? "";
        var n = 0;
        s.CausationId = cursor.LastKey ?? flowCursor?.LastKey;

        // OpenClaw 2026.9.1, operator_approvals.status ∈ pending | allowed | denied | expired | cancelled;
        // decision ∈ allow-once | allow-always | deny; resolver_kind ∈ device | channel | runtime | system.
        // Wer entschieden hat: resolver_id (Geräte-/Kanal-ID, pseudonym) — kein Klarname im Log (§9).
        var actorType = a.ResolverKind is "device" or "channel" ? "human" : "automation";
        var actorId = a.ResolverId ?? a.ResolverKind ?? "openclaw";
        switch (a.Status)
        {
            case "pending":
            {
                var key = $"{a.ApprovalId}:pending";
                if (cursor.LastKey != key)
                {
                    s.Events.Append(stream, new GatePending(flowId, a.ApprovalId, stage,
                        Meta(flowCursor?.LastKey, key, Ms(a.CreatedAtMs))));
                    cursor.LastKey = key;
                    n++;
                }
                break;
            }
            case "allowed":
            {
                var key = $"{a.ApprovalId}:granted";
                s.Events.Append(stream, new ApprovalGranted(flowId, a.ApprovalId, a.ResolverId,
                    Meta(cursor.LastKey, key, Ms(a.ResolvedAtMs ?? a.UpdatedAtMs), actorType, actorId)));
                cursor.LastKey = key;
                n++;
                break;
            }
            case "denied" or "expired" or "cancelled":
            {
                var key = $"{a.ApprovalId}:denied";
                s.Events.Append(stream, new ApprovalDenied(flowId, a.ApprovalId, a.ResolverId,
                    a.Status == "denied" ? (a.TerminalReason ?? "user") : a.Status,
                    Meta(cursor.LastKey, key, Ms(a.ResolvedAtMs ?? a.UpdatedAtMs), actorType, actorId)));
                cursor.LastKey = key;
                n++;
                break;
            }
            default:
                log.LogWarning("Approval {ApprovalId}: unbekannter Status '{Status}' — kein Event", a.ApprovalId, a.Status);
                break;
        }

        cursor.Status = a.Status;
        cursor.Decision = a.Decision;
        cursor.FlowId = flowId;
        s.CorrelationId = flowId;
        s.Store(cursor);
        await s.SaveChangesAsync(ct);
        if (n > 0) log.LogInformation("Approval {ApprovalId} für Flow {FlowId}: {Status}/{Decision}", a.ApprovalId, flowId, a.Status, a.Decision);
        return n;
    }

    private static EventMeta Meta(string? causation, string key, DateTimeOffset at, string actorType = "automation", string actorId = "openclaw") =>
        new(actorType, actorId, causation, key, at);

    /// <summary>waitJson = {"kind":"gate","step":"ship",…} → true und der Schritt hinter dem Gate.</summary>
    private static bool TryReadGate(string? waitJson, out string step)
    {
        step = "";
        if (string.IsNullOrWhiteSpace(waitJson)) return false;
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(waitJson);
            var r = doc.RootElement;
            if (r.ValueKind != System.Text.Json.JsonValueKind.Object) return false;
            if (!r.TryGetProperty("kind", out var kind) || kind.GetString() != "gate") return false;
            step = r.TryGetProperty("step", out var st) && st.ValueKind == System.Text.Json.JsonValueKind.String ? st.GetString()! : "";
            return true;
        }
        catch (System.Text.Json.JsonException) { return false; }
    }

    /// <summary>stateJson.runs = {"plan":"<runId>", …} — die Läufe eines Pipeline-Flows.</summary>
    private static IEnumerable<string> ReadRunIds(string? stateJson)
    {
        if (string.IsNullOrWhiteSpace(stateJson)) yield break;
        System.Text.Json.JsonDocument doc;
        try { doc = System.Text.Json.JsonDocument.Parse(stateJson); }
        catch (System.Text.Json.JsonException) { yield break; }
        using (doc)
        {
            if (doc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("runs", out var runs)
                || runs.ValueKind != System.Text.Json.JsonValueKind.Object) yield break;
            foreach (var p in runs.EnumerateObject())
                if (p.Value.ValueKind == System.Text.Json.JsonValueKind.String && p.Value.GetString() is { Length: > 0 } id)
                    yield return id;
        }
    }

    /// <summary>stateJson.gate = {"decision":"allow"|"deny","by":"…"} nach der Entscheidung.</summary>
    private static (string? decision, string? by) ReadGateDecision(string? stateJson)
    {
        if (string.IsNullOrWhiteSpace(stateJson)) return (null, null);
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(stateJson);
            if (doc.RootElement.ValueKind != System.Text.Json.JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("gate", out var gate)
                || gate.ValueKind != System.Text.Json.JsonValueKind.Object) return (null, null);
            var decision = gate.TryGetProperty("decision", out var d) && d.ValueKind == System.Text.Json.JsonValueKind.String ? d.GetString() : null;
            var by = gate.TryGetProperty("by", out var b) && b.ValueKind == System.Text.Json.JsonValueKind.String ? b.GetString() : null;
            return (decision, by);
        }
        catch (System.Text.Json.JsonException) { return (null, null); }
    }

    private static DateTimeOffset Ms(long? ms) =>
        ms is { } v ? DateTimeOffset.FromUnixTimeMilliseconds(v) : DateTimeOffset.UtcNow;
}

/// <summary>Der Poll-Loop im Betrieb. Tag 1 lief ohne ihn; mit leerem OpenClaw:StatePath bleibt er inaktiv.</summary>
public sealed class ConnectorService(IDocumentStore store, IConfiguration config, ILogger<ConnectorService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var statePath = config["OpenClaw:StatePath"];
        var every = TimeSpan.FromSeconds(config.GetValue("OpenClaw:PollSeconds", 5));

        if (string.IsNullOrWhiteSpace(statePath))
        {
            log.LogInformation("Connector inaktiv: OpenClaw:StatePath nicht gesetzt");
            return;
        }
        log.LogInformation("Connector: poll {Path} alle {Every}s", statePath, every.TotalSeconds);

        var warnedMissing = false;
        using var timer = new PeriodicTimer(every);
        do
        {
            try
            {
                if (!File.Exists(statePath))
                {
                    if (!warnedMissing) { log.LogWarning("State-Datei {Path} noch nicht da — warte", statePath); warnedMissing = true; }
                    continue;
                }
                warnedMissing = false;
                await OpenClawConnector.PollOnceAsync(store, statePath, log, ct);
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Poll fehlgeschlagen — nächster Versuch in {Every}s", every.TotalSeconds);
            }
        } while (await timer.WaitForNextTickAsync(ct));
    }
}
