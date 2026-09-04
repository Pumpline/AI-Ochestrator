namespace AgentOps;

/// <summary>
/// Liest zwei Quellen und schreibt Events — sonst nichts (docs/architektur.html §10).
///
///  1. OpenClaws SQLite (~/.openclaw/state/openclaw.sqlite, Tabelle flow_runs), per Poll.
///     Für jede neue Revision genau ein Event; idempotency_key = "{flow_id}:{revision}".
///     Öffnen strikt lesend: Data Source=...;Mode=ReadOnly; plus Busy-Timeout.
///     Läuft deshalb auf demselben Host wie OpenClaw. Im Container: State-Verzeichnis als Volume,
///     NICHT :ro — WAL-Modus braucht auch zum Lesen Schreibzugriff auf die -shm-Datei.
///     Die Read-only-Garantie ist die Verbindung, nicht das Dateisystem.
///  2. Gateway per WebSocket: sessions.messages.subscribe mit includeApprovals
///     (Scope operator.approvals). Nur Beschleuniger — fällt er aus, holt der nächste Poll nach.
///
/// Zustand: nur die zuletzt gesehene Revision pro Flow, und die steht schon im Log.
/// Tag 1 läuft ohne diesen Dienst — der Projektor wird über fixtures/day1.jsonl getrieben.
/// </summary>
public sealed class ConnectorService(IConfiguration config, ILogger<ConnectorService> log) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var statePath  = config["OpenClaw:StatePath"];   // z.B. C:\Users\...\.openclaw\state\openclaw.sqlite
        var gatewayUrl = config["OpenClaw:GatewayUrl"];  // z.B. ws://127.0.0.1:18789
        var pollEvery  = TimeSpan.FromSeconds(config.GetValue("OpenClaw:PollSeconds", 5));

        if (string.IsNullOrWhiteSpace(statePath))
        {
            log.LogInformation("Connector inaktiv: OpenClaw:StatePath nicht gesetzt (Tag 1: erwartet)");
            return;
        }

        log.LogInformation("Connector: poll {Path} alle {Every}s, Gateway {Gateway}",
            statePath, pollEvery.TotalSeconds, gatewayUrl ?? "(keins)");

        using var timer = new PeriodicTimer(pollEvery);
        while (await timer.WaitForNextTickAsync(ct))
        {
            // TODO Tag 2: flow_runs lesen (revision > zuletzt gesehen) -> StageEntered / Halted / GatePending
            // TODO Tag 2: WebSocket-Approvals -> ApprovalGranted / ApprovalDenied
        }
    }
}
