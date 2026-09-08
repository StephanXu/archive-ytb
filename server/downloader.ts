import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import {
  DOWNLOADER_VERSION,
  type CookieSource,
  type Settings,
} from "../shared/contracts.ts";
import { expandPath, normalizeBV } from "./paths.ts";
import { runProcess, TaskError, type RunOptions } from "./process.ts";

type Format = {
  format_id: string;
  width?: number;
  height?: number;
  vcodec?: string;
  acodec?: string;
};
export type VideoInfo = {
  id: string;
  title: string;
  upload_date?: string;
  requested_formats?: Format[];
};
export type Plan = {
  bv: string;
  title: string;
  date: string;
  format: string;
  width: number;
  height: number;
};
export type CookieRow = {
  domain: string;
  subdomains: boolean;
  path: string;
  secure: boolean;
  expires: number;
  name: string;
  value: string;
  line: string;
};
export function parseCookies(text: string): CookieRow[] {
  if (
    !/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/.test(
      text.replace(/^\uFEFF/, ""),
    )
  )
    throw new TaskError("COOKIE_INVALID", "需要 Netscape 格式 Cookie 文件");
  const rows: CookieRow[] = [];
  for (let line of text.split(/\r?\n/)) {
    if (line.startsWith("#HttpOnly_")) line = line.slice(10);
    else if (line.startsWith("#") || !line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length !== 7)
      throw new TaskError("COOKIE_INVALID", "Cookie 文件格式不正确");
    const [domain, subdomains, path, secure, expires, name, value] = parts;
    const d = domain.replace(/^\./, "").toLowerCase();
    if (d !== "bilibili.com" && !d.endsWith(".bilibili.com")) continue;
    if (
      !/^[A-Za-z0-9_!#$%&'*+.^`|~-]+$/.test(name) ||
      /[\x00-\x20\x7f;]/.test(value) ||
      !Number.isFinite(Number(expires))
    )
      throw new TaskError("COOKIE_INVALID", "Cookie 字段无效");
    rows.push({
      domain,
      subdomains: subdomains === "TRUE",
      path,
      secure: secure === "TRUE",
      expires: Number(expires),
      name,
      value,
      line,
    });
  }
  if (
    !rows.some(
      (c) =>
        c.name === "SESSDATA" &&
        c.value &&
        (c.expires === 0 || c.expires > Date.now() / 1000),
    )
  )
    throw new TaskError(
      "COOKIE_INVALID",
      "B 站 SESSDATA 缺失或过期，请更新 Cookie",
    );
  return rows;
}
export const serializeCookies = (rows: CookieRow[]) =>
  "# Netscape HTTP Cookie File\n" + rows.map((c) => c.line).join("\n") + "\n";
export function apiCookieHeader(rows: CookieRow[], path: string) {
  const host = "api.bilibili.com";
  return rows
    .filter((c) => {
      const domain = c.domain.replace(/^\./, "").toLowerCase();
      return (
        (c.expires === 0 || c.expires > Date.now() / 1000) &&
        (host === domain || (c.subdomains && host.endsWith("." + domain))) &&
        (path === c.path ||
          path.startsWith(c.path.endsWith("/") ? c.path : c.path + "/"))
      );
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}
export async function validateCookie(path: string, signal?: AbortSignal) {
  let rows: CookieRow[];
  try {
    rows = parseCookies(await readFile(path, "utf8"));
  } catch (e) {
    if (e instanceof TaskError) throw e;
    throw new TaskError("COOKIE_INVALID", "无法读取 Cookie 文件");
  }
  const host = "api.bilibili.com";
  const header = rows
    .filter(
      (c) =>
        (c.expires === 0 || c.expires > Date.now() / 1000) &&
        (host === c.domain.replace(/^\./, "") ||
          (c.subdomains && host.endsWith("." + c.domain.replace(/^\./, "")))) &&
        "/x/web-interface/nav".startsWith(c.path),
    )
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  try {
    const response = await fetch(
      "https://api.bilibili.com/x/web-interface/nav",
      {
        headers: {
          Cookie: header,
          Referer: "https://www.bilibili.com/",
          "User-Agent": "Mozilla/5.0",
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(20000),
          ...(signal ? [signal] : []),
        ]),
      },
    );
    const payload = (await response.json()) as {
      code: number;
      data?: { isLogin: boolean };
    };
    if (!response.ok || payload.code !== 0 || payload.data?.isLogin !== true)
      throw Error("invalid");
  } catch {
    if (signal?.aborted) throw new TaskError("CANCELLED", "任务已取消");
    throw new TaskError(
      "COOKIE_INVALID",
      "Cookie 无效或无法在线验证；已停止任务，请更新或重试。",
    );
  }
}
export function selectPlan(info: VideoInfo, bv: string): Plan {
  const video = info.requested_formats?.find(
    (f) => f.vcodec && f.vcodec !== "none" && f.width && f.height,
  );
  const audio = info.requested_formats?.find(
    (f) => f.acodec && f.acodec !== "none" && f.vcodec === "none",
  );
  if (!video || !audio || !video.width || !video.height)
    throw new TaskError(
      "FORMAT_UNAVAILABLE",
      "未找到最高画质的独立视频与音频格式",
    );
  if (
    !/^[A-Za-z0-9_.-]+$/.test(video.format_id) ||
    !/^[A-Za-z0-9_.-]+$/.test(audio.format_id)
  )
    throw new TaskError("FORMAT_UNAVAILABLE", "格式 ID 无效");
  const date = info.upload_date;
  if (!date || !/^\d{8}$/.test(date))
    throw new TaskError("DATE_UNAVAILABLE", "无法核验发布日期");
  return {
    bv,
    title: info.title || bv,
    date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`,
    format: `${video.format_id}+${audio.format_id}`,
    width: video.width,
    height: video.height,
  };
}
export class Downloader {
  binary: string;
  private verified = false;
  constructor(
    public root: string,
    private runner: typeof runProcess = runProcess,
  ) {
    this.binary = join(
      root,
      "bin",
      process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp",
    );
  }
  async check(signal?: AbortSignal) {
    if (this.verified) return;
    const version = (
      await this.runner(
        this.binary,
        ["--ignore-config", "--encoding", "utf-8", "--version"],
        {
          signal,
          timeout: 20000,
        },
      )
    ).trim();
    if (version !== DOWNLOADER_VERSION)
      throw new TaskError(
        "VERSION_MISMATCH",
        `需要 yt-dlp ${DOWNLOADER_VERSION}，请运行 npm run setup:downloader`,
      );
    this.verified = true;
  }
  async withCookie<T>(
    source: CookieSource,
    folder: string,
    signal: AbortSignal,
    fn: (path: string) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(join(folder, "session-"));
    const path = join(dir, "cookies.txt");
    try {
      if (source.kind === "browser") {
        await this.check(signal);
        // Export occurs only during a user-requested check/job; never during page reads.
        const spec =
          source.browser + (source.profile ? ":" + source.profile : "");
        const empty = join(dir, "empty-playlist.json");
        await writeFile(
          empty,
          JSON.stringify({
            _type: "playlist",
            id: "cookie-export",
            title: "Cookie export",
            entries: [],
          }),
        );
        await this.runner(
          this.binary,
          [
            "--ignore-config",
            "--encoding",
            "utf-8",
            "--cookies-from-browser",
            spec,
            "--cookies",
            path,
            "--load-info-json",
            empty,
            "--skip-download",
            "--no-warnings",
          ],
          { signal, timeout: 120000 },
        );
      } else {
        try {
          await writeFile(path, await readFile(expandPath(source.path)), {
            mode: 0o600,
          });
        } catch {
          throw new TaskError("COOKIE_INVALID", "Cookie 文件无法读取");
        }
      }
      const filtered = serializeCookies(
        parseCookies(await readFile(path, "utf8")),
      );
      await writeFile(path, filtered, { mode: 0o600 });
      await validateCookie(path, signal);
      return await fn(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  async json<T>(
    cookie: string,
    args: string[],
    signal: AbortSignal,
  ): Promise<T> {
    await this.check(signal);
    try {
      return JSON.parse(
        await this.runner(
          this.binary,
          [
            "--ignore-config",
            "--encoding",
            "utf-8",
            "--cookies",
            cookie,
            "--no-warnings",
            "--socket-timeout",
            "20",
            "--retries",
            "2",
            "--dump-single-json",
            ...args,
          ],
          { signal },
        ),
      );
    } catch (e) {
      if (signal.aborted) throw e;
      await validateCookie(cookie, signal);
      throw e instanceof TaskError
        ? e
        : new TaskError("EXTRACTOR_FAILED", "yt-dlp 返回的清单无效");
    }
  }
  async playlist(cookie: string, url: string, signal: AbortSignal) {
    const source = new URL(url);
    const match = source.pathname.match(
      /^\/(\d+)\/(?:lists\/(\d+)|channel\/collectiondetail)\/?$/,
    );
    const sid = match?.[2] || source.searchParams.get("sid");
    if (
      source.hostname === "space.bilibili.com" &&
      match &&
      sid &&
      /^\d+$/.test(sid) &&
      source.searchParams.get("type") !== "series"
    ) {
      // Retain metadata already present in collection pages; no video detail requests.
      const path = "/x/polymer/web-space/seasons_archives_list";
      const header = apiCookieHeader(
        parseCookies(await readFile(cookie, "utf8")),
        path,
      );
      const entries: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      let total: number | undefined;
      let size = 100;
      try {
        for (let page = 1; ; page++) {
          const endpoint = new URL("https://api.bilibili.com" + path);
          endpoint.search = new URLSearchParams({
            mid: match[1],
            season_id: sid,
            page_num: String(page),
            page_size: String(size),
          }).toString();
          const response = await fetch(endpoint, {
            headers: {
              Cookie: header,
              Referer: url,
              "User-Agent": "Mozilla/5.0",
            },
            redirect: "error",
            signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          });
          const payload = (await response.json()) as {
            code: number;
            data?: {
              page?: { page_num: number; page_size: number; total: number };
              archives?: Record<string, unknown>[];
            };
          };
          const data = payload.data,
            meta = data?.page;
          if (
            !response.ok ||
            payload.code !== 0 ||
            !meta ||
            !Array.isArray(data?.archives) ||
            !Number.isSafeInteger(meta.total) ||
            meta.total < 0 ||
            !Number.isSafeInteger(meta.page_size) ||
            meta.page_size < 1 ||
            meta.page_size > 100 ||
            meta.page_num !== page ||
            (total !== undefined &&
              (meta.total !== total || meta.page_size !== size))
          )
            throw new TaskError(
              "PLAYLIST_INVALID",
              "合集分页响应无效或已变化，请重新刷新；保留旧快照",
            );
          total = meta.total;
          size = meta.page_size;
          if (data.archives.length !== Math.min(size, total - entries.length))
            throw new TaskError(
              "PLAYLIST_INCOMPLETE",
              "合集分页不完整；保留旧快照，请重试",
            );
          for (const item of data.archives) {
            const bv =
              typeof item.bvid === "string" &&
              /^BV[0-9A-Za-z]{10}$/.test(item.bvid)
                ? item.bvid
                : null;
            if (!bv || seen.has(bv))
              throw new TaskError(
                "PLAYLIST_INVALID",
                "合集存在无效或重复 BV；保留旧快照",
              );
            seen.add(bv);
            // yt-dlp derives upload_date from the publication timestamp in UTC.
            const timestamp =
              typeof item.pubdate === "number" && item.pubdate > 0
                ? item.pubdate
                : NaN;
            const date = new Date(timestamp * 1000);
            entries.push({
              thumbnail:
                typeof item.pic === "string" &&
                /^https?:\/\/[^/]+\.hdslb\.com\//.test(item.pic)
                  ? item.pic.replace(/^http:/, "https:")
                  : undefined,
              id: bv,
              title: typeof item.title === "string" ? item.title : bv,
              upload_date: Number.isFinite(date.getTime())
                ? date.toISOString().slice(0, 10).replaceAll("-", "")
                : undefined,
            });
          }
          if (entries.length === total) return { entries };
        }
      } catch (e) {
        if (signal.aborted) throw new TaskError("CANCELLED", "任务已取消");
        await validateCookie(cookie, signal);
        if (e instanceof TaskError) throw e;
        throw new TaskError(
          "PLAYLIST_FAILED",
          "无法读取合集列表，请重试；保留旧快照",
        );
      }
    }
    return this.json<{ entries: Record<string, unknown>[] }>(
      cookie,
      ["--flat-playlist", "--", url],
      signal,
    );
  }
  async plan(cookie: string, bv: string, signal: AbortSignal) {
    const info = await this.json<VideoInfo>(
      cookie,
      [
        "--no-playlist",
        "--skip-download",
        "--check-formats",
        "--format",
        "bestvideo+bestaudio",
        "--",
        `https://www.bilibili.com/video/${bv}`,
      ],
      signal,
    );
    await validateCookie(cookie, signal);
    if (normalizeBV(info.id) !== bv)
      throw new TaskError("ID_MISMATCH", "返回的视频与待下载 BV 不一致");
    return selectPlan(info, bv);
  }
  async verify(
    path: string,
    plan: Plan,
    settings: Settings,
    signal: AbortSignal,
  ) {
    const info = JSON.parse(
      await this.runner(
        settings.ffprobe,
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height",
          "-of",
          "json",
          path,
        ],
        { signal, timeout: 30000 },
      ),
    ) as { streams?: { width: number; height: number }[] };
    if (
      info.streams?.[0]?.width !== plan.width ||
      info.streams?.[0]?.height !== plan.height
    )
      throw new TaskError(
        "QUALITY_MISMATCH",
        "本地文件尺寸与当前最高画质不一致；文件保留，未计为完成",
      );
    const s = await stat(path);
    if (!s.size) throw new TaskError("EMPTY_FILE", "成品文件为空");
    return {
      path,
      size: s.size,
      mtime: s.mtimeMs,
      width: plan.width,
      height: plan.height,
    };
  }
  async download(
    cookie: string,
    dir: string,
    plan: Plan,
    settings: Settings,
    signal: AbortSignal,
    onProgress: (p: number) => void,
  ) {
    await validateCookie(cookie, signal);
    let outputPath = "";
    const reportProgress = (line: string) => {
      if (!line.startsWith("AF_PROGRESS:")) return;
      const p = Number.parseFloat(line.slice(12));
      if (Number.isFinite(p)) onProgress(Math.max(0, Math.min(100, p)));
    };
    const options: RunOptions = {
      signal,
      timeout: 6 * 60 * 60 * 1000,
      onLine: (line) => {
        if (line.startsWith("AF_PATH:")) outputPath = line.slice(8).trim();
        reportProgress(line);
      },
      onStderrLine: reportProgress,
    };
    try {
      await this.runner(
        this.binary,
        [
          "--ignore-config",
          "--encoding",
          "utf-8",
          "--cookies",
          cookie,
          "--no-playlist",
          "--check-formats",
          "--format",
          plan.format,
          "--merge-output-format",
          "mp4",
          "--remux-video",
          "mp4",
          ...(settings.ffmpeg === "ffmpeg"
            ? []
            : ["--ffmpeg-location", settings.ffmpeg]),
          "--embed-thumbnail",
          "--no-write-thumbnail",
          "--embed-metadata",
          "--windows-filenames",
          "--no-overwrites",
          "--newline",
          "--progress",
          "--progress-template",
          "download:AF_PROGRESS:%(progress._percent_str)s",
          "--print",
          "after_move:AF_PATH:%(filepath)s",
          "--no-simulate",
          "--socket-timeout",
          "20",
          "--retries",
          "3",
          "--fragment-retries",
          "3",
          "--output",
          join(dir, "[%(upload_date>%Y-%m-%d)s] %(title)s [%(id)s].%(ext)s"),
          "--",
          `https://www.bilibili.com/video/${plan.bv}`,
        ],
        options,
      );
    } catch (e) {
      if (signal.aborted) throw e;
      await validateCookie(cookie, signal);
      throw e;
    }
    await validateCookie(cookie, signal);
    const rel = relative(resolve(dir), resolve(outputPath));
    if (
      !outputPath ||
      isAbsolute(rel) ||
      rel.startsWith("..") ||
      normalizeBV(outputPath) !== plan.bv
    )
      throw new TaskError("OUTPUT_INVALID", "下载成功但成品路径无效");
    return this.verify(outputPath, plan, settings, signal);
  }
}
