using AgentOps;
using AgentOps.ReadModel;
using JasperFx;
using JasperFx.Core;
using JasperFx.Events;
using JasperFx.Events.Daemon;
using JasperFx.Events.Projections;
using Marten;
using Weasel.Core;

// Kommandozeile parsen wir selbst — der Host würde "--rebuild" sonst als Konfigurationsschalter lesen.
var builder = WebApplication.CreateBuilder(Array.Empty<string>());

var connectionString = builder.Configuration.GetConnectionString("AgentOps");
if (string.IsNullOrWhiteSpace(connectionString))
    throw new InvalidOperationException("ConnectionStrings:AgentOps fehlt — dotnet user-secrets (lokal) oder Env ConnectionStrings__AgentOps (Container).");

builder.Services.AddMarten(opts =>
{
    opts.Connection(connectionString);
    opts.DatabaseSchemaName = "agentops";                                  // Event-Log (mt_events) und Marten-Interna
    opts.UseSystemTextJsonForSerialization(EnumStorage.AsString, Casing.CamelCase);
    opts.Events.StreamIdentity = StreamIdentity.AsString;                  // "task:a1", "approval:a1"
    opts.Events.MetadataConfig.CorrelationIdEnabled = true;
    opts.Events.MetadataConfig.CausationIdEnabled = true;
    opts.Projections.Add<FlowViewProjection>(ProjectionLifecycle.Async);
    opts.Schema.For<FlowView>().DatabaseSchemaName("readmodel").DocumentAlias("flows");   // readmodel.mt_doc_flows
    opts.AutoCreateSchemaObjects = AutoCreate.CreateOrUpdate;
})
.UseLightweightSessions()
.AddAsyncDaemon(DaemonMode.HotCold);   // genau ein Knoten projiziert, Advisory Lock — der Single-Writer aus Abb. 4

builder.Services.AddHostedService<ConnectorService>();

var app = builder.Build();
var store = app.Services.GetRequiredService<IDocumentStore>();
var ct = app.Lifetime.ApplicationStopping;

await ReadModelSchema.EnsureAsync(store, ct);

// --load [datei]: Fixture anhängen und einmal durch den Daemon projizieren, dann beenden.
if (args.Contains("--load"))
{
    var i = Array.IndexOf(args, "--load");
    var path = i + 1 < args.Length && !args[i + 1].StartsWith("--") ? args[i + 1] : "fixtures/day1.jsonl";
    await FixtureLoader.LoadAsync(store, path, app.Logger, ct);

    using var daemon = await store.BuildProjectionDaemonAsync();
    await daemon.StartAllAsync();
    await daemon.WaitForNonStaleData(TimeSpan.FromSeconds(30));
    await daemon.StopAllAsync();
    app.Logger.LogInformation("Projektion {Name} ist auf Stand", FlowViewProjection.Key);
    return;
}

// --rebuild: Read-Model leeren, Cursor auf 0, Log neu abspielen (Abb. 4). Danach beenden.
if (args.Contains("--rebuild"))
{
    using var daemon = await store.BuildProjectionDaemonAsync();
    await daemon.RebuildProjectionAsync(FlowViewProjection.Key, ct);
    app.Logger.LogInformation("Rebuild {Name} abgeschlossen", FlowViewProjection.Key);
    return;
}

// Der einzige offene Endpunkt. Genau ein Bit (Blueprint §6).
app.MapGet("/health", () => Results.Text("ok"));

// Alles Weitere hinter Bearer-Token (P2). Bis dahin: 501, damit nichts versehentlich offen ist.
app.MapGet("/flows", () => Results.StatusCode(StatusCodes.Status501NotImplemented));

app.Run();
