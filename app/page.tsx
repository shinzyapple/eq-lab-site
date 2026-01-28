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

  const [eqGains, setEqGains] = useState<number[]>(new Array(31).fill(0));
  const [reverbDry, setRevDry] = useState(1.0);
  const [reverbWet, setRevWet] = useState(0.2);
  const [volume, setGlobalVolume] = useState(0.5);

  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const [presets, setPresets] = useState<Preset[]>(defaultPresets);
  const [isMatching, setIsMatching] = useState(false);
  const [sourceTrack, setSourceTrack] = useState<Track | null>(null);
  const [targetTrack, setTargetTrack] = useState<Track | null>(null);

  const { data: session, status } = useSession();
  const isLoadingSession = status === "loading";
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);

  const requestRef = useRef<number>(null);

  // Initial Load (Default Audio)
  useEffect(() => {
    const init = async () => {
      try {
        const buffer = await loadAudio("/audio/base.wav");
        const defaultTrack = { id: "default", name: "Base Audio", buffer };
        setLibrary([defaultTrack]);
        setCurrentTrack(defaultTrack);
      } catch (e) {
        console.error("Failed to load default audio", e);
      }
    };
    init();
  }, []);

  // Sync Library Metadata
  useEffect(() => {
    if (isLoadingSession) return;
    const fetchTracks = async () => {
      if (session?.user?.email) {
        setIsLoadingLibrary(true);
        try {
          const { data, error } = await supabase
            .from("tracks")
            .select("*")
            .eq("user_email", session.user.email)
            .order("created_at", { ascending: false });

          if (error) throw error;
          if (data) {
            const tracks: Track[] = data.map(t => ({
              id: t.id,
              name: t.name,
              filePath: t.file_path
            }));
            setLibrary(prev => [prev.find(t => t.id === "default")!, ...tracks]);
          }
        } catch (e) {
          console.error("Library sync failed:", e);
        } finally {
          setIsLoadingLibrary(false);
        }
      }
    };
    fetchTracks();
  }, [session, isLoadingSession]);

  // Sync Presets
  useEffect(() => {
    if (isLoadingSession) return;
    const fetchPresets = async () => {
      if (session?.user?.email) {
        const { data } = await supabase
          .from("presets")
          .select("*")
          .eq("user_email", session.user.email)
          .order("id", { ascending: true });

        if (data) {
          const formatted: Preset[] = data.map((p: any) => ({
            id: p.id,
            name: p.name,
            eqGains: p.eq_gains,
            reverbDry: p.reverb_dry,
            reverbWet: p.reverb_wet,
            volume: p.volume,
          }));
          setPresets([...defaultPresets, ...formatted]);
        }
      }
    };
    fetchPresets();
  }, [session, isLoadingSession]);

  useEffect(() => {
    const updateProgress = () => {
      setIsPlaying(getIsPlaying());
      setProgress(getCurrentTime());
      setDuration(getDuration());
      requestRef.current = requestAnimationFrame(updateProgress);
    };
    requestRef.current = requestAnimationFrame(updateProgress);
    return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, []);

  const loadTrackBuffer = async (track: Track) => {
    if (track.buffer) return track.buffer;
    if (!track.filePath) return null;
    try {
      const { data: { publicUrl } } = supabase.storage.from("eq-lab-tracks").getPublicUrl(track.filePath);
      const buffer = await loadAudio(publicUrl);
      setLibrary(prev => prev.map(t => t.id === track.id ? { ...t, buffer } : t));
      return buffer;
    } catch (e) {
      console.error("Buffer load failed:", e);
      return null;
    }
  };

  const handleTrackSelect = async (track: Track) => {
    setCurrentTrack(track);
    const buffer = await loadTrackBuffer(track);
    if (buffer && isPlaying) {
      playBuffer(buffer, 0, volume, eqGains, reverbDry, reverbWet);
    }
  };

  const togglePlay = async () => {
    if (isPlaying) {
      stop();
    } else if (currentTrack) {
      const buffer = await loadTrackBuffer(currentTrack);
      if (buffer) playBuffer(buffer, progress, volume, eqGains, reverbDry, reverbWet);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, mode: "library" | "source" | "target") => {
    const file = e.target.files?.[0];
    if (!file) return;

    const buffer = await loadAudio(file);
    let trackId = Math.random().toString(36).substr(2, 9);
    let filePath = "";

    if (session?.user?.email && mode === "library") {
      try {
        filePath = `${session.user.email}/${Date.now()}-${file.name}`;
        await supabase.storage.from("eq-lab-tracks").upload(filePath, file);
        const { data } = await supabase.from("tracks").insert([{ user_email: session.user.email, name: file.name, file_path: filePath }]).select();
        if (data) trackId = data[0].id;
      } catch (e) {
        console.error("Cloud save failed:", e);
      }
    }

    const newTrack = { id: trackId, name: file.name, buffer, filePath };
    if (mode === "library") setLibrary(prev => [...prev, newTrack]);
    else if (mode === "source") { setSourceTrack(newTrack); setCurrentTrack(newTrack); }
    else if (mode === "target") setTargetTrack(newTrack);
    e.target.value = "";
  };

  const handleEqChange = (index: number, value: number) => {
    const newGains = [...eqGains];
    newGains[index] = value;
    setEqGains(newGains);
    setEqGain(index, value);
  };

  const applyPreset = (preset: Preset) => {
    setEqGains([...preset.eqGains]);
    setRevDry(preset.reverbDry);
    setRevWet(preset.reverbWet);
    setGlobalVolume(preset.volume);
    preset.eqGains.forEach((g, i) => setEqGain(i, g));
    setReverbDry(preset.reverbDry);
    setReverbWet(preset.reverbWet);
    setVolume(preset.volume);
  };

  const savePreset = async () => {
    if (!session?.user?.email) return alert("Login required");
    const name = prompt("Preset Name", "My Preset");
    if (!name) return;
    const { data } = await supabase.from("presets").insert([{ name, user_email: session.user.email, eq_gains: eqGains, reverb_dry: reverbDry, reverb_wet: reverbWet, volume }]).select();
    if (data) {
      const p = data[0];
      setPresets(prev => [...prev, { id: p.id, name: p.name, eqGains: p.eq_gains, reverbDry: p.reverb_dry, reverbWet: p.reverb_wet, volume: p.volume }]);
    }
  };

  const deletePreset = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Delete preset?")) return;
    await supabase.from("presets").delete().eq("id", id);
    setPresets(prev => prev.filter(p => p.id !== id));
  };

  const handleMatch = async () => {
    const s = sourceTrack || currentTrack;
    if (!s || !targetTrack) return alert("Select both source and target");
    setIsMatching(true);
    const sBuf = await loadTrackBuffer(s);
    const tBuf = await loadTrackBuffer(targetTrack);
    if (sBuf && tBuf) {
      const gains = await getMatchingEq(sBuf, tBuf);
      setEqGains(gains);
      gains.forEach((g, i) => setEqGain(i, g));
    }
    setIsMatching(false);
  };

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;

  return (
    <main className="main-layout">
      <header className="header">
        <h1 className="logo">EQ LAB</h1>
        <div className="auth">
          {isLoadingSession ? <span>...</span> : session ? <button onClick={() => signOut()} className="btn-s">{session.user?.name} (Logout)</button> : <button onClick={() => signIn()} className="btn-s">Login</button>}
        </div>
      </header>

      <nav className="tabs">
        <button className={activeTab === "library" ? "active" : ""} onClick={() => setActiveTab("library")}>Library</button>
        <button className={activeTab === "eq" ? "active" : ""} onClick={() => setActiveTab("eq")}>EQ</button>
        <button className={activeTab === "matching" ? "active" : ""} onClick={() => setActiveTab("matching")}>Match</button>
      </nav>

      <div className="main-content">
        <section className={`panel lib-panel ${activeTab === "library" ? "show" : "hide"}`}>
          <div className="panel-head">
            <h2>LIBRARY</h2>
            <label className="add-btn">+<input type="file" hidden onChange={e => handleFileUpload(e, "library")} /></label>
          </div>
          <div className="list">
            {isLoadingLibrary && <div className="loading">Syncing...</div>}
            {library.map(t => (
              <div key={t.id} className={`item ${currentTrack?.id === t.id ? "active" : ""}`} onClick={() => handleTrackSelect(t)}>
                <span>{t.name} {t.filePath && "☁"}</span>
              </div>
            ))}
          </div>
        </section>

        <section className={`panel eq-panel ${activeTab === "eq" ? "show" : "hide"}`}>
          <div className="panel-head">
            <h2>EQ & EFFECTS</h2>
            <button onClick={savePreset} className="btn-xs">Save</button>
          </div>
          <div className="eq-scroll">
            <div className="eq-grid">
              {EQ_FREQUENCIES.map((freq, i) => (
                <div key={freq} className="eq-col">
                  <span className="eq-v">{eqGains[i].toFixed(1)}</span>
                  <div className="eq-slide-wrap">
                    <input type="range" min="-12" max="12" step="0.1" value={eqGains[i]} onChange={e => handleEqChange(i, parseFloat(e.target.value))} className="v-range" />
                  </div>
                  <span className="eq-f">{freq < 1000 ? freq : `${freq / 1000}k`}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="fx-grid">
            <div className="fx-box">
              <label>Reverb Dry/Wet</label>
              <input type="range" min="0" max="1" step="0.01" value={reverbDry} onChange={e => { setRevDry(parseFloat(e.target.value)); setReverbDry(parseFloat(e.target.value)); }} />
              <input type="range" min="0" max="1" step="0.01" value={reverbWet} onChange={e => { setRevWet(parseFloat(e.target.value)); setReverbWet(parseFloat(e.target.value)); }} />
            </div>
            <div className="fx-box">
              <label>Output Gain</label>
              <input type="range" min="0" max="1.5" step="0.01" value={volume} onChange={e => { setGlobalVolume(parseFloat(e.target.value)); setVolume(parseFloat(e.target.value)); }} />
            </div>
          </div>
          <div className="pre-box">
            <label>PRESETS</label>
            <div className="pre-scroll">
              {presets.map(p => <button key={p.id} onClick={() => applyPreset(p)} className="chip">{p.name} {(p.id !== 'flat' && p.id !== 'concert-hall') && <span onClick={e => deletePreset(p.id, e)}>×</span>}</button>)}
            </div>
          </div>
        </section>

        <section className={`panel m-panel ${activeTab === "matching" ? "show" : "hide"}`}>
          <h2>AI MATCHING</h2>
          <div className="m-field">
            <div className="m-row"><span>Source:</span> <b>{sourceTrack?.name || currentTrack?.name || "-"}</b> <label className="btn-s">File<input type="file" hidden onChange={e => handleFileUpload(e, "source")} /></label></div>
            <div className="m-row"><span>Target:</span> <b>{targetTrack?.name || "-"}</b> <label className="btn-s">File<input type="file" hidden onChange={e => handleFileUpload(e, "target")} /></label></div>
          </div>
          <button onClick={handleMatch} disabled={isMatching} className="btn-primary">{isMatching ? "Processing..." : "Run Match Process"}</button>
        </section>
      </div>

      <footer className="player">
        <button onClick={togglePlay} className="play-btn">{isPlaying ? "Ⅱ" : "▶"}</button>
        <div className="play-info">
          <div className="p-meta"><b>{currentTrack?.name || "Ready"}</b> <span>{formatTime(progress)} / {formatTime(duration)}</span></div>
          <input type="range" min="0" max={duration || 1} step="0.01" value={progress} onChange={e => setOffsetTime(parseFloat(e.target.value))} className="progress" />
        </div>
      </footer>

      <style jsx>{`
        .main-layout { height: 100vh; display: flex; flex-direction: column; background: #000; color: #fff; font-family: sans-serif; overflow: hidden; }
        .header { padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #222; }
        .logo { font-size: 1.1rem; font-weight: 900; letter-spacing: 1px; color: var(--accent); }
        .btn-s { background: #222; border: none; color: #fff; padding: 6px 12px; border-radius: 4px; font-size: 0.8rem; }
        .btn-xs { background: var(--accent); color: #000; border: none; padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; }
        .btn-primary { width: 100%; background: var(--accent); color: #000; border: none; padding: 14px; border-radius: 8px; font-weight: bold; margin-top: 20px; }
        
        .tabs { display: none; }
        .main-content { flex: 1; display: grid; grid-template-columns: 300px 1fr 300px; overflow: hidden; }
        .panel { display: flex; flex-direction: column; border-right: 1px solid #222; overflow: hidden; }
        .panel-head { padding: 20px; display: flex; justify-content: space-between; align-items: center; }
        h2 { font-size: 0.75rem; color: #666; letter-spacing: 1px; }
        
        .list { flex: 1; overflow-y: auto; padding: 0 10px 20px; }
        .item { padding: 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
        .item:hover { background: #111; }
        .item.active { background: #222; color: var(--accent); }
        .add-btn { width: 32px; height: 32px; background: #222; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; }

        .eq-scroll { flex: 1; overflow-x: auto; padding: 40px 20px; scrollbar-width: none; }
        .eq-grid { display: flex; gap: 8px; min-width: max-content; height: 100%; }
        .eq-col { width: 40px; display: flex; flex-direction: column; align-items: center; gap: 15px; }
        .eq-v { font-size: 0.7rem; color: var(--accent); font-family: monospace; }
        .eq-slide-wrap { height: 280px; position: relative; width: 40px; }
        .v-range { -webkit-appearance: none; width: 280px; height: 4px; background: #222; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-90deg); border-radius: 2px; }
        .v-range::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; background: #fff; border-radius: 50%; }
        .eq-f { font-size: 0.65rem; color: #444; transform: rotate(-45deg); }

        .fx-grid { padding: 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 30px; border-top: 1px solid #222; }
        .fx-box { display: flex; flex-direction: column; gap: 10px; }
        .fx-box label { font-size: 0.7rem; color: #666; font-weight: bold; }
        .fx-box input { -webkit-appearance: none; height: 4px; background: #222; border-radius: 2px; }

        .pre-box { padding: 0 20px 20px; }
        .pre-scroll { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 10px; }
        .chip { background: #111; border: 1px solid #222; color: #fff; padding: 6px 12px; border-radius: 20px; font-size: 0.75rem; white-space: nowrap; display: flex; align-items: center; gap: 6px; }

        .m-panel { padding: 20px; }
        .m-field { background: #080808; border-radius: 12px; padding: 20px; display: flex; flex-direction: column; gap: 15px; }
        .m-row { display: flex; align-items: center; gap: 10px; font-size: 0.85rem; }
        .m-row span { color: #666; width: 60px; }
        .m-row b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .player { padding: 15px 20px 30px; border-top: 1px solid #222; display: flex; align-items: center; gap: 20px; background: #050505; }
        .play-btn { width: 50px; height: 50px; border-radius: 50%; background: var(--accent); border: none; font-size: 1.2rem; display: flex; align-items: center; justify-content: center; }
        .play-info { flex: 1; display: flex; flex-direction: column; gap: 8px; }
        .p-meta { display: flex; justify-content: space-between; font-size: 0.85rem; }
        .progress { -webkit-appearance: none; height: 4px; background: #222; border-radius: 2px; }
        .progress::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; background: var(--accent); border-radius: 50%; }

        @media (max-width: 768px) {
          .tabs { display: grid; grid-template-columns: 1fr 1fr 1fr; border-bottom: 1px solid #222; }
          .tabs button { padding: 15px; background: none; border: none; color: #666; font-size: 0.8rem; font-weight: bold; }
          .tabs button.active { color: var(--accent); border-bottom: 2px solid var(--accent); }
          .main-content { grid-template-columns: 1fr; }
          .panel { border-right: none; }
          .hide { display: none; }
          .show { display: flex; }
          .fx-grid { grid-template-columns: 1fr; }
          .player { padding-bottom: 40px; }
        }

        .loading { font-size: 0.8rem; color: var(--accent); padding: 10px; }
      `}</style>
    </main>
  );
}
