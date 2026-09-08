#!/usr/bin/env python3
"""Authenticated Bilibili season diff and highest-quality staging downloader."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from http.cookiejar import MozillaCookieJar
from pathlib import Path
from typing import Any, Iterable


BV_RE = re.compile(r"(?i)(BV[0-9A-Za-z]{10})")
MEDIA_EXTENSIONS = {".avi", ".flv", ".m4v", ".mkv", ".mov", ".mp4", ".ts", ".webm"}
BILIBILI_NAV_URL = "https://api.bilibili.com/x/web-interface/nav"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36"
)
CHINA_TZ = timezone(timedelta(hours=8))


class SyncError(Exception):
    exit_code = 2
    tag = "SYNC_ERROR"


class CookieAuthError(SyncError):
    exit_code = 3
    tag = "COOKIE_INVALID"


class ExtractorError(SyncError):
    exit_code = 4
    tag = "EXTRACTOR_FAILED"


class QualityError(SyncError):
    exit_code = 5
    tag = "QUALITY_MISMATCH"


class DownloadError(SyncError):
    exit_code = 6
    tag = "DOWNLOAD_FAILED"


@dataclass(frozen=True)
class GlobalConfig:
    yt_dlp: Path
    cookie_file: Path
    ffprobe: Path


@dataclass(frozen=True)
class TaskConfig:
    name: str
    season_url: str
    library_dir: Path
    download_dir: Path
    after_date: date | None


@dataclass(frozen=True)
class VideoPlan:
    bv: str
    title: str
    upload_date: date
    webpage_url: str
    format_id: str
    width: int
    height: int
    resolution: str


@dataclass(frozen=True)
class VideoFailure:
    task_name: str
    bv: str
    tag: str
    message: str
    exit_code: int
    title: str | None = None
    upload_date: date | None = None


def eprint(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def resolve_path(value: str, base_dir: Path) -> Path:
    expanded = Path(os.path.expandvars(os.path.expanduser(value)))
    if not expanded.is_absolute():
        expanded = base_dir / expanded
    return expanded.resolve()


def resolve_executable(value: str, base_dir: Path, label: str) -> Path:
    candidate = resolve_path(value, base_dir)
    if candidate.is_file():
        return candidate
    located = shutil.which(value)
    if located:
        return Path(located).resolve()
    raise SyncError(f"找不到 {label}: {value}")


def parse_date(value: Any, label: str) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value))
    except ValueError as exc:
        raise SyncError(f"{label} 必须是 YYYY-MM-DD，实际为 {value!r}") from exc


def load_config(config_path: Path) -> tuple[GlobalConfig, list[TaskConfig]]:
    config_path = config_path.expanduser().resolve()
    if not config_path.is_file():
        raise SyncError(f"配置文件不存在: {config_path}")
    try:
        with config_path.open("rb") as handle:
            raw = tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise SyncError(f"无法读取配置文件 {config_path}: {exc}") from exc

    base_dir = config_path.parent
    global_raw = raw.get("global")
    if not isinstance(global_raw, dict):
        raise SyncError("配置缺少 [global]")

    yt_dlp_value = str(global_raw.get("yt_dlp", "yt-dlp"))
    cookie_value = global_raw.get("cookie_file")
    if not cookie_value:
        raise SyncError("[global] 必须配置 cookie_file")
    ffprobe_value = str(global_raw.get("ffprobe", "ffprobe"))
    global_config = GlobalConfig(
        yt_dlp=resolve_executable(yt_dlp_value, base_dir, "yt-dlp"),
        cookie_file=resolve_path(str(cookie_value), base_dir),
        ffprobe=resolve_executable(ffprobe_value, base_dir, "ffprobe"),
    )

    task_rows = raw.get("tasks")
    if not isinstance(task_rows, list) or not task_rows:
        raise SyncError("配置至少需要一个 [[tasks]]")

    tasks: list[TaskConfig] = []
    seen_names: set[str] = set()
    for index, row in enumerate(task_rows, start=1):
        if not isinstance(row, dict):
            raise SyncError(f"第 {index} 个 tasks 配置不是表")
        missing = [key for key in ("name", "season_url", "library_dir", "download_dir") if not row.get(key)]
        if missing:
            raise SyncError(f"第 {index} 个 tasks 缺少: {', '.join(missing)}")
        name = str(row["name"])
        if name in seen_names:
            raise SyncError(f"task 名称重复: {name}")
        seen_names.add(name)
        tasks.append(
            TaskConfig(
                name=name,
                season_url=str(row["season_url"]),
                library_dir=resolve_path(str(row["library_dir"]), base_dir),
                download_dir=resolve_path(str(row["download_dir"]), base_dir),
                after_date=parse_date(row.get("after_date"), f"tasks.{name}.after_date"),
            )
        )
    return global_config, tasks


def load_and_validate_cookie(cookie_path: Path) -> MozillaCookieJar:
    if not cookie_path.is_file():
        raise CookieAuthError(f"Cookie 文件不存在: {cookie_path}")
    jar = MozillaCookieJar(str(cookie_path))
    try:
        jar.load(ignore_discard=True, ignore_expires=True)
    except Exception as exc:
        raise CookieAuthError(f"Cookie 文件无法解析: {cookie_path}: {exc}") from exc

    now = datetime.now(tz=timezone.utc).timestamp()
    sessdata = [
        cookie
        for cookie in jar
        if cookie.name == "SESSDATA"
        and cookie.domain.lower().lstrip(".").endswith("bilibili.com")
        and bool(cookie.value)
    ]
    if not sessdata:
        raise CookieAuthError(
            f"{cookie_path} 缺少 B 站登录 Cookie SESSDATA；拒绝继续，防止匿名画质降级"
        )
    if all(cookie.expires is not None and cookie.expires <= now for cookie in sessdata):
        raise CookieAuthError(
            f"{cookie_path} 中的 B 站 SESSDATA 已过期；拒绝继续，防止画质降级"
        )

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    request = urllib.request.Request(
        BILIBILI_NAV_URL,
        headers={
            "Accept": "application/json, text/plain, */*",
            "Origin": "https://www.bilibili.com",
            "Referer": "https://www.bilibili.com/",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with opener.open(request, timeout=20) as response:
            payload = json.load(response)
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise CookieAuthError(f"无法在线验证 B 站 Cookie 登录态: {exc}") from exc

    api_code = payload.get("code") if isinstance(payload, dict) else "unknown"
    data = payload.get("data") if isinstance(payload, dict) else None
    if api_code != 0 or not isinstance(data, dict) or data.get("isLogin") is not True:
        raise CookieAuthError(
            f"B 站接口确认当前 Cookie 未登录（API code={api_code}）；拒绝继续，防止匿名画质降级"
        )
    return jar


def decode_output(value: bytes) -> str:
    return value.decode("utf-8-sig", errors="replace")


def concise_stderr(value: bytes, limit: int = 2000) -> str:
    text = decode_output(value).strip()
    if len(text) > limit:
        text = text[-limit:]
    return text or "yt-dlp 未提供错误详情"


def run_yt_dlp_json(global_config: GlobalConfig, extra_args: list[str], context: str) -> dict[str, Any]:
    command = [
        str(global_config.yt_dlp),
        "--ignore-config",
        "--cookies",
        str(global_config.cookie_file),
        "--no-warnings",
        "--no-progress",
        *extra_args,
    ]
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if completed.returncode != 0:
        try:
            load_and_validate_cookie(global_config.cookie_file)
        except CookieAuthError:
            raise
        raise ExtractorError(f"{context}失败: {concise_stderr(completed.stderr)}")
    try:
        result = json.loads(decode_output(completed.stdout))
    except json.JSONDecodeError as exc:
        raise ExtractorError(f"{context}返回的不是有效 JSON: {exc}") from exc
    if not isinstance(result, dict):
        raise ExtractorError(f"{context}返回结构异常")
    return result


def normalize_bv(value: Any) -> str | None:
    match = BV_RE.search(str(value or ""))
    if not match:
        return None
    # BV 主体使用大小写敏感的 Base58 字符；只规范固定前缀，不改变主体。
    matched = match.group(1)
    return f"BV{matched[2:]}"


def scan_media_by_bv(root: Path, *, must_exist: bool) -> dict[str, list[Path]]:
    if not root.exists():
        if must_exist:
            raise SyncError(f"视频库不存在: {root}")
        return {}
    if not root.is_dir():
        raise SyncError(f"配置路径不是文件夹: {root}")
    result: dict[str, list[Path]] = {}
    try:
        files: Iterable[Path] = root.rglob("*")
        for path in files:
            if not path.is_file() or path.suffix.lower() not in MEDIA_EXTENSIONS:
                continue
            bv = normalize_bv(path.name)
            if bv:
                result.setdefault(bv, []).append(path)
    except OSError as exc:
        raise SyncError(f"扫描文件夹失败 {root}: {exc}") from exc
    return result


def load_playlist(global_config: GlobalConfig, task: TaskConfig) -> list[tuple[str, str]]:
    payload = run_yt_dlp_json(
        global_config,
        ["--flat-playlist", "--dump-single-json", "--", task.season_url],
        f"读取 task {task.name} 合集",
    )
    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise ExtractorError(f"task {task.name} 的合集没有 entries")
    result: list[tuple[str, str]] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        bv = normalize_bv(entry.get("id") or entry.get("url"))
        if not bv:
            raise ExtractorError(f"task {task.name} 的合集包含无法识别 BV 的条目")
        if bv in seen:
            continue
        seen.add(bv)
        url = str(entry.get("url") or f"https://www.bilibili.com/video/{bv}")
        result.append((bv, url))
    if not result:
        raise ExtractorError(f"task {task.name} 的合集为空；拒绝把空结果当作成功")
    return result


def get_video_info(global_config: GlobalConfig, bv: str, url: str) -> dict[str, Any]:
    info = run_yt_dlp_json(
        global_config,
        [
            "--no-playlist",
            "--check-formats",
            "--format",
            "bestvideo+bestaudio",
            "--dump-single-json",
            "--",
            url,
        ],
        f"读取 {bv} 元数据并选择最高画质",
    )
    actual_bv = normalize_bv(info.get("id") or info.get("webpage_url"))
    if actual_bv != bv:
        raise ExtractorError(f"{bv} 元数据返回了不同 ID: {actual_bv}")
    # 防止 Cookie 恰好在格式提取期间失效，而 yt-dlp 匿名成功返回较低画质。
    load_and_validate_cookie(global_config.cookie_file)
    return info


def selected_format_from_info(info: dict[str, Any], bv: str) -> tuple[str, int, int, str]:
    requested = info.get("requested_formats")
    if not isinstance(requested, list) or not requested:
        raise ExtractorError(f"{bv} 没有 yt-dlp 选中的独立视频+音频格式")
    video_formats = [
        fmt
        for fmt in requested
        if isinstance(fmt, dict) and str(fmt.get("vcodec") or "none").lower() != "none"
    ]
    audio_formats = [
        fmt
        for fmt in requested
        if isinstance(fmt, dict) and str(fmt.get("acodec") or "none").lower() != "none"
    ]
    if len(video_formats) != 1 or not audio_formats:
        raise ExtractorError(f"{bv} 的最高画质选择结果不是一条视频流加音频流")
    selected_ids = [str(fmt.get("format_id") or "").strip() for fmt in requested if isinstance(fmt, dict)]
    if not selected_ids or any(not format_id for format_id in selected_ids):
        raise ExtractorError(f"{bv} 的最高画质选择结果缺少 format ID")
    video = video_formats[0]
    try:
        width = int(video["width"])
        height = int(video["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ExtractorError(f"{bv} 的最高画质选择结果缺少有效尺寸") from exc
    resolution = str(video.get("resolution") or f"{width}x{height}")
    return "+".join(selected_ids), width, height, resolution


def upload_date_from_info(info: dict[str, Any], bv: str) -> date:
    upload_date = str(info.get("upload_date") or "")
    if re.fullmatch(r"\d{8}", upload_date):
        return datetime.strptime(upload_date, "%Y%m%d").date()
    timestamp = info.get("timestamp")
    if isinstance(timestamp, (int, float)):
        return datetime.fromtimestamp(timestamp, tz=CHINA_TZ).date()
    raise ExtractorError(f"{bv} 缺少可用的上传日期，无法生成要求的文件名")


def probe_dimensions(ffprobe: Path, media_path: Path) -> tuple[int, int]:
    command = [
        str(ffprobe),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "json",
        str(media_path),
    ]
    completed = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if completed.returncode != 0:
        raise DownloadError(f"ffprobe 无法验证 {media_path}: {concise_stderr(completed.stderr)}")
    try:
        payload = json.loads(decode_output(completed.stdout))
        streams = payload["streams"]
        return int(streams[0]["width"]), int(streams[0]["height"])
    except (KeyError, IndexError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise DownloadError(f"ffprobe 未能从 {media_path} 读到视频尺寸") from exc


def verify_staged_selection(global_config: GlobalConfig, paths: list[Path], item: VideoPlan) -> None:
    valid = False
    observations: list[str] = []
    for media_path in paths:
        try:
            width, height = probe_dimensions(global_config.ffprobe, media_path)
            observations.append(f"{media_path.name}={width}x{height}")
            if width == item.width and height == item.height:
                valid = True
        except DownloadError as exc:
            observations.append(f"{media_path.name}=无法读取（{exc}）")
    if not valid:
        raise QualityError(
            f"中转目录已有 {item.bv}，但尺寸与当前登录态下 yt-dlp 选中的最高画质 "
            f"{item.resolution}（format {item.format_id}）不一致（{'; '.join(observations)}）；"
            "拒绝把它当作已下载，请先移走或人工处理"
        )


def build_plan(
    global_config: GlobalConfig,
    task: TaskConfig,
    playlist: list[tuple[str, str]],
    library: dict[str, list[Path]],
    staged: dict[str, list[Path]],
    cutoff: date | None,
) -> tuple[list[VideoPlan], list[VideoPlan], list[VideoFailure]]:
    plan: list[VideoPlan] = []
    ignored: list[VideoPlan] = []
    failures: list[VideoFailure] = []
    for bv, url in playlist:
        if bv in library:
            continue
        published: date | None = None
        title: str | None = None
        try:
            info = get_video_info(global_config, bv, url)
            published = upload_date_from_info(info, bv)
            title = str(info.get("title") or "").strip()
            if not title:
                raise ExtractorError(f"{bv} 缺少标题，无法生成要求的文件名")
            webpage_url = str(info.get("webpage_url") or url)
            format_id, width, height, resolution = selected_format_from_info(info, bv)
            item = VideoPlan(
                bv=bv,
                title=title,
                upload_date=published,
                webpage_url=webpage_url,
                format_id=format_id,
                width=width,
                height=height,
                resolution=resolution,
            )
            if cutoff is not None and published <= cutoff:
                ignored.append(item)
                continue
            if bv in staged:
                verify_staged_selection(global_config, staged[bv], item)
            else:
                plan.append(item)
        except CookieAuthError:
            raise
        except (ExtractorError, QualityError) as exc:
            failures.append(
                VideoFailure(
                    task_name=task.name,
                    bv=bv,
                    tag=exc.tag,
                    message=str(exc),
                    exit_code=exc.exit_code,
                    title=title,
                    upload_date=published,
                )
            )
    return plan, ignored, failures


def expected_name_pattern(item: VideoPlan) -> re.Pattern[str]:
    escaped_bv = re.escape(item.bv)
    escaped_date = re.escape(item.upload_date.isoformat())
    return re.compile(rf"^\[{escaped_date}\] .+ \[{escaped_bv}\]\.[^.]+$")


def download_one(global_config: GlobalConfig, task: TaskConfig, item: VideoPlan) -> Path:
    # 每条下载前再次确认登录；随后锁定预检得到的精确 format ID，禁止重新选低画质。
    load_and_validate_cookie(global_config.cookie_file)
    output_template = str(
        task.download_dir / "[%(upload_date>%Y-%m-%d)s] %(title)s [%(id)s].%(ext)s"
    )
    command = [
        str(global_config.yt_dlp),
        "--ignore-config",
        "--cookies",
        str(global_config.cookie_file),
        "--no-playlist",
        "--check-formats",
        "--format",
        item.format_id,
        "--merge-output-format",
        "mp4",
        "--remux-video",
        "mp4",
        "--windows-filenames",
        "--no-overwrites",
        "--output",
        output_template,
        "--",
        item.webpage_url,
    ]
    print(
        f"\n[DOWNLOAD] {item.upload_date.isoformat()} {item.title} [{item.bv}] "
        f"{item.resolution} format={item.format_id}",
        flush=True,
    )
    completed = subprocess.run(command, check=False)
    if completed.returncode != 0:
        try:
            load_and_validate_cookie(global_config.cookie_file)
        except CookieAuthError:
            raise
        raise DownloadError(f"yt-dlp 下载 {item.bv} 失败，退出码 {completed.returncode}")

    matches = scan_media_by_bv(task.download_dir, must_exist=True).get(item.bv, [])
    if not matches:
        raise DownloadError(f"yt-dlp 返回成功，但中转目录没有找到 {item.bv}")
    matches.sort(key=lambda path: path.stat().st_mtime, reverse=True)
    output_path = matches[0]
    width, height = probe_dimensions(global_config.ffprobe, output_path)
    if width != item.width or height != item.height:
        raise QualityError(
            f"下载后硬校验失败: {output_path} 实际为 {width}x{height}，"
            f"预检最高画质为 {item.resolution}（format {item.format_id}）；文件保留供检查"
        )
    if not expected_name_pattern(item).match(output_path.name):
        raise DownloadError(f"下载完成但文件名不符合约定: {output_path.name}")
    print(f"[VERIFIED] {width}x{height} format={item.format_id}  {output_path}", flush=True)
    return output_path


def process_task(
    global_config: GlobalConfig,
    task: TaskConfig,
    *,
    dry_run: bool,
    after_date_override: date | None,
) -> list[VideoFailure]:
    cutoff = after_date_override if after_date_override is not None else task.after_date
    print(f"\n=== task: {task.name} ===")
    print(f"合集: {task.season_url}")
    print(f"视频库: {task.library_dir}")
    print(f"中转目录: {task.download_dir}")
    print(f"日期规则: {'仅处理严格晚于 ' + cutoff.isoformat() if cutoff else '不设下限'}")

    load_and_validate_cookie(global_config.cookie_file)
    print("Cookie: 已由 B 站接口确认登录")
    playlist = load_playlist(global_config, task)
    library = scan_media_by_bv(task.library_dir, must_exist=True)
    staged = scan_media_by_bv(task.download_dir, must_exist=False)
    playlist_bvs = {bv for bv, _ in playlist}

    outside_library = playlist_bvs - library.keys()
    print(
        f"BV 汇总: 合集 {len(playlist)} / 库内 {len(playlist_bvs & library.keys())} / "
        f"中转已有 {len(outside_library & staged.keys())} / 库外待核验 {len(outside_library)}"
    )
    plan, ignored, failures = build_plan(global_config, task, playlist, library, staged, cutoff)

    for item in ignored:
        print(
            f"[IGNORE:DATE] {item.upload_date.isoformat()} {item.title} [{item.bv}] "
            f"[{item.resolution}; format {item.format_id}]"
        )
    if failures:
        print(f"\n跳过 {len(failures)} 个视频:")
        for failure in failures:
            if failure.upload_date is not None and failure.title:
                print(f"  {failure.upload_date.isoformat()}  {failure.bv}  {failure.title}")
                print(f"    [{failure.tag}] {failure.message}")
            else:
                print(f"  {failure.bv}")
                print(f"    [{failure.tag}] {failure.message}")
    if plan:
        print(f"\n{'将下载' if not dry_run else 'DRY-RUN 缺失'} {len(plan)} 个视频:")
        for item in plan:
            print(
                f"  {item.upload_date.isoformat()}  {item.bv}  {item.title}"
                f"  [{item.resolution}; format {item.format_id}]"
            )
    else:
        print("没有需要下载的视频。")

    if dry_run:
        print("DRY-RUN 完成：没有创建目录或下载文件。")
        return failures
    if not plan:
        return failures

    task.download_dir.mkdir(parents=True, exist_ok=True)
    load_and_validate_cookie(global_config.cookie_file)
    completed_paths: list[Path] = []
    for item in plan:
        try:
            completed_paths.append(download_one(global_config, task, item))
        except CookieAuthError:
            raise
        except (DownloadError, ExtractorError, QualityError) as exc:
            failure = VideoFailure(
                task_name=task.name,
                bv=item.bv,
                tag=exc.tag,
                message=str(exc),
                exit_code=exc.exit_code,
                title=item.title,
                upload_date=item.upload_date,
            )
            failures.append(failure)
            print(f"[SKIP:{failure.tag}] {item.upload_date.isoformat()}  {item.bv}  {item.title}: {failure.message}")
    print(f"task {task.name} 完成并验证 {len(completed_paths)} 个最高可用画质文件。")
    return failures


def make_parser() -> argparse.ArgumentParser:
    default_config = Path(__file__).with_name("config.toml")
    parser = argparse.ArgumentParser(
        description="严格校验 B 站登录态，按 BV 做 diff，并锁定 yt-dlp 可见的最高画质下载到中转目录。"
    )
    parser.add_argument("--config", type=Path, default=default_config, help=f"TOML 配置（默认 {default_config}）")
    parser.add_argument(
        "--cookie-file",
        type=Path,
        help="从指定的 Netscape Cookie 文件读取 B 站登录态；覆盖 [global].cookie_file",
    )
    parser.add_argument("--dry-run", action="store_true", help="只做 diff、日期过滤和最高画质选择，不下载")
    parser.add_argument("--task", action="append", dest="task_names", help="只运行指定 task；可重复传入")
    parser.add_argument(
        "--after-date",
        type=lambda value: parse_date(value, "--after-date"),
        help="覆盖所选 task 的日期下限，仅处理严格晚于 YYYY-MM-DD 的视频",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = make_parser()
    args = parser.parse_args(argv)
    try:
        global_config, tasks = load_config(args.config)
        if args.cookie_file is not None:
            global_config = GlobalConfig(
                yt_dlp=global_config.yt_dlp,
                cookie_file=resolve_path(str(args.cookie_file), Path.cwd()),
                ffprobe=global_config.ffprobe,
            )
        if args.task_names:
            requested = set(args.task_names)
            known = {task.name for task in tasks}
            unknown = requested - known
            if unknown:
                raise SyncError(f"未知 task: {', '.join(sorted(unknown))}")
            tasks = [task for task in tasks if task.name in requested]

        print(f"yt-dlp: {global_config.yt_dlp}")
        print(f"Cookie: {global_config.cookie_file}")
        print(f"模式: {'DRY-RUN' if args.dry_run else 'DOWNLOAD'}")
        all_failures: list[VideoFailure] = []
        for task in tasks:
            all_failures.extend(
                process_task(
                    global_config,
                    task,
                    dry_run=args.dry_run,
                    after_date_override=args.after_date,
                )
            )
        if all_failures:
            print(f"\n完成其余条目，但有 {len(all_failures)} 个视频被跳过:")
            for failure in all_failures:
                if failure.upload_date is not None and failure.title:
                    print(
                        f"  {failure.upload_date.isoformat()}  {failure.bv}  {failure.title}"
                        f"  ({failure.task_name})"
                    )
                    print(f"    [{failure.tag}] {failure.message}")
                else:
                    print(f"  {failure.bv}  ({failure.task_name})")
                    print(f"    [{failure.tag}] {failure.message}")
            return max(failure.exit_code for failure in all_failures)
        return 0
    except SyncError as exc:
        eprint(f"\n[ALERT:{exc.tag}] {exc}")
        return exc.exit_code
    except KeyboardInterrupt:
        eprint("\n[ALERT:INTERRUPTED] 用户中断")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
