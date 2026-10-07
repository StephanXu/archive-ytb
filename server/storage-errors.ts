const sensitive =
  /token|password|passwd|secret|credential|authorization|cookie|sessdata|(?:^|_)key$|signature/i;

export function credentialValues(text: string): string[] {
  const values: string[] = [];
  function collect(value: unknown, key: string) {
    if (typeof value === "string" && sensitive.test(key) && value.length >= 4)
      values.push(value);
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) collect(v, k);
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([\w-]+)\s*=\s*(.+)$/);
    if (!match || !sensitive.test(match[1])) continue;
    try {
      collect(JSON.parse(match[2]), match[1]);
    } catch {
      collect(match[2], match[1]);
    }
  }
  return values;
}

export function storageDiagnostic(
  error: unknown,
  secrets: string[] = [],
): string {
  const parts: string[] = [];
  function extract(value: unknown, depth = 0) {
    if (depth > 3 || value == null) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (typeof value !== "object") return;
    // Never serialize SDK input/config objects or response bodies wholesale.
    for (const key of ["message", "error", "code", "cause"])
      extract((value as Record<string, unknown>)[key], depth + 1);
  }
  extract(error);
  let text = [...new Set(parts)].join("\n") || "未返回具体原因";
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    text = text
      .replaceAll(secret, "[已隐藏]")
      .replaceAll(encodeURIComponent(secret), "[已隐藏]");
  text = text
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, "[鉴权已隐藏]")
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|secret|client[_-]?secret|authorization|cookie|sessdata|api[_-]?key|signature|sig)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
      "$1[已隐藏]",
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return parsed.toString();
      } catch {
        return "[URL 已隐藏]";
      }
    })
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  return text.slice(0, 4000);
}
