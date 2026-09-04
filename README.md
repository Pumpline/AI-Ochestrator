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

Kommandos (jedes läuft einmal durch und beendet sich; ohne Kommando startet der Dienst):

| Kommando | Tut |
|---|---|
| `--verify [datei]` | **Schritt 4 + 5 in einem:** Load, Projektion durch den Daemon, Prüfsumme, Rebuild, Prüfsumme, zweiter Load. Exit 1 bei Abweichung. |
| `--load [datei]` | Fixture anhängen (idempotent pro Stream) und einmal projizieren |
| `--rebuild` | Read-Model leeren, Cursor auf 0, Log neu abspielen |
| `--check` | Read-Model und Prüfsumme ausgeben |

Lokal gibt es keinen Docker — die Entwicklung läuft gegen die Wegwerf-Datenbank `agentops_dev` auf srv1,
eigene Rolle `agentops_dev`, über einen SSH-Tunnel auf den Postgres-Container:

```bash
ssh -N -L 127.0.0.1:15432:$(ssh srv1 docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' agentops-postgres):5432 srv1 &
dotnet user-secrets --project src/AgentOps set "ConnectionStrings:AgentOps" "Host=127.0.0.1;Port=15432;Database=agentops_dev;Username=agentops_dev;Password=..."
ASPNETCORE_ENVIRONMENT=Development dotnet run --project src/AgentOps -- --verify fixtures/day1.jsonl
```

`ASPNETCORE_ENVIRONMENT=Development` ist nötig, sonst liest die App die user-secrets nicht (kein launchSettings.json).
Relative Fixture-Pfade werden auch von `src/AgentOps` aus gefunden — der Loader sucht bis zu vier Ebenen aufwärts.

Erwartetes Read-Model nach dem Fixture:

| flow_id | stage | status | gate_open | revision |
|---|---|---|---|---|
| a1 | ship | running | false | 10 |
| b2 | review | waiting | true | 4 |
| c3 | test | failed | false | 4 |

Die Prüfsumme, die `--verify` vergleicht (falls du sie von Hand ziehen willst):

```sql
select md5(string_agg(f::text, '|' order by f.flow_id)) from readmodel.flows f;
```

**Tag 1 ist bestanden** — 2026-09-04 lokal (SDK 10 durch den Tunnel) und im Container auf srv1, beide gegen
`agentops_dev`: 21 Events in 5 Streams, Prüfsumme vor und nach Rebuild identisch (`49a4ac52…`, auf beiden
Wegen dieselbe), zweiter Load hängt nichts an.

Auf dem Server dasselbe im Container, gegen die Wegwerf-Datenbank statt des echten Logs:

```bash
AGENTOPS_DB=agentops_dev docker compose --profile app run --rm --no-deps agentops --verify fixtures/day1.jsonl </dev/null
```

`</dev/null`, weil `compose run` in Skripten sonst das restliche Skript als Stdin des Containers liest.
Die Dev-Datenbank gehört einer eigenen Rolle `agentops_dev` — lokale Entwicklung kommt damit nicht an den echten Log.
Neu anlegen: `create role agentops_dev login password '…'; create database agentops_dev owner agentops_dev; grant agentops_dev to agentops;`
Der letzte Grant lässt den Container (Rolle `agentops`) dieselbe Dev-Datenbank benutzen — in die andere Richtung
gibt es keinen Grant, `agentops_dev` kommt nicht an `agentops`.
**Nie `reassign owned by`** zum Umhängen benutzen — das reicht Datenbanken als Shared Objects gleich mit weiter.

## Tag 2: der Connector

Läuft im App-Container als `ConnectorService`, liest OpenClaws State-Datei alle 5 s (Verbindung `Mode=ReadOnly`,
Busy-Timeout 5 s) und schreibt Events — sonst nichts. Kein WebSocket: die Datei hält auch die Freigaben,
der Socket wäre nur Beschleuniger (§10).

