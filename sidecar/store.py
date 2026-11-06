"""Persistent state of the app: settings, generation history and voices."""
from __future__ import annotations

import importlib.metadata
import json
import re
import shutil
import sqlite3
from contextlib import closing
from functools import lru_cache
from pathlib import Path

import soundfile as sf

AUDIO_EXTENSIONS = {".wav", ".flac", ".mp3", ".ogg"}
MIN_CLIP_SECONDS = 3.0
INVALID_NAME = re.compile(r'[/\\:*?"<>|\x00-\x1f]')


@lru_cache(maxsize=1)
def _preset_file() -> dict:
    # Read straight from the package data: importing vieneu takes several seconds.
    path = importlib.metadata.distribution("vieneu").locate_file(
        "vieneu/assets/voices_v3_turbo.json"
    )
    return json.loads(Path(str(path)).read_text(encoding="utf-8"))


def default_voice_name() -> str:
    return _preset_file()["default_voice"]


def preset_voices() -> list[dict]:
    """Built-in voices, editors' picks first (same order as the SDK)."""
    presets = _preset_file()["presets"]
    ordered = sorted(presets.items(), key=lambda kv: kv[1].get("featured") or 10_000)
    return [
        {
            "name": name,
            "kind": "preset",
            "description": v.get("description", ""),
            "featured": bool(v.get("featured")),
        }
        for name, v in ordered
    ]


class Store:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.previews_dir = data_dir / "previews"
        self.previews_dir.mkdir(parents=True, exist_ok=True)
        self._settings_path = data_dir / "settings.json"
        self._db_path = data_dir / "history.sqlite3"
        with closing(self._db()) as db, db:
            db.execute(
                """CREATE TABLE IF NOT EXISTS history (
                    id TEXT PRIMARY KEY,
                    text TEXT NOT NULL,
                    voice TEXT NOT NULL,
                    path TEXT NOT NULL,
                    conversion_seconds REAL NOT NULL,
                    audio_seconds REAL NOT NULL,
                    created_at TEXT NOT NULL
                )"""
            )

    def _db(self) -> sqlite3.Connection:
        db = sqlite3.connect(self._db_path)
        db.row_factory = sqlite3.Row
        return db

    # ── Settings ───────────────────────────────────────────────────────────
    def settings(self) -> dict:
        saved = {}
        if self._settings_path.exists():
            saved = json.loads(self._settings_path.read_text(encoding="utf-8"))
        return {
            "voices_dir": saved.get("voices_dir") or str(self.data_dir / "voices"),
            "output_dir": saved.get("output_dir") or str(Path.home() / "Music" / "VieNeu-TTS"),
        }

    def update_settings(self, voices_dir: str | None, output_dir: str | None) -> dict:
        current = self.settings()
        for key, value in (("voices_dir", voices_dir), ("output_dir", output_dir)):
            if value is not None:
                current[key] = str(absolute_dir(value))
        self._settings_path.write_text(json.dumps(current, ensure_ascii=False), encoding="utf-8")
        return current

    # ── History ────────────────────────────────────────────────────────────
    def add_history(self, entry: dict) -> None:
        with closing(self._db()) as db, db:
            db.execute(
                "INSERT INTO history VALUES "
                "(:id, :text, :voice, :path, :conversion_seconds, :audio_seconds, :created_at)",
                entry,
            )

    def history(self, limit: int = 100) -> list[dict]:
        with closing(self._db()) as db:
            rows = db.execute(
                "SELECT * FROM history ORDER BY created_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def history_item(self, item_id: str) -> dict | None:
        with closing(self._db()) as db:
            row = db.execute("SELECT * FROM history WHERE id = ?", (item_id,)).fetchone()
        return dict(row) if row else None

    # ── Voices ─────────────────────────────────────────────────────────────
    def custom_voices(self) -> list[dict]:
        """The sample folder is the source of truth: every audio clip in it is a voice."""
        folder = Path(self.settings()["voices_dir"])
        if not folder.is_dir():
            return []
        presets = {v["name"] for v in preset_voices()}
        voices = []
        for clip in sorted(folder.iterdir(), key=lambda p: p.name.casefold()):
            if clip.suffix.lower() not in AUDIO_EXTENSIONS or clip.stem in presets:
                continue
            meta = clip.with_suffix(".json")
            description = ""
            if meta.exists():
                try:
                    description = json.loads(meta.read_text(encoding="utf-8")).get("description", "")
                except (ValueError, OSError):
                    pass
            voices.append(
                {
                    "name": clip.stem,
                    "kind": "custom",
                    "description": description,
                    "featured": False,
                    "path": str(clip),
                }
            )
        return voices

    def voices(self) -> list[dict]:
        return preset_voices() + self.custom_voices()

    def find_voice(self, name: str) -> dict | None:
        return next((v for v in self.voices() if v["name"] == name), None)

    def add_voice(self, name: str, source_path: str, description: str = "") -> dict:
        name = name.strip()
        if not name or len(name) > 60 or name.startswith(".") or INVALID_NAME.search(name):
            raise ValueError("Tên giọng không hợp lệ: tối đa 60 ký tự, không chứa / \\ : * ? \" < > |.")
        if self.find_voice(name):
            raise ValueError(f"Giọng '{name}' đã tồn tại.")
        source = Path(source_path).expanduser()
        if not source.is_absolute() or not source.is_file():
            raise ValueError(f"Không tìm thấy file âm thanh: {source_path}")
        if source.suffix.lower() not in AUDIO_EXTENSIONS:
            raise ValueError("Chỉ hỗ trợ file WAV, FLAC, MP3 hoặc OGG.")
        try:
            duration = sf.info(str(source)).duration
        except Exception as exc:
            raise ValueError(f"Không đọc được file âm thanh: {exc}") from exc
        if duration < MIN_CLIP_SECONDS:
            raise ValueError(f"Clip mẫu cần dài ít nhất {MIN_CLIP_SECONDS:.0f} giây (file này {duration:.1f} giây).")

        folder = absolute_dir(self.settings()["voices_dir"])
        shutil.copyfile(source, folder / f"{name}{source.suffix.lower()}")
        (folder / f"{name}.json").write_text(
            json.dumps({"description": description.strip()}, ensure_ascii=False), encoding="utf-8"
        )
        return self.find_voice(name)


def absolute_dir(value: str) -> Path:
    """Validate a user/agent supplied folder and create it if needed."""
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"Thư mục phải là đường dẫn tuyệt đối: {value}")
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ValueError(f"Không tạo được thư mục {value}: {exc}") from exc
    return path
