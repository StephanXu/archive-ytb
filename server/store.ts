import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export class Store {
  root: string;
  db: Database.Database;
  constructor(root: string) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.db = new Database(resolve(this.root, "archive-flow.sqlite3"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS documents(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id))",
    );
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM documents WHERE kind=? AND id=?")
      .get(kind, id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  all<T>(kind: string): T[] {
    return (
      this.db
        .prepare("SELECT body FROM documents WHERE kind=? ORDER BY rowid")
        .all(kind) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  put<T>(kind: string, id: string, value: T): T {
    this.db
      .prepare(
        "INSERT INTO documents VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, id, JSON.stringify(value));
    return value;
  }
  delete(kind: string, id: string) {
    this.db
      .prepare("DELETE FROM documents WHERE kind=? AND id=?")
      .run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
  close() {
    this.db.close();
  }
}
