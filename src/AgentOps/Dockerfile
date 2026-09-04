# Build-Kontext ist das Repo-Root (siehe compose.yaml), damit später weitere Projekte dazukommen können.
FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/AgentOps/AgentOps.csproj AgentOps/
RUN dotnet restore AgentOps/AgentOps.csproj
COPY src/AgentOps/ AgentOps/
RUN dotnet publish AgentOps/AgentOps.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_EnableDiagnostics=0
# Nicht-Root. compose.yaml überschreibt die UID auf die des OpenClaw-State-Verzeichnisses.
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet", "AgentOps.dll"]
