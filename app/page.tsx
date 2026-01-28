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
  buffer: AudioBuffer;
};

export default function Home() {
  const [library, setLibrary] = useState<Track[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);

  // Matching specific tracks
  const [sourceTrack, setSourceTrack] = useState<Track | null>(null);
  const [targetTrack, setTargetTrack] = useState<Track | null>(null);

  const [eqGains, setEqGains] = useState<number[]>(new Array(31).fill(0));
  const [reverbDry, setRevDry] = useState(1.0);
  const [reverbWet, setRevWet] = useState(0.2);
  const [volume, setGlobalVolume] = useState(0.5);

  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  const [presets, setPresets] = useState<Preset[]>(defaultPresets);
  const [isMatching, setIsMatching] = useState(false);

  const { data: session, status } = useSession();
  const isLoadingSession = status === "loading";

  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);

  const requestRef = useRef<number>(null);

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

  // Load tracks from Supabase
  useEffect(() => {
    if (isLoadingSession) return;

    const fetchTracks = async () => {
      if (session?.user?.email) {
        setIsLoadingLibrary(true);
        console.log("Fetching tracks for:", session.user.email);

        const { data: trackData, error: dbError } = await supabase
          .from("tracks")
          .select("*")
          .eq("user_email", session.user.email)
          .order("created_at", { ascending: false });

        if (dbError) {
          console.error("Error fetching tracks from DB:", dbError);
        } else if (trackData) {
          const loadedTracks: Track[] = [];
          for (const t of trackData) {
            try {
              // StorageからURL取得 (または直接Public URL生成)
              const { data: { publicUrl } } = supabase.storage
                .from("eq-lab-tracks")
                .getPublicUrl(t.file_path);

              const buffer = await loadAudio(publicUrl);
              loadedTracks.push({
                id: t.id,
                name: t.name,
                buffer
              });
            } catch (e) {
              console.error(`Failed to load track ${t.name}:`, e);
            }
          }
          // Default track is already there, append
          setLibrary(prev => {
            const defaults = prev.filter(t => t.id === "default");
            return [...defaults, ...loadedTracks];
          });
        }
        setIsLoadingLibrary(false);
      }
    };
    fetchTracks();
  }, [session, isLoadingSession]);

  // Load presets from Supabase on mount/session change
  useEffect(() => {
    if (isLoadingSession) return;

    const fetchPresets = async () => {
      if (session?.user?.email) {
        console.log("Fetching presets for:", session.user.email);
        const { data, error } = await supabase
          .from("presets")
          .select("*")
          .eq("user_email", session.user.email)
          .order("id", { ascending: true });

        if (error) {
          console.error("Error fetching presets:", error);
        } else if (data) {
          console.log(`${data.length} presets loaded from Supabase`);
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
      } else {
        console.log("No session email, using default presets only");
        setPresets(defaultPresets);
      }
    };
    fetchPresets();
  }, [session, isLoadingSession]);

  useEffect(() => {
    const updateProgress = () => {
      const playing = getIsPlaying();
      setIsPlaying(playing);
      if (playing) {
        setProgress(getCurrentTime());
        setDuration(getDuration());
      }
      requestRef.current = requestAnimationFrame(updateProgress);
    };
    requestRef.current = requestAnimationFrame(updateProgress);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, mode: "library" | "source" | "target") => {
    const file = e.target.files?.[0];
    if (file) {
      const buffer = await loadAudio(file);
      let trackId = Math.random().toString(36).substr(2, 9);

      // If user is logged in and mode is library, upload to Supabase
      if (session?.user?.email && mode === "library") {
        try {
          const filePath = `${session.user.email}/${Date.now()}-${file.name}`;

          // 1. Storageにアップロード
          const { error: uploadError } = await supabase.storage
            .from("eq-lab-tracks")
            .upload(filePath, file);

          if (uploadError) throw uploadError;

          // 2. DBにメタデータ保存
          const { data: dbData, error: dbError } = await supabase
            .from("tracks")
            .insert([{
              user_email: session.user.email,
              name: file.name,
              file_path: filePath
            }])
            .select();

          if (dbError) throw dbError;
          if (dbData) trackId = dbData[0].id;

          alert("ライブラリに永続化保存したよ！");
        } catch (err: any) {
          console.error("Upload failed:", err);
          alert("クラウドへの保存に失敗したけど、一時的には使えるよ: " + err.message);
        }
      }

      const newTrack: Track = {
        id: trackId,
        name: file.name,
        buffer
      };

      if (mode === "library") {
        setLibrary(prev => [...prev, newTrack]);
      } else if (mode === "source") {
        setSourceTrack(newTrack);
        setCurrentTrack(newTrack);
        setProgress(0);
      } else if (mode === "target") {
        setTargetTrack(newTrack);
      }

      e.target.value = "";
    }
  };

  const togglePlay = () => {
    if (isPlaying) {
      stop();
      setIsPlaying(false);
    } else if (currentTrack) {
      playBuffer(currentTrack.buffer, progress, volume, eqGains, reverbDry, reverbWet);
      setIsPlaying(true);
    }
  };

  const handleSeek = (time: number) => {
    setProgress(time);
    setOffsetTime(time);
    if (isPlaying && currentTrack) {
      playBuffer(currentTrack.buffer, time, volume, eqGains, reverbDry, reverbWet);
    }
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
    if (!session?.user?.email) {
      alert("プリセットを永続化するにはログインが必要です。");
      return;
    }
    const name = prompt("プリセット名を入力してください", "マイプリセット");
    if (name) {
      const newPresetData = {
        name,
        user_email: session.user.email,
        eq_gains: [...eqGains],
        reverb_dry: reverbDry,
        reverb_wet: reverbWet,
        volume: volume
      };

      console.log("Saving preset:", newPresetData);
      const { data, error } = await supabase
        .from("presets")
        .insert([newPresetData])
        .select();

      if (error) {
        console.error("Error saving preset:", error);
        alert(`保存に失敗しました: ${error.message}`);
      } else if (data && data.length > 0) {
        const p = data[0];
        const newPreset: Preset = {
          id: p.id,
          name: p.name,
          eqGains: p.eq_gains,
          reverbDry: p.reverb_dry,
          reverbWet: p.reverb_wet,
          volume: p.volume
        };
        setPresets(prev => [...prev, newPreset]);
        alert("プリセットを保存したよ！");
      }
    }
  };

  const deletePreset = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation(); // Click on item shouldn't trigger apply
    if (!confirm("このプリセットを削除しますか？")) return;

    const { error } = await supabase
      .from("presets")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("Error deleting preset:", error);
      alert("削除に失敗しました。");
    } else {
      setPresets(prev => prev.filter(p => p.id !== id));
    }
  };

  const handleMatch = async () => {
    const matchSource = sourceTrack || currentTrack;
    if (!matchSource || !targetTrack) {
      alert("音源と録音（比較用）の両方を選択してください");
      return;
    }
    setIsMatching(true);
    try {
      const newGains = await getMatchingEq(matchSource.buffer, targetTrack.buffer);
      setEqGains(newGains);
      newGains.forEach((g, i) => setEqGain(i, g));
    } catch (e) {
      console.error(e);
    } finally {
      setIsMatching(false);
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <main className="main-layout">
      <header className="main-header">
        <div className="header-titles">
          <h1 className="logo-text">EQ LAB</h1>
          <p className="sub-logo">Professional Audio Spectrum Processor</p>
        </div>
        <div className="auth-zone">
          {isLoadingSession ? (
            <span className="user-name">Loading...</span>
          ) : session ? (
            <>
              <span className="user-name">{session.user?.name}</span>
              <button onClick={() => signOut()} className="auth-button">Logout</button>
            </>
          ) : (
            <button onClick={() => signIn()} className="auth-button">Login</button>
          )}
        </div>
      </header>

      <div className="content-grid">
        {/* Left Sidebar: Library & Matching */}
        <aside className="left-sidebar">
          <section className="glass-panel library-section">
            <h2 className="section-title">ライブラリ</h2>
            <div className="track-list">
              {library.map((track) => (
                <div
                  key={track.id}
                  onClick={() => {
                    setCurrentTrack(track);
                    setProgress(0);
                    if (isPlaying) playBuffer(track.buffer, 0, volume, eqGains, reverbDry, reverbWet);
                  }}
                  className={`library-item ${currentTrack?.id === track.id ? "active" : ""}`}
                >
                  <span className="track-name">{track.name}</span>
                  <span className="track-dur">{formatTime(track.buffer.duration)}</span>
                </div>
              ))}
            </div>
            <label className="upload-label">
              AUDIOを選択
              <input type="file" accept="audio/*" onChange={(e) => handleFileUpload(e, "library")} style={{ display: "none" }} />
            </label>
          </section>

          <section className="glass-panel matching-section">
            <h2 className="section-title">EQ MATCHING</h2>
            <p className="section-desc">
              「解析元」の音源を「ターゲット」の質感に近づけます。
            </p>

            <div className="matching-controls">
              <div className="match-slot">
                <span className="slot-label">Source (解析元):</span>
                <div className="slot-name">{sourceTrack?.name || currentTrack?.name || "未選択"}</div>
                <label className="upload-label secondary">
                  解析元を選択
                  <input type="file" accept="audio/*" onChange={(e) => handleFileUpload(e, "source")} style={{ display: "none" }} />
                </label>
              </div>

              <div className="match-slot">
                <span className="slot-label">Target (お手本):</span>
                <div className="slot-name">{targetTrack?.name || "未選択"}</div>
                <label className="upload-label secondary">
                  ターゲットを選択
                  <input type="file" accept="audio/*" onChange={(e) => handleFileUpload(e, "target")} style={{ display: "none" }} />
                </label>
              </div>
            </div>

            <button
              onClick={handleMatch}
              disabled={isMatching || !targetTrack || (!sourceTrack && !currentTrack)}
              className="match-button"
            >
              {isMatching ? "解析中..." : "マッチング実行"}
            </button>
          </section>
        </aside>

        {/* Main Area: EQ */}
        <div className="main-area">
          <section className="glass-panel eq-section">
            <div className="section-header">
              <h2 className="section-title">31バンド イコライザー</h2>
              <div className="header-actions">
                <button onClick={savePreset} className="icon-button" title="EQ設定を保存">保存</button>
                <button onClick={() => {
                  const reset = new Array(31).fill(0);
                  setEqGains(reset);
                  reset.forEach((g, i) => setEqGain(i, g));
                }} className="reset-button">リセット</button>
              </div>
            </div>

            <div className="eq-scroll-container">
              <div className="eq-container">
                {EQ_FREQUENCIES.map((freq, i) => (
                  <div key={freq} className="eq-column">
                    <div className="eq-value">{(eqGains[i] || 0).toFixed(1)}</div>
                    <div className="slider-wrapper">
                      <input
                        type="range"
                        min="-12"
                        max="12"
                        step="0.1"
                        value={eqGains[i]}
                        onChange={(e) => handleEqChange(i, parseFloat(e.target.value))}
                        className="vertical-slider"
                      />
                    </div>
                    <span className="eq-freq">
                      {freq < 1000 ? freq : `${freq / 1000}k`}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="additional-controls">
              <div className="control-group">
                <h3 className="group-title">REVERB</h3>
                <div className="slider-row">
                  <label>原音</label>
                  <input type="range" min="0" max="1" step="0.01" value={reverbDry} onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setRevDry(v);
                    setReverbDry(v);
                  }} />
                  <span className="val-text">{Math.round(reverbDry * 100)}%</span>
                </div>
                <div className="slider-row">
                  <label>残響</label>
                  <input type="range" min="0" max="1" step="0.01" value={reverbWet} onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setRevWet(v);
                    setReverbWet(v);
                  }} />
                  <span className="val-text">{Math.round(reverbWet * 100)}%</span>
                </div>
              </div>
              <div className="control-group">
                <h3 className="group-title">OUTPUT</h3>
                <div className="slider-row">
                  <label>ゲイン</label>
                  <input type="range" min="0" max="1.5" step="0.01" value={volume} onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setGlobalVolume(v);
                    setVolume(v);
                  }} />
                  <span className="val-text">{Math.round(volume * 100)}%</span>
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Right Sidebar: Presets */}
        <aside className="right-sidebar">
          <section className="glass-panel presets-section">
            <div className="section-header">
              <h2 className="section-title">プリセット</h2>
              <button onClick={savePreset} className="add-button" title="今の設定をプリセット保存">+</button>
            </div>
            <div className="preset-list">
              {presets.map((preset) => (
                <div key={preset.id} className="preset-item" onClick={() => applyPreset(preset)}>
                  <div className="preset-info">
                    <span className="preset-name">{preset.name}</span>
                    <span className="preset-icon">⚡</span>
                  </div>
                  {/* Default presets shouldn't be deletable */}
                  {preset.id !== "flat" && preset.id !== "concert-hall" && (
                    <button className="delete-btn" onClick={(e) => deletePreset(preset.id, e)}>×</button>
                  )}
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {/* Footer: Transport */}
      <footer className="footer-player glass-panel">
        <button onClick={togglePlay} className="play-button">
          {isPlaying ? "Ⅱ" : "▶"}
        </button>

        <div className="progress-container">
          <div className="progress-info">
            <span className="playing-name">{currentTrack?.name || "READY"}</span>
            <span className="time-display">{formatTime(progress)} / {formatTime(duration)}</span>
          </div>
          <input
            type="range"
            min="0"
            max={duration || 100}
            step="0.01"
            value={progress}
            onChange={(e) => handleSeek(parseFloat(e.target.value))}
            className="progress-bar"
          />
        </div>
      </footer>

      <style jsx>{`
        :global(:root) {
          --accent: #00e5ff;
          --accent-glow: rgba(0, 229, 255, 0.3);
          --bg-dark: #0a0a0c;
          --panel-bg: rgba(255, 255, 255, 0.04);
          --border: rgba(255, 255, 255, 0.08);
          --text-main: #ffffff;
          --text-dim: rgba(255, 255, 255, 0.5);
        }

        .main-layout {
          min-height: 100vh;
          background: radial-gradient(circle at 50% 0%, #1a1a2e 0%, var(--bg-dark) 100%);
          color: var(--text-main);
          display: flex;
          flex-direction: column;
          padding: 20px;
          gap: 20px;
          max-width: 1400px;
          margin: 0 auto;
          font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
        }

        .main-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 0;
          border-bottom: 1px solid var(--border);
          margin-bottom: 10px;
        }

        .logo-text { 
          font-size: 1.8rem; 
          margin: 0; 
          background: linear-gradient(to right, #00e5ff, #00a2ff);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          font-weight: 800;
          letter-spacing: -0.02em;
        }
        .sub-logo { margin: 0; opacity: 0.5; font-size: 0.75rem; letter-spacing: 0.1em; }

        .content-grid {
          display: grid;
          grid-template-columns: 320px 1fr 300px;
          gap: 24px;
          flex: 1;
        }

        .glass-panel {
          background: var(--panel-bg);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid var(--border);
          border-radius: 20px;
          padding: 24px;
          display: flex;
          flex-direction: column;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }

        .section-title {
          font-size: 0.85rem;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.15em;
          color: var(--accent);
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .section-title::after { content: ''; height: 1px; flex: 1; background: var(--border); }

        /* Track & Preset Lists */
        .track-list, .preset-list {
          flex: 1;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 20px;
          min-height: 150px;
        }

        .library-item, .preset-item {
          padding: 14px 18px;
          border-radius: 12px;
          cursor: pointer;
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid transparent;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
          font-size: 0.9rem;
        }

        .library-item:hover, .preset-item:hover {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.1);
          transform: translateY(-1px);
        }

        .library-item.active {
          background: rgba(0, 229, 255, 0.1);
          border-color: var(--accent);
          color: var(--accent);
        }

        /* Buttons and Controls */
        .upload-label, .match-button {
          padding: 16px;
          border-radius: 14px;
          font-weight: 700;
          font-size: 0.85rem;
          cursor: pointer;
          transition: all 0.2s;
          text-align: center;
          border: none;
        }

        .upload-label { background: white; color: black; }
        .upload-label:active { transform: scale(0.98); }

        .match-button {
          background: linear-gradient(135deg, #00e5ff, #00a2ff);
          color: black;
          box-shadow: 0 4px 15px var(--accent-glow);
        }
        .match-button:disabled { opacity: 0.3; cursor: not-allowed; box-shadow: none; }

        /* EQ Styles */
        .eq-scroll-container {
          overflow-x: auto;
          padding: 10px 0 30px 0;
          scrollbar-width: none; /* Hide scrollbar Firefox */
        }
        .eq-scroll-container::-webkit-scrollbar { display: none; } /* Hide scrollbar Chrome/Safari */

        .eq-container { display: flex; gap: 8px; padding: 0 10px; }
        .eq-column { width: 40px; display: flex; flex-direction: column; align-items: center; gap: 15px; }

        .eq-value { font-size: 0.7rem; color: var(--accent); font-family: 'JetBrains Mono', monospace; }
        .slider-wrapper { height: 260px; position: relative; width: 40px; }

        /* Custom Range Input */
        input[type="range"].vertical-slider {
          -webkit-appearance: none;
          width: 260px;
          height: 8px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 4px;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%) rotate(-90deg);
        }

        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 20px;
          height: 20px;
          background: white;
          border-radius: 50%;
          box-shadow: 0 0 10px rgba(0,0,0,0.5);
          cursor: pointer;
          border: 2px solid var(--accent);
        }

        .eq-freq { font-size: 0.65rem; color: var(--text-dim); transform: rotate(-45deg); margin-top: 10px; }

        /* Footer Player */
        .footer-player {
          margin-top: auto;
          display: flex;
          align-items: center;
          gap: 24px;
          padding: 20px 30px;
          position: sticky;
          bottom: 20px;
          z-index: 100;
        }

        .play-button {
          width: 64px;
          height: 64px;
          border-radius: 50%;
          border: none;
          background: var(--accent);
          color: black;
          font-size: 1.6rem;
          cursor: pointer;
          box-shadow: 0 0 30px var(--accent-glow);
          transition: all 0.2s;
        }
        .play-button:hover { transform: scale(1.05); }

        .progress-container { flex: 1; }
        .progress-info { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 0.9rem; }
        .playing-name { font-weight: 600; color: var(--accent); }

        /* Mobile Responsive */
        @media (max-width: 1200px) {
          .content-grid { grid-template-columns: 1fr 1fr; }
          .main-area { grid-column: span 2; order: -1; }
        }

        @media (max-width: 768px) {
          .main-layout { padding: 12px; gap: 12px; }
          .content-grid { grid-template-columns: 1fr; gap: 12px; }
          .main-area { grid-column: span 1; }
          
          .logo-text { font-size: 1.4rem; }
          
          .glass-panel { padding: 16px; border-radius: 20px; }
          
          .footer-player {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            border-radius: 24px 24px 0 0;
            padding: 16px 20px 32px 20px;
            margin: 0;
          }

          .play-button { width: 56px; height: 56px; }
          
          .eq-scroll-container { 
            margin: 0 -16px; 
            padding-left: 16px;
            padding-right: 16px;
          }

          /* Increase slider touch area for mobile */
          input[type="range"]::-webkit-slider-thumb {
            width: 28px;
            height: 28px;
          }

          .additional-controls { 
            grid-template-columns: 1fr !important; 
            gap: 12px; 
          }
          
          .auth-zone { margin-left: auto; }
          .user-name { font-size: 0.75rem; }
        }

        /* Specific fixes for iPhone "Safe Areas" */
        @supports (padding: env(safe-area-inset-bottom)) {
          .footer-player {
            padding-bottom: calc(16px + env(safe-area-inset-bottom));
          }
        }
      `}</style>
    </main>
  );
}



