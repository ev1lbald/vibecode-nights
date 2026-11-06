import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Session } from "../shared/types";
export function openDb(dir: string) {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "sessions.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS sessions_owner ON sessions(owner)",
  );
  return {
    get(id: string, owner: string) {
      const row = db
        .prepare("SELECT * FROM sessions WHERE id=? AND owner=?")
        .get(id, owner);
      return row
        ? {
            session: JSON.parse(row.data as string) as Session,
            fingerprint: row.fingerprint as string,
          }
        : undefined;
    },
    exists(id: string) {
      return !!db.prepare("SELECT id FROM sessions WHERE id=?").get(id);
    },
    put(session: Session, owner: string, fingerprint: string) {
      db.prepare(
        "INSERT INTO sessions VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      ).run(
        session.id,
        owner,
        fingerprint,
        JSON.stringify(session),
        session.created_at,
      );
    },
    list(owner: string) {
      return db
        .prepare(
          "SELECT data FROM sessions WHERE owner=? ORDER BY created_at DESC LIMIT 100",
        )
        .all(owner)
        .map((r) => JSON.parse(r.data as string) as Session);
    },
    delete(id: string, owner: string) {
      return db
        .prepare("DELETE FROM sessions WHERE id=? AND owner=?")
        .run(id, owner).changes;
    },
    close() {
      db.close();
    },
  };
}
