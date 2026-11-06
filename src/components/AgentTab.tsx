import { useState } from "react";
import { ServerInfo } from "../api";

const TOKEN_MASK = "•".repeat(24);
const TOOLS: [string, string][] = [
  ["list_voices", "Liệt kê giọng đọc"],
  ["synthesize_speech", "Tạo file WAV, báo tiến độ và đợi đến khi xong"],
  ["add_custom_voice", "Thêm giọng từ clip mẫu"],
  ["list_history", "Xem các bản đã tạo"],
];

export default function AgentTab({ server }: { server: ServerInfo }) {
  const { url, token } = server;
  const [showToken, setShowToken] = useState(false);
  // Snippets stay masked on screen; their copy buttons still give the full command.
  const mask = (text: string) => (showToken ? text : text.replaceAll(token, TOKEN_MASK));
  const claude = `claude mcp add --transport http vieneu-tts ${url}/mcp --header "Authorization: Bearer ${token}"`;
  const mcpJson = JSON.stringify(
    { mcpServers: { "vieneu-tts": { type: "http", url: `${url}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
  const curl = `curl -X POST ${url}/v1/tts \\
  -H "Authorization: Bearer ${token}" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "Xin chào", "voice": "Hải Đăng"}'

# Trả về job id, sau đó theo dõi tiến độ:
curl ${url}/v1/jobs/<job_id> -H "Authorization: Bearer ${token}"`;

  return (
    <div className="stack agent">
      <section className="panel">
        <p className="lead">
          Agent gọi được ứng dụng này khi ứng dụng đang mở. API chỉ nhận kết nối từ chính máy này
          và dùng chung giọng đọc, hàng đợi và lịch sử với giao diện.
        </p>
        <dl className="facts">
          <dt>Địa chỉ API</dt>
          <dd><code>{url}</code><Copy value={url} /></dd>
          <dt>Địa chỉ MCP</dt>
          <dd><code>{url}/mcp</code><Copy value={`${url}/mcp`} /></dd>
          <dt>API token</dt>
          <dd>
            <code>{showToken ? token : TOKEN_MASK}</code>
            <button onClick={() => setShowToken(!showToken)}>{showToken ? "Ẩn" : "Hiện"}</button>
            <Copy value={token} />
          </dd>
        </dl>
        <p className="hint">Token cho phép ghi file vào máy bạn, nên chỉ đưa cho agent bạn tin tưởng.</p>
      </section>

      <Snippet title="Claude Code" code={claude} shown={mask(claude)} />
      <Snippet title="Cấu hình MCP (Cursor, Claude Desktop và các client hỗ trợ HTTP)" code={mcpJson} shown={mask(mcpJson)} />

      <section>
        <h2 className="section-title">Công cụ MCP</h2>
        <ul className="tool-list">
          {TOOLS.map(([name, description]) => (
            <li key={name}><code>{name}</code><span>{description}</span></li>
          ))}
        </ul>
      </section>

      <Snippet title="REST API" code={curl} shown={mask(curl)} />
    </div>
  );
}

function Snippet({ title, code, shown }: { title: string; code: string; shown: string }) {
  return (
    <section>
      <div className="snippet-head">
        <h2 className="section-title">{title}</h2>
        <Copy value={code} />
      </div>
      <pre className="code">{shown}</pre>
    </section>
  );
}

function Copy({ value }: { value: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("done");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1500);
  };
  return <button onClick={copy}>{state === "done" ? "Đã chép" : state === "failed" ? "Không chép được" : "Sao chép"}</button>;
}
