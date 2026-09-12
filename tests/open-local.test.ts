import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { openLocalPath } from "../server/open-local.ts";

test("Windows opens associated app visibly and waits for result, keeping paths outside shell code", async () => {
  const child = new EventEmitter();
  const path = "C:\\Downloads\\中文 ' $name & video";
  const launch = ((command: string, args: string[], options: any) => {
    assert.equal(command, "powershell.exe");
    assert(args.at(-1)?.includes("-WindowStyle Normal"));
    assert(!args.join(" ").includes(path));
    assert.equal(options.env.ARCHIVE_OPEN_PATH, path);
    return child;
  }) as typeof spawn;
  let done = false;
  const opening = openLocalPath(path, launch, "win32").then(() => {
    done = true;
  });
  child.emit("spawn");
  await Promise.resolve();
  assert.equal(done, false);
  child.emit("exit", 0);
  await opening;
  assert.equal(done, true);
});

test("open failures are reported instead of returning success on spawn", async () => {
  for (const event of ["exit", "error"]) {
    const child = new EventEmitter();
    const opening = openLocalPath(
      "C:\\Downloads",
      (() => child) as unknown as typeof spawn,
      "win32",
    );
    const rejected = assert.rejects(opening, /打开失败|无法启动/);
    child.emit(event, event === "exit" ? 1 : new Error("missing launcher"));
    await rejected;
  }
});
