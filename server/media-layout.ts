import { z } from "zod";
import type { BackupConfig } from "../shared/contracts.ts";

export function mediaSubdirectory(
  template: BackupConfig["directory_template"],
  date?: string | null,
) {
  if (!template || !z.iso.date().safeParse(date).success) return "";
  return template
    .replaceAll("{{YYYY}}", date!.slice(0, 4))
    .replaceAll("{{MM}}", date!.slice(5, 7))
    .replace(/\/$/, "");
}
