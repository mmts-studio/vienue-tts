import { open } from "@tauri-apps/plugin-dialog";
import { FormEvent, useEffect, useState } from "react";
import { Api, Voice, errorText } from "../api";
import { PlayButton } from "./player";

interface Props { api: Api; voices: Voice[]; onChanged: () => Promise<void> }

export default function VoicesTab({ api, voices, onChanged }: Props) {
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [clip, setClip] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then((s) => setFolder(s.voices_dir)).catch((e) => setError(errorText(e)));
  }, [api]);

  const chooseFolder = async () => {
    const picked = await open({ directory: true, defaultPath: folder || undefined, title: "Chọn thư mục giọng đọc mẫu" });
    if (typeof picked !== "string") return;
    try {
      setFolder((await api.updateSettings({ voices_dir: picked })).voices_dir);
      await onChanged();
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const chooseClip = async () => {
    const picked = await open({
      title: "Chọn clip giọng mẫu",
      filters: [{ name: "Âm thanh", extensions: ["wav", "flac", "mp3", "ogg"] }],
    });
    if (typeof picked === "string") setClip(picked);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const voice = await api.addVoice(name, clip, description);
      await onChanged();
      setName("");
      setDescription("");
      setClip("");
      setNotice(`Đã thêm giọng ${voice.name}.`);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  const custom = voices.filter((v) => v.kind === "custom");
  const presets = voices.filter((v) => v.kind === "preset");

  return (
    <div className="voices-layout">
      <div className="stack">
        <section className="panel">
          <div className="field">
            <span className="field-label">Thư mục giọng đọc mẫu</span>
            <div className="path-picker">
              <span className="path" title={folder}>{folder}</span>
              <button onClick={() => void onChanged()}>Quét lại</button>
              <button onClick={chooseFolder}>Đổi thư mục</button>
            </div>
            <span className="hint">Mỗi file âm thanh trong thư mục này là một giọng custom, tên file là tên giọng.</span>
          </div>
        </section>

        <VoiceList title={`Giọng của bạn (${custom.length})`} voices={custom} api={api} empty="Chưa có giọng custom nào." />
        <VoiceList title={`Giọng có sẵn (${presets.length})`} voices={presets} api={api} hint="Lần nghe thử đầu tiên cần vài giây để tạo mẫu." />
      </div>

      <form className="panel add-voice" onSubmit={submit}>
        <h2 className="section-title">Thêm giọng custom</h2>
        <label className="field">
          <span className="field-label">Tên giọng</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Ví dụ: Giọng của Lan" />
        </label>
        <label className="field">
          <span className="field-label">Mô tả</span>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Nữ, miền Trung, trầm ấm" />
        </label>
        <div className="field">
          <span className="field-label">Clip giọng mẫu</span>
          <div className="path-picker">
            <span className="path" title={clip}>{clip || "Chưa chọn file"}</span>
            <button type="button" onClick={chooseClip}>Chọn file</button>
          </div>
          <span className="hint">Một người nói, ít tạp âm, từ 3 giây trở lên. Hệ thống chỉ dùng 8 giây đầu.</span>
        </div>
        <button className="primary" type="submit" disabled={saving || !name.trim() || !clip}>
          {saving ? "Đang thêm" : "Thêm giọng"}
        </button>
        {error && <p className="error-text" role="alert">{error}</p>}
        {notice && <p className="success-text" role="status">{notice}</p>}
      </form>
    </div>
  );
}

function VoiceList({ title, voices, api, empty, hint }: { title: string; voices: Voice[]; api: Api; empty?: string; hint?: string }) {
  return (
    <section>
      <h2 className="section-title">{title}</h2>
      {hint && <p className="hint section-hint">{hint}</p>}
      {voices.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <ul className="voice-list">
          {voices.map((voice) => (
            <li key={voice.name} className="voice">
              <PlayButton path={api.previewPath(voice.name)} label={`thử giọng ${voice.name}`} />
              <div className="voice-body">
                <div className="voice-name">
                  {voice.name}
                  {voice.featured && <span className="badge">Tuyển chọn</span>}
                </div>
                <div className="voice-description">{voice.description || "Chưa có mô tả"}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
