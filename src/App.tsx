import { useCallback, useEffect, useState } from "react";
import { Api, Health, Voice, errorText, isInstalled, startServer } from "./api";
import AgentTab from "./components/AgentTab";
import SetupScreen from "./components/SetupScreen";
import TtsTab from "./components/TtsTab";
import VoicesTab from "./components/VoicesTab";
import { PlayerProvider } from "./components/player";

type Tab = "tts" | "voices" | "agent";
const TABS: { id: Tab; label: string }[] = [
  { id: "tts", label: "TTS" },
  { id: "voices", label: "Giọng đọc" },
  { id: "agent", label: "API & MCP" },
];

export default function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [needsInstall, setNeedsInstall] = useState<boolean | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setStartError(null);
    try {
      setApi(new Api(await startServer()));
    } catch (error) {
      setStartError(errorText(error));
    }
  }, []);

  useEffect(() => {
    isInstalled()
      .then((installed) => {
        setNeedsInstall(!installed);
        if (installed) void start();
      })
      .catch((error) => setStartError(errorText(error)));
  }, [start]);

  if (!api) {
    return (
      <SetupScreen
        needsInstall={needsInstall}
        startError={startError}
        onInstalled={() => {
          setNeedsInstall(false);
          void start();
        }}
        onRetryStart={start}
      />
    );
  }
  return <Main api={api} onReconnect={start} />;
}

function Main({ api, onReconnect }: { api: Api; onReconnect: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("tts");
  const [health, setHealth] = useState<Health | null>(null);
  const [offline, setOffline] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [defaultVoice, setDefaultVoice] = useState("");

  const refreshVoices = useCallback(async () => {
    const data = await api.voices();
    setVoices(data.voices);
    setDefaultVoice(data.default_voice);
  }, [api]);

  useEffect(() => {
    refreshVoices().catch(() => setOffline(true));
    const check = () =>
      api.health().then(
        (next) => {
          setHealth(next);
          setOffline(false);
        },
        () => setOffline(true),
      );
    void check();
    const timer = setInterval(check, 3000);
    return () => clearInterval(timer);
  }, [api, refreshVoices]);

  const engine = health?.engine;
  return (
    <PlayerProvider api={api}>
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true" />
            VieNeu TTS
          </div>
          <nav role="tablist" aria-label="Màn hình" className="tabs">
            {TABS.map(({ id, label }) => (
              <button key={id} role="tab" aria-selected={tab === id} className="tab" onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </nav>
          <div className={`engine engine-${offline ? "error" : engine?.state ?? "idle"}`}>
            <span className="dot" aria-hidden="true" />
            {offline ? "Mất kết nối" : engineLabel(engine?.state)}
          </div>
        </header>

        {offline && (
          <div className="banner banner-error">
            Không kết nối được máy chủ giọng nói.
            <button className="link" onClick={() => void onReconnect()}>Khởi động lại</button>
          </div>
        )}
        {!offline && engine?.state === "loading" && (
          <div className="banner">Đang nạp mô hình. Lần đầu cần tải khoảng 600 MB nên có thể mất vài phút.</div>
        )}
        {!offline && engine?.state === "error" && (
          <div className="banner banner-error">Không nạp được mô hình: {engine.error}</div>
        )}

        {/* Stay mounted when hidden so a running job and form input survive tab switches. */}
        <main className="content">
          <div hidden={tab !== "tts"}><TtsTab api={api} voices={voices} defaultVoice={defaultVoice} /></div>
          <div hidden={tab !== "voices"}><VoicesTab api={api} voices={voices} onChanged={refreshVoices} /></div>
          <div hidden={tab !== "agent"}><AgentTab server={api.server} /></div>
        </main>
      </div>
    </PlayerProvider>
  );
}

function engineLabel(state?: Health["engine"]["state"]) {
  if (state === "ready") return "Sẵn sàng";
  if (state === "error") return "Lỗi mô hình";
  return "Đang nạp mô hình";
}
