import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  Layers3,
  Activity,
  KeyRound,
  Settings2,
  Plus,
  ArrowUpRight,
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Undo2,
  Download,
  RefreshCw,
  Folder,
  Copy,
  Clock3,
  Check,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  FileCheck2,
  LoaderCircle,
  ExternalLink,
  Ban,
  X,
} from "lucide-react";
import type {
  AppState,
  ConfigView,
  DiffPage,
  DiffItem,
  Job,
  ItemStatus,
} from "../../shared/contracts";
import { api, onUnauthorized } from "./api";
import {
  Button,
  Badge,
  PageTitle,
  Empty,
  Note,
  Modal,
  Field,
  time,
} from "./ui";
import { ConfigEditor, CookieEditor, ExclusionsEditor } from "./editors";
import "./style.css";

const statuses: Record<ItemStatus, string> = {
  missing: "待下载",
  archived: "已存档",
  staged: "已下载",
  excluded: "已排除",
  filtered: "日期过滤",
  removed: "源中移除",
};
const jobStatus: Record<Job["status"], string> = {
  queued: "排队中",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  partial: "部分失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
const active = (j: Job) => ["queued", "running"].includes(j.status);
const navItems = [
  { id: "configs", title: "备份配置", icon: Layers3 },
  { id: "jobs", title: "任务记录", icon: Activity },
  { id: "cookies", title: "Cookie 管理", icon: KeyRound },
  { id: "settings", title: "全局设置", icon: Settings2 },
];
const getRoute = () => {
  const [page = "configs", id] = location.hash.slice(1).split("/");
  return { page, id };
};
type ModalState =
  | { kind: "config"; id?: string }
  | { kind: "cookie"; id?: string }
  | { kind: "exclusions"; id: string }
  | { kind: "delete-config" | "delete-cookie"; id: string }
  | null;

function App() {
  const [data, setData] = useState<AppState>(),
    [route, setRoute] = useState(getRoute),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(true),
    [modal, setModal] = useState<ModalState>(null),
    [message, setMessage] = useState(""),
    [auth, setAuth] = useState(false),
    [revision, setRevision] = useState(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const notify = useCallback((text: string) => {
    setMessage(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setMessage(""), 4500);
  }, []);
  const reload = useCallback(async () => {
    const fresh = await api<AppState>("state");
    setData(fresh);
    setConnected(true);
    setError("");
    return fresh;
  }, []);
  useEffect(() => {
    onUnauthorized(() => setAuth(true));
    reload().catch((e) => {
      setError(e.message);
      setConnected(false);
    });
    const interval = setInterval(() => {
      if (!document.hidden) reload().catch(() => setConnected(false));
    }, 3000);
    const change = () => setRoute(getRoute());
    window.addEventListener("hashchange", change);
    return () => {
      clearInterval(interval);
      window.removeEventListener("hashchange", change);
    };
  }, [reload]);
  async function action(
    path: string,
    method = "POST",
    body?: unknown,
    success?: string,
  ) {
    try {
      await api(path, method, body);
      await reload();
      setRevision((n) => n + 1);
      if (success) notify(success);
    } catch (e) {
      notify((e as Error).message);
      throw e;
    }
  }
  const perform = (
    path: string,
    method = "POST",
    body?: unknown,
    success?: string,
  ) => {
    void action(path, method, body, success).catch(() => {});
  };
  const saved = () => {
    setModal(null);
    void reload();
    setRevision((n) => n + 1);
    notify("已保存");
  };
  const current = data?.configs.find((c) => c.id === route.id);
  return (
    <>
      <aside className="sidebar">
        <a className="brand" href="#configs">
          <div className="brand-symbol">
            <Archive size={24} />
          </div>
          <div>
            Archive<span>Flow</span>
            <small>让每一份收藏都有归处</small>
          </div>
        </a>
        <div className="nav-caption">工作空间</div>
        <nav aria-label="主导航">
          {navItems.map(({ id, title, icon: Icon }) => (
            <a
              key={id}
              className={route.page === id ? "active" : ""}
              href={"#" + id}
            >
              <Icon size={19} />
              <span>{title}</span>
              {id === "configs" && <b>{data?.configs.length || 0}</b>}
              {id === "jobs" && data?.jobs.some(active) && (
                <i className="dot" />
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span>
            <i className={"dot " + (!connected ? "offline" : "")} />
            {connected ? "已连接备份主机" : "连接已断开"}
          </span>
          <small>LOCAL FIRST</small>
        </div>
      </aside>
      <div className="layout">
        <header className="topbar">
          <div>
            工作空间 <span>/</span>{" "}
            {navItems.find((n) => n.id === route.page)?.title || "备份配置"}
            {current && (
              <>
                {" "}
                <span>/</span> {current.name}
              </>
            )}
          </div>
          <span className="private-label">
            <ShieldCheck size={14} />
            你的内容，你的存档
          </span>
        </header>
        <main>
          {!data ? (
            <Empty
              title={error ? "连接未完成" : "正在连接工作台"}
              description={error || "正在读取本地配置…"}
            >
              {error ? (
                <Button
                  onClick={() => reload().catch((e) => setError(e.message))}
                >
                  重试
                </Button>
              ) : (
                <LoaderCircle className="spin" />
              )}
            </Empty>
          ) : route.page === "configs" && route.id ? (
            current ? (
              <DiffWorkspace
                key={current.id}
                config={current}
                data={data}
                revision={revision}
                edit={() => setModal({ kind: "config", id: current.id })}
                exclusions={() =>
                  setModal({ kind: "exclusions", id: current.id })
                }
                action={action}
                notify={notify}
              />
            ) : (
              <Empty title="配置不存在" description="这份配置可能已被删除。">
                <a href="#configs">返回全部配置</a>
              </Empty>
            )
          ) : route.page === "cookies" ? (
            <Cookies
              data={data}
              edit={(id) => setModal({ kind: "cookie", id })}
              remove={(id) => setModal({ kind: "delete-cookie", id })}
              perform={perform}
            />
          ) : route.page === "jobs" ? (
            <Jobs data={data} perform={perform} />
          ) : route.page === "settings" ? (
            <Settings data={data} action={action} />
          ) : (
            <Configurations
              data={data}
              edit={(id) => setModal({ kind: "config", id })}
            />
          )}
        </main>
        <footer>
          Archive Flow <span>轻量预览 · 有序备份</span>
        </footer>
      </div>
      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}
      {data && modal?.kind === "config" && (
        <ConfigEditor
          config={data.configs.find((c) => c.id === modal.id)}
          cookies={data.cookies}
          saved={saved}
          close={() => setModal(null)}
          remove={(id) => setModal({ kind: "delete-config", id })}
        />
      )}{" "}
      {data && modal?.kind === "cookie" && (
        <CookieEditor
          cookie={data.cookies.find((c) => c.id === modal.id)}
          saved={saved}
          close={() => setModal(null)}
        />
      )}{" "}
      {data && modal?.kind === "exclusions" && (
        <ExclusionsEditor
          config={data.configs.find((c) => c.id === modal.id)!}
          saved={saved}
          close={() => setModal(null)}
        />
      )}{" "}
      {modal &&
        (modal.kind === "delete-config" || modal.kind === "delete-cookie") && (
          <ConfirmDelete
            type={modal.kind}
            close={() => setModal(null)}
            remove={async () => {
              await action(
                (modal.kind === "delete-config" ? "configs/" : "cookies/") +
                  modal.id,
                "DELETE",
              );
              setModal(null);
              if (modal.kind === "delete-config") location.hash = "configs";
            }}
          />
        )}
      {auth && (
        <Auth
          close={() => setAuth(false)}
          connected={async () => {
            await reload();
            setAuth(false);
          }}
        />
      )}
    </>
  );
}
function Configurations({
  data,
  edit,
}: {
  data: AppState;
  edit: (id?: string) => void;
}) {
  const [search, setSearch] = useState("");
  const configs = data.configs.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()),
  );
  const stats = [
    {
      label: "备份配置",
      value: data.configs.length,
      note: "每份收藏，独立管理",
      icon: Layers3,
    },
    {
      label: "待下载内容",
      value: data.configs.reduce((n, c) => n + c.counts.missing, 0),
      note: "来自最近一次 diff",
      icon: Download,
    },
    {
      label: "自动计划",
      value: data.configs.filter((c) => c.interval_minutes).length,
      note: "服务运行时按计划检查",
      icon: Clock3,
    },
  ];
  return (
    <>
      <PageTitle
        eyebrow="YOUR BACKUP SPACE"
        title="备份工作台"
        description="收藏在更新，备份也会。留住每一份值得保存的内容。"
        actions={
          <Button variant="primary" onClick={() => edit()}>
            <Plus size={17} />
            新建配置
          </Button>
        }
      />
      <div className="stats-grid">
        {stats.map(({ label, value, note, icon: Icon }, i) => (
          <div className={"stat-card color-" + i} key={label}>
            <div className="stat-icon">
              <Icon size={20} />
            </div>
            <span>{label}</span>
            <strong>
              {value}
              <small>{i === 1 ? "条" : "个"}</small>
            </strong>
            <p>{note}</p>
          </div>
        ))}
      </div>
      <div className="section-header">
        <h2>
          我的配置 <small>{data.configs.length} 个配置</small>
        </h2>
        <label className="search-input">
          <Search size={16} />
          <input
            aria-label="搜索配置"
            placeholder="搜索配置…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <div className="config-list">
        {configs.map((c, i) => (
          <article className="config-card" key={c.id}>
            <div className={"collection-icon color-" + (i % 3)}>
              <Folder size={23} />
            </div>
            <div className="config-main">
              <div className="config-name">
                <h3>
                  <a href={"#configs/" + c.id}>{c.name}</a>
                </h3>
                <Badge tone={c.interval_minutes ? "green" : ""}>
                  {c.interval_minutes
                    ? `每 ${c.interval_minutes} 分钟`
                    : "手动备份"}
                </Badge>
                {data.jobs.some((j) => j.config_id === c.id && active(j)) && (
                  <Badge tone="blue">执行中</Badge>
                )}
              </div>
              <p>
                Bilibili 合集 <span>·</span>{" "}
                {data.cookies.find((k) => k.id === c.cookie_id)?.name ||
                  "未绑定 Cookie"}
              </p>
            </div>
            <div className="config-commands">
              <Button
                variant="quiet icon-button"
                aria-label={"编辑 " + c.name}
                onClick={() => edit(c.id)}
              >
                <Ellipsis size={20} />
              </Button>
              <a className="button" href={"#configs/" + c.id}>
                查看 diff
                <ArrowUpRight size={15} />
              </a>
            </div>
            <div className="config-foot">
              <span>
                待下载 <b>{c.counts.missing}</b>
              </span>
              <span>
                已存档 <b>{c.counts.archived}</b>
              </span>
              <span>
                上次刷新 <b>{time(c.refreshed_at)}</b>
              </span>
              <code title={c.resolved_download_dir}>
                {c.resolved_download_dir}
              </code>
            </div>
          </article>
        ))}
      </div>
      {!configs.length && (
        <Empty
          title={data.configs.length ? "没有匹配的配置" : "从第一份备份开始"}
          description="添加合集链接和 Cookie，然后预览需要下载的内容。"
        >
          <Button variant="primary" onClick={() => edit()}>
            <Plus size={16} />
            新建配置
          </Button>
        </Empty>
      )}
      <Note>
        打开配置即可查看缓存的 diff。点击「刷新
        diff」才会读取合集清单；画质预检在执行下载时进行。
      </Note>
      {!data.runtime.downloader_available && (
        <Note>
          下载器尚未安装。请在项目目录运行 <code>npm run setup:downloader</code>
          ，安装已锁定版本的 yt-dlp。
        </Note>
      )}
    </>
  );
}

function Cover({ item }: { item: DiffItem }) {
  const ref = useRef<HTMLImageElement>(null);
  const [local, setLocal] = useState("");
  useEffect(() => {
    setLocal("");
    if (!item.cover_id || !ref.current) return;
    const ctl = new AbortController();
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        api<{ data: string }>(
          `covers/${item.cover_id}`,
          "GET",
          undefined,
          ctl.signal,
        )
          .then((r) => setLocal(r.data))
          .catch(() => {});
      },
      { rootMargin: "200px" },
    );
    observer.observe(ref.current);
    return () => {
      observer.disconnect();
      ctl.abort();
    };
  }, [item.cover_id]);
  if (!item.cover_id && !item.thumbnail) return null;
  return (
    <img
      ref={ref}
      className="video-cover"
      src={local || (item.cover_id ? undefined : item.thumbnail)}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  );
}

type Action = (
  path: string,
  method?: string,
  body?: unknown,
  success?: string,
) => Promise<void>;
function DiffWorkspace({
  config: c,
  data,
  revision,
  edit,
  exclusions,
  action,
  notify,
}: {
  config: ConfigView;
  data: AppState;
  revision: number;
  edit: () => void;
  exclusions: () => void;
  action: Action;
  notify: (s: string) => void;
}) {
  const [diff, setDiff] = useState<DiffPage>(),
    [filter, setFilter] = useState("all"),
    [order, setOrder] = useState<"desc" | "asc">("desc"),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  const jobs = data.jobs.filter((j) => j.config_id === c.id),
    running = jobs.find(active);
  const jobStamp = jobs.map((j) => j.updated_at).join(",");
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query);
      setOffset(0);
    }, 200);
    return () => clearTimeout(t);
  }, [query]);
  useEffect(() => {
    const ctl = new AbortController();
    api<DiffPage>(
      `configs/${c.id}/diff?status=${filter}&search=${encodeURIComponent(search)}&offset=${offset}&order=${order}`,
      "GET",
      undefined,
      ctl.signal,
    )
      .then((d) => {
        setDiff(d);
        setError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctl.abort();
  }, [c.id, filter, search, offset, order, revision, jobStamp, c.refreshed_at]);
  async function run(path: string, body?: unknown, message?: string) {
    setPending(true);
    try {
      await action(path, "POST", body, message);
    } catch {
    } finally {
      setPending(false);
    }
  }
  function select(bv: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      checked ? next.add(bv) : next.delete(bv);
      return next;
    });
  }
  async function exclude(item: DiffItem) {
    const excluded = c.excluded.includes(item.bv)
      ? c.excluded.filter((b) => b !== item.bv)
      : [...c.excluded, item.bv];
    try {
      await action(`configs/${c.id}/excluded`, "PUT", { excluded });
      select(item.bv, false);
    } catch {}
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(c.resolved_download_dir);
      notify("下载路径已复制");
    } catch {
      notify("浏览器限制了剪贴板，请在下方路径中选中文字后复制");
    }
  }
  const eligible =
    diff?.items.filter(
      (i) => i.status === "missing" || i.status === "staged",
    ) || [];
  const total = diff
    ? Object.values(diff.counts).reduce((a, b) => a + b, 0)
    : 0;
  return (
    <>
      <a className="back-link" href="#configs">
        <ArrowLeft size={15} />
        全部配置
      </a>
      <PageTitle
        eyebrow="COLLECTION / DIFF"
        title={c.name}
        description={`Bilibili 合集 · 上次刷新 ${time(diff?.refreshed_at)}`}
        actions={
          <>
            <Button onClick={edit}>
              <SlidersHorizontal size={16} />
              编辑
            </Button>
            <Button
              disabled={!!running || pending}
              onClick={() =>
                run(`configs/${c.id}/refresh`, undefined, "已加入刷新队列")
              }
            >
              <RefreshCw
                size={16}
                className={running?.kind === "refresh" ? "spin" : ""}
              />
              刷新列表
            </Button>
          </>
        }
      />
      <div className="detail-properties">
        <span>
          <KeyRound size={15} />
          {data.cookies.find((k) => k.id === c.cookie_id)?.name ||
            "未设置 Cookie"}
        </span>
        <span>
          <Clock3 size={15} />
          {c.interval_minutes
            ? `每 ${c.interval_minutes} 分钟 · ${c.auto_download ? "自动下载" : "等待审核"}`
            : "手动执行"}
        </span>
        <span>
          <FileCheck2 size={15} />
          {c.after_date ? `仅晚于 ${c.after_date}` : "不限发布日期"}
        </span>
        {c.next_run && <span>下次检查 {time(c.next_run)}</span>}
      </div>
      {running && (
        <div className="running-banner floating-job" role="status">
          <LoaderCircle size={17} className="spin" />
          <span>
            {running.message}
            {running.kind === "download" &&
              ` · 当前下载 ${Math.round(running.progress || 0)}%`}
            {running.total > 0
              ? ` · 已处理 ${running.done}/${running.total}`
              : ""}
          </span>
          <a href="#jobs">
            查看任务
            <ArrowUpRight size={14} />
          </a>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <section className="diff-panel">
        <div className="diff-toolbar">
          <div className="filter-tabs" role="group" aria-label="筛选差异状态">
            {[
              ["all", "全部", total],
              ...Object.entries(statuses).map(([s, n]) => [
                s,
                n,
                diff?.counts[s as ItemStatus] || 0,
              ]),
            ].map(([s, n, count]) => (
              <button
                key={s}
                className={filter === s ? "active" : ""}
                aria-pressed={filter === s}
                onClick={() => {
                  setFilter(String(s));
                  setOffset(0);
                }}
              >
                {n}
                <span>{count}</span>
              </button>
            ))}
          </div>
          <label className="search-input">
            <Search size={15} />
            <input
              aria-label="搜索标题或 BV"
              placeholder="搜索标题或 BV…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>
        {!diff ? (
          <div className="table-empty">
            <LoaderCircle className="spin" />
            正在读取 diff…
          </div>
        ) : !diff.snapshot_id ? (
          <Empty
            title="看看有哪些内容值得留下"
            description="第一次刷新会读取合集清单与本地文件名，不会逐条查询画质。"
          >
            <Button
              variant="primary"
              disabled={!!running || pending}
              onClick={() => run(`configs/${c.id}/refresh`)}
            >
              <RefreshCw size={16} />
              刷新列表
            </Button>
          </Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        aria-label="选择本页可下载条目"
                        checked={
                          eligible.length > 0 &&
                          eligible.every((i) => selected.has(i.bv))
                        }
                        disabled={!eligible.length}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setSelected((prev) => {
                            const next = new Set(prev);
                            eligible.forEach((i) =>
                              checked ? next.add(i.bv) : next.delete(i.bv),
                            );
                            return next;
                          });
                        }}
                      />
                    </th>
                    <th>视频内容</th>
                    <th
                      aria-sort={order === "desc" ? "descending" : "ascending"}
                    >
                      <button
                        className="date-sort"
                        onClick={() => {
                          setOrder(order === "desc" ? "asc" : "desc");
                          setOffset(0);
                        }}
                      >
                        发布日期{" "}
                        {order === "desc" ? (
                          <ArrowDown size={14} />
                        ) : (
                          <ArrowUp size={14} />
                        )}
                      </button>
                    </th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.items.map((i) => (
                    <tr key={i.bv}>
                      <td>
                        {["missing", "staged"].includes(i.status || "") && (
                          <input
                            type="checkbox"
                            aria-label={"选择 " + i.title}
                            checked={selected.has(i.bv)}
                            onChange={(e) => select(i.bv, e.target.checked)}
                          />
                        )}
                      </td>
                      <td className="video-cell">
                        <div className="video-summary">
                          <Cover item={i} />
                          <div className="video-heading">
                            <span>{i.title}</span>
                            <span className="title-actions">
                              <Button
                                variant="quiet icon-button"
                                title="复制 BV"
                                aria-label={"复制 BV " + i.bv}
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(i.bv);
                                    notify("BV 已复制");
                                  } catch {
                                    notify("无法访问剪贴板");
                                  }
                                }}
                              >
                                <Copy size={14} />
                              </Button>
                              <a
                                className="button quiet icon-button"
                                href={i.url}
                                target="_blank"
                                rel="noreferrer"
                                title="打开原视频"
                                aria-label={"打开原视频 " + i.title}
                              >
                                <ExternalLink size={14} />
                              </a>
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="date-cell">{i.date || "下载时核验"}</td>
                      <td>
                        <Badge
                          tone={
                            i.status === "missing"
                              ? "green"
                              : i.status === "staged"
                                ? "blue"
                                : i.status === "excluded"
                                  ? "purple"
                                  : i.status === "removed"
                                    ? "amber"
                                    : ""
                          }
                        >
                          {statuses[i.status!]}
                        </Badge>
                        {i.quality_error && (
                          <span className="badge red" title={i.quality_error}>
                            画质核验异常
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          {running?.kind === "download" &&
                          !running.failures.some((f) => f.bv === i.bv) &&
                          (running.current_bv === i.bv ||
                            running.selected?.includes(i.bv)) &&
                          !i.verified ? (
                            <Button
                              variant="icon-button download-progress"
                              disabled
                              title={
                                running.current_bv === i.bv
                                  ? `下载进度 ${Math.round(running.progress || 0)}%`
                                  : "等待下载"
                              }
                              aria-label={
                                running.current_bv === i.bv
                                  ? `下载进度 ${Math.round(running.progress || 0)}%`
                                  : "等待下载"
                              }
                            >
                              <span
                                className="progress-fill"
                                style={{
                                  width: `${running.current_bv === i.bv ? running.progress || 0 : 0}%`,
                                }}
                              />
                              <LoaderCircle size={16} className="spin" />
                            </Button>
                          ) : ["archived", "staged"].includes(i.base_status) ? (
                            <Button
                              variant="quiet icon-button"
                              title="查看本地文件夹"
                              aria-label={"查看本地文件夹 " + i.title}
                              onClick={() =>
                                run(
                                  `configs/${c.id}/open-folder`,
                                  { bv: i.bv },
                                  "已打开视频所在文件夹",
                                )
                              }
                            >
                              <Folder size={16} />
                            </Button>
                          ) : (
                            <Button
                              variant="quiet icon-button"
                              title="下载此视频"
                              aria-label={"下载此视频 " + i.title}
                              disabled={
                                !!running || pending || i.status !== "missing"
                              }
                              onClick={() =>
                                run(
                                  `configs/${c.id}/download`,
                                  {
                                    snapshot_id: diff.snapshot_id,
                                    selected: [i.bv],
                                  },
                                  "已加入下载队列",
                                )
                              }
                            >
                              <Download size={16} />
                            </Button>
                          )}
                          <Button
                            variant="quiet icon-button"
                            title={i.status === "excluded" ? "恢复" : "排除"}
                            aria-label={
                              (i.status === "excluded" ? "恢复 " : "排除 ") +
                              i.title
                            }
                            onClick={() => exclude(i)}
                          >
                            {i.status === "excluded" ? (
                              <Undo2 size={16} />
                            ) : (
                              <Ban size={16} />
                            )}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!diff.items.length && (
                <div className="table-empty">当前筛选下没有条目</div>
              )}
            </div>
            <div className="table-footer">
              <span>
                {diff.total ? offset + 1 : 0}–
                {Math.min(offset + 100, diff.total)} / {diff.total} 条{" "}
                {selected.size > 0 && `· 已选 ${selected.size}`}
              </span>
              <div className="actions">
                {selected.size > 0 && (
                  <Button
                    variant="quiet compact"
                    onClick={() => setSelected(new Set())}
                  >
                    清空选择
                  </Button>
                )}
                <Button variant="quiet compact" onClick={exclusions}>
                  <Ban size={14} />
                  维护排除项
                </Button>
                <Button
                  variant="compact"
                  aria-label="上一页"
                  disabled={!offset}
                  onClick={() => setOffset((n) => Math.max(0, n - 100))}
                >
                  <ChevronLeft size={16} />
                </Button>
                <Button
                  variant="compact"
                  aria-label="下一页"
                  disabled={offset + 100 >= diff.total}
                  onClick={() => setOffset((n) => n + 100)}
                >
                  <ChevronRight size={16} />
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
      <div className="bulk-download">
        {" "}
        <Button
          variant="primary"
          disabled={
            !!running ||
            pending ||
            !diff?.snapshot_id ||
            !(diff.counts.missing + diff.counts.staged)
          }
          onClick={async () => {
            await run(
              `configs/${c.id}/download`,
              {
                snapshot_id: diff?.snapshot_id,
                ...(selected.size ? { selected: [...selected] } : {}),
              },
              "已加入下载队列",
            );
            setSelected(new Set());
          }}
        >
          <Download size={16} />
          {selected.size ? `下载所选 (${selected.size})` : "下载待处理"}
        </Button>
      </div>
      <div className="directory-bar">
        <Folder size={17} />
        <div>
          <small>下载目录</small>
          <code>{c.resolved_download_dir}</code>
        </div>
        <Button variant="quiet compact" onClick={copy}>
          <Copy size={14} />
          复制路径
        </Button>
        <Button
          variant="quiet compact"
          onClick={() =>
            run(
              `configs/${c.id}/open-folder`,
              undefined,
              "已在服务电脑上打开目录",
            )
          }
        >
          <ArrowUpRight size={14} />
          打开目录
        </Button>
      </div>
      <Note>
        「已下载」表示下载目录中已有视频，仅在画质核验异常时额外标注。发布日期缺失时会在下载预检中按日期下限过滤。「源中移除」不会删除本地文件。打开目录的操作发生在服务电脑上。
      </Note>
    </>
  );
}
function Cookies({
  data,
  edit,
  remove,
  perform,
}: {
  data: AppState;
  edit: (id?: string) => void;
  remove: (id: string) => void;
  perform: (p: string, m?: string, b?: unknown, s?: string) => void;
}) {
  return (
    <>
      <PageTitle
        eyebrow="AUTHENTICATION"
        title="Cookie 管理"
        description="一份登录态，一个实例。让不同的备份配置各取所需。"
        actions={
          <Button variant="primary" onClick={() => edit()}>
            <Plus size={17} />
            添加 Cookie
          </Button>
        }
      />
      <div className="cookie-grid">
        {data.cookies.map((c) => (
          <article className="cookie-card" key={c.id}>
            <div className="cookie-head">
              <div className="collection-icon">
                <KeyRound size={22} />
              </div>
              <div>
                <h3>{c.name}</h3>
                <p>
                  {
                    {
                      file: "引用本地文件",
                      upload: "本机托管",
                      browser: "直接读取浏览器",
                    }[c.kind]
                  }
                </p>
              </div>
              <Badge
                tone={
                  c.status === "可用"
                    ? "green"
                    : c.status === "验证失败"
                      ? "red"
                      : ""
                }
              >
                {c.status}
              </Badge>
            </div>
            <div className="cookie-source">
              {c.kind === "browser"
                ? `${c.browser} / ${c.profile || "默认 Profile"}`
                : c.path}
            </div>
            <p className="cookie-meta">
              关联 {data.configs.filter((x) => x.cookie_id === c.id).length}{" "}
              个配置 <span>·</span>{" "}
              {c.checked_at ? "验证于 " + time(c.checked_at) : "尚未验证登录态"}
            </p>
            {c.hint && <p className="form-error">{c.hint}</p>}
            <div className="cookie-actions">
              <Button
                variant="compact"
                disabled={data.jobs.some(
                  (j) => j.cookie_id === c.id && active(j),
                )}
                onClick={() =>
                  perform(
                    `cookies/${c.id}/verify`,
                    "POST",
                    undefined,
                    "验证任务已加入队列",
                  )
                }
              >
                <ShieldCheck size={15} />
                验证登录态
              </Button>
              <Button variant="quiet compact" onClick={() => edit(c.id)}>
                更新
              </Button>
              <Button
                variant="quiet compact danger"
                onClick={() => remove(c.id)}
              >
                删除
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!data.cookies.length && (
        <Empty
          title="给备份配置一份登录凭据"
          description="导入 Cookie 文件，或连接服务电脑上已登录的浏览器。"
        >
          <Button variant="primary" onClick={() => edit()}>
            <Plus size={16} />
            添加 Cookie
          </Button>
        </Empty>
      )}
      <Note>
        Windows Chrome / Edge 可能因加密或数据库占用而读取失败，可改用 Netscape
        文件导入或 Firefox。托管实例仅保存 B 站 Cookie，页面不会回显凭据内容。
      </Note>
    </>
  );
}
function Jobs({
  data,
  perform,
}: {
  data: AppState;
  perform: (p: string, m?: string, b?: unknown, s?: string) => void;
}) {
  return (
    <>
      <PageTitle
        eyebrow="ACTIVITY LOG"
        title="任务记录"
        description="每一次检查与下载，都有迹可循。关闭页面，队列继续。"
      />
      <div className="job-list">
        {data.jobs.map((j) => (
          <article key={j.id} className="job-card">
            <div className="job-head">
              <span className="job-symbol">
                {active(j) ? (
                  <LoaderCircle size={19} className="spin" />
                ) : j.status === "completed" ? (
                  <Check size={19} />
                ) : (
                  <Activity size={19} />
                )}
              </span>
              <h3>
                {
                  {
                    refresh: "刷新列表",
                    download: "下载备份",
                    cookie: "验证 Cookie",
                  }[j.kind]
                }
                {j.config_id
                  ? " · " +
                    (data.configs.find((c) => c.id === j.config_id)?.name ||
                      "已删除的配置")
                  : ""}
              </h3>
              <Badge
                tone={
                  j.status === "completed"
                    ? "green"
                    : ["failed", "partial", "interrupted"].includes(j.status)
                      ? "red"
                      : active(j)
                        ? "blue"
                        : ""
                }
              >
                {jobStatus[j.status]}
              </Badge>
              <time>{time(j.created_at)}</time>
              {active(j) && (
                <Button
                  variant="quiet compact"
                  onClick={() => perform(`jobs/${j.id}/cancel`)}
                >
                  <X size={14} />
                  取消
                </Button>
              )}
            </div>
            <p>
              {j.message}
              {j.total > 0 && ` · ${j.done} / ${j.total}`}
              {j.kind === "download" &&
                active(j) &&
                ` · 当前下载 ${Math.round(j.progress || 0)}%`}
            </p>
            {j.total > 0 && (
              <div
                className="progress-track"
                role="progressbar"
                aria-valuenow={
                  j.kind === "download" && active(j)
                    ? j.progress || 0
                    : Math.min(100, (j.done / j.total) * 100)
                }
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={
                  j.kind === "download" && active(j)
                    ? "当前下载进度"
                    : "已处理条目"
                }
              >
                <span
                  style={{
                    width:
                      (j.kind === "download" && active(j)
                        ? j.progress || 0
                        : Math.min(100, (j.done / j.total) * 100)) + "%",
                  }}
                />
              </div>
            )}
            {j.failures.length > 0 && (
              <details>
                <summary>{j.failures.length} 个条目失败</summary>
                <ul>
                  {j.failures.map((f, i) => (
                    <li key={i}>
                      <code>{f.bv}</code> {f.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        ))}
      </div>
      {!data.jobs.length && (
        <Empty
          title="准备好开始第一份备份"
          description="刷新列表、验证 Cookie 或执行下载后，记录会出现在这里。"
        />
      )}
    </>
  );
}
function Settings({ data, action }: { data: AppState; action: Action }) {
  const [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    try {
      await action(
        "settings",
        "PUT",
        Object.fromEntries(new FormData(e.currentTarget)),
        "全局设置已保存",
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="PREFERENCES"
        title="全局设置"
        description="统一管理新下载的内容，让每份配置各就各位。"
      />
      <form className="settings-panel" onSubmit={submit}>
        <div className="settings-title">
          <Folder size={21} />
          <div>
            <h2>下载与存储</h2>
            <p>默认按配置名创建文件夹，存档目录仍在每份配置中独立设置。</p>
          </div>
        </div>
        <div className="form-grid">
          <Field
            label="统一下载根目录"
            hint="未设置独立下载目录时，使用「根目录 / 配置名」。修改路径不会移动已有文件。"
            wide
          >
            <input
              name="download_root"
              defaultValue={data.settings.download_root}
              required
            />
          </Field>
          <Field label="ffmpeg 命令或绝对路径">
            <input name="ffmpeg" defaultValue={data.settings.ffmpeg} required />
          </Field>
          <Field label="ffprobe 命令或绝对路径">
            <input
              name="ffprobe"
              defaultValue={data.settings.ffprobe}
              required
            />
          </Field>
        </div>
        <div className="runtime-grid">
          <span>
            yt-dlp <b>{data.runtime.yt_dlp}</b>
            <Badge tone={data.runtime.downloader_available ? "green" : "amber"}>
              {data.runtime.downloader_available ? "已固定版本" : "尚未安装"}
            </Badge>
          </span>
          <span>
            ffmpeg <b>{data.runtime.ffmpeg_available ? "已就绪" : "未找到"}</b>
          </span>
          <span>
            ffprobe{" "}
            <b>{data.runtime.ffprobe_available ? "已就绪" : "未找到"}</b>
          </span>
        </div>
        <p className="form-error" role="alert">
          {error}
        </p>
        <div className="form-actions">
          <Button variant="primary" disabled={pending}>
            <Check size={16} />
            {pending ? "保存中…" : "保存设置"}
          </Button>
        </div>
      </form>
      <Note>
        自动计划由 Node.js
        服务执行，电脑需保持唤醒、服务需持续运行。关闭浏览器不影响任务；服务重启后，未完成的任务会标为「已中断」。
      </Note>
    </>
  );
}
function ConfirmDelete({
  type,
  close,
  remove,
}: {
  type: string;
  close: () => void;
  remove: () => Promise<void>;
}) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title={type === "delete-config" ? "删除这份配置？" : "删除 Cookie 实例？"}
      description={
        type === "delete-config"
          ? "配置和缓存 diff 会移除，已经下载的视频会保留。"
          : "被配置使用的实例需要先解除关联。托管 Cookie 文件会一并移除。"
      }
      close={close}
    >
      <p className="form-error">{error}</p>
      <div className="form-actions">
        <Button onClick={close}>取消</Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await remove();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          确认删除
        </Button>
      </div>
    </Modal>
  );
}
function Auth({
  close,
  connected,
}: {
  close: () => void;
  connected: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <Modal
      title="连接备份主机"
      description="输入服务设置的访问令牌。令牌仅保存在当前标签页的会话中。"
      close={close}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          sessionStorage.setItem(
            "backup-token",
            String(new FormData(e.currentTarget).get("token")),
          );
          try {
            await connected();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <Field label="访问令牌">
          <input
            name="token"
            type="password"
            autoComplete="off"
            required
            autoFocus
          />
        </Field>
        <p className="form-error">{error}</p>
        <div className="form-actions">
          <Button variant="primary">连接</Button>
        </div>
      </form>
    </Modal>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
