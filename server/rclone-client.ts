import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import createRCDClient, { type RCDClient } from "rclone-sdk";
import { RCLONE_VERSION } from "../shared/contracts.ts";
import { runProcess, TaskError } from "./process.ts";
import { credentialValues, storageDiagnostic } from "./storage-errors.ts";

export type TransferContext = {
  signal?: AbortSignal;
  message?: (message: string) => void;
  progress?: (value: number) => void;
};
type Operation =
  | "/operations/list"
  | "/operations/copyfile"
  | "/operations/hashsum"
  | "/operations/deletefile";
const operationNames: Record<Operation, string> = {
  "/operations/list": "读取文件列表",
  "/operations/copyfile": "复制文件",
  "/operations/hashsum": "核验文件内容",
  "/operations/deletefile": "删除文件",
};

// The open-source SDK owns the RC protocol. This class owns only our bundled
// daemon's lifetime and connects its jobs to Archive Flow cancellation/progress.
export class RcloneClient {
  child?: ChildProcess;
  private starting?: Promise<RCDClient>;
  private secrets: string[] = [];
  private failure(stage: string, error?: unknown) {
    return new TaskError(
      "STORAGE_FAILED",
      `云存储${stage}失败；已有副本已保留`,
      storageDiagnostic(error, this.secrets),
    );
  }
  constructor(
    public binary: string,
    private config: () => string,
  ) {}
  private client() {
    if (!this.starting)
      this.starting = this.start().catch((error) => {
        this.starting = undefined;
        throw error;
      });
    return this.starting;
  }
  async remotes(validate = false): Promise<string[]> {
    try {
      const result = await (
        await this.client()
      ).POST("/config/listremotes", {
        signal: AbortSignal.timeout(20000),
      });
      if (result.error || !Array.isArray(result.data?.remotes))
        throw this.failure("读取账号配置", result.error);
      if (validate) {
        const dump = await (
          await this.client()
        ).POST("/config/dump", {
          signal: AbortSignal.timeout(20000),
        });
        const config = dump.data as
          Record<string, { type?: string }> | undefined;
        if (
          dump.error ||
          !config ||
          result.data.remotes.some((name) => !config[name]?.type?.trim())
        )
          throw this.failure("检查账号配置", dump.error);
      }
      return result.data.remotes.sort();
    } catch (error) {
      throw new TaskError(
        "VALIDATION",
        "无法读取 rclone 配置，请导入完整、未加密的 rclone.conf",
        error instanceof TaskError
          ? error.details || error.message
          : storageDiagnostic(error, this.secrets),
      );
    }
  }
  private async start(): Promise<RCDClient> {
    const version = await runProcess(this.binary, ["version"], {
      timeout: 20000,
      failureMessage: "项目内 rclone 未就绪，请运行 npm run setup:storage",
    });
    if (version.split(/\r?\n/)[0] !== `rclone v${RCLONE_VERSION}`)
      throw new TaskError(
        "VERSION_MISMATCH",
        "项目内 rclone 版本不匹配，请运行 npm run setup:storage",
      );
    const user = "archive-flow",
      password = randomBytes(32).toString("hex");
    try {
      this.secrets = credentialValues(readFileSync(this.config(), "utf8"));
    } catch {
      this.secrets = [];
    }
    this.secrets.push(password);
    const child = spawn(
      this.binary,
      [
        "rcd",
        "--rc-addr",
        "127.0.0.1:0",
        "--rc-user",
        user,
        "--rc-pass",
        password,
        "--config",
        this.config(),
        "--use-json-log",
      ],
      { shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    this.child = child;
    return new Promise((resolve, reject) => {
      let pending = "",
        ready = false,
        startupError = "启动超时，未收到云存储进程就绪信号";
      const timer = setTimeout(() => {
        child.kill();
        reject(this.failure("启动", startupError));
      }, 20000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(this.failure("启动", error));
      });
      child.on("exit", () => {
        clearTimeout(timer);
        this.child = undefined;
        this.starting = undefined;
        if (!ready) reject(this.failure("启动", startupError));
      });
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (data: string) => {
        pending += data;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop()!;
        for (const line of lines) {
          try {
            const log = JSON.parse(line) as { msg?: string; level?: string };
            if (["error", "fatal"].includes(log.level || ""))
              startupError = storageDiagnostic(log.msg, this.secrets);
            const match = String(log.msg).match(
              /Serving remote control on (http:\/\/127\.0\.0\.1:\d+\/)/,
            );
            if (!match || ready) continue;
            ready = true;
            clearTimeout(timer);
            resolve(
              createRCDClient({
                baseUrl: match[1].replace(/\/$/, ""),
                headers: {
                  Authorization:
                    "Basic " +
                    Buffer.from(`${user}:${password}`).toString("base64"),
                },
              }),
            );
          } catch {
            /* Logs are diagnostic data, not user-facing content. */
          }
        }
      });
    });
  }
  async execute(
    path: Operation,
    body: Record<string, unknown>,
    ctx: TransferContext = {},
  ): Promise<unknown> {
    if (ctx.signal?.aborted) throw new TaskError("CANCELLED", "任务已取消");
    const client = await this.client();
    if (ctx.signal?.aborted) throw new TaskError("CANCELLED", "任务已取消");
    const group = randomBytes(12).toString("hex");
    const started = await client
      .ASYNC(path, {
        body: { ...body, _group: group } as never,
        signal: AbortSignal.timeout(20000),
      })
      .catch(async (error) => {
        // A lost submission response may hide a running write job. Stop this
        // daemon before returning failure, so a retry cannot overlap that write.
        await this.close();
        throw this.failure(`${operationNames[path]}（提交）`, error);
      });
    if (started.error || !started.data)
      throw this.failure(
        `${operationNames[path]}（提交 HTTP ${started.response.status}）`,
        started.error,
      );
    const jobid = started.data.jobid;
    try {
      while (true) {
        if (ctx.signal?.aborted)
          throw new TaskError("CANCELLED", "任务已取消，已有副本已保留");
        const status = await client.POST("/job/status", {
          body: { jobid },
          signal: AbortSignal.timeout(20000),
        });
        if (status.error || !status.data)
          throw this.failure(
            `${operationNames[path]}（查询进度 HTTP ${status.response.status}）`,
            status.error,
          );
        if (status.data.finished) {
          if (!status.data.success)
            throw this.failure(operationNames[path], status.data.error);
          return status.data.output;
        }
        if (ctx.progress) {
          const stats = await client.POST("/core/stats", {
            body: { group },
            signal: AbortSignal.timeout(20000),
          });
          if (stats.data?.totalBytes && stats.data.totalBytes > 0)
            ctx.progress(
              Math.min(
                100,
                ((stats.data.bytes || 0) / stats.data.totalBytes) * 100,
              ),
            );
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } catch (error) {
      await client
        .POST("/job/stop", {
          body: { jobid },
          signal: AbortSignal.timeout(10000),
        })
        .catch(() => {});
      // Wait for cancellation before a later operation can reuse these paths.
      for (let i = 0; i < 20; i++) {
        const status = await client
          .POST("/job/status", {
            body: { jobid },
            signal: AbortSignal.timeout(2000),
          })
          .catch(() => undefined);
        if (!status?.data || status.data.finished) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (i === 19) await this.close();
      }
      throw error instanceof TaskError
        ? error
        : this.failure(`${operationNames[path]}（查询进度）`, error);
    } finally {
      await client
        .POST("/core/stats-delete", {
          body: { group },
          signal: AbortSignal.timeout(2000),
        })
        .catch(() => {});
    }
  }
  async close() {
    // A start in flight must finish before its child can be shut down.
    await this.starting?.catch(() => {});
    const child = this.child;
    this.starting = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      });
    }
    this.child = undefined;
  }
}
