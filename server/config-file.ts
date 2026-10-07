import { z } from "zod";
import { parse, stringify } from "smol-toml";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  configSchema,
  cookieSchema,
  settingsSchema,
  storageSchema,
  bvSchema,
} from "../shared/contracts.ts";
import { safeName } from "./paths.ts";
import { TaskError } from "./process.ts";

// IDs are stable references, not paths. In particular they must not escape cookies/.
const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const documentSchema = z
  .object({
    version: z.literal(1),
    settings: settingsSchema.strict().optional(),
    configs: z
      .array(
        configSchema
          .extend({
            id,
            excluded: z.array(bvSchema).default([]),
          })
          .strict(),
      )
      .default([]),
    cookies: z.array(cookieSchema.extend({ id }).strict()).default([]),
    storages: z.array(storageSchema.extend({ id }).strict()).default([]),
  })
  .strict();
export type ConfigDocument = z.infer<typeof documentSchema>;
export const configKinds = new Set([
  "settings",
  "configs",
  "cookies",
  "storages",
]);

export function validateDocument(
  input: unknown,
  references = true,
): ConfigDocument {
  // Do not propagate Zod/TOML diagnostics: parser messages can contain credentials.
  let doc: ConfigDocument;
  try {
    doc = documentSchema.parse(input);
  } catch {
    throw new TaskError(
      "VALIDATION",
      "config.toml 格式或字段无效，请检查版本和配置字段",
    );
  }
  for (const rows of [doc.configs, doc.cookies, doc.storages]) {
    if (new Set(rows.map((r) => r.id)).size !== rows.length)
      throw new TaskError("VALIDATION", "config.toml 存在重复 ID");
  }
  if (
    new Set(doc.storages.map((s) => s.name)).size !== doc.storages.length ||
    new Set(doc.configs.map((c) => safeName(c.name).toLowerCase())).size !==
      doc.configs.length
  )
    throw new TaskError("VALIDATION", "config.toml 存储源或配置名称重复");
  for (const c of doc.cookies) {
    if ((c.kind === "upload" && !c.content) || (c.kind === "file" && !c.path))
      throw new TaskError(
        "VALIDATION",
        "config.toml Cookie 缺少内容或文件路径",
      );
  }
  if (references)
    for (const c of doc.configs) {
      if (
        (c.cookie_id && !doc.cookies.some((k) => k.id === c.cookie_id)) ||
        (c.storage_name &&
          !doc.storages.some((s) => s.name === c.storage_name)) ||
        (c.storage_name && c.library_dir)
      )
        throw new TaskError(
          "VALIDATION",
          "config.toml 存在无效的 Cookie 或存储源引用",
        );
    }
  return doc;
}

export class ConfigFile {
  path: string;
  doc: ConfigDocument = { version: 1, configs: [], cookies: [], storages: [] };
  private revision?: string;
  constructor(path: string) {
    this.path = resolve(path);
    if (existsSync(this.path)) {
      const text = readFileSync(this.path, "utf8");
      let raw: unknown;
      try {
        raw = parse(text.replace(/^\uFEFF/, ""));
      } catch {
        throw new TaskError(
          "VALIDATION",
          "config.toml 语法无效，请检查 TOML 文件",
        );
      }
      this.doc = validateDocument(raw);
      this.revision = text;
    }
  }
  get exists() {
    return this.revision !== undefined;
  }
  save() {
    const doc = validateDocument(this.doc);
    const current = existsSync(this.path)
      ? readFileSync(this.path, "utf8")
      : undefined;
    if (current !== this.revision)
      throw new TaskError(
        "CONFLICT",
        "config.toml 已被外部修改，请重启服务加载后再保存",
      );
    const text =
      "# Archive Flow 项目配置；包含 Cookie，请勿提交 Git。\n# 手动编辑前停止服务；相对路径以本文件所在目录为基准。\n" +
      stringify(doc) +
      "\n";
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = join(dirname(this.path), `.config-${randomUUID()}.tmp`);
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      this.doc = doc;
      this.revision = text;
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
}