| Quelle | Bedingung | Event |
|---|---|---|
| `flow_runs` | `current_step` ≠ zuletzt gesehen | `StageEntered` |
| `flow_runs` | `status` ∈ failed, lost, blocked, cancelled | `Halted` (Grund: `blocked_summary`) |
| `flow_runs` | `status` = succeeded | `FlowCompleted` |
| `operator_approvals` | `status` = pending | `GatePending` |
| `operator_approvals` | `status` = allowed | `ApprovalGranted` (actor_ref: `resolver_id`) |
| `operator_approvals` | `status` ∈ denied, expired, cancelled | `ApprovalDenied` |
| `flow_runs` | `status` = waiting mit `wait_json.kind` = gate (Plugin-Gate) | `GatePending` (`gate:<flow>:<step>`) |
| `flow_runs` | verlässt waiting, `state_json.gate.decision` = allow / deny | `ApprovalGranted` / `ApprovalDenied` (actor_ref: `gate.by`) |

Nur Revisionen, die Schritt oder Status ändern, erzeugen ein Event; Idempotenzschlüssel `flow:revision:art`.
Das Gesehene steht als Cursor-Dokument (`FlowCursor`, `ApprovalCursor`, Schema `agentops`) **in derselben
Transaktion** wie die Events — ein Neustart schreibt nichts doppelt. Änderungen innerhalb eines Poll-Intervalls
werden nach Zeitstempel geordnet, bei Gleichstand Freigabe vor Flow. Zwischenschritte, die kürzer als ein Intervall
leben, sieht Polling nicht — der Log hält dann `previous` ≠ vorheriger Schritt.

Test ohne laufende Flows — `fixtures/openclaw-test.py` baut aus dem echten Schema eine synthetische State-Datei
und spielt vier Phasen durch (Schritte, Blockade, Freigabe pending → allowed, Abschluss):

```bash
export AGENTOPS_DB=agentops_dev
for p in 1 2 3 4; do
  python3 fixtures/openclaw-test.py openclaw/state/openclaw.sqlite fixtures/openclaw-test.sqlite $p
  docker compose --profile app run --rm --no-deps -e OpenClaw__StatePath=/app/fixtures/openclaw-test.sqlite agentops --poll-once /app/fixtures/openclaw-test.sqlite </dev/null
done
docker compose --profile app run --rm --no-deps agentops --check </dev/null   # erwartet: f1 ship succeeded rev 5, f2 code blocked rev 3
```

Bestanden 2026-09-05: 10 Events in 4 Streams, Reihenfolge domänenkorrekt, zweiter Poll 0 Events, Prüfsumme nach Rebuild identisch.

## Die Pipeline: OpenClaw-Plugin `agentops-pipeline`

`infra/openclaw/plugins/agentops-pipeline/` — ein OpenClaw-Plugin (ESM, kein Build), das plan → code → test → review →
**Gate** → ship als *managed TaskFlow* führt. Die Reihenfolge steht im Code (§5, Variante B); jeder Schritt ist ein
Subagent-Lauf mit eigener Soul (`extraSystemPrompt`), `promptMode: minimal` und `lightContext` — der Kontext bleibt klein.
Übergabe zwischen den Schritten über Dateien in `.agentops/` im Repo (`plan.md`, `code.md`, `test.md`, `review.md`, `ship.md`),
nicht über ein Modell in der Mitte. Das Plugin hält keinen Zustand: welcher Lauf zu welchem Flow gehört, steht im Flow
(`stateJson.runs[currentStep]`) — OpenClaw lädt Plugin-Instanzen mehrfach und neu, ein Speicher im Plugin geht verloren.

HTTP-API am Gateway, Auth = Gateway-Token:

```bash
T=$(grep '^OPENCLAW_GATEWAY_TOKEN=' /opt/agentops/.env | cut -d= -f2); H="Authorization: Bearer $T"; U=http://127.0.0.1:18789/plugins/agentops-pipeline
curl -s -H "$H" -H 'Content-Type: application/json' -d '{"repo":"agentops-playground","goal":"…"}' $U/start   # Flow anlegen, plan startet
curl -s -H "$H" $U                                    # alle Pipeline-Flows
curl -s -H "$H" $U/<flowId>                           # einer
curl -s -H "$H" -d '{"decision":"allow","by":"leo"}' $U/<flowId>/gate      # Gate vor ship: allow | deny
curl -s -H "$H" -d '{"by":"leo"}' $U/<flowId>/advance                      # Operator-Eingriff: Schritt als beendet behandeln
```

