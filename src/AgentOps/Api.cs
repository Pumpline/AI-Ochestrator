using System.Security.Cryptography;
using System.Text;
using AgentOps.ReadModel;
using Marten;

namespace AgentOps;

/// <summary>
/// Die Read-API (P2). Nur lesen — es gibt keinen Endpunkt, der etwas verändert (§12).
/// /health ist offen und sagt genau ein Bit. Alles unter /api verlangt "Authorization: Bearer &lt;Api:Token&gt;";
/// ist kein Token konfiguriert, antwortet /api mit 503 statt offen zu sein.
/// </summary>
public static class Api
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/health", () => Results.Text("ok"));

        var api = app.MapGroup("/api").AddEndpointFilter(RequireBearer);

        // Alle Flows, optional nach Status gefiltert (?status=waiting)
        api.MapGet("/flows", async (IQuerySession s, string? status, CancellationToken ct) =>
        {
            IQueryable<FlowView> q = s.Query<FlowView>();
            if (!string.IsNullOrWhiteSpace(status)) q = q.Where(f => f.Status == status);
            return Results.Ok(await q.OrderByDescending(f => f.UpdatedAt).ToListAsync(ct));
        });

        api.MapGet("/flows/{id}", async (IQuerySession s, string id, CancellationToken ct) =>
            await s.LoadAsync<FlowView>(id, ct) is { } f ? Results.Ok(f) : Results.NotFound());

        // Die Zeitleiste eines Flows aus dem Log — "warum ist Flow Y stehen geblieben?"
        api.MapGet("/flows/{id}/events", async (IQuerySession s, string id, CancellationToken ct) =>
        {
            var events = await s.Events.QueryAllRawEvents()
                .Where(e => e.CorrelationId == id)
                .OrderBy(e => e.Sequence)
                .ToListAsync(ct);
            return Results.Ok(events.Select(e => new
            {
                e.Sequence,
                Stream = e.StreamKey,
                e.Version,
                Type = e.EventTypeName,
                RecordedAt = e.Timestamp,
                e.CausationId,
                e.Data
            }));
        });

        // "Welche Flows warten gerade auf mich?"
        api.MapGet("/gates", async (IQuerySession s, CancellationToken ct) =>
            Results.Ok(await s.Query<FlowView>().Where(f => f.GateOpen).OrderBy(f => f.UpdatedAt).ToListAsync(ct)));

        // Cockpit: Projekte, Souls, Pipeline-Relais, Kosten (Cockpit.cs)
        Cockpit.Map(api, app.Configuration);
    }

    private static async ValueTask<object?> RequireBearer(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var expected = ctx.HttpContext.RequestServices.GetRequiredService<IConfiguration>()["Api:Token"];
        if (string.IsNullOrEmpty(expected))
            return Results.Problem("API ist aus: Api:Token nicht gesetzt.", statusCode: StatusCodes.Status503ServiceUnavailable);

        var header = ctx.HttpContext.Request.Headers.Authorization.ToString();
        if (!header.StartsWith("Bearer ", StringComparison.Ordinal)) return Results.Unauthorized();

        var given = Encoding.UTF8.GetBytes(header["Bearer ".Length..].Trim());
        var want = Encoding.UTF8.GetBytes(expected);
        if (given.Length != want.Length || !CryptographicOperations.FixedTimeEquals(given, want)) return Results.Unauthorized();

        return await next(ctx);
    }
}
