"""Runs VieNeu-TTS on one worker thread; the ONNX/CPU engine handles one job at a time."""
from __future__ import annotations

import logging
import queue
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np

logger = logging.getLogger("vieneu-app")

# infer_stream reports no total, so progress compares generated audio against the
# duration expected from the text length. Measured: about 18 characters per second.
CHARS_PER_AUDIO_SECOND = 18
MAX_FINISHED_JOBS = 200


def _load_vieneu():
    from vieneu import Vieneu

    return Vieneu()


@dataclass
class Job:
    text: str
    voice: str
    voice_args: dict
    output_path: Path
    record_history: bool = True
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    status: str = "queued"  # queued | running | done | error
    progress: float = 0.0
    message: str = "Đang chờ tới lượt"
    error: str | None = None
    result: dict | None = None
    finished: threading.Event = field(default_factory=threading.Event)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "progress": round(self.progress, 4),
            "message": self.message,
            "error": self.error,
            "result": self.result,
        }


class Engine:
    def __init__(self, on_result: Callable[[dict], None], load_tts: Callable = _load_vieneu):
        self._on_result = on_result
        self._load_tts = load_tts
        self._tts = None
        self._queue: queue.Queue[Job] = queue.Queue()
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self.state = "idle"  # idle | loading | ready | error
        self.error: str | None = None

    def start(self) -> None:
        threading.Thread(target=self._run, daemon=True, name="tts-worker").start()

    def submit(self, job: Job) -> Job:
        self._jobs[job.id] = job
        finished = [k for k, j in self._jobs.items() if j.finished.is_set()]
        for key in finished[: max(0, len(finished) - MAX_FINISHED_JOBS)]:
            del self._jobs[key]
        self._queue.put(job)
        return job

    def job(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    def _ensure_loaded(self) -> None:
        if self._tts is not None:
            return
        self.state, self.error = "loading", None
        try:
            self._tts = self._load_tts()
            self.state = "ready"
        except Exception as exc:
            self.state, self.error = "error", str(exc)
            raise

    def _run(self) -> None:
        # Load up front so the first request does not also pay for the model download.
        try:
            self._ensure_loaded()
        except Exception:
            logger.exception("Could not load the model")
        while True:
            job = self._queue.get()
            job.status = "running"
            try:
                self._synthesize(job)
                job.status, job.progress, job.message = "done", 1.0, "Hoàn tất"
            except Exception as exc:
                logger.exception("Job %s failed", job.id)
                job.status, job.error, job.message = "error", str(exc), "Thất bại"
            job.finished.set()

    def _synthesize(self, job: Job) -> None:
        job.message = "Đang nạp mô hình"
        self._ensure_loaded()

        is_clone = "ref_audio" in job.voice_args
        job.message = "Đang phân tích giọng mẫu" if is_clone else "Đang tạo giọng nói"
        expected_seconds = max(len(job.text) / CHARS_PER_AUDIO_SECOND, 1.0)
        sample_rate = self._tts.sample_rate
        started = time.perf_counter()
        parts, samples = [], 0
        for chunk in self._tts.infer_stream(job.text, **job.voice_args):
            parts.append(chunk)
            samples += len(chunk)
            job.message = "Đang tạo giọng nói"
            job.progress = min(samples / sample_rate / expected_seconds, 0.99)
        if not samples:
            raise RuntimeError("Mô hình không sinh ra âm thanh. Hãy kiểm tra lại nội dung văn bản.")

        # Written next to the target and renamed so a partial file is never visible.
        temp_path = job.output_path.with_name(f".{job.id}.tmp.wav")
        try:
            self._tts.save(np.concatenate(parts), temp_path)
            temp_path.replace(job.output_path)
        finally:
            temp_path.unlink(missing_ok=True)

        job.result = {
            "id": job.id,
            "text": job.text,
            "voice": job.voice,
            "path": str(job.output_path),
            "conversion_seconds": round(time.perf_counter() - started, 2),
            "audio_seconds": round(samples / sample_rate, 2),
            "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        if job.record_history:
            self._on_result(job.result)
