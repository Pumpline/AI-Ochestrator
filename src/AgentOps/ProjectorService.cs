namespace AgentOps;

/// <summary>
/// Platzhalter. Mit Marten (Schritt 3) übernimmt der Async-Daemon diese Rolle:
///   opts.Projections.Add&lt;FlowViewProjection&gt;(ProjectionLifecycle.Async);
///   services.AddMarten(opts).AddAsyncDaemon(DaemonMode.HotCold);
/// HotCold = genau ein Knoten projiziert, per Advisory Lock — der Single-Writer aus Abb. 4.
/// Diese Klasse dann löschen.
/// </summary>
public sealed class ProjectorService(ILogger<ProjectorService> log) : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken ct)
    {
        log.LogInformation("Projector: Platzhalter, wird durch Martens Async-Daemon ersetzt");
        return Task.CompletedTask;
    }
}
