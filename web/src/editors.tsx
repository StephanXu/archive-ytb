import { useState, type FormEvent } from "react";
import { Check, Trash2 } from "lucide-react";
import type { BackupConfig, CookieSource } from "../../shared/contracts";
import { api } from "./api";
import { Modal, Field, Button } from "./ui";

export function ConfigEditor({
  config,
  cookies,
  close,
  saved,
  remove,
}: {
  config?: BackupConfig;
  cookies: CookieSource[];
  close: () => void;
  saved: () => void;
  remove?: (id: string) => void;
}) {
  const [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      ...Object.fromEntries(f),
      interval_minutes: Number(f.get("interval_minutes")),
      auto_download: f.has("auto_download"),
    };
    setSaving(true);
    setError("");
    try {
      await api(
        config ? "configs/" + config.id : "configs",
        config ? "PUT" : "POST",
        body,
      );
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={config ? "编辑备份配置" : "新建备份配置"}
      description="添加内容来源，选择登录态，再预览与本地的差异。"
      close={close}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="配置名称" wide>
            <input
              name="name"
              defaultValue={config?.name}
              placeholder="例如：每周公开课"
              required
              maxLength={100}
              autoFocus
            />
          </Field>
          <Field label="Bilibili 合集链接" wide>
            <input
              name="season_url"
              type="url"
              defaultValue={config?.season_url}
              placeholder="https://space.bilibili.com/…/lists/…"
              required
            />
          </Field>
          <Field label="使用的 Cookie 实例" wide>
            <select name="cookie_id" defaultValue={config?.cookie_id || ""}>
              <option value="">暂不选择</option>
              {cookies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.status}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="存档目录（可选）"
            hint="已有视频库，仅用于比对；不会向这里下载或删除文件。"
            wide
          >
            <input
              name="library_dir"
              defaultValue={config?.library_dir}
              placeholder="已归档视频所在的绝对路径"
            />
          </Field>
          <Field
            label="独立下载目录（可选）"
            hint="留空时使用「统一下载根目录 / 配置名」。"
            wide
          >
            <input
              name="download_dir"
              defaultValue={config?.download_dir}
              placeholder="使用统一下载目录"
            />
          </Field>
          <Field label="仅处理晚于此日期的内容">
            <input
              name="after_date"
              type="date"
              defaultValue={config?.after_date}
            />
          </Field>
          <Field
            label="自动检查间隔（分钟）"
            hint="0 为手动；自动间隔至少 5 分钟。"
          >
            <input
              name="interval_minutes"
              type="number"
              min={0}
              max={525600}
              defaultValue={config?.interval_minutes || 0}
              required
            />
          </Field>
          <label className="checkbox-field wide">
            <input
              name="auto_download"
              type="checkbox"
              defaultChecked={config?.auto_download}
            />
            <span>
              自动检查成功后下载
              <small>未勾选时只更新 diff，等待你审核。排除项始终生效。</small>
            </span>
          </label>
        </div>
        <p className="form-error" role="alert">
          {error}
        </p>
        <div className="form-actions">
          {config && remove && (
            <Button
              type="button"
              variant="quiet danger push-right"
              onClick={() => remove(config.id)}
            >
              <Trash2 size={15} />
              删除配置
            </Button>
          )}
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button variant="primary" disabled={saving}>
            <Check size={16} />
            {saving ? "保存中…" : "保存配置"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function CookieEditor({
  cookie,
  close,
  saved,
}: {
  cookie?: CookieSource;
  close: () => void;
  saved: () => void;
}) {
  const [kind, setKind] = useState(cookie?.kind || "upload"),
    [content, setContent] = useState(""),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api(
        cookie ? "cookies/" + cookie.id : "cookies",
        cookie ? "PUT" : "POST",
        { ...Object.fromEntries(new FormData(e.currentTarget)), kind, content },
      );
      saved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      title={cookie ? "更新 Cookie 实例" : "添加 Cookie 实例"}
      description="凭据保存在运行服务的电脑上，配置通过实例名称引用。"
      close={close}
    >
      <form onSubmit={submit}>
        <div className="form-grid">
          <Field label="实例名称" wide>
            <input
              name="name"
              required
              maxLength={100}
              defaultValue={cookie?.name}
              placeholder="例如：我的 B 站账号"
              autoFocus
            />
          </Field>
          <Field label="凭据来源" wide>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="upload">导入 Cookie 文件 · 本机托管</option>
              <option value="file">引用已有 Cookie 文件</option>
              <option value="browser">直接读取浏览器</option>
            </select>
          </Field>
          {kind === "upload" ? (
            <>
              <Field label="选择 Netscape Cookie 文件" wide>
                <input
                  type="file"
                  accept=".txt"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (f.size > 1_000_000) {
                      setError("文件不能超过 1 MB");
                      return;
                    }
                    setContent(await f.text());
                  }}
                />
              </Field>
              <Field
                label="或粘贴文件内容"
                hint="仅保留 B 站 Cookie。更新时请重新导入，已有内容不会回显。"
                wide
              >
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="# Netscape HTTP Cookie File"
                  rows={5}
                  spellCheck={false}
                  autoComplete="off"
                  required
                />
              </Field>
            </>
          ) : kind === "file" ? (
            <Field
              label="服务电脑上的文件路径"
              hint="文件由你维护；下次执行任务时读取最新内容。"
              wide
            >
              <input
                name="path"
                defaultValue={cookie?.path}
                placeholder="C:\cookies\bilibili.txt 或 /Users/…/cookies.txt"
                required
              />
            </Field>
          ) : (
            <>
              <Field label="浏览器">
                <select
                  name="browser"
                  defaultValue={cookie?.browser || "chrome"}
                >
                  {[
                    "chrome",
                    "edge",
                    "firefox",
                    "safari",
                    "chromium",
                    "brave",
                  ].map((b) => (
                    <option key={b}>{b}</option>
                  ))}
                </select>
              </Field>
              <Field label="Profile 名称或路径（可选）">
                <input
                  name="profile"
                  defaultValue={cookie?.profile}
                  placeholder="Default / Profile 1"
                />
              </Field>
              <div className="form-hint wide">
                Windows Chrome / Edge
                可能因应用绑定加密或数据库占用而读取失败。可以导入 Netscape
                文件，或使用 Firefox。读取的是服务电脑上的浏览器。
              </div>
            </>
          )}
        </div>
        <p className="form-error" role="alert">
          {error}
        </p>
        <div className="form-actions">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button variant="primary" disabled={saving}>
            <Check size={16} />
            {saving ? "保存中…" : "保存实例"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function ExclusionsEditor({
  config,
  close,
  saved,
}: {
  config: BackupConfig;
  close: () => void;
  saved: () => void;
}) {
  const [value, setValue] = useState(config.excluded.join("\n")),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title="维护排除项"
      description="每行一个完整 BV 号，保留原始大小写。排除项会跨刷新、跨自动计划保留。"
      close={close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`configs/${config.id}/excluded`, "PUT", {
              excluded: value.split(/[\s,，]+/).filter(Boolean),
            });
            saved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="排除的 BV">
          <textarea
            rows={9}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </Field>
        <p className="form-error" role="alert">
          {error}
        </p>
        <div className="form-actions">
          <Button type="button" onClick={close}>
            取消
          </Button>
          <Button variant="primary" disabled={busy}>
            保存排除项
          </Button>
        </div>
      </form>
    </Modal>
  );
}
