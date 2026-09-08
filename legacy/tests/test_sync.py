from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).parents[1] / "bilibili_season_sync.py"
SPEC = importlib.util.spec_from_file_location("bilibili_season_sync", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sync
SPEC.loader.exec_module(sync)


class SyncTests(unittest.TestCase):
    def test_normalize_bv_from_filename(self) -> None:
        self.assertEqual(
            sync.normalize_bv("[2026-08-01] title [BV1abcdefghi].mp4"),
            "BV1abcdefghi",
        )

    def test_scan_media_ignores_sidecars_and_finds_nested_video(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            nested = root / "nested"
            nested.mkdir()
            (nested / "[2026-08-01] title [BV1abcdefghi].mp4").touch()
            (nested / "[2026-08-01] title [BV1zzzzzzzzz].info.json").touch()
            result = sync.scan_media_by_bv(root, must_exist=True)
            self.assertEqual(set(result), {"BV1abcdefghi"})

    def test_selected_format_accepts_highest_available_below_1080(self) -> None:
        info = {
            "requested_formats": [
                {
                    "format_id": "100024",
                    "resolution": "1280x634",
                    "width": 1280,
                    "height": 634,
                    "vcodec": "av01",
                    "acodec": "none",
                },
                {"format_id": "30280", "vcodec": "none", "acodec": "mp4a.40.2"},
            ]
        }
        self.assertEqual(
            sync.selected_format_from_info(info, "BV1abcDEFghi"),
            ("100024+30280", 1280, 634, "1280x634"),
        )

    def test_after_date_is_strict(self) -> None:
        cutoff = sync.parse_date("2026-08-01", "test")
        self.assertEqual(cutoff, date(2026, 8, 1))
        self.assertFalse(date(2026, 8, 1) > cutoff)
        self.assertTrue(date(2026, 8, 2) > cutoff)

    def test_cookie_file_cli_option(self) -> None:
        args = sync.make_parser().parse_args(["--cookie-file", "cookies/bilibili.txt", "--dry-run"])
        self.assertEqual(args.cookie_file, Path("cookies/bilibili.txt"))
        self.assertTrue(args.dry_run)

    def test_build_plan_skips_item_failure_and_continues(self) -> None:
        global_config = sync.GlobalConfig(
            yt_dlp=Path("yt-dlp"),
            cookie_file=Path("cookies.txt"),
            ffprobe=Path("ffprobe"),
        )
        task = sync.TaskConfig(
            name="test",
            season_url="https://example.invalid/season",
            library_dir=Path("library"),
            download_dir=Path("downloads"),
            after_date=None,
        )
        playlist = [
            ("BV1abcDEFghi", "https://example.invalid/BV1abcDEFghi"),
            ("BV1jklMNOpqr", "https://example.invalid/BV1jklMNOpqr"),
        ]
        infos = [
            {
                "id": playlist[0][0],
                "title": "broken",
                "upload_date": "20260801",
                "webpage_url": playlist[0][1],
                "requested_formats": [],
            },
            {
                "id": playlist[1][0],
                "title": "full",
                "upload_date": "20260802",
                "webpage_url": playlist[1][1],
                "requested_formats": [
                    {
                        "format_id": "30077",
                        "resolution": "1920x1080",
                        "width": 1920,
                        "height": 1080,
                        "vcodec": "hev1",
                        "acodec": "none",
                    },
                    {"format_id": "30280", "vcodec": "none", "acodec": "mp4a.40.2"},
                ],
            },
        ]
        with mock.patch.object(sync, "get_video_info", side_effect=infos):
            plan, ignored, failures = sync.build_plan(
                global_config, task, playlist, library={}, staged={}, cutoff=None
            )
        self.assertEqual([item.bv for item in plan], ["BV1jklMNOpqr"])
        self.assertEqual(plan[0].format_id, "30077+30280")
        self.assertEqual(plan[0].resolution, "1920x1080")
        self.assertEqual(ignored, [])
        self.assertEqual([failure.bv for failure in failures], ["BV1abcDEFghi"])
        self.assertEqual(failures[0].title, "broken")
        self.assertEqual(failures[0].upload_date, date(2026, 8, 1))

    def test_cookie_failure_is_global_and_not_skipped(self) -> None:
        global_config = sync.GlobalConfig(
            yt_dlp=Path("yt-dlp"),
            cookie_file=Path("cookies.txt"),
            ffprobe=Path("ffprobe"),
        )
        task = sync.TaskConfig(
            name="test",
            season_url="https://example.invalid/season",
            library_dir=Path("library"),
            download_dir=Path("downloads"),
            after_date=None,
        )
        playlist = [("BV1abcDEFghi", "https://example.invalid/BV1abcDEFghi")]
        with (
            mock.patch.object(
                sync,
                "get_video_info",
                side_effect=sync.CookieAuthError("login expired"),
            ),
            self.assertRaises(sync.CookieAuthError),
        ):
            sync.build_plan(global_config, task, playlist, library={}, staged={}, cutoff=None)

    def test_download_locks_preflight_format_id(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            download_dir = Path(temp)
            item = sync.VideoPlan(
                bv="BV1abcDEFghi",
                title="title",
                upload_date=date(2026, 8, 1),
                webpage_url="https://example.invalid/BV1abcDEFghi",
                format_id="100024+30280",
                width=1280,
                height=634,
                resolution="1280x634",
            )
            media_path = download_dir / "[2026-08-01] title [BV1abcDEFghi].mp4"
            media_path.touch()
            global_config = sync.GlobalConfig(
                yt_dlp=Path("yt-dlp"),
                cookie_file=Path("cookies.txt"),
                ffprobe=Path("ffprobe"),
            )
            task = sync.TaskConfig(
                name="test",
                season_url="https://example.invalid/season",
                library_dir=Path("library"),
                download_dir=download_dir,
                after_date=None,
            )
            with (
                mock.patch.object(sync, "load_and_validate_cookie"),
                mock.patch.object(sync.subprocess, "run", return_value=mock.Mock(returncode=0)) as run,
                mock.patch.object(sync, "probe_dimensions", return_value=(1280, 634)),
            ):
                result = sync.download_one(global_config, task, item)
            command = run.call_args.args[0]
            self.assertEqual(command[command.index("--format") + 1], "100024+30280")
            self.assertNotIn("bestvideo", command)
            self.assertEqual(result, media_path)


if __name__ == "__main__":
    unittest.main()
