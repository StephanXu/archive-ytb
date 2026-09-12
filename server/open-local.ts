import { spawn } from "node:child_process";
import { TaskError } from "./process.ts";

// Hide the helper console, but explicitly request a visible associated app.
export async function openLocalPath(
  path: string,
  launch = spawn,
  platform: NodeJS.Platform = process.platform,
) {
  await new Promise<void>((resolve, reject) => {
    const child =
      platform === "win32"
        ? launch(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:ARCHIVE_OPEN_PATH -WindowStyle Normal -ErrorAction Stop",
            ],
            {
              env: { ...process.env, ARCHIVE_OPEN_PATH: path },
              windowsHide: true,
              stdio: "ignore",
            },
          )
        : launch(platform === "darwin" ? "open" : "xdg-open", [path], {
            stdio: "ignore",
          });
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new TaskError(
          "OPEN_FAILED",
          "打开操作超时，请在服务电脑上检查默认应用",
        ),
      );
    }, 15000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new TaskError(
          "OPEN_FAILED",
          "无法启动默认应用，请在服务电脑上检查文件关联",
        ),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new TaskError("OPEN_FAILED", "打开失败，请检查路径权限和默认应用"),
        );
    });
  });
}
