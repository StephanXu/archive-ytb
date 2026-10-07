import { z } from "zod";

export const DOWNLOADER_VERSION = "2026.08.19";
export const RCLONE_VERSION = "1.75.1";
export const DEFAULT_DOWNLOAD_ROOT = "~/Downloads/ArchiveFlow";
export const bvSchema = z
  .string()
  .regex(/^BV[0-9A-Za-z]{10}$/, "请输入完整 BV 号，保留大小写");
export const configSchema = z.object({
  name: z.string().trim().min(1).max(100),
  season_url: z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        u.protocol === "https:" &&
        u.hostname === "space.bilibili.com" &&
        !u.port &&
        !u.username &&
        !u.password &&
        /^\/\d+\/(lists\/\d+|channel\/collectiondetail)/.test(u.pathname)
      );
    }, "请输入 Bilibili 空间合集 HTTPS 链接"),
  cookie_id: z.string().default(""),
  library_dir: z.string().max(2000).default(""),
  storage_name: z.string().trim().max(100).optional(),
  download_dir: z.string().trim().max(2000).default(""),
  directory_template: z
    .enum(["", "{{YYYY}}/{{MM}}/", "{{YYYY}}-{{MM}}/", "{{YYYY}}/"])
    .optional(),
  after_date: z.union([z.literal(""), z.iso.date()]).default(""),
  interval_minutes: z
    .number()
    .int()
    .min(0)
    .max(525600)
    .refine((v) => v === 0 || v >= 5, "自动间隔至少 5 分钟")
    .default(0),
  auto_download: z.boolean().default(false),
});
export const cookieSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["upload", "file", "browser"]),
  path: z.string().max(2000).default(""),
  content: z.string().max(1_000_000).default(""),
  browser: z
    .enum(["chrome", "edge", "firefox", "safari", "chromium", "brave"])
    .default("chrome"),
  profile: z
    .string()
    .max(2000)
    .refine((s) => !s.includes("\n") && !s.includes("\0"))
    .default(""),
});
export const settingsSchema = z.object({
  download_root: z
    .string()
    .trim()
    .max(2000)
    .transform((value) => value || DEFAULT_DOWNLOAD_ROOT)
    .default(DEFAULT_DOWNLOAD_ROOT),
  ffprobe: z.string().trim().min(1).max(2000).default("ffprobe"),
  ffmpeg: z.string().trim().min(1).max(2000).default("ffmpeg"),
  rclone_config: z.string().trim().max(2000).optional(),
});
export const storageSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((v) => !/[\x00-\x1f]/.test(v), "名称不能包含控制字符"),
  kind: z.enum(["local", "rclone"]),
  root: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((v) => !/[\x00-\x1f]/.test(v), "路径不能包含控制字符"),
});
export type StorageSource = z.infer<typeof storageSchema> & { id: string };
export type BackupConfig = z.infer<typeof configSchema> & {
  id: string;
  excluded: string[];
  next_run: number | null;
};
export type CookieSource = Omit<z.infer<typeof cookieSchema>, "content"> & {
  id: string;
  status: "未验证" | "可用" | "验证失败";
  checked_at?: number;
  hint?: string;
};
export type Settings = z.infer<typeof settingsSchema>;
export type ItemStatus =
  "missing" | "archived" | "staged" | "excluded" | "filtered" | "removed";
export type DiffItem = {
  bv: string;
  title: string;
  url: string;
  date: string | null;
  thumbnail?: string;
  cover_id?: string;
  base_status: ItemStatus;
  status?: ItemStatus;
  verified?: boolean;
  quality_error?: string;
};
export type Counts = Record<ItemStatus, number>;
export type Snapshot = { id: string; refreshed_at: number; items: DiffItem[] };
export type Job = {
  id: string;
  kind: "refresh" | "download" | "cookie" | "archive" | "retrieve";
  config_id?: string;
  cookie_id?: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "partial"
    | "interrupted"
    | "cancelled";
  message: string;
  created_at: number;
  updated_at: number;
  done: number;
  total: number;
  progress?: number;
  current_bv?: string;
  failures: { bv: string; message: string; code?: string; details?: string }[];
  error_code?: string;
  error_details?: string;
  selected?: string[];
  scheduled?: boolean;
};
export type ConfigView = BackupConfig & {
  resolved_download_dir: string;
  refreshed_at: number | null;
  counts: Counts;
};
export type AppState = {
  configs: ConfigView[];
  cookies: CookieSource[];
  storages: StorageSource[];
  settings: Settings;
  jobs: Job[];
  runtime: {
    yt_dlp: string;
    downloader_available: boolean;
    ffmpeg_available: boolean;
    ffprobe_available: boolean;
    platform: string;
    remote: boolean;
    rclone_available: boolean;
    rclone_version: string;
    config_file: string;
  };
};
export type DiffPage = {
  snapshot_id: string | null;
  refreshed_at: number | null;
  items: DiffItem[];
  total: number;
  counts: Counts;
};
