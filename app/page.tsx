"use client";

import { useState, useEffect, useRef } from "react";
import {
  playBuffer,
  stop,
  setEqGain,
  setReverbWet,
  setReverbDry,
  setVolume,
  EQ_FREQUENCIES,
  loadAudio,
  loadBufferForAnalysis,
  getCurrentTime,
  getDuration,
  getIsPlaying,
  getSpectrum,
  calculateMatchedGains,
  resumeContext,
  initContext,
  createSampleBuffer,
  setAudioEngineCallbacks,
  updateMediaMetadata,
  updateMediaPositionState,
  seekTo,
  getVisualizerData,
  playStream
} from "@/lib/audioEngine";
import { defaultPresets, Preset } from "@/lib/presets";
import { db } from "@/lib/db";

type Track = {
  id: string;
  name: string;
  buffer?: AudioBuffer;
};

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
};

export default function Home() {
  const [library, setLibrary] = useState<Track[]>([]);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [activeTab, setActiveTab] = useState<"library" | "eq" | "matching">("library");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const [eqGains, setEqGains] = useState<number[]>(new Array(10).fill(0));
  const [reverbDry, setRevDry] = useState(1.0);
  const [reverbWet, setRevWet] = useState(0.2);
  const [volume, setGlobalVolume] = useState(0.5);

  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDragging, setIsDragging] = useState(false);

  const [presets, setPresets] = useState<Preset[]>(defaultPresets);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [isMatching, setIsMatching] = useState(false);
  const [sourceTrack, setSourceTrack] = useState<Track | null>(null);
  const [targetTrack, setTargetTrack] = useState<Track | null>(null);

  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const requestRef = useRef<number | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Helper to load buffer if missing
  // Pre-load logic: returns either a buffer or a signed URL for streaming
  const prepareTrackSource = async (track: Track): Promise<{ buffer?: AudioBuffer, url?: string } | null> => {
    if (track.buffer) return { buffer: track.buffer };

    try {
      const trackId = Number(track.id);
      const localTrack = await db.tracks.get(trackId);
      if (localTrack) {
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        // If file is > 4MB on mobile, we stream it to save memory
        const shouldStream = isMobile && localTrack.data.size > 4 * 1024 * 1024;

        if (shouldStream) {
          const url = URL.createObjectURL(localTrack.data);
          return { url };
        } else {
          const buffer = await loadAudio(localTrack.data);
          return { buffer };
        }
      }
    } catch (e: any) {
      console.error("Failed to prepare track source:", e);
      alert(`楽曲の準備に失敗しました: ${e.message || '不明なエラー'}`);
    }
    return null;
  };

  // Load all local storage settings once on mount
  useEffect(() => {
    const savedSettings = localStorage.getItem("eq-lab-settings");
    if (savedSettings) {
      try {
        const s = JSON.parse(savedSettings);
        if (s.eqGains) {
          setEqGains(s.eqGains);
        }
        if (s.reverbDry !== undefined) setRevDry(s.reverbDry);
        if (s.reverbWet !== undefined) setRevWet(s.reverbWet);
        if (s.volume !== undefined) setGlobalVolume(s.volume);
        if (s.activePresetId) setActivePresetId(s.activePresetId);
        if (s.currentTrackId) (window as any).__lastTrackId = s.currentTrackId;
      } catch (e) {
        console.error("Failed to parse saved settings", e);
      }
    }
  }, []);

  // Update engine whenever basic FX state changes
  useEffect(() => {
    eqGains.forEach((g, i) => setEqGain(i, g));
    setReverbDry(reverbDry);
    setReverbWet(reverbWet);
    setVolume(volume);
  }, [eqGains, reverbDry, reverbWet, volume]);

  // Separate Effect for Local DB Sync
  useEffect(() => {
    let isMounted = true;

    const syncLibrary = async () => {
      console.log("Starting local library sync...");
      setIsLoadingLibrary(true);

      try {
        // 1. Load Tracks from IndexedDB
        const localTracks = await db.tracks.toArray();
        const formattedLocalTracks: Track[] = localTracks.map(t => ({
          id: t.id!.toString(),
          name: t.name,
        }));

        if (!isMounted) return;

        setLibrary(formattedLocalTracks);

        // Restore last selected track
        const lastId = (window as any).__lastTrackId;
        if (lastId) {
          const matched = formattedLocalTracks.find((t: Track) => t.id === lastId);
          if (matched) {
            setCurrentTrack(matched);
            // Pre-load restored track
            prepareTrackSource(matched).then(source => {
              if (source?.buffer) {
                setDuration(source.buffer.duration);
                setCurrentTrack({ ...matched, buffer: source.buffer });
              } else if (source?.url) {
                // For streams, duration will be set when metadata loads in audioEngine
                setCurrentTrack(matched);
              }
            });
          }
          delete (window as any).__lastTrackId;
        }

        // 2. Load Presets from IndexedDB
        const localPresets = await db.presets.toArray();
        const formattedPresets: Preset[] = [
          ...defaultPresets,
          ...localPresets.map(p => ({
            id: p.id!.toString(),
            name: p.name,
            eqGains: p.eqGains,
            reverbDry: p.reverbDry,
            reverbWet: p.reverbWet,
            volume: p.volume
          }))
        ];
        setPresets(formattedPresets);

        console.log(`Sync complete: ${formattedLocalTracks.length} tracks, ${localPresets.length} presets`);
      } catch (err) {
        console.error("Local DB fetch error:", err);
      } finally {
        setIsLoadingLibrary(false);
      }
    };

    syncLibrary();
    return () => { isMounted = false; };
  }, []);

  // Handle currentTrack initialization and synchronization
  useEffect(() => {
    if (library.length > 0 && !currentTrack) {
      setCurrentTrack(library[0]);
    } else if (currentTrack) {
      // Sync currentTrack's buffer/metadata if library contains it (e.g. after download)
      const matched = library.find(t => t.id === currentTrack.id);
      if (matched && matched.buffer && !currentTrack.buffer) {
        setCurrentTrack(matched);
      }
    }
  }, [library]);

  // Handle background/foreground
  useEffect(() => {
    const handleVisibilityChange = () => {
      // Don't suspend if audio is playing, but resume if returning
      if (document.visibilityState === "visible") {
        resumeContext();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // Register Media Session Callbacks
  useEffect(() => {
    setAudioEngineCallbacks({
      onPlaybackChange: (playing) => {
        if (playing) {
          if (!isPlaying && currentTrack) togglePlay();
        } else {
          if (isPlaying) togglePlay();
        }
      },
      onSeekTo: (time) => {
        handleManualSeek(time);
      }
    });
  }, [isPlaying, currentTrack, progress, volume, eqGains, reverbDry, reverbWet]);

  // Update Media Metadata when track changes
  useEffect(() => {
    if (currentTrack) {
      updateMediaMetadata(currentTrack.name);
    }
  }, [currentTrack]);

  // Sync Presets from Local DB
  useEffect(() => {
    setUpdatedAt(new Date().toLocaleString("ja-JP"));
    const fetchPresets = async () => {
      try {
        const localPresets = await db.presets.toArray();
        const formatted = localPresets.map(p => ({
          id: p.id!.toString(),
          name: p.name,
          eqGains: p.eqGains,
          reverbDry: p.reverbDry,
          reverbWet: p.reverbWet,
          volume: p.volume
        }));

        setPresets([...defaultPresets, ...formatted]);
      } catch (err) {
        console.error("Local preset fetch error:", err);
      }
    };
    fetchPresets();
  }, []);

  // Persistence Effect for Settings
  useEffect(() => {
    const settings = {
      eqGains,
      reverbDry,
      reverbWet,
      volume,
      activePresetId,
      currentTrackId: currentTrack?.id
    };
    localStorage.setItem("eq-lab-settings", JSON.stringify(settings));
  }, [eqGains, reverbDry, reverbWet, volume, activePresetId, currentTrack?.id]);

  // Progress Loop
  const updateProgress = () => {
    const isAppPlaying = getIsPlaying();
    setIsPlaying(isAppPlaying);

    // Always update duration if we have a track
    if (isAppPlaying && !isDragging) {
      const currentTime = getCurrentTime();
      setProgress(currentTime);
      setDuration(getDuration());
      if ('mediaSession' in navigator) {
        updateMediaPositionState();
      }
    } else if (!isAppPlaying && currentTrack?.buffer) {
      // If paused but we have the buffer, ensure duration is synced
      setDuration(currentTrack.buffer.duration);
    }
    requestRef.current = requestAnimationFrame(updateProgress);
  };

  useEffect(() => {
    requestRef.current = requestAnimationFrame(updateProgress);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isDragging]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement> | { target: { files: File[], value: string } }, mode: "library" | "source" | "target") => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      let buffer: AudioBuffer | undefined;
      let trackId = Math.random().toString(36).substr(2, 9);

      // On mobile, decode on upload often causes OOM/Crash.
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      if (mode !== "library" || !isMobile) {
        buffer = await loadAudio(file);
      }

      if (mode === "library") {
        console.log(`Saving to IndexedDB: ${file.name}`);
        const id = await db.tracks.add({
          name: file.name,
          data: file,
          createdAt: Date.now()
        });
        trackId = id.toString();
      }

      const newTrack: Track = {
        id: trackId,
        name: file.name,
        buffer: buffer // Optional, will be re-loaded if undefined
      };

      if (mode === "library") {
        setLibrary(prev => [newTrack, ...prev]);
        setCurrentTrack(curr => curr || newTrack);
      }
      else if (mode === "source") {
        setSourceTrack(newTrack);
        setCurrentTrack(newTrack);
        setProgress(0);
      }
      else if (mode === "target") {
        setTargetTrack(newTrack);
      }

    } catch (err: any) {
      console.error("Upload process failed:", err);
      alert(`アップロードに失敗しました: ${err.message || '不明なエラー'}`);
    } finally {
      setIsUploading(false);
      try { e.target.value = ""; } catch (e) { }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(true);
  };

  const handleDragLeave = () => {
    setIsDraggingFile(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDraggingFile(false);
    const file = e.dataTransfer.files?.[0];
    if (file && (file.type.startsWith("audio/") || file.name.match(/\.(mp3|wav|m4a|aac|ogg|caf|flac|aiff)$/i))) {
      // Mock an event structure for handleFileUpload compatibility or just call a shared logic
      const mockEvent = { target: { files: [file], value: "" } } as any;
      handleFileUpload(mockEvent, "library");
    }
  };

  const togglePlay = async () => {
    await initContext();

    if (isPlaying) {
      stop();
      setIsPlaying(false);
    } else {
      if (!currentTrack) {
        alert("再生する曲をライブラリから選択してください。");
        return;
      }

      setIsBuffering(true);
      try {
        const source = await prepareTrackSource(currentTrack);
        if (source?.buffer) {
          await initContext();
          playBuffer(source.buffer, progress, volume, eqGains, reverbDry, reverbWet);
          setIsPlaying(true);
        } else if (source?.url) {
          await initContext();
          playStream(source.url, progress, volume, eqGains, reverbDry, reverbWet);
          setIsPlaying(true);
        }
      } catch (e: any) {
        console.error("Playback error:", e);
        alert(`再生エラー: ${e.message}`);
      } finally {
        setIsBuffering(false);
      }
    }
  };

  const handleManualSeek = async (time: number) => {
    setProgress(time);
    seekTo(time, volume, eqGains, reverbDry, reverbWet);
  };

  const deleteTrack = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const track = library.find(t => t.id === id);
    if (!track) return;
    if (!confirm(`楽曲 "${track.name}" を削除しますか？`)) return;

    try {
      console.log("Removing track from local database...");
      await db.tracks.delete(Number(id));

      setLibrary(prev => prev.filter(t => t.id !== id));
      if (currentTrack?.id === id) setCurrentTrack(null);
      console.log("Track deleted successfully");
    } catch (e: any) {
      console.error("Delete failed:", e);
      alert(`削除に失敗しました: ${e.message || JSON.stringify(e)}`);
    }
  };

  const applyPreset = async (p: Preset) => {
    await initContext();
    setActivePresetId(p.id);
    setEqGains([...p.eqGains]);
    setRevDry(p.reverbDry);
    setRevWet(p.reverbWet);
    setGlobalVolume(p.volume);

    // Engine update is handled by useEffect
  };

  const updateActivePreset = (updatedFields: Partial<Preset>) => {
    if (!activePresetId) return;

    const isCustom = !['flat', 'concert-hall'].includes(activePresetId);

    // 1. Update local state immediately
    setPresets(prev => prev.map(p => {
      if (p.id === activePresetId) {
        return { ...p, ...updatedFields };
      }
      return p;
    }));

    // 2. Debounce local DB update
    if (isCustom) {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(async () => {
        console.log("Syncing preset to local DB...", activePresetId);
        try {
          await db.presets.update(Number(activePresetId), {
            eqGains: updatedFields.eqGains || undefined,
            reverbDry: updatedFields.reverbDry,
            reverbWet: updatedFields.reverbWet,
            volume: updatedFields.volume
          });
        } catch (err) {
          console.error("Local DB preset update failed:", err);
        }
      }, 1000);
    }
  };

  const handleEqChange = (index: number, value: number) => {
    const next = [...eqGains]; next[index] = value;
    setEqGains(next); setEqGain(index, value);
    updateActivePreset({ eqGains: next });
  };

  const savePreset = async () => {
    const name = prompt("Preset Name", "My Preset");
    if (!name) return;

    try {
      const id = await db.presets.add({
        name,
        eqGains: [...eqGains],
        reverbDry,
        reverbWet,
        volume,
        createdAt: Date.now()
      });

      const newPreset = { id: id.toString(), name, eqGains: [...eqGains], reverbDry, reverbWet, volume };
      setPresets(v => [...v, newPreset]);
      applyPreset(newPreset);
    } catch (err) {
      console.error("Failed to save preset:", err);
      alert("プリセットの保存に失敗しました。");
    }
  };

  const deletePreset = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("このプリセットを削除しますか？")) return;

    try {
      await db.presets.delete(Number(id));
      setPresets(prev => prev.filter(p => p.id !== id));
      if (activePresetId === id) setActivePresetId(null);
    } catch (err) {
      console.error("Delete preset failed:", err);
      alert("削除に失敗しました。");
    }
  };

  const handleMatch = async () => {
    const sTrack = sourceTrack || currentTrack;
    if (!sTrack || !targetTrack) {
      alert("比較する楽曲（ソースとターゲット）を両方選択してください。");
      return;
    }

    console.log(`Starting match process: ${sTrack.name} vs ${targetTrack.name}`);
    setIsMatching(true);

    try {
      // 1. Analyze Source Track
      let sSpec: number[] | null = null;
      console.log("Analyzing Source Track...");

      // Get track data directly for analysis - avoid prepareTrackSource which might only give URL
      const sLocal = await db.tracks.get(Number(sTrack.id));
      if (!sLocal) throw new Error("ソース楽曲が見つかりません。");

      const sBuffer = await loadBufferForAnalysis(sLocal.data);
      sSpec = await getSpectrum(sBuffer);
      console.log("Source Spectrum Analysis Complete.");

      // Let iOS breathe and GC
      await new Promise(r => setTimeout(r, 600));

      // 2. Analyze Target Track
      let tSpec: number[] | null = null;
      console.log("Analyzing Target Track...");

      const tLocal = await db.tracks.get(Number(targetTrack.id));
      if (!tLocal) throw new Error("ターゲット楽曲が見つかりません。");

      const tBuffer = await loadBufferForAnalysis(tLocal.data);
      tSpec = await getSpectrum(tBuffer);
      console.log("Target Spectrum Analysis Complete.");

      if (sSpec && tSpec) {
        console.log("Calculating matched gains...");
        const matchedGains = calculateMatchedGains(sSpec, tSpec);
        setEqGains(matchedGains);
        matchedGains.forEach((g: number, i: number) => setEqGain(i, g));

        setTimeout(() => {
          const name = prompt("比較（Matching）に成功しました！\nこの設定を新しいプリセットとして保存しますか？（空欄でキャンセル）", "Matched Preset");
          if (name) saveMatchedPreset(name, matchedGains);
          else alert("Matching設定を現在のEQに適用しました。");
        }, 100);
      } else {
        throw new Error("楽曲の周波数解析に失敗しました。");
      }
    } catch (e: any) {
      console.error("Match Process Error:", e);
      alert(`比較中にエラーが発生しました。\niPhone等の場合はブラウザの他のタブを閉じてからお試しください。\n\n詳細: ${e.message || '不明なエラー'}`);
    } finally {
      setIsMatching(false);
    }
  };

  const saveMatchedPreset = async (name: string, gains: number[]) => {
    try {
      const id = await db.presets.add({
        name,
        eqGains: [...gains],
        reverbDry,
        reverbWet,
        volume,
        createdAt: Date.now()
      });

      const newPreset = {
        id: id.toString(),
        name,
        eqGains: [...gains],
        reverbDry,
        reverbWet,
        volume
      };

      setPresets(v => [...v, newPreset]);
      applyPreset(newPreset);
      alert(`プリセット "${name}" を保存しました。`);
    } catch (e: any) {
      console.error("Failed to save matched preset:", e);
      alert("プリセットの保存に失敗しました。設定は現在のEQに適用されています。");
    }
  };

  // Visualizer Ref
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!isPlaying || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;
    const render = () => {
      const visData = getVisualizerData();

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = (canvas.width / visData.length) * 2.5;
      let x = 0;

      for (let i = 0; i < visData.length; i++) {
        const barHeight = (visData[i] / 255) * canvas.height;
        ctx.fillStyle = `rgba(139, 92, 246, ${visData[i] / 255})`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
      animId = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(animId);
  }, [isPlaying]);

  return (
    <main className={`main-layout ${theme === "light" ? "light-theme" : ""}`} data-active-tab={activeTab}>
      <header>
        <div className="header-left">
          <h1 className="logo">EQ LAB</h1>
          <small style={{ color: "var(--text-dim)", marginLeft: 12 }}>{updatedAt}</small>
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} className="theme-btn" style={{ background: "none", border: "none", fontSize: "1.2rem", cursor: "pointer" }}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
      </header>

      <div className="content-grid">
        {/* Left Sidebar: Library */}
        <aside
          className={`sidebar-library ${isDraggingFile ? "drag-active" : ""}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={{ position: "relative" }}
        >
          {isDraggingFile && (
            <div style={{
              position: "absolute",
              inset: 0,
              background: "rgba(139, 92, 246, 0.2)",
              backdropFilter: "blur(4px)",
              border: "2px dashed var(--accent)",
              zIndex: 10,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
              borderRadius: "inherit"
            }}>
              <div style={{ background: "var(--p-bg)", padding: "12px 24px", borderRadius: "20px", fontWeight: "bold", boxShadow: "var(--shadow)" }}>
                Drop to Add Audio
              </div>
            </div>
          )}
          <div className="panel-head">
            <h2 className="section-title">Library</h2>
            <button className="add-icon-btn" onClick={() => fileInputRef.current?.click()} style={{ background: "var(--accent)", color: "white", border: "none", width: 28, height: 28, borderRadius: "50%", cursor: "pointer", fontWeight: "bold" }}>+</button>
            <input ref={fileInputRef} type="file" accept="audio/*,audio/x-caf,audio/caf,audio/x-m4a,audio/mp3,audio/wav,.caf,.mp3,.wav,.m4a" onChange={(e) => handleFileUpload(e, "library")} style={{ display: "none" }} />
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "0 12px" }}>
            {isLoadingLibrary && <div style={{ textAlign: "center", padding: 20, color: "var(--text-dim)" }}>Syncing...</div>}
            {library.map((track) => (
              <div
                key={track.id}
                onClick={async () => {
                  await initContext();
                  setCurrentTrack(track);
                  setProgress(0);
                  const source = await prepareTrackSource(track);
                  if (source?.buffer) {
                    setDuration(source.buffer.duration);
                    const updatedTrack = { ...track, buffer: source.buffer };
                    setCurrentTrack(updatedTrack);
                    if (isPlaying) {
                      playBuffer(source.buffer, 0, volume, eqGains, reverbDry, reverbWet);
                    }
                    setLibrary(prev => prev.map(t => t.id === track.id ? updatedTrack : t));
                  } else if (source?.url) {
                    setCurrentTrack(track);
                    if (isPlaying) {
                      playStream(source.url, 0, volume, eqGains, reverbDry, reverbWet);
                    }
                  }
                }}
                className={`track-item ${currentTrack?.id === track.id ? "active" : ""}`}
              >
                <div style={{ overflow: "hidden" }}>
                  <div style={{ fontWeight: 500, fontSize: "0.9rem", whiteSpace: "nowrap", textOverflow: "ellipsis", overflow: "hidden" }}>{track.name}</div>
                  <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{track.buffer ? formatTime(track.buffer.duration) : "Local"}</div>
                </div>
                {track.id !== "default" && (
                  <button onClick={(e) => deleteTrack(track.id, e)} style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: "1.1rem", cursor: "pointer" }}>×</button>
                )}
              </div>
            ))}
          </div>
        </aside>

        {/* Center: EQ */}
        <section className="center-panel">
          <div className="panel-head">
            <h2 className="section-title">Equalizer & Effects</h2>
            <button onClick={savePreset} className="btn-xs" style={{ background: "var(--accent)", color: "white", border: "none", padding: "6px 12px", borderRadius: 8, cursor: "pointer" }}>Save Preset</button>
          </div>

          <div className="eq-container">
            <div className="eq-strips pc-only">
              {EQ_FREQUENCIES.map((freq, i) => (
                <div key={freq} className="eq-strip">
                  <div style={{ fontSize: "0.6rem", color: "var(--accent)", fontWeight: "bold" }}>{eqGains[i]?.toFixed(1)}</div>
                  <div className="slider-vertical">
                    <input type="range" min="-12" max="12" step="0.1" value={eqGains[i] || 0} onChange={e => handleEqChange(i, parseFloat(e.target.value))} />
                  </div>
                  <div className="freq-label">{freq < 1000 ? freq : `${freq / 1000}k`}</div>
                </div>
              ))}
            </div>

            <div className="fx-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, padding: "24px 0" }}>
              <div className="fx-box">
                <label style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: 8, display: "block" }}>REVERB DRY</label>
                <input type="range" min="0" max="1" step="0.01" value={reverbDry} onChange={e => {
                  const v = parseFloat(e.target.value);
                  setRevDry(v); setReverbDry(v);
                  updateActivePreset({ reverbDry: v });
                }} style={{ width: "100%" }} />
              </div>
              <div className="fx-box">
                <label style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: 8, display: "block" }}>REVERB WET</label>
                <input type="range" min="0" max="1" step="0.01" value={reverbWet} onChange={e => {
                  const v = parseFloat(e.target.value);
                  setRevWet(v); setReverbWet(v);
                  updateActivePreset({ reverbWet: v });
                }} style={{ width: "100%" }} />
              </div>
              <div className="fx-box" style={{ gridColumn: "span 2" }}>
                <label style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: 8, display: "block" }}>OUTPUT GAIN</label>
                <input type="range" min="0" max="1.5" step="0.01" value={volume} onChange={e => {
                  const v = parseFloat(e.target.value);
                  setGlobalVolume(v); setVolume(v);
                  updateActivePreset({ volume: v });
                }} style={{ width: "100%" }} />
              </div>
            </div>

            <div style={{ marginTop: 24 }}>
              <h3 className="section-title" style={{ marginBottom: 16 }}>Presets</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {presets.map(p => (
                  <div key={p.id} onClick={() => applyPreset(p)} className={`preset-item ${activePresetId === p.id ? "active-preset" : ""}`} style={{ padding: 12, borderRadius: 12, border: "1px solid var(--border)", cursor: "pointer", background: activePresetId === p.id ? "rgba(139, 92, 246, 0.1)" : "var(--hover)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "0.85rem", fontWeight: activePresetId === p.id ? 600 : 400 }}>{p.name}</span>
                    {(p.id !== 'flat' && p.id !== 'concert-hall') && (
                      <button onClick={e => deletePreset(p.id, e)} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}>×</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Right Sidebar: AI Match */}
        <aside className="sidebar-matching">
          <div className="panel-head">
            <h2 className="section-title">AI Matching</h2>
          </div>
          <div className="glass-card">
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: 4 }}>SOURCE TRACK</div>
              <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{sourceTrack?.name || currentTrack?.name || "Select from library"}</div>
            </div>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginBottom: 4 }}>TARGET REFERENCE</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <div style={{ fontWeight: 600, fontSize: "0.9rem", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{targetTrack?.name || "Load file..."}</div>
                <label className="btn-s" style={{ background: "var(--border)", padding: "4px 10px", borderRadius: 6, fontSize: "0.75rem", cursor: "pointer" }}>
                  Pick <input type="file" accept="audio/*,audio/x-caf,audio/caf,audio/x-m4a,audio/mp3,audio/wav,.caf,.mp3,.wav,.m4a" hidden onChange={e => handleFileUpload(e, "target")} />
                </label>
              </div>
            </div>
            <button
              onClick={handleMatch}
              disabled={isMatching || !targetTrack}
              className="btn-primary"
              style={{ width: "100%", background: "var(--accent-gradient)", color: "white", border: "none", padding: 14, borderRadius: 12, fontWeight: 700, cursor: "pointer", opacity: (isMatching || !targetTrack) ? 0.5 : 1 }}
            >
              {isMatching ? "Analyzing..." : "Calculate Best EQ"}
            </button>
          </div>
        </aside>
      </div>

      <footer className="player-bar">
        <button onClick={togglePlay} className={`play-btn ${isBuffering ? "buffering" : ""}`} disabled={isBuffering}>
          {isBuffering ? "..." : (isPlaying ? "Ⅱ" : "▶")}
        </button>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <div style={{ overflow: "hidden" }}>
              <div style={{ fontWeight: 700, fontSize: "1rem", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{currentTrack?.name || "No track selected"}</div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-dim)" }}>{isBuffering ? "Decoding audio..." : (isPlaying ? "Playing locally" : "Ready")}</div>
            </div>
            <div style={{ fontSize: "0.85rem", fontFamily: "monospace", color: "var(--text-dim)" }}>
              {formatTime(progress)} / {formatTime(duration)}
            </div>
          </div>
          <input
            type="range" min="0" max={duration || 1} step="0.01" value={progress}
            onInput={(e) => { setIsDragging(true); setProgress(parseFloat((e.target as any).value)); }}
            onChange={(e) => { setIsDragging(false); handleManualSeek(parseFloat((e.target as any).value)); }}
            style={{ width: "100%", cursor: "pointer" }}
          />
        </div>

        <canvas ref={canvasRef} width="160" height="40" style={{ opacity: isPlaying ? 0.8 : 0.2, transition: "0.3s" }} className="pc-only" />
      </footer>

      <nav className="mobile-only" style={{ position: "fixed", bottom: 0, width: "100%", height: 64, display: "flex", background: "var(--p-bg)", borderTop: "1px solid var(--border)", zIndex: 2000 }}>
        {["library", "eq", "matching"].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab as any)}
            style={{ flex: 1, background: "none", border: "none", color: activeTab === tab ? "var(--accent)" : "var(--text-dim)", fontWeight: activeTab === tab ? 700 : 400, fontSize: "0.75rem", textTransform: "uppercase" }}
          >
            {tab}
          </button>
        ))}
      </nav>
    </main>
  );
}
