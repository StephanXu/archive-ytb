# Bilibili 合集 BV diff + 登录态最高画质下载

这个工具先按文件名中的 BV 比对合集、最终视频库和中转目录，再把真正缺失的视频下载到中转目录。它不会接受匿名或次级画质 fallback。

## 安全约束

- 下载前必须同时通过两层登录检查：Cookie 文件中存在未过期的 `SESSDATA`，且 B 站 `/x/web-interface/nav` 明确返回 `isLogin=true`。
- yt-dlp 使用 `bestvideo+bestaudio` 从当前登录态下 `-F` 可见的格式中选最高画质；有 1080p 就取最高质量的 1080p，没有 1080p 就取该视频真实可用的最高画质，例如 1280x634。
- 预检会记录 yt-dlp 选中的精确 format ID 和分辨率；实际下载锁定这个 format ID，不会在 Cookie 中途失效后重新选择低画质。
- Cookie 是全局硬门槛，不属于“可跳过的单条失败”：任务开始、每条格式提取后、每条下载前以及 yt-dlp 失败后都会验证 `isLogin=true`。发现未登录就以 `COOKIE_INVALID` 终止整个任务，绝不会接受匿名降画质。
- 整批视频会先完成元数据和画质预检，再开始第一个下载。
- 下载结束后用 `ffprobe` 检查成品尺寸与预检选择完全一致；失败返回非零退出码，文件保留供人工检查。
- 单个视频元数据异常或下载失败时，会记录 `[SKIP:...]` 并继续处理后续 BV；全部条目处理完后统一汇总，并返回对应的非零退出码。
- 跳过汇总会尽可能按 `日期  BV  标题` 列出视频，并在下一行显示具体原因；只有连标题元数据都无法读取时才仅显示 BV。
- 中转目录已有同 BV 文件时，也会把实际尺寸与当前登录态下 yt-dlp 选择的最高画质比较，避免接受以前匿名降级得到的低画质文件。
- `--ignore-config` 隔离用户级 yt-dlp 配置，避免外部格式规则改变本工具的严格选择。

## 运行

在 PowerShell 中：

```powershell
Set-Location 'C:\Users\xuzih\Documents\Codex\2026-08-28\https-space-bilibili-com-265529806-lists\outputs\bilibili-season-sync'

# 只看 diff，不创建目录、不下载
uv run python .\bilibili_season_sync.py --dry-run

# 临时指定 Cookie 文件，覆盖 config.toml 中的 cookie_file
uv run python .\bilibili_season_sync.py `
  --cookie-file 'D:\cookies\bilibili.txt' `
  --dry-run

# 实际下载所有配置的 task
uv run python .\bilibili_season_sync.py

# 只跑一个 task
uv run python .\bilibili_season_sync.py --task '常士杉直播脱水' --dry-run

# 临时覆盖日期下限：只看严格晚于 2026-08-01 的视频
uv run python .\bilibili_season_sync.py --task '常士杉直播脱水' --after-date 2026-08-01 --dry-run
```

配置在 `config.toml`。Cookie 可以通过 `[global].cookie_file` 固定配置，也可以用 `--cookie-file PATH` 临时覆盖。相对路径按运行命令时的当前目录解析。每个 `[[tasks]]` 独立设置 `season_url`、`library_dir` 和 `download_dir`；可选 `after_date`。默认下载路径 `~/Downloads` 在当前电脑解析为 `C:\Users\xuzih\Downloads`。

文件名由 yt-dlp 生成：

```text
[YYYY-MM-DD] {title} [BVxxxxxxxxxx].mp4
```

BV 主体保持 B 站返回的原始大小写，不会转成全大写。

Windows 不允许的文件名字符会由 yt-dlp 安全替换；下载过程需要 `ffmpeg`，成品检查需要 `ffprobe`。

## 更新 Cookie

当前配置使用：

```text
C:\Users\xuzih\Documents\tools\yt-dlp\ytbcookie.txt
```

这必须是 Netscape 格式，并包含浏览器当前已登录 B 站账号的 Cookie。可以用 yt-dlp 从已经登录 B 站的 Chrome 导出并覆盖该文件：

```powershell
& 'C:\Users\xuzih\Documents\tools\yt-dlp\yt-dlp.exe' `
  --ignore-config `
  --cookies-from-browser chrome `
  --cookies 'C:\Users\xuzih\Documents\tools\yt-dlp\ytbcookie.txt' `
  --flat-playlist --playlist-items 1 --skip-download `
  'https://space.bilibili.com/265529806/lists/7913961?type=season'
```

如果 Chrome 的 Cookie 数据库被占用，先完全退出 Chrome 后重试。工具不会在错误信息中打印 Cookie 值。

## 退出码

| 退出码 | 含义 |
|---:|---|
| 0 | 成功，或没有缺失视频 |
| 2 | 配置、本地路径或一般同步错误 |
| 3 | Cookie 缺失、过期、未登录或无法在线验证 |
| 4 | 合集或视频元数据读取失败 |
| 5 | 中转文件或下载成品尺寸与预检选择的最高画质不一致 |
| 6 | 下载、命名或 ffprobe 成品检查失败 |
