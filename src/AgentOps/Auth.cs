using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Claims;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;

namespace AgentOps;

/// <summary>
/// Anmeldung über Discord (OAuth2, scope identify) — nach dem Muster von Rust-Manager-Web:
/// Discord liefert die Identität, das Cockpit entscheidet über eine Allowlist, wer hineindarf.
/// Anmelden legt nie ein Konto an: unbekannte Discord-IDs bekommen keine Session, und zwar dieselbe
/// Antwort wie ein deaktiviertes Konto, damit der Endpunkt nicht verrät, wer erlaubt ist.
/// Die Session ist ein Cookie; die Read-API akzeptiert daneben weiter den Bearer-Token für Skripte.
/// </summary>
public static class Auth
{
    private const string Authorize = "https://discord.com/api/oauth2/authorize";
    private const string TokenUrl = "https://discord.com/api/oauth2/token";
    private const string MeUrl = "https://discord.com/api/v10/users/@me";
    private const string StateCookie = "agentops.oauth_state";
    public const string DisplayName = "display_name";
    public const string Avatar = "avatar";

    private static readonly JsonSerializerOptions DiscordJson = new(JsonSerializerDefaults.Web) { PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower };

    public sealed record Options(string? ClientId, string? ClientSecret, string? RedirectUri, HashSet<string> AllowedIds, string? RootId)
    {
        public bool Ready => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ClientSecret) && !string.IsNullOrWhiteSpace(RedirectUri);
        public bool Allows(string discordId) => discordId == RootId || AllowedIds.Contains(discordId);

