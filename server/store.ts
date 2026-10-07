import Database from "better-sqlite3";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { ConfigFile, configKinds, validateDocument } from "./config-file.ts";
import { expandPath } from "./paths.ts";
import type {
  BackupConfig,
  CookieSource,
  Settings,
  StorageSource,
} from "../shared/contracts.ts";

export class Store {
  root: string;
  db: Database.Database;
  configuration: ConfigFile;
  private depth = 0;
  constructor(root: string, configPath = resolve(root, "config.toml")) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.db = new Database(resolve(this.root, "archive-flow.sqlite3"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS documents(kind TEXT,id TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id))",
    );
    try {
      this.configuration = new ConfigFile(configPath);
      if (!this.configuration.exists) this.migrateConfiguration();
      this.reconcileConfiguration();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private dbGet<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT body FROM documents WHERE kind=? AND id=?")
      .get(kind, id) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  get<T>(kind: string, id: string): T | undefined {
    if (!configKinds.has(kind)) return this.dbGet<T>(kind, id);
    const doc = this.configuration.doc;
    if (kind === "settings") {
      if (id !== "global" || !doc.settings) return undefined;
      return this.resolveSettings(doc.settings) as T;
    }
    if (kind === "configs") {
      const c = doc.configs.find((r) => r.id === id);
      if (!c) return undefined;
      return {
        ...c,
        excluded: [...c.excluded],
        library_dir: this.path(c.library_dir),
        download_dir: this.path(c.download_dir),
        next_run:
          this.dbGet<{ next_run: number | null }>("config_runtime", id)
            ?.next_run ?? null,
      } as T;
    }
    if (kind === "storages") {
      const s = doc.storages.find((r) => r.id === id);
      return s
        ? ({ ...s, root: s.kind === "local" ? this.path(s.root) : s.root } as T)
        : undefined;
    }
    const c = doc.cookies.find((r) => r.id === id);
    if (!c) return undefined;
    const { content: _content, ...definition } = c;
    return {
      ...definition,
      path:
        c.kind === "upload"
          ? this.cookiePath(c.id, c.content)
          : this.path(c.path),
      status: "未验证",
      ...this.dbGet<object>("cookie_runtime", id),
    } as T;
  }
  all<T>(kind: string): T[] {
    if (configKinds.has(kind)) {
      if (kind === "settings")
        return this.get<T>(kind, "global")
          ? [this.get<T>(kind, "global")!]
          : [];
      return this.configuration.doc[
        kind as "configs" | "cookies" | "storages"
      ].map((r) => this.get<T>(kind, r.id)!);
    }
    return (
      this.db
        .prepare("SELECT body FROM documents WHERE kind=? ORDER BY rowid")
        .all(kind) as { body: string }[]
    ).map((r) => JSON.parse(r.body));
  }
  put<T>(kind: string, id: string, value: T): T {
    if (configKinds.has(kind)) {
      this.transaction(() => this.putConfiguration(kind, id, value));
      return this.get<T>(kind, id)!;
    }
    return this.dbPut(kind, id, value);
  }
  private dbPut<T>(kind: string, id: string, value: T): T {
    this.db
      .prepare(
        "INSERT INTO documents VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
      )
      .run(kind, id, JSON.stringify(value));
    return value;
  }
  delete(kind: string, id: string) {
    if (configKinds.has(kind)) {
      this.transaction(() => {
        if (kind === "settings") delete this.configuration.doc.settings;
        else {
          const key = kind as "configs" | "cookies" | "storages";
          this.configuration.doc[key] = this.configuration.doc[key].filter(
            (r) => r.id !== id,
          ) as never;
        }
        this.dbDelete(
          kind === "configs" ? "config_runtime" : "cookie_runtime",
          id,
        );
      });
      return;
    }
    this.dbDelete(kind, id);
  }
  private dbDelete(kind: string, id: string) {
    this.db
      .prepare("DELETE FROM documents WHERE kind=? AND id=?")
      .run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    const before = structuredClone(this.configuration.doc);
    const outer = this.depth === 0;
    this.depth++;
    try {
      return this.db.transaction(() => {
        const result = fn();
        if (outer)
          this.configuration.doc = validateDocument(this.configuration.doc);
        if (
          outer &&
          JSON.stringify(before) !== JSON.stringify(this.configuration.doc)
        ) {
          // Immutable credential paths keep the previous Cookie usable if publication fails.
          this.materializeCookies();
          this.configuration.save();
          this.saveFingerprints();
        }
        return result;
      })();
    } catch (error) {
      this.configuration.doc = before;
      throw error;
    } finally {
      this.depth--;
    }
  }
  private path(value: string) {
    return value ? expandPath(value, dirname(this.configuration.path)) : value;
  }
  private resolveSettings(s: Settings): Settings {
    return {
      ...s,
      download_root: this.path(s.download_root),
      rclone_config: s.rclone_config
        ? this.path(s.rclone_config)
        : s.rclone_config,
      ffprobe: /[/\\]/.test(s.ffprobe) ? this.path(s.ffprobe) : s.ffprobe,
      ffmpeg: /[/\\]/.test(s.ffmpeg) ? this.path(s.ffmpeg) : s.ffmpeg,
    };
  }
  private cookiePath(id: string, content: string) {
    return join(this.root, "cookies", `${id}-${this.hash(content)}.txt`);
  }
  private hash(value: unknown) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
  private materializeCookies() {
    for (const c of this.configuration.doc.cookies)
      if (c.kind === "upload") {
        const path = this.cookiePath(c.id, c.content);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        if (!existsSync(path) || readFileSync(path, "utf8") !== c.content)
          writeFileSync(path, c.content, { mode: 0o600 });
      }
  }
  private putConfiguration<T>(kind: string, id: string, value: T) {
    const doc = this.configuration.doc;
    if (kind === "settings") {
      doc.settings = value as Settings;
      return;
    }
    let definition: unknown;
    if (kind === "configs") {
      const { next_run, ...rest } = value as BackupConfig;
      const previous = doc.configs.find((r) => r.id === id);
      for (const key of ["library_dir", "download_dir"] as const)
        if (previous && rest[key] === this.path(previous[key]))
          rest[key] = previous[key];
      definition = { ...rest, id };
      this.dbPut("config_runtime", id, { next_run: next_run ?? null });
    } else if (kind === "cookies") {
      const { status, checked_at, hint, ...rest } = value as CookieSource & {
        content?: string;
      };
      const old = doc.cookies.find((r) => r.id === id);
      if (old && rest.kind === old.kind && rest.path === this.path(old.path))
        rest.path = old.path;
      const content =
        rest.kind === "upload"
          ? (rest.content ?? old?.content ?? readFileSync(rest.path, "utf8"))
          : "";
      definition = {
        ...rest,
        id,
        path: rest.kind === "upload" ? "" : rest.path,
        content,
      };
      this.dbPut("cookie_runtime", id, { status, checked_at, hint });
    } else definition = { ...(value as StorageSource), id };
    const rows = doc[kind as "configs" | "cookies" | "storages"];
    const index = rows.findIndex((r) => r.id === id);
    if (index < 0) rows.push(definition as never);
    else rows[index] = definition as never;
  }
  private migrateConfiguration() {
    const rows = this.db
      .prepare(
        "SELECT kind,id,body FROM documents WHERE kind IN ('settings','configs','cookies','storages') ORDER BY rowid",
      )
      .all() as { kind: string; id: string; body: string }[];
    if (!rows.length) return;
    this.transaction(() => {
      for (const row of rows) {
        const value = JSON.parse(row.body);
        // Old relative paths used the working directory. Preserve that location on migration.
        const keys =
          row.kind === "settings"
            ? ["download_root", "rclone_config", "ffmpeg", "ffprobe"]
            : row.kind === "configs"
              ? ["download_dir", "library_dir"]
              : row.kind === "cookies"
                ? ["path"]
                : value.kind === "local"
                  ? ["root"]
                  : [];
        for (const key of keys)
          if (
            value[key] &&
            (!["ffmpeg", "ffprobe"].includes(key) || /[/\\]/.test(value[key]))
          )
            value[key] = expandPath(value[key]);
        this.putConfiguration(row.kind, row.id, value);
      }
    });
    // The TOML has been published first; old rows are kept until that succeeds.
    this.db
      .prepare(
        "DELETE FROM documents WHERE kind IN ('settings','configs','cookies','storages')",
      )
      .run();
  }
  private fingerprints() {
    const doc = this.configuration.doc;
    return doc.configs.map((c) => {
      const config = this.get<BackupConfig>("configs", c.id)!;
      const cookie = doc.cookies.find((k) => k.id === c.cookie_id);
      const storage = this.all<StorageSource>("storages").find(
        (s) => s.name === c.storage_name,
      );
      return {
        id: c.id,
        snapshot: this.hash([
          config.season_url,
          config.cookie_id,
          config.library_dir,
          config.storage_name,
          config.download_dir,
          config.after_date,
          storage,
          doc.settings ? this.resolveSettings(doc.settings).download_root : "",
          cookie,
        ]),
        interval: c.interval_minutes,
      };
    });
  }
  private saveFingerprints() {
    for (const f of this.fingerprints())
      this.dbPut("config_fingerprints", f.id, f);
    for (const c of this.configuration.doc.cookies)
      this.dbPut("cookie_fingerprints", c.id, this.hash(c));
  }
  private reconcileConfiguration() {
    this.materializeCookies();
    this.db.transaction(() => {
      for (const f of this.fingerprints()) {
        const previous = this.dbGet<typeof f>("config_fingerprints", f.id);
        if (previous?.snapshot !== f.snapshot) this.dbDelete("snapshots", f.id);
        if (
          previous?.interval !== f.interval ||
          !this.dbGet("config_runtime", f.id)
        )
          this.dbPut("config_runtime", f.id, {
            next_run: f.interval ? Date.now() / 1000 + f.interval * 60 : null,
          });
      }
      for (const c of this.configuration.doc.cookies)
        if (this.dbGet("cookie_fingerprints", c.id) !== this.hash(c))
          this.dbDelete("cookie_runtime", c.id);
      this.saveFingerprints();
      // An existing file is authoritative; never resurrect deleted resources from old SQLite rows.
      this.db
        .prepare(
          "DELETE FROM documents WHERE kind IN ('settings','configs','cookies','storages')",
        )
        .run();
    })();
  }
  close() {
    this.db.close();
  }
}
