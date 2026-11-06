import { ReactNode, createContext, useContext, useEffect, useRef, useState } from "react";
import { Api, errorText } from "../api";

type State = { key: string; status: "loading" | "playing" } | null;

const PlayerContext = createContext<{ state: State; toggle: (path: string) => void } | null>(null);

/** One shared audio element, so starting a clip stops the previous one. */
export function PlayerProvider({ api, children }: { api: Api; children: ReactNode }) {
  const audio = useRef(new Audio());
  const url = useRef<string | null>(null);
  const request = useRef(0);
  const [state, setState] = useState<State>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = audio.current;
    const stop = () => setState(null);
    element.addEventListener("ended", stop);
    return () => element.removeEventListener("ended", stop);
  }, []);

  const toggle = async (path: string) => {
    const current = ++request.current;
    audio.current.pause();
    setError(null);
    if (state?.key === path) {
      setState(null);
      return;
    }
    setState({ key: path, status: "loading" });
    try {
      const blob = await api.audioBlob(path);
      if (current !== request.current) return;
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = URL.createObjectURL(blob);
      audio.current.src = url.current;
      await audio.current.play();
      setState({ key: path, status: "playing" });
    } catch (failure) {
      if (current !== request.current) return;
      setState(null);
      setError(errorText(failure));
    }
  };

  return (
    <PlayerContext.Provider value={{ state, toggle }}>
      {children}
      {error && <div className="toast" role="alert">{error}</div>}
    </PlayerContext.Provider>
  );
}

export function PlayButton({ path, label }: { path: string; label: string }) {
  const player = useContext(PlayerContext)!;
  const status = player.state?.key === path ? player.state.status : "idle";
  const text = status === "playing" ? `Dừng ${label}` : `Nghe ${label}`;
  return (
    <button className={`play play-${status}`} aria-label={text} title={text} onClick={() => player.toggle(path)}>
      <span className="play-icon" aria-hidden="true" />
    </button>
  );
}
