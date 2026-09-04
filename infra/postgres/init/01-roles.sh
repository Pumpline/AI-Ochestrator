#!/bin/bash
# Läuft genau einmal: beim ersten Start mit leerem Volume (docker-entrypoint-initdb.d).
# Danach ändern heißt: Volume löschen (docker compose down -v) oder von Hand nachziehen.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  -- Anwendungsrolle: Owner der Datenbank. Legt Marten-Schema und Read-Models selbst an.
  create role agentops login password '${AGENTOPS_PASSWORD}';
  alter database ${POSTGRES_DB} owner to agentops;

  -- Read-Model-Schema. Hier landen die Projektionen
  -- (Marten: opts.Schema.For<FlowView>().DatabaseSchemaName("readmodel")).
  create schema readmodel authorization agentops;

  -- Grafana: nur lesen, nur readmodel (§14 Schritt 2).
  create role grafana_ro login password '${GRAFANA_RO_PASSWORD}';
  alter role grafana_ro set default_transaction_read_only = on;
  grant connect on database ${POSTGRES_DB} to grafana_ro;
  grant usage on schema readmodel to grafana_ro;
  alter default privileges for role agentops in schema readmodel
    grant select on tables to grafana_ro;
EOSQL
