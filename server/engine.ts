import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "smol-toml";
import { DEFAULT_DOWNLOAD_ROOT } from "../shared/contracts.ts";
import type {
  BackupConfig,
  CookieSource,
  Settings,
  Snapshot,
  DiffItem,
  Counts,
  Job,
  ConfigView,
} from "../shared/contracts.ts";
import { Library } from "./library.ts";
import { Store } from "./store.ts";
import {
  expandPath,
  safeName,
  scanMedia,
  normalizeBV,
  executable,
} from "./paths.ts";
import { Downloader, validateCookie } from "./downloader.ts";
import { TaskError } from "./process.ts";
import { StorageManager } from "./storage.ts";

export const now = () => Date.now() / 1000;
export const isActive = (j: Job) =>
  j.status === "queued" || j.status === "running";
export class Engine {
  controller?: AbortController;
  currentJob?: string;
  timer?: NodeJS.Timeout;
  stopped = false;
  processing = false;
  pumpPromise?: Promise<void>;
  cookieDir: string;
  library: Library;
  storage: StorageManager;
  transferPromise?: Promise<unknown>;
  constructor(
    public store: Store,
    public downloader: Downloader,
    legacy?: string,
  ) {
    this.storage = new StorageManager(
      store,
      () => this.settings(),
      downloader.root,
    );
    this.library = new Library(store);
    for (const row of store.db
      .prepare("SELECT id,body FROM documents WHERE kind='snapshots'")
      .all() as { id: string; body: string }[])
      this.library.ingest(row.id, JSON.parse(row.body));
    for (const receipt of store.all<{ bv: string; path: string }>("receipts"))
      if (receipt.bv && receipt.path)
        this.library.recordFile("bilibili", receipt.bv, receipt);
    this.library.cacheCovers();
    this.cookieDir = join(store.root, "cookies");
    mkdirSync(this.cookieDir, { recursive: true, mode: 0o700 });
    if (!store.get("settings", "global")) {
      const firstRun = !store.configuration.exists;
      store.transaction(() => {
        store.put<Settings>("settings", "global", {
          download_root: DEFAULT_DOWNLOAD_ROOT,
          ffprobe: "ffprobe",
          ffmpeg: "ffmpeg",
        });
        if (firstRun && legacy && existsSync(legacy)) this.importLegacy(legacy);
      });
    }
    this.storage.migrate();
    for (const job of store.all<Job>("jobs"))
      if (isActive(job))
        this.updateJob(job.id, {
          status: "interrupted",
          message: "服务重启，任务已中断；请重新执行。",
        });
  }
  importLegacy(file: string) {
    const raw = parse(readFileSync(file, "utf8")) as {
      global?: { cookie_file?: string };
      tasks?: {
        name: string;
        season_url: string;
        library_dir: string;
        download_dir?: string;
        after_date?: unknown;
      }[];
    };
    const cookieId = raw.global?.cookie_file ? randomUUID() : "";
    if (cookieId)
      this.store.put<CookieSource>("cookies", cookieId, {
        id: cookieId,
        name: "原配置 Cookie",
        kind: "file",
        path: expandPath(raw.global!.cookie_file!, dirname(file)),
        browser: "chrome",
        profile: "",
        status: "未验证",
      });
    for (const row of raw.tasks || []) {
      const id = randomUUID();
      this.store.put<BackupConfig>("configs", id, {
        id,
        name: row.name,
        season_url: row.season_url,
        library_dir: expandPath(row.library_dir, dirname(file)),
        download_dir: row.download_dir
          ? expandPath(row.download_dir, dirname(file))
          : "",
        after_date:
          row.after_date instanceof Date
            ? row.after_date.toISOString().slice(0, 10)
            : row.after_date
              ? String(row.after_date).slice(0, 10)
              : "",
        cookie_id: cookieId,
        excluded: [],
        interval_minutes: 0,
        auto_download: false,
        next_run: null,
      });
    }
  }
  settings() {
    return this.store.get<Settings>("settings", "global")!;
  }
  config(id: string) {
    const row = this.store.get<BackupConfig>("configs", id);
    if (!row) throw new TaskError("NOT_FOUND", "配置不存在");
    return row;
  }
  downloadDir(c: BackupConfig) {
    return expandPath(
      c.download_dir ||
        join(expandPath(this.settings().download_root), safeName(c.name)),
    );
  }
  diff(c: BackupConfig): DiffItem[] {
    const excluded = new Set(c.excluded);
    return (this.store.get<Snapshot>("snapshots", c.id)?.items || []).map(
      (i) => ({
        ...i,
        cover_id: this.library.coverId("bilibili", i.bv),
        status: ["archived", "staged"].includes(i.base_status)
          ? i.base_status
          : excluded.has(i.bv)
            ? "excluded"
            : i.base_status === "missing" &&
                c.after_date &&
                i.date &&
                i.date <= c.after_date
              ? "filtered"
              : i.base_status,
      }),
    );
  }
  counts(items: DiffItem[]): Counts {
    const counts: Counts = {
      missing: 0,
      archived: 0,
      staged: 0,
      excluded: 0,
      filtered: 0,
      removed: 0,
    };
    for (const i of items) counts[i.status || i.base_status]++;
    return counts;
  }
  views(): ConfigView[] {
    return this.store.all<BackupConfig>("configs").map((c) => ({
      ...c,
      resolved_download_dir: this.downloadDir(c),
      refreshed_at:
        this.store.get<Snapshot>("snapshots", c.id)?.refreshed_at || null,
      counts: this.counts(this.diff(c)),
    }));
  }
  fileOperation = false;
  transfer<T>(
    kind: "archive" | "retrieve",
    c: BackupConfig,
    bv: string,
    fn: (ctx: {
      signal: AbortSignal;
      message: (value: string) => void;
      progress: (value: number) => void;
    }) => Promise<T>,
  ): Promise<T> {
    this.idle();
    if (this.stopped) throw new TaskError("STOPPING", "服务正在关闭");
    // File transfers use the same global lock and durable task record as downloads.
    const job: Job = {
      id: randomUUID(),
      kind,
      config_id: c.id,
      current_bv: bv,
      total: 1,
      done: 0,
      failures: [],
      status: "running",
      message: "准备中",
      created_at: now(),
      updated_at: now(),
    };
    this.store.put("jobs", job.id, job);
    this.fileOperation = true;
    this.currentJob = job.id;
    this.controller = new AbortController();
    this.updateJob(job.id, {
      status: "running",
      message: kind === "archive" ? "准备存档" : "准备取回",
    });
    const promise = fn({
      signal: this.controller.signal,
      message: (message) => this.updateJob(job.id, { message, progress: 0 }),
      progress: (progress) => this.updateJob(job.id, { progress }),
    })
      .then((result) => {
        this.updateJob(job.id, {
          status: "completed",
          message: "已完成",
          done: 1,
          progress: 100,
        });
        return result;
      })
      .catch((error) => {
        this.updateJob(job.id, {
          status: this.stopped
            ? "interrupted"
            : error instanceof TaskError && error.code === "CANCELLED"
              ? "cancelled"
              : "failed",
          message:
            error instanceof TaskError
              ? error.message
              : "存储操作失败，本地文件已保留",
          error_code:
            error instanceof TaskError ? error.code : "STORAGE_FAILED",
          error_details: error instanceof TaskError ? error.details : undefined,
        });
        throw error;
      })
      .finally(() => {
        this.fileOperation = false;
        this.currentJob = undefined;
        this.controller = undefined;
      });
    this.transferPromise = promise;
    return promise;
  }
  busy(id?: string) {
    if (this.fileOperation) return true;
    return this.store
      .all<Job>("jobs")
      .some((j) => isActive(j) && (!id || j.config_id === id));
  }
  idle(id?: string) {
    if (this.busy(id))
      throw new TaskError("BUSY", "请等待相关任务结束后再修改配置");
  }
  updateJob(id: string, fields: Partial<Job>) {
    const j = this.store.get<Job>("jobs", id)!;
    this.store.put("jobs", id, { ...j, ...fields, updated_at: now() });
  }
  enqueue(kind: Job["kind"], config_id?: string, extras: Partial<Job> = {}) {
    if (this.fileOperation)
      throw new TaskError("BUSY", "文件存档中，请稍后再试");
    if (this.stopped) throw new TaskError("STOPPING", "服务正在关闭");
    if (config_id) this.idle(config_id);
    if (
      kind === "cookie" &&
      this.store
        .all<Job>("jobs")
        .some((j) => j.cookie_id === extras.cookie_id && isActive(j))
    )
      throw new TaskError("BUSY", "此 Cookie 已有验证任务");
    const job: Job = {
      id: randomUUID(),
      kind,
      config_id,
      status: "queued",
      message: "等待执行",
      created_at: now(),
      updated_at: now(),
      done: 0,
      total: 0,
      failures: [],
      ...extras,
    };
    this.store.put("jobs", job.id, job);
    if (this.timer) void this.pump();
    return job;
  }
  start() {
    this.timer = setInterval(() => this.tick(), 5000);
    void this.pump();
  }
  tick() {
    if (this.stopped) return;
    for (const c of this.store.all<BackupConfig>("configs")) {
      if (
        c.interval_minutes &&
        (c.next_run || 0) <= now() &&
        !this.busy(c.id)
      ) {
        this.enqueue("refresh", c.id, { scheduled: true });
        c.next_run = now() + c.interval_minutes * 60;
        this.store.put("configs", c.id, c);
      }
    }
  }
  cancel(id: string) {
    const j = this.store.get<Job>("jobs", id);
    if (!j || !isActive(j)) throw new TaskError("CONFLICT", "任务已经结束");
    if (j.status === "queued")
      this.updateJob(id, { status: "cancelled", message: "已取消" });
    else if (this.currentJob === id) this.controller?.abort();
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    this.controller?.abort();
    await this.pumpPromise;
    await this.transferPromise?.catch(() => {});
    await this.storage.rpc.close();
    await this.library.close();
  }
  pump() {
    if (this.processing || this.stopped || this.fileOperation)
      return this.pumpPromise;
    this.processing = true;
    this.pumpPromise = this.work().finally(() => {
      this.processing = false;
    });
    return this.pumpPromise;
  }
  private async work() {
    while (!this.stopped) {
      const job = this.store
        .all<Job>("jobs")
        .find((j) => j.status === "queued");
      if (!job) break;
      this.currentJob = job.id;
      this.controller = new AbortController();
      const signal = this.controller.signal;
      this.updateJob(job.id, { status: "running", message: "准备中" });
      const cfg = job.config_id ? this.config(job.config_id) : undefined;
      const cookie = this.store.get<CookieSource>(
        "cookies",
        job.cookie_id || cfg?.cookie_id || "",
      );
      try {
        if (!cookie)
          throw new TaskError("COOKIE_INVALID", "请先为配置选择 Cookie 实例");
        await this.downloader.withCookie(
          cookie,
          this.cookieDir,
          signal,
          async (path) => {
            this.store.put("cookies", cookie.id, {
              ...cookie,
              status: "可用",
              checked_at: now(),
              hint: "",
            });
            if (job.kind === "refresh")
              await this.refresh(cfg!, job.id, path, signal);
            else if (job.kind === "download")
              await this.download(cfg!, job, path, signal);
          },
        );
        const result = this.store.get<Job>("jobs", job.id)!;
        this.updateJob(job.id, {
          status: result.failures.length ? "partial" : "completed",
          message: result.failures.length
            ? "部分条目失败，请查看详情"
            : "已完成",
        });
        if (
          job.scheduled &&
          job.kind === "refresh" &&
          cfg?.auto_download &&
          !this.stopped
        )
          this.enqueue("download", cfg.id);
      } catch (e) {
        this.controller?.abort();
        const error =
          e instanceof TaskError
            ? e
            : new TaskError(
                "TASK_FAILED",
                "任务失败，请检查路径、网络与文件权限",
              );
        if (
          cookie &&
          ["COOKIE_INVALID", "BROWSER_COOKIE"].includes(error.code)
        ) {
          this.store.put("cookies", cookie.id, {
            ...cookie,
            status: "验证失败",
            checked_at: now(),
            hint: error.message,
          });
        }
        this.updateJob(job.id, {
          status:
            error.code === "CANCELLED"
              ? this.stopped
                ? "interrupted"
                : "cancelled"
              : "failed",
          message: error.message,
          error_code: error.code,
          error_details: error.details,
        });
      } finally {
        this.currentJob = undefined;
        this.controller = undefined;
      }
    }
  }
  async refresh(
    cfg: BackupConfig,
    key: string,
    cookie: string,
    signal: AbortSignal,
  ) {
    this.updateJob(key, { message: "读取合集清单与存储索引" });
    const [payload, library, staged] = await Promise.all([
      this.downloader.playlist(cookie, cfg.season_url, signal),
      this.storage.scan(cfg, { signal }),
      scanMedia(this.downloadDir(cfg)),
    ]);
    if (!Array.isArray(payload.entries) || !payload.entries.length)
      throw new TaskError(
        "EMPTY_PLAYLIST",
        "合集清单为空或不可访问；保留上一次 diff",
      );
    await validateCookie(cookie, signal);
    const items: DiffItem[] = [],
      seen = new Set<string>();
    for (const e of payload.entries) {
      const bv = normalizeBV(e?.id || e?.url);
      if (!bv)
        throw new TaskError("BAD_PLAYLIST", "清单包含无效 BV；保留上一次 diff");
      if (seen.has(bv)) continue;
      seen.add(bv);
      const date = String(e.upload_date || "");
      const status = library.has(bv)
        ? "archived"
        : staged.has(bv)
          ? "staged"
          : "missing";
      items.push({
        bv,
        title: String(e.title || bv),
        thumbnail: typeof e.thumbnail === "string" ? e.thumbnail : undefined,
        url: `https://www.bilibili.com/video/${bv}`,
        date: /^\d{8}$/.test(date)
          ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
          : null,
        base_status: status,
      });
    }
    const previous = this.store.get<Snapshot>("snapshots", cfg.id);
    for (const old of previous?.items || [])
      if (!seen.has(old.bv))
        items.push({ ...old, base_status: "removed", verified: false });
    if (signal.aborted) throw new TaskError("CANCELLED", "任务已取消");
    this.store.put<Snapshot>("snapshots", cfg.id, {
      id: randomUUID(),
      refreshed_at: now(),
      items,
    });
    this.library.ingest(cfg.id, this.store.get<Snapshot>("snapshots", cfg.id)!);
    this.library.cacheCovers();
    this.updateJob(key, { done: seen.size, total: seen.size });
  }
  async download(
    cfg: BackupConfig,
    job: Job,
    cookie: string,
    signal: AbortSignal,
  ) {
    const snapshot = this.store.get<Snapshot>("snapshots", cfg.id);
    if (!snapshot) throw new TaskError("NO_DIFF", "请先刷新列表");
    const settings = this.settings();
    if (
      !(await executable(settings.ffprobe)) ||
      !(await executable(settings.ffmpeg))
    )
      throw new TaskError(
        "MEDIA_TOOLS_MISSING",
        "请先安装 ffmpeg / ffprobe，或在全局设置填写路径",
      );
    const chosen = job.selected ? new Set(job.selected) : null;
    const items = this.diff(cfg).filter(
      (i) =>
        (i.status === "missing" || i.status === "staged") &&
        (!chosen || chosen.has(i.bv)),
    );
    const dir = this.downloadDir(cfg);
    this.updateJob(job.id, { total: items.length });
    const failures: Job["failures"] = [];
    for (const [index, item] of items.entries()) {
      if (signal.aborted) throw new TaskError("CANCELLED", "任务已取消");
      if (this.config(cfg.id).excluded.includes(item.bv)) {
        this.updateJob(job.id, { done: index + 1 });
        continue;
      }
      this.updateJob(job.id, {
        message: `获取视频信息 · ${item.title}`,
        current_bv: item.bv,
        progress: 0,
      });
      try {
        // Recheck disk after the user may have moved files since preview.
        const library = await this.storage.scan(cfg, { signal });
        if (library.has(item.bv)) {
          this.mark(snapshot, item.bv, "archived");
          continue;
        }
        const plan = await this.downloader.plan(cookie, item.bv, signal);
        if (cfg.after_date && plan.date <= cfg.after_date) {
          this.mark(snapshot, item.bv, "filtered", plan.date);
          continue;
        }
        if (this.config(cfg.id).excluded.includes(item.bv)) continue;
        const staged = (await scanMedia(dir)).get(item.bv) || [];
        let receipt;
        if (staged.length) {
          this.updateJob(job.id, { message: `校验本地文件 · ${item.title}` });
          for (const path of staged) {
            try {
              receipt = await this.downloader.verify(
                path,
                plan,
                settings,
                signal,
              );
              break;
            } catch (e) {
              if (signal.aborted) throw e;
            }
          }
          if (!receipt)
            throw new TaskError(
              "QUALITY_MISMATCH",
              "下载目录已有同 BV 文件但未通过最高画质检查；请移走文件后重试",
            );
        } else {
          await mkdir(dir, { recursive: true });
          this.updateJob(job.id, { message: `下载中 · ${plan.title}` });
          let last = 0;
          receipt = await this.downloader.download(
            cookie,
            dir,
            plan,
            settings,
            signal,
            (p) => {
              if (p === 100 || Date.now() - last > 700) {
                this.updateJob(job.id, { progress: p });
                last = Date.now();
              }
            },
          );
        }
        this.store.put("receipts", cfg.id + ":" + item.bv, {
          ...receipt,
          bv: item.bv,
          format: plan.format,
          date: plan.date,
          verified_at: now(),
        });
        this.library.recordFile("bilibili", item.bv, receipt);
        this.mark(snapshot, item.bv, "staged", plan.date, true);
      } catch (e) {
        const error =
          e instanceof TaskError
            ? e
            : new TaskError("ITEM_FAILED", "条目处理失败");
        if (["COOKIE_INVALID", "CANCELLED"].includes(error.code)) throw error;
        if (error.code === "QUALITY_MISMATCH") {
          const failed = snapshot.items.find((i) => i.bv === item.bv);
          if (failed) {
            failed.quality_error = error.message;
            failed.verified = false;
          }
        }
        failures.push({
          bv: item.bv,
          message: error.message,
          code: error.code,
          details: error.details,
        });
      } finally {
        this.store.put("snapshots", cfg.id, snapshot);
        this.updateJob(job.id, { done: index + 1, failures, progress: 0 });
      }
    }
  }
  private mark(
    snapshot: Snapshot,
    bv: string,
    status: DiffItem["base_status"],
    date?: string,
    verified = false,
  ) {
    const item = snapshot.items.find((i) => i.bv === bv);
    if (item) {
      item.base_status = status;
      item.verified = verified;
      delete item.quality_error;
      if (date) item.date = date;
    }
  }
}
