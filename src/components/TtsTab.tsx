import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Api, HistoryItem, Job, Voice, errorText } from "../api";
import { PlayButton } from "./player";

const JOB_POLL_MS = 400;
// History also changes when an agent generates audio through the API.
const HISTORY_POLL_MS = 5000;

interface Props { api: Api; voices: Voice[]; defaultVoice: string }

export default function TtsTab({ api, voices, defaultVoice }: Props) {
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  const selected = voice && voices.some((v) => v.name === voice) ? voice : defaultVoice;
  const busy = job?.status === "queued" || job?.status === "running";

  const refreshHistory = useCallback(() => api.history().then(setHistory).catch(() => {}), [api]);

  useEffect(() => {
    api.settings().then((s) => setOutputDir(s.output_dir)).catch((e) => setError(errorText(e)));
    void refreshHistory();
    const timer = setInterval(refreshHistory, HISTORY_POLL_MS);
    return () => clearInterval(timer);
  }, [api, refreshHistory]);

  useEffect(() => {
    if (!job || !busy) return;
    const timer = setInterval(async () => {
      try {
        const next = await api.job(job.id);
        setJob(next);
        if (next.status === "done") void refreshHistory();
        if (next.status === "error") setError(next.error);
      } catch (failure) {
        setError(errorText(failure));
        setJob(null);
      }
    }, JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [api, job, busy, refreshHistory]);

  const chooseFolder = async () => {
    const folder = await open({ directory: true, defaultPath: outputDir || undefined, title: "Chọn thư mục lưu file" });
    if (typeof folder !== "string") return;
    setOutputDir(folder);
    api.updateSettings({ output_dir: folder }).catch((e) => setError(errorText(e)));
  };

  const generate = async () => {
    setError(null);
    try {
      setJob(await api.createTts(text, selected, outputDir));
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const percent = Math.round((job?.progress ?? 0) * 100);
  const groups = useMemo(() => groupVoices(voices), [voices]);

  return (
    <div className="stack">
      <section className="panel compose">
        <label className="field">
          <span className="field-label">Văn bản</span>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={7}
            placeholder="Nhập nội dung cần đọc. Có thể chèn [cười] hoặc [thở dài] để thêm cảm xúc."
          />
          <span className="hint">{text.trim().length.toLocaleString("vi-VN")} ký tự</span>
        </label>

        <div className="compose-options">
          <label className="field">
            <span className="field-label">Giọng đọc</span>
            <select value={selected} onChange={(e) => setVoice(e.target.value)}>
              {groups.map(([label, items]) => (
                <optgroup key={label} label={label}>
                  {items.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          <div className="field">
            <span className="field-label">Thư mục lưu file</span>
            <div className="path-picker">
              <span className="path" title={outputDir}>{outputDir || "Chưa chọn"}</span>
              <button onClick={chooseFolder}>Chọn thư mục</button>
            </div>
          </div>
        </div>

        <div className="compose-action">
          <button className="primary" disabled={busy || !text.trim() || !selected} onClick={generate}>
            {busy ? "Đang tạo" : "Tạo giọng nói"}
          </button>
          {job && !error && (
            <div className="job" aria-live="polite">
              <div className="job-line">
                <span>{job.message}</span>
                <span className="num">{percent}%</span>
              </div>
              <div className="progress" role="progressbar" aria-label="Tiến độ tạo giọng nói" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <span style={{ width: `${percent}%` }} />
              </div>
            </div>
          )}
          {error && <p className="error-text" role="alert">{error}</p>}
        </div>
      </section>

      <section>
        <h2 className="section-title">Lịch sử</h2>
        {history.length === 0 ? (
          <p className="empty">Chưa có bản nào. File bạn tạo sẽ xuất hiện ở đây.</p>
        ) : (
          <div className="table-wrap">
            <table className="history">
              <thead>
                <tr>
                  <th scope="col" className="col-play"><span className="sr-only">Nghe lại</span></th>
                  <th scope="col">Văn bản</th>
                  <th scope="col" className="right">Thời gian chuyển đổi</th>
                  <th scope="col" className="right">Thời lượng</th>
                  <th scope="col" className="right">Tạo lúc</th>
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={item.id}>
                    <td><PlayButton path={api.historyAudioPath(item.id)} label="bản này" /></td>
                    <td>
                      <div className="history-text" title={item.text}>{item.text}</div>
                      <div className="history-meta" title={item.path}>{item.voice} · {item.path}</div>
                    </td>
                    <td className="right num">{seconds(item.conversion_seconds)}</td>
                    <td className="right num">{seconds(item.audio_seconds)}</td>
                    <td className="right num nowrap">{dateTime(item.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function groupVoices(voices: Voice[]): [string, Voice[]][] {
  const groups: [string, Voice[]][] = [
    ["Giọng tuyển chọn", voices.filter((v) => v.featured)],
    ["Giọng có sẵn", voices.filter((v) => v.kind === "preset" && !v.featured)],
    ["Giọng của bạn", voices.filter((v) => v.kind === "custom")],
  ];
  return groups.filter(([, items]) => items.length > 0);
}

function seconds(value: number) {
  if (value < 60) return `${value.toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} giây`;
  const total = Math.round(value);
  return `${Math.floor(total / 60)} phút ${total % 60} giây`;
}

function dateTime(iso: string) {
  return new Date(iso).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
}
