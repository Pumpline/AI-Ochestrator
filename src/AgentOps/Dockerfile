# Build-Kontext ist das Repo-Root (siehe compose.yaml), damit später weitere Projekte dazukommen können.
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY src/AgentOps/AgentOps.csproj AgentOps/
RUN dotnet restore AgentOps/AgentOps.csproj
COPY src/AgentOps/ AgentOps/
RUN dotnet publish AgentOps/AgentOps.csproj -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
# git für die Soul-Commits des Cockpits (der einzige Schreibweg in ein Repo ist ein Commit, §12)
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app .
ENV ASPNETCORE_URLS=http://0.0.0.0:8080 \
    DOTNET_EnableDiagnostics=0
# Nicht-Root. compose.yaml überschreibt die UID auf die des OpenClaw-State-Verzeichnisses.
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet", "AgentOps.dll"]
