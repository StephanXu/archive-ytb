import { useEffect, useState, type FormEvent } from "react";
import { Plus, Folder, Archive, Check, Trash2, Upload } from "lucide-react";
import type { AppState, StorageSource } from "../../shared/contracts";
import { PageTitle, Button, Field, Modal, Empty, Note } from "./ui";
import { api } from "./api";

type Action = (
  path: string,
  method?: string,
  body?: unknown,
  success?: string,
) => Promise<void>;
export function Storages({ data, action }: { data: AppState; action: Action }) {
  const [editing, setEditing] = useState<StorageSource | null | undefined>(
    undefined,
  );
  const [kind, setKind] = useState<"local" | "rclone">("local");
  const [root, setRoot] = useState("");
  const [remotes, setRemotes] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [content, setContent] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<{ remotes: string[] }>(
      "storage-config",
      "GET",
      undefined,
      controller.signal,
    )
      .then((result) => setRemotes(result.remotes))
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [data.settings.rclone_config]);
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const open = (source: StorageSource | null) => {
    setEditing(source);
    setKind(source?.kind || "local");
    setRoot(source?.root || "");
    setError("");
  };
  async function importConfig(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError("");
    try {
      await action("storage-config", "POST", { content }, "云存储配置已导入");
      const result = await api<{ remotes: string[] }>("storage-config");
      setRemotes(result.remotes);
      setContent("");
      setImporting(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError("");
    try {
      await action(
        editing ? `storages/${editing.id}` : "storages",
        editing ? "PUT" : "POST",
        { ...Object.fromEntries(new FormData(e.currentTarget)), kind },
        "存储源已保存",
      );
      setEditing(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function perform(path: string, method = "POST", message = "") {
    setPending(true);
    setError("");
    try {
      await action(path, method, undefined, message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="STORAGE"
        title="存储管理"
        description="配置多个存储位置，备份配置通过名字选择。"
        actions={
          <>
            <Button
              disabled={pending}
              onClick={() => {
                setContent("");
                setError("");
                setImporting(true);
              }}
            >
              <Upload size={16} />
              导入 rclone 配置
            </Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => open(null)}
            >
              <Plus size={16} />
              添加存储源
            </Button>
          </>
        }
      />
      <div className="cookie-grid">
        {data.storages.map((s) => (
          <article className="cookie-card" key={s.id}>
            <div className="cookie-head">
              <Folder size={20} />
              <h2>{s.name}</h2>
              <span>{s.kind === "local" ? "本地目录" : "云存储"}</span>
            </div>
            <div className="cookie-source">{s.root}</div>
            <p className="cookie-meta">
              关联{" "}
              {data.configs.filter((c) => c.storage_name === s.name).length}{" "}
              份配置
            </p>
            <div className="cookie-actions">
              <Button
                disabled={pending}
                onClick={() =>
                  void perform(
                    `storages/${s.id}/verify`,
                    "POST",
                    "存储源可访问",
                  )
                }
              >
                <Check size={15} />
                检查连接
              </Button>
              <Button disabled={pending} onClick={() => open(s)}>
                编辑
              </Button>
              <Button
                variant="quiet danger"
                disabled={
                  pending || data.configs.some((c) => c.storage_name === s.name)
                }
                onClick={() => {
                  if (
                    window.confirm(`删除存储源「${s.name}」？已有文件会保留。`)
                  )
                    void perform(`storages/${s.id}`, "DELETE", "存储源已删除");
                }}
              >
                <Trash2 size={15} />
                删除
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!data.storages.length && (
        <Empty
          title="添加第一个存储源"
          description="支持本地目录，以及 OneDrive、Google Drive、S3 等云存储。"
        />
      )}
      <p className="form-error" role="alert">
        {error}
      </p>
      <Note>
        可直接导入已有 rclone.conf，再添加命名存储源。
        {remotes.length > 0 && <>已识别远端：{remotes.join("、")}。</>}
        上传并校验成功后才会移除下载副本，打开云端视频时会先取回本地。
      </Note>
      {importing && (
        <Modal
          title="导入 rclone 配置"
          description="粘贴完整 rclone.conf，或选择配置文件。导入会替换服务的云端配置；已有视频会保留。"
          close={() => {
            if (!pending) {
              setContent("");
              setImporting(false);
            }
          }}
        >
          <form onSubmit={importConfig}>
            <div className="form-grid">
              <Field label="选择配置文件" wide>
                <input
                  type="file"
                  accept=".conf,.ini,.txt,text/plain"
                  disabled={pending}
                  onChange={async (e) => {
                    const file = e.currentTarget.files?.[0];
                    if (!file) return;
                    setError("");
                    if (file.size > 1024 * 1024) {
                      setError("配置文件不能超过 1 MB");
                      return;
                    }
                    setPending(true);
                    try {
                      setContent(await file.text());
                    } catch {
                      setError("无法读取配置文件");
                    } finally {
                      setPending(false);
                    }
                  }}
                />
              </Field>
              <Field
                label="rclone 配置内容"
                hint="支持多个远端。保存后不会回显配置内容或令牌。"
                wide
              >
                <textarea
                  required
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={12}
                  disabled={pending}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={"[onedrive]\ntype = onedrive\n..."}
                  autoFocus
                />
              </Field>
            </div>
            <p className="form-error" role="alert">
              {error}
            </p>
            <div className="form-actions">
              <Button
                type="button"
                disabled={pending}
                onClick={() => {
                  setContent("");
                  setImporting(false);
                }}
              >
                取消
              </Button>
              <Button variant="primary" disabled={pending || !content.trim()}>
                <Upload size={16} />
                {pending ? "导入中…" : "导入配置"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {editing !== undefined && (
        <Modal
          title={editing ? "编辑存储源" : "添加存储源"}
          close={() => {
            if (!pending) setEditing(undefined);
          }}
        >
          <form onSubmit={submit}>
            <div className="form-grid">
              <Field label="存储源名称" wide>
                <input
                  name="name"
                  required
                  maxLength={100}
                  defaultValue={editing?.name}
                  placeholder="例如：OneDrive 视频库"
                  autoFocus
                />
              </Field>
              <Field label="存储类型" wide>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as typeof kind)}
                >
                  <option value="local">本地目录</option>
                  <option value="rclone">云存储</option>
                </select>
              </Field>
              {kind === "rclone" && remotes.length > 0 && (
                <Field label="选择已导入远端" wide>
                  <select
                    value={
                      remotes.find((name) => root.startsWith(name + ":")) || ""
                    }
                    onChange={(e) => {
                      if (e.target.value) setRoot(e.target.value + ":");
                    }}
                  >
                    <option value="">选择远端</option>
                    {remotes.map((name) => (
                      <option value={name} key={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field
                label={kind === "local" ? "目录位置" : "云端位置"}
                hint={
                  kind === "local"
                    ? "选择已有存档目录。"
                    : "远端名来自导入配置，可在冒号后填写存档目录。"
                }
                wide
              >
                <input
                  name="root"
                  required
                  value={root}
                  onChange={(e) => setRoot(e.target.value)}
                  placeholder={
                    kind === "local" ? "D:\\视频库" : "onedrive:视频存档"
                  }
                />
              </Field>
            </div>
            <p className="form-error" role="alert">
              {error}
            </p>
            <div className="form-actions">
              <Button
                type="button"
                disabled={pending}
                onClick={() => setEditing(undefined)}
              >
                取消
              </Button>
              <Button variant="primary" disabled={pending}>
                <Archive size={16} />
                {pending ? "保存中…" : "保存存储源"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
