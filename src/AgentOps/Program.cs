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

// Kommandos (§14): jedes läuft einmal durch und beendet den Prozess. Ohne Kommando startet der Dienst.
string ArgAfter(string flag, string fallback)
{
    var i = Array.IndexOf(args, flag);
    return i >= 0 && i + 1 < args.Length && !args[i + 1].StartsWith("--") ? args[i + 1] : fallback;
}

// --verify [datei]: Schritt 4 + 5 in einem — Load, Projektion, Prüfsumme, Rebuild, Prüfsumme, zweiter Load. Exit 1 bei Abweichung.
if (args.Contains("--verify"))
    return await Day1Check.VerifyAsync(store, ArgAfter("--verify", "fixtures/day1.jsonl"), app.Logger, ct) ? 0 : 1;

// --load [datei]: Fixture anhängen und einmal durch den Daemon projizieren.
if (args.Contains("--load"))
{
    await FixtureLoader.LoadAsync(store, ArgAfter("--load", "fixtures/day1.jsonl"), app.Logger, ct);
    await Day1Check.ProjectOnceAsync(store);
    app.Logger.LogInformation("Projektion {Name} ist auf Stand", FlowViewProjection.Key);
    return 0;
}

// --rebuild: Read-Model leeren, Cursor auf 0, Log neu abspielen (Abb. 4).
if (args.Contains("--rebuild"))
{
    await Day1Check.RebuildAsync(store, ct);
    app.Logger.LogInformation("Rebuild {Name} abgeschlossen", FlowViewProjection.Key);
    return 0;
}

// --check: nur die Prüfsumme des Read-Models ausgeben.
if (args.Contains("--check"))
{
    await Day1Check.PrintRowsAsync(store, app.Logger, ct);
    app.Logger.LogInformation("Prüfsumme {Checksum}", await Day1Check.ChecksumAsync(store, ct));
    return 0;
}

// Der einzige offene Endpunkt. Genau ein Bit (Blueprint §6).
app.MapGet("/health", () => Results.Text("ok"));

// Alles Weitere hinter Bearer-Token (P2). Bis dahin: 501, damit nichts versehentlich offen ist.
app.MapGet("/flows", () => Results.StatusCode(StatusCodes.Status501NotImplemented));

app.Run();
return 0;