Das Gate ist ein `waiting`-Zustand mit `waitJson.kind = "gate"`; die Entscheidung landet in `stateJson.gate`. Der Connector
macht daraus `GatePending` / `ApprovalGranted` / `ApprovalDenied` mit `gate:<flowId>:<step>` als Approval-ID und dem
Freigebenden aus `gate.by` — dieselben Events wie bei OpenClaws eigenen `operator_approvals`.

Installieren auf srv1 (das Verzeichnis liegt in OpenClaws Home, nicht im Git-Checkout):

```bash
cd /opt/agentops
cp -r infra/openclaw/plugins/agentops-pipeline openclaw/extensions/
mkdir -p openclaw/extensions/agentops-pipeline/node_modules && ln -sfn /app openclaw/extensions/agentops-pipeline/node_modules/openclaw
docker exec agentops-openclaw node openclaw.mjs config set plugins.allow '["diagnostics-otel","agentops-pipeline"]'
docker exec agentops-openclaw node openclaw.mjs config set plugins.entries.agentops-pipeline '{"enabled":true,"config":{"reposRoot":"/home/node/repos","ownerSessionKey":"agent:main:main"}}'
docker compose --profile openclaw restart openclaw
```

Aktualisieren = `index.js` neu kopieren und Gateway neu starten. Der Symlink `node_modules/openclaw → /app` löst
`openclaw/plugin-sdk/plugin-entry` im Container auf.

**Erster echter Lauf, 2026-09-05, Wegwerf-Repo `/opt/repos/agentops-playground`** (Node, `node --test`), Ziel
„multiply(a, b) mit Test": plan → code → test (2/2 grün) → review (APPROVE) → Gate (allow durch leo) → ship
(Commit `bac9d20`) → succeeded. Drei Schritte in 90 s, Gesamtkosten rund **0,6 USD**. Im Cockpit als
`StageEntered` ×6 und `FlowCompleted`, Board und `/api/flows/{id}/events` zeigen die Zeitleiste.

### Die Souls sind eigene Agenten

Seit Lauf #2 ist jeder Schritt ein eigener OpenClaw-Agent: `agents.entries.pipeline-<step>` mit eigenem Workspace
`/home/node/.openclaw/workspace-pipeline-<step>/` und `SOUL.md` darin. Quelle der Souls ist `infra/openclaw/souls/<step>.md`
im Repo; auf srv1 liegt die Kopie in `/opt/agentops/openclaw/workspace-pipeline-<step>/SOUL.md`. Anlegen (einmalig):

```bash
cd /opt/agentops && cp -r infra/openclaw/souls openclaw/
for s in plan code test review ship; do
  mkdir -p openclaw/workspace-pipeline-$s && cp openclaw/souls/$s.md openclaw/workspace-pipeline-$s/SOUL.md
  docker exec agentops-openclaw node openclaw.mjs agents add pipeline-$s --workspace /home/node/.openclaw/workspace-pipeline-$s --model openai/gpt-5.6-sol --non-interactive
done
```

Soul ändern = Datei ändern; beim nächsten Lauf gilt sie. **Pro Projekt** überschreibt `<repo>/.agentops/souls/<step>.md`
die Soul des Agenten (kommt als `extraSystemPrompt` oben drauf) — die Grundlage für den Soul-Editor im Frontend.
Der Plugin-Parameter `agentPrefix` (Default `pipeline-`) wählt den Agenten-Satz.

Weil jeder Schritt-Agent seinen Lauf selbst besitzt, der Flow aber `main` gehört, greift OpenClaws eigene
Kind-Task-Verknüpfung (`runTask`) nicht — „Task backing ownership could not be verified" ist strukturell, kein
Timing. Die Zuordnung Lauf ↔ Flow steht deshalb im Flow (`stateJson.runs[step] = runId`), und der Connector
nutzt sie auch für den Join von OpenClaws Exec-Approvals auf den Flow. Review-Ergebnis `REQUEST_CHANGES`
verzweigt in v0.1 noch nicht.

**Lauf #2** (divide() mit Fehlerfall, 4/4 Tests grün, Commit `9e0c592`): Kosten je Soul, aus Prometheus
`openclaw_cost_usd_total{openclaw_agent}` — die Frage „was hat Agent X gekostet?" ist damit pro Schritt beantwortbar:

