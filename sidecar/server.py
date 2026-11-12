"""Local HTTP server: the app's UI, the REST API and MCP all share this one engine."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import importlib.metadata
import logging
import os
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel

from engine import Engine, Job, _load_vieneu
from store import Store, absolute_dir, default_voice_name

DEFAULT_PORT = 8765
PREVIEW_TEXT = "Xin chào, đây là giọng đọc mẫu của VieNeu. Rất vui được đồng hành cùng bạn."
PREVIEW_TIMEOUT_SECONDS = 600
UI_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"]


class TtsRequest(BaseModel):
    text: str
    voice: str | None = None
    output_dir: str | None = None
    filename: str | None = None


class VoiceRequest(BaseModel):
    name: str
    source_path: str
    description: str = ""


class SettingsRequest(BaseModel):
    voices_dir: str | None = None
    output_dir: str | None = None


class Service:
    """Operations shared by the REST routes and the MCP tools."""

    def __init__(self, store: Store, engine: Engine):
        self.store = store
        self.engine = engine

    def submit_tts(self, text, voice=None, output_dir=None, filename=None) -> Job:
        text = (text or "").strip()
        if not text:
            raise ValueError("Văn bản không được để trống.")
        voice_name = voice or default_voice_name()
        found = self.store.find_voice(voice_name)
        if not found:
            raise ValueError(f"Không có giọng '{voice_name}'. Xem danh sách tại GET /v1/voices.")
        folder = absolute_dir(output_dir or self.store.settings()["output_dir"])
        return self.engine.submit(
            Job(
                text=text,
                voice=voice_name,
                voice_args=_voice_args(found),
                output_path=_unique_output_path(folder, filename),
            )
        )


def _voice_args(voice: dict) -> dict:
    if voice["kind"] == "custom":
        return {"ref_audio": voice["path"]}
    return {"voice": voice["name"]}


def _unique_output_path(folder: Path, filename: str | None) -> Path:
    # .name strips any directory part so a filename cannot escape the output folder.
    stem = Path(filename).stem if filename and Path(filename).name else ""
    stem = stem or f"tts-{datetime.now():%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:6]}"
    path = folder / f"{stem}.wav"
    index = 1
    while path.exists():
        path = folder / f"{stem}-{index}.wav"
        index += 1
    return path


def _preview_path(service: Service, voice: dict) -> Path:
    if voice["kind"] == "custom":
        return Path(voice["path"])
    # Hashed because a voice name is not guaranteed to be a safe file name everywhere.
    key = hashlib.sha256(f"{voice['name']}|{PREVIEW_TEXT}".encode()).hexdigest()[:16]
    path = service.store.previews_dir / f"{key}.wav"
    if not path.exists():
        job = service.engine.submit(
            Job(
                text=PREVIEW_TEXT,
                voice=voice["name"],
                voice_args=_voice_args(voice),
                output_path=path,
                record_history=False,
            )
        )
        if not job.finished.wait(PREVIEW_TIMEOUT_SECONDS):
            raise HTTPException(504, "Tạo giọng nghe thử quá lâu.")
        if job.status == "error":
            raise HTTPException(500, job.error)
    return path


@contextlib.contextmanager
def _reasons_for_agent():
    # Other exceptions are masked by the SDK, but an agent needs the reason to retry.
    try:
        yield
    except ValueError as exc:
        raise ToolError(str(exc)) from exc


def build_mcp(service: Service) -> MCPServer:
    mcp = MCPServer(
        "vieneu-tts",
        instructions=(
            "Vietnamese text-to-speech running locally. Call list_voices to pick a voice, "
            "then synthesize_speech. Audio is written to disk; the result gives its path."
        ),
    )

    @mcp.tool()
    def list_voices() -> list[dict]:
        """List available voices. Pass a voice's `name` to synthesize_speech."""
        return service.store.voices()

    @mcp.tool()
    async def synthesize_speech(
        text: str,
        ctx: Context,
        voice: str | None = None,
        output_dir: str | None = None,
        filename: str | None = None,
    ) -> dict:
        """Turn text into a WAV file and wait until it is finished.

        Args:
            text: Vietnamese or mixed English-Vietnamese text. Experimental cues such as
                [cười] and [thở dài] are supported.
            voice: Voice name from list_voices. Defaults to the built-in default voice.
            output_dir: Absolute folder for the file. Defaults to the app's output folder.
            filename: File name without a folder. A unique name is generated when omitted.

        Returns:
            path, audio_seconds, conversion_seconds, voice, created_at.
        """
        with _reasons_for_agent():
            job = service.submit_tts(text, voice, output_dir, filename)
        while not job.finished.is_set():
            await ctx.report_progress(job.progress, 1.0, job.message)
            await asyncio.sleep(0.5)
        if job.status == "error":
            raise ToolError(job.error)
        return job.result

    @mcp.tool()
    def add_custom_voice(name: str, source_path: str, description: str = "") -> dict:
        """Clone a voice from a clean clip of at least 3 seconds (only the first 8 are used).

        Args:
            name: Name for the new voice.
            source_path: Absolute path of a WAV, FLAC, MP3 or OGG file on this machine.
            description: Optional description shown in the app.
        """
        with _reasons_for_agent():
            return service.store.add_voice(name, source_path, description)

    @mcp.tool()
    def list_history(limit: int = 20) -> list[dict]:
        """List recently generated audio, newest first."""
        return service.store.history(limit)

    return mcp


