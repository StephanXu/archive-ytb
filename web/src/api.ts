let unauthorized: () => void = () => {};
export function onUnauthorized(fn: () => void) {
  unauthorized = fn;
}
export async function api<T = unknown>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const token = sessionStorage.getItem("backup-token");
  const r = await fetch("/api/" + path, {
    method,
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Backup-Request": "1",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error("服务响应异常，请检查连接");
  }
  if (!r.ok) {
    if (r.status === 401) unauthorized();
    throw Error(
      [data.detail || "操作失败", data.error_details]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return data;
}
