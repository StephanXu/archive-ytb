import { randomUUID } from "node:crypto";
import type { Store } from "./store.ts";
import type { Snapshot } from "../shared/contracts.ts";

// A work can have several platform sources. Matching titles never merges works.
export class Library {
  pending = Promise.resolve();
  controller = new AbortController();
  constructor(public store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media_sources(
        id TEXT PRIMARY KEY, media_id TEXT NOT NULL REFERENCES media(id),
        platform TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT NOT NULL,
        title TEXT NOT NULL, published_date TEXT, thumbnail_url TEXT,
        updated_at INTEGER NOT NULL, UNIQUE(platform, external_id));
      CREATE TABLE IF NOT EXISTS media_collections(
        config_id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES media_sources(id),
        present INTEGER NOT NULL, PRIMARY KEY(config_id,source_id));
      CREATE TABLE IF NOT EXISTS media_covers(
        source_id TEXT PRIMARY KEY REFERENCES media_sources(id), url TEXT NOT NULL,
        mime TEXT NOT NULL, image BLOB NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS media_files(
        source_id TEXT NOT NULL REFERENCES media_sources(id), path TEXT NOT NULL,
        metadata TEXT NOT NULL, PRIMARY KEY(source_id,path));
    `);
  }
  upsert(
    platform: string,
    externalId: string,
    item: {
      url: string;
      title: string;
      date: string | null;
      thumbnail?: string;
    },
  ) {
    const existing = this.store.db
      .prepare(
        "SELECT id FROM media_sources WHERE platform=? AND external_id=?",
      )
      .get(platform, externalId) as { id: string } | undefined;
    const id = existing?.id || randomUUID();
    if (!existing) {
      const mediaId = randomUUID();
      this.store.db
        .prepare("INSERT INTO media VALUES(?,?)")
        .run(mediaId, Date.now());
      this.store.db
        .prepare("INSERT INTO media_sources VALUES(?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          mediaId,
          platform,
          externalId,
          item.url,
          item.title,
          item.date,
          item.thumbnail || null,
          Date.now(),
        );
    } else
      this.store.db
        .prepare(
          "UPDATE media_sources SET url=?,title=?,published_date=COALESCE(?,published_date),thumbnail_url=COALESCE(?,thumbnail_url),updated_at=? WHERE id=?",
        )
        .run(
          item.url,
          item.title,
          item.date,
          item.thumbnail || null,
          Date.now(),
          id,
        );
    return id;
  }
  ingest(config: string, snapshot: Snapshot) {
    this.store.transaction(() => {
      this.store.db
        .prepare("UPDATE media_collections SET present=0 WHERE config_id=?")
        .run(config);
      for (const item of snapshot.items) {
        const id = this.upsert("bilibili", item.bv, item);
        this.store.db
          .prepare(
            "INSERT INTO media_collections VALUES(?,?,?) ON CONFLICT(config_id,source_id) DO UPDATE SET present=excluded.present",
          )
          .run(config, id, item.base_status === "removed" ? 0 : 1);
      }
    });
  }
  coverId(platform: string, externalId: string) {
    return (
      this.store.db
        .prepare(
          "SELECT c.source_id AS id FROM media_covers c JOIN media_sources s ON s.id=c.source_id WHERE s.platform=? AND s.external_id=?",
        )
        .get(platform, externalId) as { id: string } | undefined
    )?.id;
  }
  recordFile(platform: string, externalId: string, receipt: { path: string }) {
    const source = this.store.db
      .prepare(
        "SELECT id FROM media_sources WHERE platform=? AND external_id=?",
      )
      .get(platform, externalId) as { id: string } | undefined;
    if (source)
      this.store.db
        .prepare(
          "INSERT INTO media_files VALUES(?,?,?) ON CONFLICT(source_id,path) DO UPDATE SET metadata=excluded.metadata",
        )
        .run(source.id, receipt.path, JSON.stringify(receipt));
  }
  cacheCovers() {
    this.pending = this.pending.then(async () => {
      if (!this.store.db.open || this.controller.signal.aborted) return;
      const rows = this.store.db
        .prepare(
          "SELECT s.id,s.thumbnail_url AS url FROM media_sources s LEFT JOIN media_covers c ON c.source_id=s.id WHERE s.thumbnail_url IS NOT NULL AND (c.source_id IS NULL OR c.url<>s.thumbnail_url)",
        )
        .all() as { id: string; url: string }[];
      for (const row of rows) {
        if (this.controller.signal.aborted) break;
        try {
          const u = new URL(row.url);
          // Source adapters explicitly allow their public image CDN; never forward cookies.
          if (
            u.protocol !== "https:" ||
            u.port ||
            u.username ||
            u.password ||
            !/^(?:[a-z0-9-]+\.)+(?:hdslb\.com|ytimg\.com)$/.test(u.hostname)
          )
            continue;
          const r = await fetch(u, {
            redirect: "error",
            signal: AbortSignal.any([
              this.controller.signal,
              AbortSignal.timeout(10000),
            ]),
          });
          if (!r.ok || !r.body) continue;
          const reader = r.body.getReader(),
            chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 4_000_000) {
              await reader.cancel();
              throw Error("image too large");
            }
            chunks.push(part.value);
          }
          const image = Buffer.concat(chunks);
          const mime =
            image[0] === 255 && image[1] === 216
              ? "image/jpeg"
              : image
                    .subarray(0, 8)
                    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                ? "image/png"
                : image.toString("ascii", 0, 4) === "RIFF" &&
                    image.toString("ascii", 8, 12) === "WEBP"
                  ? "image/webp"
                  : null;
          if (!mime || !this.store.db.open || this.controller.signal.aborted)
            continue;
          this.store.db
            .prepare(
              "INSERT INTO media_covers VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET url=excluded.url,mime=excluded.mime,image=excluded.image,updated_at=excluded.updated_at",
            )
            .run(row.id, row.url, mime, image, Date.now());
        } catch {
          /* Keep the last saved cover if the CDN is unavailable. */
        }
      }
    });
  }
  async close() {
    this.controller.abort();
    await this.pending;
  }
}
