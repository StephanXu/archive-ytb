import express from "express";
import { z } from "zod";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { unlink, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
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
}: {
  root: string;
  stateDir: string;
  legacy?: string;
  token?: string;
  downloader?: Downloader;
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
            "name",
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
  app.put("/api/configs/:id/excluded", (req, res) => {
    const body = z
        .object({ excluded: z.array(bvSchema).max(50000) })
        .parse(req.body),
      c = engine.config(req.params.id);
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
  app.post("/api/configs/:id/open-folder", async (req, res) => {
    const config = engine.config(req.params.id);
    let path = engine.downloadDir(config);
    const body = z.object({ bv: bvSchema.optional() }).parse(req.body || {});
    if (body.bv) {
      const roots = [
        config.library_dir ? expandPath(config.library_dir) : "",
        path,
      ].filter(Boolean);
      let file: string | undefined;
      for (const root of roots) {
        file = (await scanMedia(root)).get(body.bv)?.[0];
        if (file) break;
      }
      if (!file) throw new TaskError("CONFLICT", "未找到本地视频，请刷新 diff");
      path = dirname(file);
    }
    if (!(await exists(path)) || (await stat(path)).isDirectory() === false)
      throw new TaskError(
        "CONFLICT",
        "目录尚未创建，首次下载时会创建；现在可以复制路径",
      );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.platform === "win32"
          ? "explorer.exe"
          : process.platform === "darwin"
            ? "open"
            : "xdg-open",
        [path],
        { windowsHide: true, stdio: "ignore" },
      );
      child.once("error", () =>
        reject(new TaskError("OPEN_FAILED", "无法打开文件管理器，请复制路径")),
      );
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
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
