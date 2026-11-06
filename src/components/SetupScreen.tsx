import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { errorText, getLogs, install } from "../api";

interface Props {
  needsInstall: boolean | null;
  startError: string | null;
  onInstalled: () => void;
  onRetryStart: () => Promise<void>;
}

export default function SetupScreen({ needsInstall, startError, onInstalled, onRetryStart }: Props) {
  const [installing, setInstalling] = useState(false);
  const [step, setStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stopLog = listen<string>("sidecar-log", (e) => setLogs((all) => [...all.slice(-300), e.payload]));
    const stopStep = listen<string>("setup-step", (e) => setStep(e.payload));
    return () => {
      void stopLog.then((stop) => stop());
      void stopStep.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (startError) void getLogs().then(setLogs);
  }, [startError]);

  useEffect(() => logEnd.current?.scrollIntoView({ block: "nearest" }), [logs]);

  const runInstall = async () => {
    setInstalling(true);
    setError(null);
    try {
      await install();
      onInstalled();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setInstalling(false);
    }
  };

  const shownError = error ?? startError;
  const offerInstall = needsInstall === true && !installing;

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="brand brand-large"><span className="brand-mark" aria-hidden="true" />VieNeu TTS</div>

        {offerInstall && !shownError && (
          <>
            <h1>Cài đặt lần đầu</h1>
            <p>
              Ứng dụng sẽ tải Python, VieNeu-TTS và mô hình giọng nói về máy, tổng cộng khoảng 1,2 GB.
              Sau khi cài xong, mọi xử lý đều chạy trên máy của bạn.
            </p>
          </>
        )}
        {installing && (
          <>
            <h1>Đang cài đặt</h1>
            <p aria-live="polite">{step || "Đang chuẩn bị"}</p>
            <div className="progress progress-indeterminate" role="progressbar" aria-label="Đang cài đặt"><span /></div>
          </>
        )}
        {needsInstall === false && !shownError && (
          <>
            <h1>Đang khởi động</h1>
            <div className="progress progress-indeterminate" role="progressbar" aria-label="Đang khởi động"><span /></div>
          </>
        )}
        {shownError && (
          <>
            <h1>Chưa khởi động được</h1>
            <p className="error-text" role="alert">{shownError}</p>
          </>
        )}

        {offerInstall && (
          <button className="primary" onClick={runInstall}>{error ? "Cài đặt lại" : "Cài đặt"}</button>
        )}
        {needsInstall === false && startError && (
          <button className="primary" onClick={() => void onRetryStart()}>Thử lại</button>
        )}

        {logs.length > 0 && (
          <pre className="log" aria-label="Nhật ký cài đặt">
            {logs.join("\n")}
            <div ref={logEnd} />
          </pre>
        )}
      </div>
    </div>
  );
}
