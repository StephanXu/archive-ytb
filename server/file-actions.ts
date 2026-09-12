import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import {
  copyFile,
  unlink,
  readdir,
  lstat,
  realpath,
  link,
} from "node:fs/promises";
import { basename, join, relative, isAbsolute } from "node:path";
import { scanMedia } from "./paths.ts";
import { TaskError } from "./process.ts";

// Ordinary deletion needs an identity/change guard, not a content-equality check.
// BigInt timestamps preserve filesystem precision without reading video contents.
export async function fileIdentity(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile())
    throw new TaskError("CONFLICT", "文件类型已变化，请重新确认删除");
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

export async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function archiveFile(
  download: string,
  library: string,
  bv: string,
  confirmedHash?: string,
) {
  const roots = await Promise.all([realpath(download), realpath(library)]);
  const nested = (a: string, b: string) => {
    const r = relative(a, b);
    return !r || (!r.startsWith("..") && !isAbsolute(r));
  };
  if (nested(roots[0], roots[1]) || nested(roots[1], roots[0]))
    throw new TaskError("CONFLICT", "下载目录与存档目录不能相同或互相包含");
  const files = (await scanMedia(download)).get(bv) || [];
  if (files.length !== 1)
    throw new TaskError(
      "CONFLICT",
      files.length
        ? "找到多个下载文件，请先在文件夹中整理后再存档"
        : "未找到下载文件，请刷新列表",
    );
  const source = files[0];
  const collisions: string[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name.toLowerCase() === basename(source).toLowerCase())
        collisions.push(path);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(path);
    }
  }
  await walk(library);
  if (collisions.length) {
    const hash = await hashFile(source);
    if (collisions.length !== 1 || !(await lstat(collisions[0])).isFile())
      throw new TaskError(
        "CONFLICT",
        "存档目录存在多个同名项目或同名非普通文件，请手动整理",
      );
    const destination = collisions[0];
    const targetHash = await hashFile(destination);
    if (hash !== targetHash)
      throw new TaskError(
        "CONFLICT",
        `同名文件 SHA-256 不一致，已停止存档并保留两份文件。下载：${hash}；存档：${targetHash}`,
      );
    if (!confirmedHash)
      return { status: "duplicate" as const, source, destination, hash };
    if (confirmedHash !== hash)
      throw new TaskError("CONFLICT", "文件已变化，请重新检查重复文件");
    await unlink(source);
    return { status: "deduplicated" as const, source, destination, hash };
  }
  if (confirmedHash)
    throw new TaskError("CONFLICT", "原存档文件已变化，请重新存档");
  const destination = join(library, basename(source));
  // link + unlink moves the same file on a supporting volume without copying bytes.
  // Unlike rename on Windows/POSIX, link cannot overwrite an existing destination.
  let linked = false;
  try {
    await link(source, destination);
    linked = true;
  } catch (error) {
    if (
      !["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(
        (error as NodeJS.ErrnoException).code || "",
      )
    )
      throw error;
  }
  if (linked) {
    await unlink(source);
    return { status: "archived" as const, source, destination };
  }
  // Different disks and filesystems without hard links require a verified copy.
  const hash = await hashFile(source);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  if (
    (await hashFile(destination)) !== hash ||
    (await hashFile(source)) !== hash
  )
    throw new TaskError(
      "CONFLICT",
      "复制后哈希校验失败，已保留下载文件，请检查存档副本",
    );
  await unlink(source);
  return { status: "archived" as const, source, destination, hash };
}