| plan | code | test | review | ship | gesamt |
|---|---|---|---|---|---|
| 0,14 | 0,31 | 0,19 | 0,20 | 0,24 | **1,08 USD** |

Teurer als Lauf #1 (0,60 USD): jeder Agent-Workspace bringt eigenen Bootstrap-Kontext mit, und die Aufgabe war größer.
Prompt-Tokens je Schritt 90k–195k über mehrere Modellaufrufe — der Hebel ist die Tool-Liste je Agent (`agents.entries.<id>.tools`),
noch nicht angefasst.

## Das Cockpit (Frontend)

`src/AgentOps/wwwroot/` — eine statische Web-App (ES-Module, kein Framework, kein Build), ausgeliefert vom
AgentOps-Container unter `http://srv1:5080/` (Tailnet; lokal `127.0.0.1:5080`). Beim ersten Öffnen fragt sie
einmalig nach dem `API_TOKEN` und deinem Namen für Freigaben; beides bleibt im Browser (`localStorage`).

| Seite | Zeigt / tut |
|---|---|
| Flows | alle Flows aus dem Read-Model mit **Stufenstreifen** (plan · code · test · review · gate · ship), Ziel und Repo aus dem Plugin, alle 10 s aktualisiert |
| Flow | großer Streifen, Zeitleiste aus `/api/flows/{id}/events`; am Gate: **Freigeben** / **Ablehnen**; bei hängendem Schritt: „Schritt als beendet behandeln" |
| Wartet auf dich | offene Gates, Zähler in der Leiste |
| Projekt | **Pipeline starten** (Ziel eingeben), letzte Läufe, **Souls je Schritt** — Standard des Agenten oder Projekt-Override, „Soul speichern" committet `.agentops/souls/<schritt>.md` ins Repo |
| Kosten | Kosten je Soul (7 Tage / seit Gateway-Start), Tokens nach Art — aus Prometheus |

