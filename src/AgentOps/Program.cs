using AgentOps;

var builder = WebApplication.CreateBuilder(args);

// Schritt 3 (§14): builder.Services.AddMarten(...) — Event-Store, FlowView-Projektion,
// Async-Daemon im HotCold-Modus. Der Daemon ersetzt dann ProjectorService.
builder.Services.AddHostedService<ConnectorService>();
builder.Services.AddHostedService<ProjectorService>();

var app = builder.Build();

// --rebuild: Read-Models leeren, Cursor auf 0, Log neu abspielen (Abb. 4).
// Mit Marten: daemon.RebuildProjectionAsync<FlowView>(ct). Danach beenden, nicht weiterlaufen.
if (args.Contains("--rebuild"))
{
    app.Logger.LogWarning("--rebuild: noch nicht verdrahtet (Schritt 3)");
    return;
}

// Der einzige offene Endpunkt. Genau ein Bit (Blueprint §6).
app.MapGet("/health", () => Results.Text("ok"));

// Alles Weitere hinter Bearer-Token (P2). Bis dahin: 501, damit nichts versehentlich offen ist.
app.MapGet("/flows", () => Results.StatusCode(StatusCodes.Status501NotImplemented));

app.Run();