        public static Options From(IConfiguration c)
        {
            var s = c.GetSection("Auth:Discord");
            var ids = (s["AllowedUserIds"] ?? "").Split([',', ' ', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            return new(s["ClientId"], s["ClientSecret"], s["RedirectUri"], [.. ids], s["RootUserId"]);
        }
    }

    public static void AddCockpitAuth(this WebApplicationBuilder builder)
    {
        builder.Services.AddSingleton(Options.From(builder.Configuration));
        builder.Services.AddHttpClient("discord", c => c.Timeout = TimeSpan.FromSeconds(15));
        builder.Services.AddAuthentication(CookieAuthenticationDefaults.AuthenticationScheme).AddCookie(o =>
        {
            o.Cookie.Name = "agentops.session";
            o.Cookie.HttpOnly = true;
            o.Cookie.SameSite = SameSiteMode.Lax;
            // Im Tailnet läuft das Cockpit über http — ein Secure-Cookie käme dort nie an.
            o.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
            o.ExpireTimeSpan = TimeSpan.FromDays(14);
            o.SlidingExpiration = true;
            // Eine API antwortet 401, sie leitet nicht um.
            o.Events.OnRedirectToLogin = ctx => { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return Task.CompletedTask; };
            o.Events.OnRedirectToAccessDenied = ctx => { ctx.Response.StatusCode = StatusCodes.Status403Forbidden; return Task.CompletedTask; };
        });

        // Data-Protection-Schlüssel persistent, sonst sind alle Sessions nach jedem Neustart ungültig.
        var keysDir = builder.Configuration["DataProtection:KeysDir"];
        if (!string.IsNullOrWhiteSpace(keysDir))
        {
            try
            {
                Directory.CreateDirectory(keysDir);
                builder.Services.AddDataProtection().PersistKeysToFileSystem(new DirectoryInfo(keysDir));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Ohne Verzeichnis läuft es weiter — mit Schlüsseln im Speicher (Sessions enden mit dem Prozess).
            }
        }
    }

    public static void Map(WebApplication app)
    {
        // Ob Anmelden überhaupt geht — die Login-Seite fragt das abgemeldet, deshalb nur ein Bit.
        app.MapGet("/api/auth/discord/status", (Options o) => Results.Ok(new { oauthReady = o.Ready }));

        // Schritt 1: zu Discords Einwilligung umleiten, State im Cookie.
        app.MapGet("/api/auth/discord/login", (HttpContext ctx, Options o) =>
        {
            if (!o.Ready) return Results.Problem("Discord-Anmeldung ist nicht konfiguriert.", statusCode: StatusCodes.Status503ServiceUnavailable);
            var state = Guid.NewGuid().ToString("N");
            ctx.Response.Cookies.Append(StateCookie, state, new CookieOptions
            {
                HttpOnly = true, SameSite = SameSiteMode.Lax, Secure = ctx.Request.IsHttps, MaxAge = TimeSpan.FromMinutes(10), Path = "/",
            });
            var url = $"{Authorize}?response_type=code&client_id={Uri.EscapeDataString(o.ClientId!)}"
                    + $"&redirect_uri={Uri.EscapeDataString(o.RedirectUri!)}&scope=identify&state={state}&prompt=none";
            return Results.Redirect(url);
        });

        // Schritt 2: Discord kommt mit code zurück. State prüfen, Token tauschen, Profil holen, Allowlist, Session.
        app.MapGet("/api/auth/discord/callback", async (HttpContext ctx, Options o, IHttpClientFactory httpFactory, ILogger<Options> log, string? code, string? state, CancellationToken ct) =>
        {
            if (!o.Ready) return Results.Problem("Discord-Anmeldung ist nicht konfiguriert.", statusCode: StatusCodes.Status503ServiceUnavailable);
            var expected = ctx.Request.Cookies[StateCookie];
            ctx.Response.Cookies.Delete(StateCookie);
            if (string.IsNullOrWhiteSpace(code) || string.IsNullOrWhiteSpace(state) || state != expected) return Results.Redirect("/#/login?error=state");

            var http = httpFactory.CreateClient("discord");
            using var tokenReq = new HttpRequestMessage(HttpMethod.Post, TokenUrl)
            {
                Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["client_id"] = o.ClientId!, ["client_secret"] = o.ClientSecret!, ["grant_type"] = "authorization_code",
                    ["code"] = code, ["redirect_uri"] = o.RedirectUri!,
                }),
            };
            using var tokenRes = await http.SendAsync(tokenReq, ct);
            if (!tokenRes.IsSuccessStatusCode) return Results.Redirect("/#/login?error=exchange");
            var token = await tokenRes.Content.ReadFromJsonAsync<TokenResponse>(DiscordJson, ct);
            if (token?.AccessToken is null) return Results.Redirect("/#/login?error=token");

            using var meReq = new HttpRequestMessage(HttpMethod.Get, MeUrl);
            meReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token.AccessToken);
            using var meRes = await http.SendAsync(meReq, ct);
            if (!meRes.IsSuccessStatusCode) return Results.Redirect("/#/login?error=profile");
            var user = await meRes.Content.ReadFromJsonAsync<DiscordUser>(DiscordJson, ct);
            if (user?.Id is null) return Results.Redirect("/#/login?error=profile");

            // Das Gate: nur die Allowlist. Kein Konto entsteht durch Anmelden.
            if (!o.Allows(user.Id))
            {
                log.LogWarning("Discord-Anmeldung abgewiesen: {Id} ({Name}) steht nicht auf der Allowlist", user.Id, user.Username);
                return Results.Redirect("/#/login?error=not-provisioned");
            }

            var claims = new List<Claim>
            {
                new(ClaimTypes.NameIdentifier, user.Id),
                new(ClaimTypes.Name, user.Username ?? user.Id),
                new(DisplayName, user.GlobalName ?? user.Username ?? user.Id),
            };
            if (user.Avatar is not null) claims.Add(new Claim(Avatar, user.Avatar));
            await ctx.SignInAsync(CookieAuthenticationDefaults.AuthenticationScheme,
                new ClaimsPrincipal(new ClaimsIdentity(claims, CookieAuthenticationDefaults.AuthenticationScheme)));
            log.LogInformation("Angemeldet: {Name} ({Id})", user.Username, user.Id);
            return Results.Redirect("/");
        });

        app.MapGet("/api/auth/me", (HttpContext ctx, Options o) =>
        {
            var u = ctx.User;
            if (u.Identity?.IsAuthenticated != true) return Results.Unauthorized();
            var id = u.FindFirstValue(ClaimTypes.NameIdentifier) ?? "";
            var avatar = u.FindFirstValue(Avatar);
            return Results.Ok(new
            {
                id,
                name = u.FindFirstValue(ClaimTypes.Name),
                displayName = u.FindFirstValue(DisplayName),
                avatarUrl = avatar is null ? null : $"https://cdn.discordapp.com/avatars/{id}/{avatar}.png?size=64",
                root = id == o.RootId,
            });
        });

        app.MapPost("/api/auth/logout", async (HttpContext ctx) =>
        {
            await ctx.SignOutAsync(CookieAuthenticationDefaults.AuthenticationScheme);
            return Results.NoContent();
        });
    }

    /// <summary>Konfiguration (Modelle je Agent) ändert nur Root — oder ein Skript mit Bearer-Token, das keine Session hat.</summary>
    public static bool MayConfigure(HttpContext ctx, Options o) =>
        ctx.User.Identity?.IsAuthenticated != true || (o.RootId is not null && ctx.User.FindFirstValue(ClaimTypes.NameIdentifier) == o.RootId);

    /// <summary>Der Name, unter dem eine Entscheidung im Log steht: Discord-Anzeigename der Session, sonst der übergebene.</summary>
    public static string ActorName(HttpContext ctx, string? fallback) =>
        ctx.User.Identity?.IsAuthenticated == true
            ? ctx.User.FindFirstValue(DisplayName) ?? ctx.User.FindFirstValue(ClaimTypes.Name) ?? "cockpit"
            : (string.IsNullOrWhiteSpace(fallback) ? "cockpit" : fallback.Trim());

    private sealed record TokenResponse(string? AccessToken);
    private sealed record DiscordUser(string? Id, string? Username, string? GlobalName, string? Avatar);
}