Die Schreibseite des Cockpits sind genau drei Verben, alle in `Cockpit.cs`: Gate entscheiden und Pipeline
starten (Relais zum Plugin am Gateway — der Gateway-Token bleibt im Container), Soul speichern (Datei + Commit als
„AgentOps Cockpit"). Alles andere liest. Neue Endpunkte: `/api/projects`, `/api/projects/{name}/souls[/{step}]`
(GET/PUT/DELETE), `/api/projects/{name}/runs` (POST), `/api/flows/{id}/gate` (POST), `/api/pipeline/flows[/{id}]`,
`/api/pipeline/flows/{id}/advance` (POST), `/api/costs`. Der Container mountet dafür `/repos` (rw, Commits) und
`/souls-default` (ro) und hat `git`.

Prometheus-Detail: der Collector ließ Metriken ohne neue Werte nach 5 Minuten verfallen — nach einem ruhigen
Gateway waren die Kosten „seit Start" weg. Jetzt `metric_expiration: 72h`, und die Abfragen nutzen `last_over_time(…[24h])`.

## Read-API (P2) und Grafana-Board (P3)

Die API liest nur. `/health` ist offen und sagt genau ein Bit; alles unter `/api` verlangt
`Authorization: Bearer <API_TOKEN>` — ohne konfigurierten Token antwortet `/api` mit 503, nie offen.

| Endpunkt | Antwort |
|---|---|
| `GET /api/flows[?status=waiting]` | alle Flows aus dem Read-Model, neueste zuerst |
| `GET /api/flows/{id}` | ein Flow |
| `GET /api/flows/{id}/events` | die Zeitleiste aus dem Log: seq, stream, version, type, recorded_at, causation, data |
| `GET /api/gates` | Flows mit offenem Gate — „wartet auf mich“ |

```bash
curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:5080/api/gates
```

Das Grafana-Board **Agent-Ops** (`infra/grafana/provisioning/dashboards/agentops.json`, provisioniert, nicht
in der UI editierbar) beantwortet die drei Fragen aus P3: offene Gates, stehen gebliebene Flows,
Flows nach Status, Kosten pro Modell aus Prometheus (leer, bis ein Orchestrator exportiert), alle Flows.

## OpenClaw (Ebene 1) auf srv1

Entscheidung 2026-09-05: OpenClaw bleibt der Orchestrator — als **Container** aus dem offiziellen Image
(`ghcr.io/openclaw/openclaw`, festgenagelt auf **2026.9.1**, State-Schema 15), Profil `openclaw` in derselben `compose.yaml`.
Läuft seit 2026-09-04 auf srv1; die OTel-Kette steht end-to-end (Prometheus hat `openclaw_*`-Metriken).
Die für den Connector relevanten Tabellen der State-Datei: `flow_runs` (`flow_id`, `revision`, `status`,
`current_step`, `state_json`, `wait_json`, `blocked_summary`, Zeiten als Epoch-ms), `operator_approvals`
(`approval_id`, `status`, `decision`, `resolver_kind`, `resolver_id`, `resolved_at_ms`), `task_runs` (`parent_flow_id`,
`agent_id`, `status`, `terminal_outcome`, `error`). CLI im Container: `docker compose --profile openclaw run --rm openclaw node openclaw.mjs <befehl>`. Das Image läuft als uid 1000,
auf srv1 ist das `admin`: Bind-Mounts brauchen kein sudo, und der Connector (ebenfalls 1000) liest die SQLite direkt.
Gateway und Connector reden über das Compose-Netz (`ws://openclaw:18789`), nach außen nur `127.0.0.1:18789`.

Einmalig auf srv1:

```bash
cd /opt/agentops
mkdir -p openclaw && cp -n infra/openclaw/openclaw.json openclaw/     # Vorlage: mode local, bind 0.0.0.0, Token aus Env, OTel → Collector
grep -q '^OPENCLAW_GATEWAY_TOKEN=.' .env || echo "OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)" >> .env
sed -i 's#^OPENCLAW_STATE_DIR=.*#OPENCLAW_STATE_DIR=/opt/agentops/openclaw/state#' .env
docker compose --profile openclaw up -d
docker compose --profile openclaw run --rm openclaw plugins install clawhub:@openclaw/diagnostics-otel </dev/null
docker compose --profile openclaw restart openclaw
curl -s http://127.0.0.1:18789/healthz
```

Danach `--profile app` neu starten, damit der Connector den neuen State-Pfad und das Token bekommt:
`docker compose --profile app --profile openclaw up -d`.

Provider-Schlüssel kommen als Env in den OpenClaw-Container, nie in die Konfig-Datei: `OPENAI_API_KEY` in `.env`
(Eintrag ohne History: `read -rsp "Key: " K; echo "OPENAI_API_KEY=$K" >> .env; unset K`), `compose.yaml` reicht ihn durch.

**Runtime-Policy:** OpenAI-Modelle laufen in OpenClaw standardmäßig über den *Codex*-Harness, dessen Binary im
Image fehlt („Managed Codex app-server binary was not found"). Die Vorlage pinnt das Default-Modell deshalb auf
OpenClaws eingebetteten Runtime (`agents.defaults.models["openai/gpt-5.6-sol"].agentRuntime.id = "openclaw"`).
Im laufenden Container ändert man die Konfig mit `node openclaw.mjs config set <pfad> <json>` — die Datei wird von
OpenClaw selbst umgeschrieben, nicht aus der Vorlage überschreiben. Erster Agent-Turn über das Gateway
(`node openclaw.mjs agent -m "…" --json`) bestanden am 2026-09-04: runner `embedded`, Modell `gpt-5.6-sol`.

**Kosten-Metriken** kommen erst mit `diagnostics.otel.metrics: true` (die Vorlage setzt es; `enabled` allein reicht
nicht). In Prometheus: `openclaw_tokens_total{openclaw_token=input|output|prompt|cache_read|cache_write|total,
openclaw_provider, openclaw_model, openclaw_agent}` und `openclaw_cost_usd_total{openclaw_provider, openclaw_model}`,
dazu `gen_ai_client_token_usage_*`. Erste Messung: ein Turn „Antworte mit OK" = 53k Prompt-Tokens, 10 Output-Tokens,
**0,18 USD** — der Kontext des Default-Agenten (Skills, Speicher) ist die Kostenstelle, nicht die Antwort (§1).

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
