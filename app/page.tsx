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

  // Load presets from Supabase on mount/session change
  useEffect(() => {
    const fetchPresets = async () => {
      if (session?.user?.email) {
        const { data, error } = await supabase
          .from("presets")
          .select("*")
          .eq("user_email", session.user.email);

        if (error) {
          console.error("Error fetching presets:", error);
        } else if (data) {
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
        setPresets(defaultPresets);
      }
    };
    fetchPresets();
  }, [session]);

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
      const newTrack: Track = {
        id: Math.random().toString(36).substr(2, 9),
        name: file.name,
        buffer
      };

      if (mode === "library") {
        setLibrary(prev => [...prev, newTrack]);
      } else if (mode === "source") {
        setSourceTrack(newTrack);
        setCurrentTrack(newTrack); // Auto-select for playback
        setProgress(0);
      } else if (mode === "target") {
        setTargetTrack(newTrack);
      }

      // Reset input value to allow re-uploading the same file if needed
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

      const { data, error } = await supabase
        .from("presets")
        .insert([newPresetData])
        .select();

      if (error) {
        console.error("Error saving preset:", error);
        alert("保存に失敗しました。");
      } else if (data) {
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
        alert("保存しました！");
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
        .main-layout {
          min-height: 100vh;
          background: radial-gradient(circle at 50% 50%, #1a1a2e 0%, #0a0a0c 100%);
          color: white;
          display: flex;
          flex-direction: column;
          padding: 20px;
          gap: 20px;
          max-width: 1600px;
          margin: 0 auto;
        }

        .main-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 0;
        }

        .logo-text { font-size: 2rem; margin: 0; color: var(--accent); letter-spacing: 0.1em; }
        .sub-logo { margin: 0; opacity: 0.5; font-size: 0.8rem; }

        .content-grid {
          display: grid;
          grid-template-columns: 300px 1fr 300px;
          gap: 20px;
          flex: 1;
        }

        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .section-title {
          font-size: 0.9rem;
          font-weight: 600;
          letter-spacing: 0.1em;
          opacity: 0.8;
          border-left: 3px solid var(--accent);
          padding-left: 10px;
          margin: 0;
        }

        .section-desc { font-size: 0.7rem; opacity: 0.6; margin-bottom: 15px; }

        .glass-panel {
          background: rgba(255, 255, 255, 0.03);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 16px;
          padding: 20px;
        }

        /* Library & Matching Slots */
        .track-list, .preset-list {
          flex: 1;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-bottom: 15px;
          max-height: 300px;
        }

        .library-item, .preset-item {
          padding: 12px;
          border-radius: 8px;
          cursor: pointer;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 0.85rem;
          background: rgba(255, 255, 255, 0.02);
          transition: all 0.2s;
        }

        .library-item:hover, .preset-item:hover { background: rgba(255, 255, 255, 0.07); }
        .library-item.active { background: rgba(0, 229, 255, 0.1); color: var(--accent); }

        .preset-item { justify-content: space-between; }
        .preset-info { display: flex; align-items: center; gap: 10px; }
        .delete-btn {
          background: none;
          border: none;
          color: rgba(255, 255, 255, 0.2);
          font-size: 1.2rem;
          cursor: pointer;
          line-height: 1;
          padding: 0 4px;
          transition: color 0.2s;
        }
        .delete-btn:hover { color: #ff4d4d; }

        .matching-controls { display: flex; flex-direction: column; gap: 15px; margin-bottom: 20px; }
        .slot-label { font-size: 0.75rem; opacity: 0.5; display: block; margin-bottom: 4px; }
        .slot-name { font-size: 0.8rem; margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

        /* Buttons */
        .upload-label {
          display: block;
          padding: 12px;
          background: var(--accent);
          color: black;
          text-align: center;
          border-radius: 8px;
          font-weight: 700;
          font-size: 0.8rem;
          cursor: pointer;
        }

        .upload-label.secondary { background: rgba(255, 255, 255, 0.05); color: white; border: 1px solid rgba(255, 255, 255, 0.1); padding: 8px; font-size: 0.75rem; }

        .match-button {
          width: 100%;
          padding: 14px;
          background: linear-gradient(135deg, #00e5ff, #00a2ff);
          border: none;
          border-radius: 8px;
          color: black;
          font-weight: 700;
          cursor: pointer;
        }

        .reset-button, .icon-button {
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          color: white;
          padding: 6px 12px;
          border-radius: 6px;
          font-size: 0.75rem;
          cursor: pointer;
        }

        .add-button {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: 1px solid var(--accent);
          background: transparent;
          color: var(--accent);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        /* EQ Container */
        .eq-scroll-container {
          overflow-x: auto;
          padding: 20px 0 40px 0;
          mask-image: linear-gradient(to right, transparent, black 5%, black 95%, transparent);
        }

        .eq-container {
          display: flex;
          gap: 4px;
          min-width: max-content;
        }

        .eq-column {
          width: 36px;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 12px;
        }

        .eq-value { font-size: 0.7rem; color: var(--accent); height: 14px; font-family: monospace; }
        .slider-wrapper { height: 280px; position: relative; width: 36px; }

        .vertical-slider {
          -webkit-appearance: none;
          width: 240px;
          height: 6px;
          background: rgba(255, 255, 255, 0.08);
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%) rotate(-90deg);
          border-radius: 3px;
        }

        .eq-freq { font-size: 0.65rem; opacity: 0.4; transform: rotate(-45deg); margin-top: 10px; }

        /* Controls Output */
        .additional-controls { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .control-group { background: rgba(255, 255, 255, 0.02); padding: 16px; border-radius: 12px; }
        .group-title { font-size: 0.75rem; margin-top: 0; margin-bottom: 12px; opacity: 0.6; }
        .slider-row { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; font-size: 0.8rem; }
        .slider-row input { flex: 1; height: 4px; }
        .val-text { width: 35px; text-align: right; opacity: 0.5; font-size: 0.75rem; }

        /* Footer Player */
        .footer-player {
          display: flex;
          align-items: center;
          gap: 20px;
          padding: 15px 30px;
        }

        .play-button {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          border: none;
          background: var(--accent);
          color: black;
          font-size: 1.4rem;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 20px rgba(0, 229, 255, 0.3);
          flex-shrink: 0;
        }

        .progress-container { flex: 1; display: flex; flex-direction: column; gap: 6px; }
        .progress-info { display: flex; justify-content: space-between; font-size: 0.85rem; }
        .playing-name { color: var(--accent); font-weight: 500; }
        .time-display { opacity: 0.5; font-family: monospace; }
        .progress-bar { width: 100%; height: 6px; cursor: pointer; }

        .auth-button { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: white; padding: 6px 16px; border-radius: 20px; font-size: 0.8rem; cursor: pointer; }
        .user-name { font-size: 0.8rem; opacity: 0.7; margin-right: 10px; }

        /* Mobile Adjustments */
        @media (max-width: 1100px) {
          .content-grid {
            grid-template-columns: 1fr;
          }
          .right-sidebar { order: 3; }
          .left-sidebar { order: 2; }
          .main-area { order: 1; }
        }

        @media (max-width: 600px) {
          .main-layout { padding: 10px; }
          .header-titles h1 { font-size: 1.5rem; }
          .additional-controls { grid-template-columns: 1fr; }
          .footer-player { padding: 10px 15px; }
          .play-button { width: 44px; height: 44px; font-size: 1rem; }
          .playing-name { font-size: 0.75rem; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .time-display { font-size: 0.7rem; }
          .eq-scroll-container { padding-bottom: 30px; }
        }
      `}</style>
    </main>
  );
}



