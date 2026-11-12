import { invoke } from "@tauri-apps/api/core";

export interface ServerInfo { url: string }
export interface Voice {
  name: string;
  kind: "preset" | "custom";
  description: string;
  featured: boolean;
  path?: string;
}
export interface HistoryItem {
  id: string;
  text: string;
  voice: string;
  path: string;
  conversion_seconds: number;
  audio_seconds: number;
  created_at: string;
}
export interface Job {
  id: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;
  message: string;
  error: string | null;
  result: HistoryItem | null;
}
export interface Settings { voices_dir: string; output_dir: string }
export interface Health { vieneu_version: string; engine: { state: "idle" | "loading" | "ready" | "error"; error: string | null } }

export const isInstalled = () => invoke<boolean>("is_installed");
export const install = () => invoke<void>("install");
export const startServer = () => invoke<ServerInfo>("start_server");
export const getLogs = () => invoke<string[]>("get_logs");

/** Thin client over the sidecar; the same API that agents call. */
export class Api {
  constructor(readonly server: ServerInfo) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(this.server.url + path, {
      ...init,
      headers: init.body ? { "Content-Type": "application/json" } : {},
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      const detail = body?.detail;
      throw new Error(typeof detail === "string" ? detail : `Lỗi máy chủ (${response.status})`);
    }
    return response;
  }

  private async json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const init = body === undefined ? { method } : { method, body: JSON.stringify(body) };
    return (await this.request(path, init)).json();
  }

  health = () => this.json<Health>("/health");
  settings = () => this.json<Settings>("/v1/settings");
  updateSettings = (patch: Partial<Settings>) => this.json<Settings>("/v1/settings", "PUT", patch);
  voices = () => this.json<{ default_voice: string; voices: Voice[] }>("/v1/voices");
  addVoice = (name: string, source_path: string, description: string) =>
    this.json<Voice>("/v1/voices", "POST", { name, source_path, description });
  createTts = (text: string, voice: string, output_dir: string) =>
    this.json<Job>("/v1/tts", "POST", { text, voice, output_dir });
  job = (id: string) => this.json<Job>(`/v1/jobs/${id}`);
  history = () => this.json<HistoryItem[]>("/v1/history");

  async audioBlob(path: string): Promise<Blob> {
    return (await this.request(path)).blob();
  }
  historyAudioPath = (id: string) => `/v1/history/${id}/audio`;
  previewPath = (name: string) => `/v1/voices/${encodeURIComponent(name)}/preview`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
