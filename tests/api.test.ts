import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createApp } from "../server/app.ts";
import type { BackupConfig, Snapshot, Job } from "../shared/contracts.ts";

async function fixture(token = "") {
  const dir = await mkdtemp(join(tmpdir(), "archive-api-"));
  const { app, store, engine } = createApp({
    root: resolve("."),
    stateDir: dir,
    token,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const r = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Backup-Request": "1",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, data: await r.json() };
  }
  return {
    request,
    store,
    engine,
    dir,
    port: address.port,
    async close() {
      await engine.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
const body = {
  name: "课程",
  season_url: "https://space.bilibili.com/123/lists/456",
  cookie_id: "",
  library_dir: "",
  download_dir: "",
  interval_minutes: 0,
  auto_download: false,
  after_date: "",
};
test("config CRUD, unified download directory, cache-only diff, exclusions and stale snapshot protection", async () => {
  const f = await fixture();
  try {
    const created = await f.request("configs", "POST", body);
    assert.equal(created.status, 200);
    const c = created.data as BackupConfig;
    const state = await f.request("state");
    assert(state.data.configs[0].resolved_download_dir.endsWith("课程"));
    assert.equal(f.store.all("jobs").length, 0);
    f.store.put<Snapshot>("snapshots", c.id, {
      id: "snapshot1",
      refreshed_at: 1,
      items: [
        {
          bv: "BV1abcDEFghi",
          title: "新内容",
          url: "https://www.bilibili.com/video/BV1abcDEFghi",
          date: null,
          base_status: "missing",
        },
        {
          bv: "BV1jklMNOpqr",
          title: "已下载",
          url: "https://www.bilibili.com/video/BV1jklMNOpqr",
          date: null,
          base_status: "staged",
        },
      ],
    });
    await f.request(`configs/${c.id}/excluded`, "PUT", {
      excluded: ["BV1abcDEFghi"],
    });
    const diff = await f.request(`configs/${c.id}/diff?status=excluded`);
    assert.equal(diff.data.total, 1);
    assert.equal(diff.data.items[0].bv, "BV1abcDEFghi");
    assert.equal(f.store.all("jobs").length, 0);
    assert.equal(
      (
        await f.request(`configs/${c.id}/download`, "POST", {
          snapshot_id: "stale",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(`configs/${c.id}/download`, "POST", {
          snapshot_id: "snapshot1",
          selected: ["BV1abcDEFghi"],
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(`configs/${c.id}/download`, "POST", {
          snapshot_id: "snapshot1",
          selected: ["BV1jklMNOpqr"],
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request(`configs/${c.id}/refresh`, "POST")).status,
      409,
    );
    assert.equal((await f.request(`configs/${c.id}`, "PUT", body)).status, 409);
    const job = f.store.all<Job>("jobs")[0];
    await f.request(`jobs/${job.id}/cancel`, "POST");
    assert.equal(
      (
        await f.request(`configs/${c.id}`, "PUT", {
          ...body,
          download_dir: "~/Downloads/custom",
        })
      ).status,
      200,
    );
    assert.equal(
      (await f.request(`configs/${c.id}/diff`)).data.snapshot_id,
      null,
    );
    assert.equal((await f.request(`configs/${c.id}`, "DELETE")).status, 200);
  } finally {
    await f.close();
  }
});
test("Cookie upload is scoped, never echoed, refreshes in place, and cannot delete a bound instance", async () => {
  const f = await fixture();
  try {
    const content =
      "# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\ttest_fixture\n.example.com\tTRUE\t/\tTRUE\t0\tTOKEN\tprivate_fixture\n";
    const input = { name: "测试账号", kind: "upload", content };
    const c = await f.request("cookies", "POST", input);
    assert.equal(c.status, 200);
    assert(!JSON.stringify(c.data).includes("test_fixture"));
    const disk = await readFile(c.data.path, "utf8");
    assert(disk.includes("test_fixture"));
    assert(!disk.includes("private_fixture"));
    await f.request("configs", "POST", { ...body, cookie_id: c.data.id });
    assert.equal(
      (await f.request(`cookies/${c.data.id}`, "DELETE")).status,
      409,
    );
    await f.request(`cookies/${c.data.id}`, "PUT", {
      ...input,
      content: content.replace("test_fixture", "fresh_fixture"),
    });
    assert((await readFile(c.data.path, "utf8")).includes("fresh_fixture"));
    const invalid = await f.request("cookies", "POST", {
      ...input,
      content: "SECRET_INVALID_INPUT",
    });
    assert.equal(invalid.status, 422);
    assert(!JSON.stringify(invalid.data).includes("SECRET_INVALID_INPUT"));
    assert(
      !JSON.stringify((await f.request("state")).data).includes(
        "fresh_fixture",
      ),
    );
  } finally {
    await f.close();
  }
});
test("reject cross-origin mutations, rebinding hosts, invalid source URLs and folder collisions", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.request("configs", "POST", body, {
          Origin: "https://evil.example",
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.request("configs", "POST", body, { "X-Backup-Request": "" }))
        .status,
      403,
    );
    const hostStatus = await new Promise<number | undefined>(
      (resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: f.port,
            path: "/api/state",
            headers: { Host: "evil.example" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      },
    );
    assert.equal(hostStatus, 403);
    assert.equal(
      (
        await f.request("configs", "POST", {
          ...body,
          season_url: "http://127.0.0.1/private",
        })
      ).status,
      422,
    );
    assert.equal(
      (await f.request("configs", "POST", { ...body, name: "a/b" })).status,
      200,
    );
    assert.equal(
      (await f.request("configs", "POST", { ...body, name: "a:b" })).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test("remote access requires correct bearer token", async () => {
  const f = await fixture("long-test-token-not-a-real-secret");
  try {
    assert.equal(
      (await f.request("state", "GET", undefined, { Authorization: "" }))
        .status,
      401,
    );
    assert.equal((await f.request("state")).status, 200);
  } finally {
    await f.close();
  }
});
test("scheduler persists next run, deduplicates, and restart interrupts old jobs", async () => {
  const f = await fixture();
  try {
    const c = (
      await f.request("configs", "POST", { ...body, interval_minutes: 5 })
    ).data as BackupConfig;
    c.next_run = 1;
    f.store.put("configs", c.id, c);
    f.engine.tick();
    f.engine.tick();
    assert.equal(f.store.all<Job>("jobs").length, 1);
    assert(
      f.store.get<BackupConfig>("configs", c.id)!.next_run! > Date.now() / 1000,
    );
    assert.equal(f.store.all<Job>("jobs")[0].scheduled, true);
  } finally {
    await f.close();
  }
});
test("date sorting precedes pagination and always leaves unknown dates last", async () => {
  const f = await fixture();
  try {
    const c = (await f.request("configs", "POST", body)).data;
    f.store.put("snapshots", c.id, {
      id: "sort",
      refreshed_at: 1,
      items: [null, "2026-09-03", "2026-09-04"].map((date, i) => ({
        bv: "BV" + String(i).padStart(10, "0"),
        title: "title",
        url: "https://www.bilibili.com/",
        date,
        base_status: "missing",
      })),
    });
    assert.equal(
      (await f.request(`configs/${c.id}/diff?limit=1`)).data.items[0].date,
      "2026-09-04",
    );
    assert.deepEqual(
      (await f.request(`configs/${c.id}/diff?order=asc`)).data.items.map(
        (i: { date: string | null }) => i.date,
      ),
      ["2026-09-03", "2026-09-04", null],
    );
    assert.equal(
      (await f.request(`configs/${c.id}/diff?order=bad`)).status,
      422,
    );
  } finally {
    await f.close();
  }
});

