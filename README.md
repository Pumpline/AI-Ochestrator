# AI-Ochestrator — Agent-Ops Kontrollebene

Read-only-Cockpit über einem Agenten-Orchestrator: ein append-only Event-Log für das,
was sich nicht rekonstruieren lässt (Schritte, Gates, Freigaben), Prometheus für alles
Ableitbare (Tokens, Kosten), Grafana als eine Scheibe Glas.

**Das Dokument ist die Wahrheit:** [docs/architektur.html](docs/architektur.html).
Diese README ist nur der Einstieg.

## Struktur

```
compose.yaml                 Postgres, OTel Collector, Prometheus, Grafana (§14 Schritt 2)
infra/postgres/init/         Rollen agentops (Owner) und grafana_ro (SELECT auf readmodel)
infra/otel/collector.yaml    OTLP/HTTP :4318 rein, Prometheus :8889 raus
infra/prometheus/            scrapt den Collector
infra/grafana/provisioning/  Datasources: Prometheus + Postgres (grafana_ro)
fixtures/day1.jsonl          21 Events, 3 Flows — treibt den Projektor an Tag 1 (§14 Schritt 4)
src/AgentOps/                ein Worker-Host: Connector, Projektor, Read-API (§14 Schritt 1)
docs/architektur.html        Architektur, Mechanik, Bauplan
```

## Start (lokal)

```bash
cp .env.example .env        # Passwörter setzen
docker compose -f compose.yaml -f compose.dev.yaml up -d
```

| Dienst | Adresse | Zweck |
|---|---|---|
| Postgres | 127.0.0.1:5432 (nur mit compose.dev.yaml) | DB `agentops`, Rollen `agentops` / `grafana_ro` |
| OTel Collector | 127.0.0.1:4318 | Ziel für OpenClaws `diagnostics-otel` (OTLP/HTTP) |
| Prometheus | 127.0.0.1:9090 | Metriken; `openclaw.cost.usd` heißt hier `openclaw_cost_usd` |
| Grafana | 127.0.0.1:3000 | admin / `GRAFANA_ADMIN_PASSWORD`, Datasources vorprovisioniert |

Rollen werden beim **ersten** Start angelegt — Passwörter später ändern heißt
`docker compose down -v` oder von Hand in psql.

## Tag 1 (§14)

Schritt 3 ist umgesetzt: **Marten 9.31.2 auf net10.0** (7.x und 8.x bis 8.36 tragen CVE-2026-45288,
SQL-Injection in der Volltextsuche — deshalb nicht darunter). SDK 10 nötig.

| Datei | Inhalt |
|---|---|
| `Events.cs` | die fünf Event-Typen aus §9 als `record`s plus `EventMeta` |
| `ReadModel.cs` | `FlowView` + `FlowViewProjection` (multi-stream, async) + View `readmodel.flows` |
| `FixtureLoader.cs` | `--load`: JSONL → Events, idempotent pro Stream |
| `Program.cs` | `AddMarten` (Schema `agentops`, String-Stream-IDs, Correlation/Causation), Daemon `HotCold`, `--load`, `--rebuild` |

Wo was liegt: Log `agentops.mt_events`, Read-Model `readmodel.mt_doc_flows` (Marten-Dokument),
für Grafana und die Prüfsumme die View `readmodel.flows`. Beides legt die App beim Start an.

```bash
dotnet user-secrets --project src/AgentOps set "ConnectionStrings:AgentOps" "Host=127.0.0.1;Database=agentops;Username=agentops;Password=..."
dotnet run --project src/AgentOps -- --load fixtures/day1.jsonl   # anhängen + einmal projizieren
dotnet run --project src/AgentOps -- --rebuild                     # Read-Model leeren, Log neu abspielen
```

Erwartetes Read-Model nach dem Fixture:

| flow_id | stage | status | gate_open | revision |
|---|---|---|---|---|
| a1 | ship | running | false | 10 |
| b2 | review | waiting | true | 4 |
| c3 | test | failed | false | 4 |

Prüfsumme ziehen, `--rebuild`, Prüfsumme erneut ziehen:

```sql
select md5(string_agg(f::text, '|' order by f.flow_id)) from readmodel.flows f;
```

Tag 1 ist fertig, wenn beide Werte gleich sind. Stand 2026-09-04 auf srv1 gegen `agentops_dev`:
identisch (`49a4ac52…`), 21 Events in 5 Streams, zweiter `--load` hängt nichts an.

Auf dem Server dasselbe im Container, gegen eine Wegwerf-Datenbank statt des echten Logs:

```bash
AGENTOPS_DB=agentops_dev docker compose --profile app run --rm --no-deps agentops --load fixtures/day1.jsonl
AGENTOPS_DB=agentops_dev docker compose --profile app run --rm --no-deps agentops --rebuild
```

