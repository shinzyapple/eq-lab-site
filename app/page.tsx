"use client";

import { useState, useEffect, useRef } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import {
  playBuffer,
  stop,
  setEqGain,
  setReverbWet,
  setReverbDry,
  setVolume,
  EQ_FREQUENCIES,
  loadAudio,
  getCurrentTime,
  getDuration,
  getIsPlaying,
  getMatchingEq,
  setOffsetTime
} from "@/lib/audioEngine";
import { defaultPresets, Preset } from "@/lib/presets";
import { supabase } from "@/lib/supabaseClient";

type Track = {
  id: string;
  name: string;
  buffer?: AudioBuffer;
  filePath?: string;
};

export default function Home() {
  const [library, setLibrary] = useState<Track[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [activeTab, setActiveTab] = useState<"library" | "eq" | "matching">("eq");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const [eqGains, setEqGains] = useState<number[]>(new Array(31).fill(0));
  const [reverbDry, setRevDry] = useState(1.0);
  const [reverbWet, setRevWet] = useState(0.2);
  const [volume, setGlobalVolume] = useState(0.5);

  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const [presets, setPresets] = useState<Preset[]>(defaultPresets);
  const [isMatching, setIsMatching] = useState(false);
  const [sourceTrack, setSourceTrack] = useState<Track | null>(null);
  const [targetTrack, setTargetTrack] = useState<Track | null>(null);

  const { data: session, status } = useSession();
  const isLoadingSession = status === "loading";
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);

  const requestRef = useRef<number>(null);

  // Sync Library Metadata - Refined to prevent flickering and disappearing tracks
  useEffect(() => {
    if (isLoadingSession) return;

    let isMounted = true;
    const fetchTracks = async () => {
      console.log("Syncing library metadata...");

      // Load default base audio
      let initLib: Track[] = [];
      try {
        const buffer = await loadAudio("/audio/base.wav");
        initLib.push({ id: "default", name: "Base Audio", buffer });
      } catch (e) {
        console.warn("Base audio load skipped");
      }

      if (session?.user?.email) {
        setIsLoadingLibrary(true);
        const { data, error } = await supabase
          .from("tracks")
          .select("*")
          .eq("user_email", session.user.email)
          .order("created_at", { ascending: false });

        if (isMounted) {
          if (data && !error) {
            const cloudTracks = data.map(t => ({ id: t.id, name: t.name, filePath: t.file_path }));
            setLibrary([...initLib, ...cloudTracks]);
          } else {
            setLibrary(initLib);
          }
          setIsLoadingLibrary(false);
        }
      } else {
        if (isMounted) setLibrary(initLib);
      }
    };

    fetchTracks();
    return () => { isMounted = false; };
  }, [session?.user?.email, isLoadingSession]);

  // Sync Presets
  useEffect(() => {
    if (isLoadingSession || !session?.user?.email) return;
    const fetchPresets = async () => {
      const { data } = await supabase.from("presets").select("*").eq("user_email", session.user.email).order("id", { ascending: true });
      if (data) {
        const formatted = data.map((p: any) => ({ id: p.id, name: p.name, eqGains: p.eq_gains, reverbDry: p.reverb_dry, reverbWet: p.reverb_wet, volume: p.volume }));
        setPresets([...defaultPresets, ...formatted]);
      }
    };
    fetchPresets();
  }, [session?.user?.email, isLoadingSession]);

  // Progress Loop
  useEffect(() => {
    const loop = () => {
      const playing = getIsPlaying();
      setIsPlaying(playing);
      if (playing && !isDragging) {
        setProgress(getCurrentTime());
        setDuration(getDuration());
      }
      requestRef.current = requestAnimationFrame(loop);
    };
    requestRef.current = requestAnimationFrame(loop);
    return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, [isDragging]);

  // Media Session handlers
  useEffect(() => {
    if ("mediaSession" in navigator && currentTrack) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentTrack.name, artist: "EQ LAB", album: "Advanced Processor",
        artwork: [{ src: "/favicon.ico", sizes: "192x192", type: "image/png" }],
      });
      navigator.mediaSession.setActionHandler("play", () => togglePlay());
      navigator.mediaSession.setActionHandler("pause", () => togglePlay());
      navigator.mediaSession.setActionHandler("seekto", (details) => { if (details.seekTime !== undefined) handleManualSeek(details.seekTime); });
    }
  }, [currentTrack]);

  const loadTrackBuffer = async (track: Track) => {
    if (track.buffer) return track.buffer;
    if (!track.filePath) return null;
    try {
      const { data: { publicUrl } } = supabase.storage.from("eq-lab-tracks").getPublicUrl(track.filePath);
      const buffer = await loadAudio(publicUrl);
      setLibrary(prev => prev.map(t => t.id === track.id ? { ...t, buffer } : t));
      return buffer;
    } catch (e) { return null; }
  };

  const handleTrackSelect = async (track: Track) => {
    setCurrentTrack(track);
    setProgress(0);
    const buffer = await loadTrackBuffer(track);
    if (buffer && isPlaying) playBuffer(buffer, 0, volume, eqGains, reverbDry, reverbWet);
  };

  const togglePlay = async () => {
    if (isPlaying) stop();
    else if (currentTrack) {
      const buffer = await loadTrackBuffer(currentTrack);
      if (buffer) playBuffer(buffer, progress, volume, eqGains, reverbDry, reverbWet);
    }
  };

  const handleManualSeek = async (time: number) => {
    setProgress(time);
    setOffsetTime(time);
    if (isPlaying && currentTrack) {
      const buffer = await loadTrackBuffer(currentTrack);
      if (buffer) playBuffer(buffer, time, volume, eqGains, reverbDry, reverbWet);
    }
  };

  const deleteTrack = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const track = library.find(t => t.id === id);
    if (!track || id === "default") return;
    if (!confirm(`Delete "${track.name}"?`)) return;
    try {
      if (track.filePath) await supabase.storage.from("eq-lab-tracks").remove([track.filePath]);
      await supabase.from("tracks").delete().eq("id", id);
      setLibrary(prev => prev.filter(t => t.id !== id));
      if (currentTrack?.id === id) setCurrentTrack(null);
    } catch (e) { alert("Delete failed"); }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, mode: "library" | "source" | "target") => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await loadAudio(file);
      let trackId = Math.random().toString(36).substr(2, 9);
      let filePath = "";
      if (session?.user?.email && mode === "library") {
        filePath = `${session.user.email}/${Date.now()}-${file.name}`;
        await supabase.storage.from("eq-lab-tracks").upload(filePath, file);
        const { data } = await supabase.from("tracks").insert([{ user_email: session.user.email, name: file.name, file_path: filePath }]).select();
        if (data) trackId = data[0].id;
      }
      const newTrack = { id: trackId, name: file.name, buffer, filePath };
      if (mode === "library") setLibrary(prev => [newTrack, ...prev]);
      else if (mode === "source") { setSourceTrack(newTrack); setCurrentTrack(newTrack); }
      else if (mode === "target") setTargetTrack(newTrack);
    } catch (e) { alert("Import failed"); }
    e.target.value = "";
  };

  const handleEqChange = (index: number, value: number) => {
    const next = [...eqGains]; next[index] = value;
    setEqGains(next); setEqGain(index, value);
  };

  const applyPreset = (p: Preset) => {
    setEqGains([...p.eqGains]); setRevDry(p.reverbDry); setRevWet(p.reverbWet); setGlobalVolume(p.volume);
    p.eqGains.forEach((g, i) => setEqGain(i, g));
    setReverbDry(p.reverbDry); setReverbWet(p.reverbWet); setVolume(p.volume);
  };

  const savePreset = async () => {
    if (!session?.user?.email) return alert("Login required");
    const name = prompt("Preset Name", "My Preset");
    if (!name) return;
    const { data } = await supabase.from("presets").insert([{ name, user_email: session.user.email, eq_gains: eqGains, reverb_dry: reverbDry, reverb_wet: reverbWet, volume }]).select();
    if (data) setPresets(v => [...v, { id: data[0].id, name, eqGains: [...eqGains], reverbDry, reverbWet, volume }]);
  };

  return (
    <main className={`main-layout ${theme === "light" ? "light-theme" : ""}`}>
      <header className="header">
        <div className="header-left">
          <h1 className="logo">EQ LAB</h1>
          <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} className="theme-btn">{theme === "dark" ? "☀️" : "🌙"}</button>
        </div>
        <div className="auth">
          {isLoadingSession ? <span>...</span> : session ? <button onClick={() => signOut()} className="btn-s">{session.user?.name} (Logout)</button> : <button onClick={() => signIn()} className="btn-s">Login</button>}
        </div>
      </header>

      <nav className="tabs">
        {["library", "eq", "matching"].map(t => <button key={t} className={activeTab === t ? "active" : ""} onClick={() => setActiveTab(t as any)}>{t.toUpperCase()}</button>)}
      </nav>

      <div className="main-content">
        <section className={`panel lib-panel ${activeTab === "library" ? "show" : "hide"}`}>
          <div className="panel-head"><h2>LIBRARY</h2><label className="add-btn">+<input type="file" hidden onChange={e => handleFileUpload(e, "library")} /></label></div>
          <div className="list">
            {isLoadingLibrary && <div className="loading">Syncing...</div>}
            {library.map(t => (
              <div key={t.id} className={`item ${currentTrack?.id === t.id ? "active" : ""}`} onClick={() => handleTrackSelect(t)}>
                <div className="item-meta"><span className="t-n">{t.name}</span>{t.filePath && <span className="c-i">☁</span>}</div>
                {t.id !== "default" && <button onClick={e => deleteTrack(t.id, e)} className="del-btn">×</button>}
              </div>
            ))}
          </div>
        </section>

        <section className={`panel eq-panel ${activeTab === "eq" ? "show" : "hide"}`}>
          <div className="panel-head"><h2>EQ & EFFECTS</h2><button onClick={savePreset} className="btn-xs">Save</button></div>
          <div className="eq-scroll">
            <div className="eq-grid">
              {EQ_FREQUENCIES.map((freq, i) => (
                <div key={freq} className="eq-col">
                  <span className="eq-v">{eqGains[i]?.toFixed(1)}</span>
                  <div className="eq-wrap"><input type="range" min="-12" max="12" step="0.1" value={eqGains[i] || 0} onChange={e => handleEqChange(i, parseFloat(e.target.value))} className="v-range" /></div>
                  <span className="eq-f">{freq < 1000 ? freq : `${freq / 1000}k`}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="fx-grid">
            <div className="fx-box"><label>Reverb Dry/Wet</label><div className="f-r">
              <input type="range" min="0" max="1" step="0.01" value={reverbDry} onChange={e => { const v = parseFloat(e.target.value); setRevDry(v); setReverbDry(v); }} />
              <input type="range" min="0" max="1" step="0.01" value={reverbWet} onChange={e => { const v = parseFloat(e.target.value); setRevWet(v); setReverbWet(v); }} />
            </div></div>
            <div className="fx-box"><label>Output Gain</label><input type="range" min="0" max="1.5" step="0.01" value={volume} onChange={e => { const v = parseFloat(e.target.value); setGlobalVolume(v); setVolume(v); }} className="wide" /></div>
          </div>
          <div className="pre-box"><label>PRESETS</label><div className="p-s">{presets.map(p => <button key={p.id} onClick={() => applyPreset(p)} className="chip">{p.name} {(p.id !== 'flat' && p.id !== 'concert-hall') && <span onClick={e => { e.stopPropagation(); deletePreset(p.id, e); }} className="p-del">×</span>}</button>)}</div></div>
        </section>

        <section className={`panel m-panel ${activeTab === "matching" ? "show" : "hide"}`}>
          <h2>AI MATCHING</h2>
          <div className="m-field">
            <div className="m-row"><span>Src:</span> <b>{sourceTrack?.name || currentTrack?.name || "-"}</b> <label className="btn-s">File<input type="file" hidden onChange={e => handleFileUpload(e, "source")} /></label></div>
            <div className="m-row"><span>Tgt:</span> <b>{targetTrack?.name || "-"}</b> <label className="btn-s">File<input type="file" hidden onChange={e => handleFileUpload(e, "target")} /></label></div>
          </div>
          <button onClick={handleMatch} disabled={isMatching || !targetTrack} className="btn-primary">{isMatching ? "Processing..." : "Run Match Process"}</button>
        </section>
      </div>

      <footer className="player">
        <button onClick={togglePlay} className="p-btn">{isPlaying ? "Ⅱ" : "▶"}</button>
        <div className="p-info">
          <div className="p-meta"><b>{currentTrack?.name || "Ready"}</b> <span>{formatTime(progress)} / {formatTime(duration)}</span></div>
          <input
            type="range" min="0" max={duration || 1} step="0.01" value={progress}
            onInput={(e) => { setIsDragging(true); setProgress(parseFloat((e.target as any).value)); }}
            onChange={(e) => { setIsDragging(false); handleManualSeek(parseFloat((e.target as any).value)); }}
            className="p-bar"
          />
        </div>
      </footer>

      <style jsx>{`
        .main-layout { --accent: #00e5ff; --bg: #000; --p-bg: #0c0c0e; --text: #fff; --text-m: #888; --border: #222; --hover: #161618; --player: rgba(10,10,12,0.7); height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: sans-serif; overflow: hidden; transition: 0.3s; }
        .main-layout.light-theme { --bg: #f5f5f7; --p-bg: #fff; --text: #1d1d1f; --text-m: #86868b; --border: #e2e2e7; --hover: #f5f5f7; --player: rgba(255,255,255,0.75); }
        .header { padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); background: var(--p-bg); }
        .header-left { display: flex; align-items: center; gap: 15px; }
        .logo { font-size: 1.1rem; font-weight: 900; color: var(--accent); }
        .theme-btn { background: none; border: none; font-size: 1.2rem; cursor: pointer; }
        .btn-s { background: var(--border); border: none; color: var(--text); padding: 6px 12px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; }
        .btn-xs { background: var(--accent); color: #000; border: none; padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; cursor: pointer; }
        .btn-primary { width: 100%; background: var(--accent); color: #000; border: none; padding: 14px; border-radius: 8px; font-weight: bold; margin-top: 15px; cursor: pointer; }
        .tabs { display: none; }
        .main-content { flex: 1; display: grid; grid-template-columns: 320px 1fr 300px; overflow: hidden; }
        .panel { display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--p-bg); overflow: hidden; }
        .panel-head { padding: 20px; display: flex; justify-content: space-between; align-items: center; }
        h2 { font-size: 0.7rem; color: var(--text-m); letter-spacing: 1px; }
        .list { flex: 1; overflow-y: auto; padding: 0 10px 120px; }
        .item { padding: 10px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; }
        .item:hover { background: var(--hover); }
        .item.active { background: var(--hover); color: var(--accent); }
        .item-meta { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
        .t-n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .del-btn { background: none; border: none; color: var(--text-m); font-size: 1.1rem; cursor: pointer; opacity: 0; }
        .item:hover .del-btn { opacity: 1; }
        .add-btn { width: 30px; height: 30px; background: var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text); }
        .eq-scroll { flex: 1; overflow-x: auto; padding: 40px 20px 120px; scrollbar-width: none; }
        .eq-grid { display: flex; gap: 8px; min-width: max-content; }
        .eq-col { width: 40px; display: flex; flex-direction: column; align-items: center; gap: 15px; }
        .eq-v { font-size: 0.7rem; color: var(--accent); font-family: monospace; }
        .eq-wrap { height: 260px; position: relative; width: 40px; }
        .v-range { -webkit-appearance: none; width: 260px; height: 4px; background: var(--border); position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-90deg); border-radius: 2px; }
        .v-range::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; background: #fff; border-radius: 50%; border: 2px solid var(--accent); cursor: pointer; }
        .eq-f { font-size: 0.6rem; color: var(--text-m); transform: rotate(-45deg); }
        .fx-grid { padding: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; border-top: 1px solid var(--border); }
        .fx-box { display: flex; flex-direction: column; gap: 8px; }
        .fx-box label { font-size: 0.65rem; color: var(--text-m); font-weight: bold; }
        .f-r { display: flex; flex-direction: column; gap: 5px; }
        input[type="range"] { -webkit-appearance: none; height: 3px; background: var(--border); border-radius: 2px; }
        .pre-box { padding: 0 20px 120px; }
        .p-s { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 10px; }
        .chip { background: var(--hover); border: 1px solid var(--border); color: var(--text); padding: 5px 12px; border-radius: 20px; font-size: 0.75rem; white-space: nowrap; display: flex; align-items: center; gap: 5px; cursor: pointer; }
        .p-del { opacity: 0.3; }
        .m-panel { padding: 20px; }
        .m-field { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
        .m-row { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; }
        .m-row b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .player { position: fixed; bottom: 20px; left: 20px; right: 20px; z-index: 1000; padding: 15px 25px; background: var(--player); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid var(--border); border-radius: 20px; display: flex; align-items: center; gap: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .p-btn { width: 45px; height: 45px; border-radius: 50%; background: var(--accent); border: none; font-size: 1rem; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #000; }
        .p-info { flex: 1; display: flex; flex-direction: column; gap: 5px; }
        .p-meta { display: flex; justify-content: space-between; font-size: 0.8rem; }
        .p-bar { -webkit-appearance: none; height: 3px; background: var(--border); }
        .p-bar::-webkit-slider-thumb { -webkit-appearance: none; width: 12px; height: 12px; background: var(--accent); border-radius: 50%; cursor: pointer; }
        @media (max-width: 768px) {
          .tabs { display: grid; grid-template-columns: 1fr 1fr 1fr; border-bottom: 1px solid var(--border); }
          .tabs button { padding: 12px; background: none; border: none; color: var(--text-m); font-size: 0.8rem; font-weight: bold; cursor: pointer; }
          .tabs button.active { color: var(--accent); border-bottom: 2px solid var(--accent); }
          .main-content { grid-template-columns: 1fr; }
          .panel { border-right: none; }
          .hide { display: none; } .show { display: flex; }
          .fx-grid { grid-template-columns: 1fr; }
          .player { bottom: 0; left: 0; right: 0; border-radius: 20px 20px 0 0; padding-bottom: 35px; }
        }
        .loading { font-size: 0.8rem; color: var(--accent); text-align: center; padding: 10px; }
      `}</style>
    </main>
  );
}
