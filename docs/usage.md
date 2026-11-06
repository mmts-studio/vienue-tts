# VieNeu TTS Desktop

Ứng dụng Tauri để cài đặt và dùng [VieNeu-TTS](https://github.com/pnnbao97/VieNeu-TTS) (v3 Turbo, 48 kHz) trên máy, kèm REST API và MCP cho agent.

## Kiến trúc

Tauri (`src-tauri/`) chỉ cài Python runtime và giữ tiến trình sidecar sống. Giao diện React (`src/`), REST API và MCP đều đi qua cùng một sidecar FastAPI (`sidecar/`), nên dùng chung giọng đọc, hàng đợi và lịch sử.

Dữ liệu nằm trong thư mục dữ liệu của ứng dụng (macOS: `~/Library/Application Support/local.vieneu-tts.desktop`): môi trường Python, mô hình, `history.sqlite3`, `settings.json`, `api_token`, giọng custom mặc định.

## Phát triển

Cần Node, pnpm và Rust.

```bash
pnpm install
pnpm tauri dev            # chạy ứng dụng
pnpm tauri build          # đóng gói
pnpm test:sidecar         # test API với mô hình giả
```

`sidecar/requirements.lock` cố định toàn bộ thư viện Python. Sau khi sửa `requirements.in`, chạy lại lệnh ghi ở đầu file đó. Ứng dụng sẽ cài lại khi file lock thay đổi.

Lưu ý khi nâng cấp: `huggingface-hub` từ 2.x đổi cách lưu cache làm `onnxruntime` từ chối nạp mô hình, nên phiên bản đang được ghim.

## Kết nối agent

Xem URL, token và lệnh mẫu trong tab **API & MCP**. Server chỉ nghe ở `127.0.0.1:8765` và mọi route trừ `/health` đều cần `Authorization: Bearer <token>`. Đổi cổng bằng biến môi trường `VIENEU_TTS_PORT`.

Chạy không cần giao diện (sau khi ứng dụng đã cài xong):

```bash
"<thư mục dữ liệu>/venv/bin/python" sidecar/server.py --data-dir "<thư mục dữ liệu>"
```

### MCP (Streamable HTTP, `/mcp`)

| Tool | Công dụng |
|---|---|
| `list_voices` | Liệt kê giọng đọc |
| `synthesize_speech` | Tạo file WAV, báo tiến độ, đợi đến khi xong và trả về đường dẫn |
| `add_custom_voice` | Thêm giọng từ clip mẫu trên máy |
| `list_history` | Xem các bản đã tạo |

### REST

| Route | Công dụng |
|---|---|
| `GET /health` | Trạng thái server và mô hình (không cần token) |
| `POST /v1/tts` | Tạo job: `text`, tuỳ chọn `voice`, `output_dir` (tuyệt đối), `filename` |
| `GET /v1/jobs/{id}` | Tiến độ và kết quả của job |
| `GET /v1/history` | Lịch sử |
| `GET /v1/history/{id}/audio` | Tải file âm thanh |
| `GET /v1/voices` | Danh sách giọng đọc |
| `POST /v1/voices` | Thêm giọng: `name`, `source_path`, `description` |
| `GET /v1/voices/{name}/preview` | Nghe thử giọng |
| `GET`, `PUT /v1/settings` | `voices_dir`, `output_dir` |

Tài liệu tương tác của FastAPI có tại `/docs`, cũng cần token.

## Giọng custom

Mỗi file WAV, FLAC, MP3 hoặc OGG trong thư mục giọng mẫu là một giọng, tên file là tên giọng. File cùng tên với giọng có sẵn sẽ bị bỏ qua. Mô tả nằm ở `<tên>.json`. Muốn xoá giọng thì xoá file trong thư mục.

Thanh tiến trình là ước lượng theo độ dài văn bản, vì SDK không báo tổng thời lượng trước khi tạo xong.
