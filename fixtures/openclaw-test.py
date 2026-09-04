#!/usr/bin/env python3
"""
Synthetische OpenClaw-State-Datei für den Connector-Test (Tag 2).

Kopiert das echte Schema von flow_runs, task_runs und operator_approvals aus einer laufenden
OpenClaw-Instanz (Version 2026.9.1, Schema 15) und spielt in vier Phasen durch, was der Connector
zwischen zwei Polls sehen kann. Zwischen den Phasen: --poll-once gegen diese Datei.
NOT-NULL-Spalten, die uns nicht interessieren, werden mit Platzhaltern gefüllt — das Schema hat viele davon.

  python3 fixtures/openclaw-test.py <echte openclaw.sqlite> <test.sqlite> <phase 1..4>

Erwartung nach Phase 4 (readmodel.flows):
  f1  ship  succeeded  gate=false  rev=5
  f2  code  blocked    gate=false  rev=3
"""
import os, sqlite3, sys, time

src, dst, phase = sys.argv[1], sys.argv[2], int(sys.argv[3])
now = int(time.time() * 1000)
TABLES = ("flow_runs", "task_runs", "operator_approvals")


def insert(db, table, values):
    """INSERT mit Platzhaltern für alle NOT-NULL-Spalten ohne Default, die values nicht setzt."""
    cols = db.execute(f"pragma table_info({table})").fetchall()
    row = dict(values)
    for _, name, typ, notnull, dflt, _ in cols:
        if notnull and dflt is None and name not in row:
            row[name] = 0 if (typ or "").upper().startswith(("INT", "REAL", "NUM")) else ""
    names = ", ".join(row)
    marks = ", ".join("?" for _ in row)
    db.execute(f"insert into {table} ({names}) values ({marks})", list(row.values()))


if phase == 1:
    s = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    ddl = [r[0] for r in s.execute(
        "select sql from sqlite_master where type='table' and name in ('flow_runs','task_runs','operator_approvals')")]
    s.close()
    if os.path.exists(dst):
        os.remove(dst)
    d = sqlite3.connect(dst)
    for stmt in ddl:
        d.execute(stmt)
    for fid in ("f1", "f2"):
        insert(d, "flow_runs", {"flow_id": fid, "revision": 1, "status": "running", "current_step": "plan",
                                "owner_key": "test", "created_at": now, "updated_at": now})
    d.commit(); d.close()
    print("phase 1: f1/f2 plan rev 1")

else:
    d = sqlite3.connect(dst)
    if phase == 2:
        d.execute("update flow_runs set revision=2, current_step='code', updated_at=? where flow_id in ('f1','f2')", (now,))
        print("phase 2: f1/f2 code rev 2")
    elif phase == 3:
        # f1 springt in einem Poll-Intervall über test nach review — Polling sieht nur den letzten Stand
        d.execute("update flow_runs set revision=4, current_step='review', updated_at=? where flow_id='f1'", (now,))
        d.execute("update flow_runs set revision=3, status='blocked', blocked_summary='CI: 2 tests failed', updated_at=? where flow_id='f2'", (now,))
        insert(d, "task_runs", {"task_id": "t1", "run_id": "r1", "parent_flow_id": "f1", "status": "running",
                                "runtime": "test", "created_at": now})
        # Echte Enums und CHECKs (2026.9.1): kind exec|plugin|system-agent, status pending|allowed|denied|expired|cancelled,
        # decision allow-once|allow-always|deny, resolver_kind device|channel|runtime|system, resolution_ref 43 Zeichen base64url.
        insert(d, "operator_approvals", {"approval_id": "apr1", "kind": "exec", "status": "pending", "source_run_id": "r1",
                                         "resolution_ref": "A" * 43, "presentation_json": "{}", "reviewer_device_ids_json": "[]",
                                         "audience_session_keys_json": "[]", "runtime_epoch": "e1",
                                         "created_at_ms": now, "updated_at_ms": now, "expires_at_ms": now + 3_600_000})
        print("phase 3: f1 review rev 4 + apr1 pending; f2 blocked rev 3")
    elif phase == 4:
        d.execute("update operator_approvals set status='allowed', decision='allow-once', resolver_kind='device', resolver_id='device-42', resolved_at_ms=?, updated_at_ms=? where approval_id='apr1'", (now, now))
        d.execute("update flow_runs set revision=5, current_step='ship', status='succeeded', updated_at=?, ended_at=? where flow_id='f1'", (now, now))
        print("phase 4: apr1 allow durch device-42; f1 ship succeeded rev 5")
    d.commit(); d.close()
