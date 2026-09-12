import { archiveFile, fileIdentity } from "./file-actions.ts";
import express from "express";
import { z } from "zod";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { unlink, stat, lstat, realpath } from "node:fs/promises";
import { join, dirname, relative, isAbsolute } from "node:path";
import { openLocalPath } from "./open-local.ts";
import { writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import {
  configSchema,
  cookieSchema,
  settingsSchema,
  bvSchema,
  DOWNLOADER_VERSION,
  type BackupConfig,
  type CookieSource,
  type Settings,
  type Snapshot,
  type Job,
} from "../shared/contracts.ts";
import { Engine, now } from "./engine.ts";
import { Store } from "./store.ts";
import { Downloader, parseCookies, serializeCookies } from "./downloader.ts";
import {
  expandPath,
  safeName,
  exists,
  executable,
  scanMedia,
} from "./paths.ts";
import { TaskError } from "./process.ts";

export function createApp({
  root,
  stateDir,
  legacy,
  token = "",
  downloader,
  openPath = openLocalPath,
}: {
  root: string;
  stateDir: string;
  legacy?: string;
  token?: string;
  downloader?: Downloader;
  openPath?: typeof openLocalPath;
}) {
  const store = new Store(stateDir),
    engine = new Engine(store, downloader || new Downloader(root), legacy),
    app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const host = req.hostname;
    if (!token && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
      res
        .status(403)
        .json({ detail: "只允许本机访问；远程模式需配置访问令牌" });
      return;
    }
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.hdslb.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    if (req.path.startsWith("/api/")) {
      const auth = Buffer.from(req.get("authorization") || ""),
        expected = Buffer.from("Bearer " + token);
      if (
        token &&
        (auth.length !== expected.length || !timingSafeEqual(auth, expected))
      ) {
        res.status(401).json({ detail: "请输入访问令牌" });
        return;
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        if (req.get("x-backup-request") !== "1") {
          res.status(403).json({ detail: "请求来源无效" });
          return;
        }
        const origin = req.get("origin");
        // Vite is a loopback-only development surface, explicitly opt-in.
        const devOrigin =
          process.env.BACKUP_DEV === "1" && origin === "http://127.0.0.1:5173";
        const publicOrigin = process.env.BACKUP_PUBLIC_ORIGIN;
        if (
          origin &&
          origin !== `${req.protocol}://${req.get("host")}` &&
          origin !== publicOrigin &&
          !devOrigin
        ) {
          res.status(403).json({ detail: "不允许跨站操作" });
          return;
        }
      }
    }
    next();
  });
  app.use(express.json({ limit: "1100kb" }));
  app.get("/api/covers/:id", (req, res) => {
    const row = store.db
      .prepare("SELECT mime,image FROM media_covers WHERE source_id=?")
      .get(req.params.id) as { mime: string; image: Buffer } | undefined;
    if (!row) {
      res.status(404).json({ detail: "封面尚未缓存" });
      return;
    }
    res.json({
      data: `data:${row.mime};base64,${row.image.toString("base64")}`,
    });
  });
  app.get("/api/state", async (_req, res) => {
    const s = engine.settings();
    res.json({
      configs: engine.views(),
      cookies: store.all("cookies"),
      settings: s,
      jobs: store
        .all<Job>("jobs")
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 100),
      runtime: {
        yt_dlp: DOWNLOADER_VERSION,
        downloader_available: await exists(engine.downloader.binary),
        ffmpeg_available: await executable(s.ffmpeg),
        ffprobe_available: await executable(s.ffprobe),
        platform: process.platform,
        remote: !!token,
      },
    });
  });
  function saveConfig(id: string, input: unknown) {
    engine.idle(id);
    const body = configSchema.parse(input);
    if (body.cookie_id && !store.get("cookies", body.cookie_id))
      throw new TaskError("VALIDATION", "Cookie 实例不存在");
    if (
      store
        .all<BackupConfig>("configs")
        .some(
          (c) =>
            c.id !== id &&
            safeName(c.name).toLowerCase() ===
              safeName(body.name).toLowerCase(),
        )
    )
      throw new TaskError("CONFLICT", "配置名对应的文件夹与已有配置重复");
    const old = store.get<BackupConfig>("configs", id);
    const value: BackupConfig = {
      ...body,
      id,
      excluded: old?.excluded || [],
      next_run: body.interval_minutes
        ? now() + body.interval_minutes * 60
        : null,
    };
    return store.transaction(() => {
      store.put("configs", id, value);
      if (
        !old ||
        (
          [
            "season_url",
            "cookie_id",
            "library_dir",
            "download_dir",
            "after_date",
          ] as const
        ).some((k) => old[k] !== value[k])
      )
        store.delete("snapshots", id);
      return value;
    });
  }
  app.post("/api/configs", (req, res) =>
    res.json(saveConfig(randomUUID(), req.body)),
  );
  app.put("/api/configs/:id", (req, res) => {
    engine.config(req.params.id);
    res.json(saveConfig(req.params.id, req.body));
  });
  app.delete("/api/configs/:id", (req, res) => {
    engine.config(req.params.id);
    engine.idle(req.params.id);
    store.transaction(() => {
      store.delete("configs", req.params.id);
      store.delete("snapshots", req.params.id);
    });
    res.json({ ok: true });
  });
  app.get("/api/configs/:id/diff", (req, res) => {
    const c = engine.config(req.params.id),
      snapshot = store.get<Snapshot>("snapshots", c.id);
    const query = z
      .object({
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        status: z
          .enum([
            "all",
            "missing",
            "archived",
            "staged",
            "excluded",
            "filtered",
            "removed",
          ])
          .default("all"),
        search: z.string().max(300).default(""),
        order: z.enum(["desc", "asc"]).default("desc"),
      })
      .parse(req.query);
    const all = engine.diff(c);
    const items = all.filter(
      (i) =>
        (query.status === "all" || i.status === query.status) &&
        (i.title + i.bv).toLowerCase().includes(query.search.toLowerCase()),
    );
    items.sort((a, b) => {
      if (!a.date || !b.date)
        return a.date ? -1 : b.date ? 1 : a.bv.localeCompare(b.bv);
      return (
        (query.order === "asc" ? 1 : -1) * a.date.localeCompare(b.date) ||
        a.bv.localeCompare(b.bv)
      );
    });
    res.json({
      snapshot_id: snapshot?.id || null,
      refreshed_at: snapshot?.refreshed_at || null,
      counts: engine.counts(all),
      items: items.slice(query.offset, query.offset + query.limit),
      total: items.length,
    });
  });
  app.put("/api/configs/:id/excluded", async (req, res) => {
    const body = z
        .object({ excluded: z.array(bvSchema).max(50000) })
        .parse(req.body),
      c = engine.config(req.params.id);
    const added = body.excluded.filter((bv) => !c.excluded.includes(bv));
    if (added.length) {
      engine.idle();
      for (const root of [
        c.library_dir ? expandPath(c.library_dir) : "",
        engine.downloadDir(c),
      ].filter(Boolean)) {
        const files = await scanMedia(root);
        if (added.some((bv) => files.has(bv)))
          throw new TaskError("CONFLICT", "请先删除本地文件，再排除该条目");
      }
    }
    c.excluded = [...new Set(body.excluded)];
    store.put("configs", c.id, c);
    res.json({ ok: true });
  });
  app.post("/api/configs/:id/refresh", (req, res) => {
    engine.config(req.params.id);
    res.json(engine.enqueue("refresh", req.params.id));
  });
  app.post("/api/configs/:id/download", (req, res) => {
    const body = z
        .object({
          snapshot_id: z.string(),
          selected: z.array(bvSchema).min(1).max(50000).optional(),
        })
        .parse(req.body),
      c = engine.config(req.params.id),
      snap = store.get<Snapshot>("snapshots", c.id);
    if (!snap || snap.id !== body.snapshot_id)
      throw new TaskError("CONFLICT", "diff 已变化，请重新预览");
    const eligible = new Set(
      engine
        .diff(c)
        .filter((i) => i.status === "missing" || i.status === "staged")
        .map((i) => i.bv),
    );
    if (body.selected?.some((b) => !eligible.has(b)))
      throw new TaskError("CONFLICT", "所选条目已变化，请重新选择");
    res.json(engine.enqueue("download", c.id, { selected: body.selected }));
  });
  app.post("/api/jobs/:id/cancel", (req, res) => {
    engine.cancel(req.params.id);
    res.json({ ok: true });
  });
  async function saveCookie(id: string, input: unknown) {
    engine.idle();
    const body = cookieSchema.parse(input);
    const { content, ...rest } = body;
    const source: CookieSource = { ...rest, id, status: "未验证" };
    if (source.kind === "upload") {
      const safeText = serializeCookies(parseCookies(content));
      const path = join(engine.cookieDir, `${id}.txt`),
        tmp = path + ".new";
      // Bounded (< 1 MB) atomic write keeps source replacement and DB update
      // in the same event-loop turn, so a queued job cannot read half an update.
      try {
        writeFileSync(tmp, safeText, { mode: 0o600 });
        renameSync(tmp, path);
        source.path = path;
      } finally {
        if (existsSync(tmp)) unlinkSync(tmp);
      }
    } else if (source.kind === "file") {
      if (!source.path.trim())
        throw new TaskError("VALIDATION", "请输入 Cookie 文件路径");
      source.path = expandPath(source.path);
    }
    const saved = store.put("cookies", id, source);
    const managed = join(engine.cookieDir, `${id}.txt`);
    if (source.kind !== "upload" && existsSync(managed)) unlinkSync(managed);
    return saved;
  }
  app.post("/api/cookies", async (req, res) =>
    res.json(await saveCookie(randomUUID(), req.body)),
  );
  app.put("/api/cookies/:id", async (req, res) => {
    if (!store.get("cookies", req.params.id))
      throw new TaskError("NOT_FOUND", "Cookie 实例不存在");
    res.json(await saveCookie(req.params.id, req.body));
  });
  app.delete("/api/cookies/:id", async (req, res) => {
    engine.idle();
    if (
      store
        .all<BackupConfig>("configs")
        .some((c) => c.cookie_id === req.params.id)
    )
      throw new TaskError("CONFLICT", "请先解除配置与此 Cookie 的关联");
    const c = store.get<CookieSource>("cookies", req.params.id);
    store.delete("cookies", req.params.id);
    if (c) await unlink(join(engine.cookieDir, `${c.id}.txt`)).catch(() => {});
    res.json({ ok: true });
  });
  app.post("/api/cookies/:id/verify", (req, res) => {
    if (!store.get("cookies", req.params.id))
      throw new TaskError("NOT_FOUND", "Cookie 实例不存在");
    res.json(engine.enqueue("cookie", undefined, { cookie_id: req.params.id }));
  });
  app.put("/api/settings", (req, res) => {
    engine.idle();
    const body = settingsSchema.parse(req.body);
    body.download_root = expandPath(body.download_root);
    store.transaction(() => {
      store.put<Settings>("settings", "global", body);
      for (const c of store.all<BackupConfig>("configs"))
        if (!c.download_dir) store.delete("snapshots", c.id);
    });
    res.json(body);
  });
  const deletionChecks = new Map<
    string,
    {
      config: string;
      bv: string;
      files: { path: string; identity: string }[];
      expires: number;
    }
  >();
  app.post("/api/configs/:id/delete-file", async (req, res) => {
    const c = engine.config(req.params.id);
    const body = z
      .object({ bv: bvSchema, confirmation: z.string().optional() })
      .parse(req.body);
    engine.idle();
    engine.fileOperation = true;
    // Scan each distinct root once per request, including shared config roots.
    const scans = new Map<string, Promise<Map<string, string[]>>>();
    function scan(root: string) {
      const key = expandPath(root);
      let result = scans.get(key);
      if (!result) {
        result = scanMedia(key);
        scans.set(key, result);
      }
      return result;
    }
    async function roots(cfg: BackupConfig) {
      return await Promise.all([
        cfg.library_dir
          ? scan(cfg.library_dir)
          : Promise.resolve(new Map<string, string[]>()),
        scan(engine.downloadDir(cfg)),
      ]);
    }
    try {
      for (const [key, value] of deletionChecks)
        if (value.expires < Date.now()) deletionChecks.delete(key);
      const maps = await roots(c);
      const paths = [
        ...new Set(maps.flatMap((map) => map.get(body.bv) || [])),
      ].sort();
      if (!paths.length)
        throw new TaskError("CONFLICT", "未找到本地文件，请刷新列表");
      const files = await Promise.all(
        paths.map(async (path) => ({
          path,
          identity: await fileIdentity(path),
        })),
      );
      if (!body.confirmation) {
        const confirmation = randomUUID();
        deletionChecks.set(confirmation, {
          config: c.id,
          bv: body.bv,
          files,
          expires: Date.now() + 300000,
        });
        res.json({ confirmation, files: paths });
        return;
      }
      const check = deletionChecks.get(body.confirmation);
      deletionChecks.delete(body.confirmation);
      if (
        !check ||
        check.config !== c.id ||
        check.bv !== body.bv ||
        JSON.stringify(check.files) !== JSON.stringify(files)
      )
        throw new TaskError(
          "CONFLICT",
          "文件已变化或确认已过期，请重新确认删除",
        );
      try {
        for (const file of files) {
          if ((await fileIdentity(file.path)) !== file.identity)
            throw new TaskError("CONFLICT", "文件已变化，请重新确认删除");
          await unlink(file.path);
          for (const scanned of scans.values()) {
            const map = await scanned;
            const remaining = (map.get(body.bv) || []).filter(
              (path) => path !== file.path,
            );
            if (remaining.length) map.set(body.bv, remaining);
            else map.delete(body.bv);
          }
          store.db
            .prepare("DELETE FROM media_files WHERE path=?")
            .run(file.path);
          for (const cfg of store.all<BackupConfig>("configs")) {
            const key = cfg.id + ":" + body.bv;
            if (
              store.get<{ path: string }>("receipts", key)?.path === file.path
            )
              store.delete("receipts", key);
          }
        }
      } finally {
        for (const cfg of store.all<BackupConfig>("configs")) {
          const snap = store.get<Snapshot>("snapshots", cfg.id);
          if (!snap?.items.some((i) => i.bv === body.bv)) continue;
          const [library, downloads] = await roots(cfg);
          const archived = library.has(body.bv);
          const staged = downloads.has(body.bv);
          for (const item of snap.items)
            if (item.bv === body.bv) {
              item.base_status = archived
                ? "archived"
                : staged
                  ? "staged"
                  : item.base_status === "removed"
                    ? "removed"
                    : "missing";
              item.verified = false;
              delete item.quality_error;
            }
          snap.id = randomUUID();
          store.put("snapshots", cfg.id, snap);
        }
      }
      res.json({ ok: true });
    } finally {
      engine.fileOperation = false;
    }
  });
  app.post("/api/configs/:id/archive", async (req, res) => {
    const c = engine.config(req.params.id);
    const body = z
      .object({
        bv: bvSchema,
        confirmedHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .parse(req.body);
    engine.idle();
    if (!c.library_dir.trim())
      throw new TaskError("VALIDATION", "请先在配置中设置存档目录");
    engine.fileOperation = true;
    try {
      const result = await archiveFile(
        engine.downloadDir(c),
        expandPath(c.library_dir),
        body.bv,
        body.confirmedHash,
      );
      if (result.status !== "duplicate")
        store.transaction(() => {
          for (const snapshotConfig of store.all<BackupConfig>("configs")) {
            const snap = store.get<Snapshot>("snapshots", snapshotConfig.id);
            if (snap && snapshotConfig.id === c.id) {
              snap.id = randomUUID();
              for (const item of snap.items)
                if (item.bv === body.bv) item.base_status = "archived";
              store.put("snapshots", snapshotConfig.id, snap);
            }
          }
          for (const receiptConfig of store.all<BackupConfig>("configs")) {
            const key = receiptConfig.id + ":" + body.bv;
            const receipt = store.get<{ path: string }>("receipts", key);
            if (receipt?.path === result.source)
              store.put("receipts", key, {
                ...receipt,
                path: result.destination,
              });
          }
          store.db
            .prepare(
              "UPDATE OR REPLACE media_files SET path=?,metadata=json_set(metadata,'$.path',?) WHERE path=?",
            )
            .run(result.destination, result.destination, result.source);
        });
      res.json(result);
    } finally {
      engine.fileOperation = false;
    }
  });
  async function resolveLocalFile(c: BackupConfig, bv: string) {
    const receipt = store.get<{ path: string }>("receipts", c.id + ":" + bv);
    const indexed = store.db
      .prepare(
        "SELECT f.path FROM media_files f JOIN media_sources s ON s.id=f.source_id WHERE s.platform='bilibili' AND s.external_id=?",
      )
      .all(bv) as { path: string }[];
    const roots = [
      c.library_dir ? expandPath(c.library_dir) : "",
      engine.downloadDir(c),
    ].filter(Boolean);
    const status = store
      .get<Snapshot>("snapshots", c.id)
      ?.items.find((i) => i.bv === bv)?.base_status;
    if (status === "staged") roots.reverse();
    const candidates = [
      ...new Set(
        [receipt?.path, ...indexed.map((row) => row.path)].filter(
          (path): path is string => !!path,
        ),
      ),
    ];
    // Verify recorded paths, rather than recursively enumerating both libraries on every click.
    for (const root of roots) {
      for (const path of candidates) {
        const rel = relative(root, path);
        if (
          !rel ||
          rel === ".." ||
          rel.startsWith("..\\") ||
          rel.startsWith("../") ||
          isAbsolute(rel)
        )
          continue;
        try {
          if (!(await lstat(path)).isFile()) continue;
          const physical = relative(await realpath(root), await realpath(path));
          if (
            physical &&
            physical !== ".." &&
            !physical.startsWith("..\\") &&
            !physical.startsWith("../") &&
            !isAbsolute(physical)
          )
            return path;
        } catch {
          /* An external move invalidates the saved path. */
        }
      }
    }
    for (const root of roots) {
      const path = (await scanMedia(root)).get(bv)?.[0];
      if (path) {
        engine.library.recordFile("bilibili", bv, { path });
        return path;
      }
    }
    return undefined;
  }
  app.post("/api/configs/:id/open-file", async (req, res) => {
    const c = engine.config(req.params.id);
    const { bv } = z.object({ bv: bvSchema }).parse(req.body);
    const path = await resolveLocalFile(c, bv);
    if (!path) throw new TaskError("CONFLICT", "未找到本地视频，请刷新列表");
    await openPath(path);
    res.json({ ok: true, path });
  });
  app.post("/api/configs/:id/open-folder", async (req, res) => {
    const config = engine.config(req.params.id);
    let path = engine.downloadDir(config);
    const body = z.object({ bv: bvSchema.optional() }).parse(req.body || {});
    if (body.bv) {
      const file = await resolveLocalFile(config, body.bv);
      if (!file) throw new TaskError("CONFLICT", "未找到本地视频，请刷新列表");
      path = dirname(file);
    }
    if (!(await exists(path)) || (await stat(path)).isDirectory() === false)
      throw new TaskError(
        "CONFLICT",
        "目录尚未创建，首次下载时会创建；现在可以复制路径",
      );
    await openPath(path);
    res.json({ ok: true, path });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ detail: "接口不存在" }),
  );
  app.use(express.static(join(root, "dist")));
  app.get("/", (_req, res) => res.sendFile(join(root, "dist/index.html")));
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (error instanceof z.ZodError) {
        res.status(422).json({
          detail: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("；"),
        });
        return;
      }
      if (error instanceof TaskError) {
        res
          .status(
            error.code === "NOT_FOUND"
              ? 404
              : ["VALIDATION", "COOKIE_INVALID"].includes(error.code)
                ? 422
                : 409,
          )
          .json({ detail: error.message });
        return;
      }
      res.status(500).json({ detail: "操作失败，请检查文件权限和请求格式" });
    },
  );
  return { app, store, engine };
}
