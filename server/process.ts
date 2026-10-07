import { spawn, type ChildProcess } from "node:child_process";

export class TaskError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: string,
  ) {
    super(message);
  }
}
export type RunOptions = {
  signal?: AbortSignal;
  timeout?: number;
  onLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  maxOutput?: number;
  failureMessage?: string;
};
function terminate(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}
export function runProcess(
  command: string,
  args: string[],
  opts: RunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new TaskError("CANCELLED", "任务已停止"));
      return;
    }
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      stderr = "",
      pending = "",
      pendingError = "",
      reason: TaskError | undefined;
    const stop = (error: TaskError) => {
      reason = error;
      terminate(child);
    };
    const abort = () => stop(new TaskError("CANCELLED", "任务已取消"));
    const timer = setTimeout(
      () =>
        stop(new TaskError("TIMEOUT", "操作超时，已停止子进程，可重试任务")),
      opts.timeout ?? 180000,
    );
    opts.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => {
      output += text;
      if (output.length > (opts.maxOutput ?? 30_000_000)) {
        stop(new TaskError("OUTPUT_LIMIT", "合集清单超过允许大小"));
        return;
      }
      if (opts.onLine) {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop()!;
        lines.forEach(opts.onLine);
      }
    });
    child.stderr.on("data", (text: string) => {
      stderr = (stderr + text).slice(-6000);
      if (opts.onStderrLine) {
        pendingError += text;
        const lines = pendingError.split(/\r\n|\r|\n/);
        pendingError = lines.pop()!;
        lines.forEach(opts.onStderrLine);
      }
    });
    child.on("error", () => {
      cleanup();
      reject(
        new TaskError(
          "TOOL_MISSING",
          opts.failureMessage ||
            "无法启动工具，请检查 yt-dlp / ffmpeg / ffprobe 安装",
        ),
      );
    });
    child.on("close", (code) => {
      cleanup();
      if (pendingError && opts.onStderrLine) opts.onStderrLine(pendingError);
      if (reason) {
        reject(reason);
        return;
      }
      if (code !== 0) {
        const cookie =
          /DPAPI|decrypt|cookie database|could not copy.*cookie|permission denied.*cookie/i.test(
            stderr,
          );
        reject(
          new TaskError(
            cookie ? "BROWSER_COOKIE" : "EXTRACTOR_FAILED",
            cookie
              ? "浏览器 Cookie 无法读取或解密；可导入文件或改用 Firefox。"
              : opts.failureMessage ||
                  "yt-dlp 或媒体工具执行失败，请检查来源、网络和工具版本。",
          ),
        );
        return;
      }
      if (pending && opts.onLine) opts.onLine(pending);
      resolve(output);
    });
  });
}