def create_app(data_dir: Path, load_tts=_load_vieneu) -> FastAPI:
    store = Store(data_dir)
    engine = Engine(store.add_history, load_tts)
    service = Service(store, engine)
    mcp = build_mcp(service)
    mcp_app = mcp.streamable_http_app(stateless_http=True)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        engine.start()
        # A mounted app's own lifespan does not run, so the session manager starts here.
        async with mcp.session_manager.run():
            yield

    app = FastAPI(title="VieNeu-TTS Local API", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware, allow_origins=UI_ORIGINS, allow_methods=["*"], allow_headers=["*"]
    )

    @app.exception_handler(ValueError)
    async def bad_request(_request, exc: ValueError):
        return JSONResponse({"detail": str(exc)}, status_code=400)

    @app.get("/health")
    def health():
        return {
            "service": "vieneu-tts",
            "vieneu_version": importlib.metadata.version("vieneu"),
            "engine": {"state": engine.state, "error": engine.error},
        }

    @app.get("/v1/settings")
    def get_settings():
        return store.settings()

    @app.put("/v1/settings")
    def put_settings(body: SettingsRequest):
        return store.update_settings(body.voices_dir, body.output_dir)

    @app.get("/v1/voices")
    def list_voices():
        return {"default_voice": default_voice_name(), "voices": store.voices()}

    @app.post("/v1/voices", status_code=201)
    def add_voice(body: VoiceRequest):
        return store.add_voice(body.name, body.source_path, body.description)

    @app.get("/v1/voices/{name}/preview")
    def voice_preview(name: str):
        voice = store.find_voice(name)
        if not voice:
            raise HTTPException(404, f"Không có giọng '{name}'.")
        return FileResponse(_preview_path(service, voice))

    @app.post("/v1/tts", status_code=202)
    def create_tts(body: TtsRequest):
        job = service.submit_tts(body.text, body.voice, body.output_dir, body.filename)
        return job.to_dict()

    @app.get("/v1/jobs/{job_id}")
    def get_job(job_id: str):
        job = engine.job(job_id)
        if not job:
            raise HTTPException(404, "Không tìm thấy job.")
        return job.to_dict()

    @app.get("/v1/history")
    def history(limit: int = 100):
        return store.history(limit)

    @app.get("/v1/history/{item_id}/audio")
    def history_audio(item_id: str):
        item = store.history_item(item_id)
        if not item:
            raise HTTPException(404, "Không tìm thấy bản ghi.")
        if not Path(item["path"]).is_file():
            raise HTTPException(410, f"File đã bị xoá hoặc di chuyển: {item['path']}")
        return FileResponse(item["path"], media_type="audio/wav")

    # Last, because it matches everything; its own route is /mcp.
    app.mount("/", mcp_app)
    return app


def _exit_when_parent_dies() -> None:
    # The app holds our stdin open, so EOF means it is gone, even after a crash.
    def watch():
        sys.stdin.read()
        os._exit(0)

    threading.Thread(target=watch, daemon=True).start()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--exit-with-parent", action="store_true")
    args = parser.parse_args()

    data_dir = args.data_dir.expanduser().resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    # A private cache: a shared one may already use the blob layout onnxruntime rejects.
    os.environ["HF_HOME"] = str(data_dir / "huggingface")
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if args.exit_with_parent:
        _exit_when_parent_dies()

    import uvicorn

    app = create_app(data_dir)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
