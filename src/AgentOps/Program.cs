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
builder.Services.AddHttpClient<PluginClient>(c => c.Timeout = TimeSpan.FromSeconds(60));
builder.Services.AddHttpClient<CostsClient>(c => c.Timeout = TimeSpan.FromSeconds(10));

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

// --poll-once [state.sqlite]: ein Connector-Durchlauf gegen eine State-Datei, dann beenden (Tests, Nachholen).
if (args.Contains("--poll-once"))
{
    var path = ArgAfter("--poll-once", builder.Configuration["OpenClaw:StatePath"] ?? "");
    if (string.IsNullOrWhiteSpace(path)) throw new InvalidOperationException("--poll-once braucht einen Pfad oder OpenClaw:StatePath");
    var n = await OpenClawConnector.PollOnceAsync(store, path, app.Logger, ct);
    await Day1Check.ProjectOnceAsync(store);
    app.Logger.LogInformation("Poll: {Count} Event(s) angehängt, Projektion auf Stand", n);
    return 0;
}

// --check: nur die Prüfsumme des Read-Models ausgeben.
if (args.Contains("--check"))
{
    await Day1Check.PrintRowsAsync(store, app.Logger, ct);
    app.Logger.LogInformation("Prüfsumme {Checksum}", await Day1Check.ChecksumAsync(store, ct));
    return 0;
}

// /health offen (genau ein Bit, Blueprint §6), /api/* hinter Bearer-Token (P2). Siehe Api.cs.
Api.Map(app);

// Das Cockpit-Frontend: statische Dateien aus wwwroot, alles andere fällt auf index.html zurück.
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");

app.Run();
return 0;