(`agentops_dev` einmal anlegen: `docker exec agentops-postgres psql -U postgres -c "create database agentops_dev owner agentops"`.
In Skripten `</dev/null` anhängen — `compose run` liest sonst das restliche Skript als Stdin des Containers.)

## Server: srv1

Debian 13, 4 vCPU, 31 GB RAM, Docker 29 / Compose v5, erreichbar nur über Tailscale
(`<Tailscale-IP>`). `admin` ist in der docker-Gruppe, sudo braucht ein Passwort. Stand 2026-09-04
laufen dort schon: Pterodactyl mit Game-Containern (öffentliche IP), n8n, fahrschule (.NET),
`postgres-bots` (pg17+pgvector), netdata, host-nginx mit TLS. **Kein OpenClaw, kein Grafana, kein Prometheus.**

Was daraus für diesen Stack folgt:

| Entscheidung | Warum |
|---|---|
| Eigener Postgres-Container, **kein Host-Port** | 5432 ist dort von `postgres-bots` belegt — und der hört auf `0.0.0.0`. Der Entscheidungs-Log gehört nicht in eine öffentlich gebundene Instanz. |
| `postgres:17` | wie `postgres-bots`, damit deren Backup-Werkzeuge passen |
| Grafana auf `BIND_ADDR=<Tailscale-IP>` | so macht es netdata dort schon: nur Tailnet, nie die öffentliche IP |
| Collector nur OTLP/HTTP `4318` | `4317` gehört netdata |
| Eigenes Bridge-Netz `agentops` | Konvention von fahrschule/n8n; nichts teilt sich ein Netz mit Game-Containern |
| Ablage `/opt/agentops` | Konvention von `/opt/n8n`, `/opt/metabase`; braucht einmal sudo |

Einmalig als admin (das eine sudo):

```bash
sudo mkdir -p /opt/agentops && sudo chown admin:admin /opt/agentops
```

Deploy:

```bash
git clone <repo> /opt/agentops && cd /opt/agentops
cp .env.example .env            # Passwörter; BIND_ADDR=<Tailscale-IP>; OPENCLAW_STATE_DIR + UID/GID sobald OpenClaw existiert
docker compose up -d            # Tag 1: nur Infrastruktur
docker compose --profile app up -d --build   # sobald der Connector gegen ein echtes OpenClaw läuft
docker compose ps
```

Grafana dann unter `http://srv1:3000` von jedem Tailnet-Gerät. Schöner wäre `tailscale serve --bg 3000`
(TLS unter `https://srv1.<tailnet>.ts.net`), braucht einmal `sudo tailscale set --operator=admin`.

- **Backup:** srv1 hat einen root-Cron (`/usr/local/bin/srv1-backup.sh`, täglich/wöchentlich nach
  `/home/admin/db-archive/auto`). Dort eine Zeile ergänzen — die Events-Tabelle ist das Einzige,
  was sich nicht neu ableiten lässt (§9):
  ```bash
  docker exec agentops-postgres pg_dump -U postgres -Fc agentops > "$TAEGLICH/agentops-$(date +%F).dump"
  ```
- **Ebene 1 fehlt auf srv1.** OpenClaw ist nicht installiert. Bis das entschieden ist, läuft der Stack ohne
  `--profile app` — Tag 1 bis 3 brauchen ihn nicht. Wenn OpenClaw kommt: eigener Unix-User `openclaw`,
  Gateway als systemd-Unit oder eigenes Compose-Projekt, State-Verzeichnis in `.env` eintragen.
- **OpenClaws State-Verzeichnis** wird als Volume gemountet, nicht `:ro`: SQLite im WAL-Modus braucht auch
  zum Lesen Schreibzugriff auf die `-shm`-Datei. Read-only ist die *Verbindung* (`Mode=ReadOnly`), nicht das
  Dateisystem. `AGENTOPS_UID/GID` muss der Besitzer des Verzeichnisses sein.
- **OpenClaw → Collector:** `diagnostics.otel.endpoint` auf `http://127.0.0.1:4318` (Host) bzw.
  `http://otel-collector:4318` (gleiches Compose-Netz).
- **Zeilenenden:** `.gitattributes` erzwingt LF, auch bei Checkout auf Windows. Ohne das stirbt
  `01-roles.sh` im Container an `\r`.

Vor dem ersten Deploy prüfen, unabhängig von diesem Projekt: `sudo ufw status` bzw. `sudo nft list ruleset`.
`postgres-bots` und Wings hören auf allen Interfaces eines Hosts mit öffentlicher IP.

## Was hier bewusst fehlt

Kein Schreibzugriff auf Cluster, Repo oder Gateway. Kein Langfuse. Kein Actor-Dienst.
Warum, steht in §12 und §13 des Dokuments.
