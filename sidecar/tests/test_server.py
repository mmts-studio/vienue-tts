"""API tests with a fake model, so they run without downloading anything."""
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).parent.parent))
from server import create_app  # noqa: E402

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class FakeTts:
    sample_rate = 48_000

    def __init__(self):
        self.calls = []

    def infer_stream(self, text, **kwargs):
        self.calls.append(kwargs)
        if "boom" in text:
            raise RuntimeError("engine exploded")
        for _ in range(3):
            yield np.zeros(4_800, dtype=np.float32)

    def save(self, audio, path):
        sf.write(str(path), audio, self.sample_rate)


@pytest.fixture
def fake():
    return FakeTts()


@pytest.fixture
def client(tmp_path, fake):
    with TestClient(create_app(tmp_path / "data", TOKEN, lambda: fake), headers=AUTH) as c:
        yield c


def wait(client, job_id):
    for _ in range(200):
        job = client.get(f"/v1/jobs/{job_id}").json()
        if job["status"] in ("done", "error"):
            return job
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def clip(path, seconds=4):
    sf.write(str(path), np.zeros(16_000 * seconds, dtype=np.float32), 16_000)
    return str(path)


def test_token_required_everywhere_except_health(tmp_path, fake):
    with TestClient(create_app(tmp_path / "d", TOKEN, lambda: fake)) as anon:
        assert anon.get("/health").status_code == 200
        assert anon.get("/v1/voices").status_code == 401
        assert anon.post("/mcp", json={}).status_code == 401
        wrong = {"Authorization": "Bearer nope"}
        assert anon.get("/v1/history", headers=wrong).status_code == 401


def test_tts_writes_file_and_records_history(client, tmp_path):
    out = tmp_path / "out"
    job = client.post(
        "/v1/tts", json={"text": "Xin chào", "voice": "Hải Đăng", "output_dir": str(out)}
    ).json()
    done = wait(client, job["id"])
    assert done["status"] == "done" and done["progress"] == 1.0
    assert Path(done["result"]["path"]).parent == out
    assert done["result"]["audio_seconds"] == 0.3
    assert [p.name for p in out.iterdir()] == [Path(done["result"]["path"]).name]

    [item] = client.get("/v1/history").json()
    assert item["text"] == "Xin chào" and item["voice"] == "Hải Đăng"
    audio = client.get(f"/v1/history/{item['id']}/audio")
    assert audio.status_code == 200 and audio.headers["content-type"] == "audio/wav"

    Path(item["path"]).unlink()
    assert client.get(f"/v1/history/{item['id']}/audio").status_code == 410


@pytest.mark.parametrize(
    "body",
    [
        {"text": "   "},
        {"text": "x", "voice": "Không tồn tại"},
        {"text": "x", "output_dir": "relative/path"},
    ],
)
def test_tts_rejects_bad_input(client, body):
    assert client.post("/v1/tts", json=body).status_code == 400


def test_filename_cannot_escape_output_dir_or_overwrite(client, tmp_path):
    out = tmp_path / "out"
    body = {"text": "x", "output_dir": str(out), "filename": "../../evil.mp3"}
    first = wait(client, client.post("/v1/tts", json=body).json()["id"])
    second = wait(client, client.post("/v1/tts", json=body).json()["id"])
    assert first["result"]["path"] == str(out / "evil.wav")
    assert second["result"]["path"] == str(out / "evil-1.wav")


def test_engine_failure_is_reported_and_leaves_no_file(client, tmp_path):
    out = tmp_path / "out"
    job = client.post("/v1/tts", json={"text": "boom", "output_dir": str(out)}).json()
    done = wait(client, job["id"])
    assert done["status"] == "error" and "exploded" in done["error"]
    assert list(out.iterdir()) == [] and client.get("/v1/history").json() == []


def test_custom_voice_clones_from_folder(client, tmp_path, fake):
    source = clip(tmp_path / "me.wav")
    added = client.post(
        "/v1/voices", json={"name": "Giọng tôi", "source_path": source, "description": "Trầm"}
    )
    assert added.status_code == 201
    voice = added.json()
    assert voice["kind"] == "custom" and voice["description"] == "Trầm"

    assert client.get("/v1/voices/Giọng tôi/preview").status_code == 200
    job = client.post(
        "/v1/tts", json={"text": "x", "voice": "Giọng tôi", "output_dir": str(tmp_path / "out")}
    ).json()
    assert wait(client, job["id"])["status"] == "done"
    assert fake.calls[-1] == {"ref_audio": voice["path"]}


def test_clip_dropped_into_folder_appears_as_voice(client, tmp_path):
    folder = tmp_path / "samples"
    client.put("/v1/settings", json={"voices_dir": str(folder)})
    clip(folder / "Thả vào.wav")
    names = [v["name"] for v in client.get("/v1/voices").json()["voices"]]
    assert "Thả vào" in names


@pytest.mark.parametrize(
    "name,seconds,message",
    [
        ("../evil", 4, "không hợp lệ"),
        ("Hải Đăng", 4, "đã tồn tại"),
        ("Ngắn", 1, "ít nhất"),
    ],
)
def test_add_voice_rejects_bad_input(client, tmp_path, name, seconds, message):
    source = clip(tmp_path / "c.wav", seconds)
    response = client.post("/v1/voices", json={"name": name, "source_path": source})
    assert response.status_code == 400 and message in response.json()["detail"]


def test_preset_preview_is_cached_and_not_in_history(client, fake):
    assert client.get("/v1/voices/Hải Đăng/preview").status_code == 200
    assert client.get("/v1/voices/Hải Đăng/preview").status_code == 200
    assert len(fake.calls) == 1
    assert client.get("/v1/history").json() == []
    assert client.get("/v1/voices/Không có/preview").status_code == 404
