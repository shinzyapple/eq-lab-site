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
  setOffsetTime,
  suspendContext,
  resumeContext,
  initContext,
  createSampleBuffer,
  setAudioEngineCallbacks,
  updateMediaMetadata,
  updateMediaPositionState
} from "@/lib/audioEngine";
import { defaultPresets, Preset } from "@/lib/presets";
import { supabase } from "@/lib/supabaseClient";

type Track = {
  id: string;
  name: string;
  buffer?: AudioBuffer;
  filePath?: string;
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

  const [eqGains, setEqGains] = useState<number[]>(new Array(31).fill(0));
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

  const { data: session, status } = useSession();
  const isLoadingSession = status === "loading";
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const requestRef = useRef<number | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Helper to load buffer if missing
  const loadTrackBuffer = async (track: Track): Promise<AudioBuffer | null> => {
    if (track.buffer) return track.buffer;
    if (track.filePath) {
      try {
        console.log(`Downloading track: ${track.filePath}`);
        const { data, error } = await supabase.storage.from("eq-lab-tracks").download(track.filePath);

        if (error) {
          console.error("Download Error Details:", error);
          const errorMsg = error.message || JSON.stringify(error, Object.getOwnPropertyNames(error));
          alert(`楽曲のダウンロードに失敗しました: ${errorMsg}`);
          return null;
        }

        if (data) {
          console.log(`Download complete, decoding...`);
          const buffer = await loadAudio(new File([data], track.name));

          // Update library cache
          const updater = (t: Track) => t.id === track.id ? { ...t, buffer } : t;
          setLibrary(prev => prev.map(updater));

          // CRITICAL: Also update currentTrack so subsequent calls find the buffer
          setCurrentTrack(curr => curr?.id === track.id ? { ...curr, buffer } : curr);

          return buffer;
        }
      } catch (e: any) {
        console.error("Failed to load cloud track:", e);
        alert(`楽曲の解析に失敗しました: ${e.message || '不明なエラー'}`);
      }
    }
    return null;
  };

  // Load all local storage settings once on mount
  useEffect(() => {
    const savedLib = localStorage.getItem("eq-lab-library");
    if (savedLib) {
      try {
        const parsed = JSON.parse(savedLib);
        const metadataOnly = parsed.map((t: any) => ({ ...t, buffer: undefined }));
        setLibrary(metadataOnly);
        console.log("Restored library from localStorage", metadataOnly.length);
      } catch (e) { console.error("Failed to parse saved library"); }
    }

    const savedSettings = localStorage.getItem("eq-lab-settings");
    if (savedSettings) {
      try {
        const s = JSON.parse(savedSettings);
        if (s.eqGains) {
          setEqGains(s.eqGains);
          s.eqGains.forEach((g: number, i: number) => setEqGain(i, g));
        }
        if (s.reverbDry !== undefined) { setRevDry(s.reverbDry); setReverbDry(s.reverbDry); }
        if (s.reverbWet !== undefined) { setRevWet(s.reverbWet); setReverbWet(s.reverbWet); }
        if (s.volume !== undefined) { setGlobalVolume(s.volume); setVolume(s.volume); }
        if (s.activePresetId) setActivePresetId(s.activePresetId);
        if (s.currentTrackId) (window as any).__lastTrackId = s.currentTrackId;
      } catch (e) { console.error("Failed to parse saved settings"); }
    }
  }, []);

  // Separate Effect for Cloud Sync: Triggered by session changes
  useEffect(() => {
    // CRITICAL: If session is still loading, do nothing. 
    // This prevents wiping out the results restored from localStorage in the first effect.
    if (status === "loading") return;

    let isMounted = true;
    const userEmail = session?.user?.email;

    const syncLibrary = async () => {
      console.log("Starting cloud/default sync... Auth status:", status);

      // 1. Parallel fetch: Default track and Cloud tracks
      const [defaultTrackRes, cloudTracksRes] = await Promise.allSettled([
        (async () => {
          try {
            const buffer = await loadAudio("/audio/base.wav");
            return { id: "default", name: "サンプル曲 (base.wav)", buffer } as Track;
          } catch (e) {
            console.warn("Base audio load failed, creating fallback");
            const ctx = await initContext();
            return ctx ? { id: "default", name: "⚠️ 初期警告音 (ファイル未検出)", buffer: createSampleBuffer(ctx) } : null;
          }
        })(),
        (async () => {
          if (!userEmail) return [] as Track[];
          setIsLoadingLibrary(true);
          try {
            const { data, error } = await supabase
              .from("tracks")
              .select("*")
              .eq("user_email", userEmail)
              .order("created_at", { ascending: false });
            if (data && !error) {
              return data.map(t => ({ id: t.id, name: t.name, filePath: t.file_path })) as Track[];
            }
          } catch (err) {
            console.error("Supabase fetch error:", err);
          } finally {
            if (isMounted) setIsLoadingLibrary(false);
          }
          return [] as Track[];
        })()
      ]);

      if (!isMounted) return;

      const defaultTrack = defaultTrackRes.status === 'fulfilled' ? defaultTrackRes.value : null;
      const cloudTracks = cloudTracksRes.status === 'fulfilled' ? cloudTracksRes.value : [];

      // 3. Update the library state
      setLibrary(prev => {
        const cloudIds = new Set(cloudTracks.map(t => t.id));

        // Filter previous state: 
        // If logged in: only keep local/guest tracks or cloud tracks that are still in cloudIds.
        // If guest: keep all existing local tracks.
        const locals = prev.filter(t => {
          if (t.id === "default") return false;
          if (t.filePath) {
            // If we are logged in, we only keep it if it's still in the cloud
            if (userEmail) return cloudIds.has(t.id);
            // If logged out but it has a path, it's a "ghost" from a previous session, usually we keep it
            return true;
          }
          return true; // Guest tracks (no filePath) always stay
        });

        const combined = defaultTrack ? [defaultTrack, ...locals, ...cloudTracks] : [...locals, ...cloudTracks];
        const unique = Array.from(new Map(combined.map(t => [t.id, t])).values());

        // Update local storage with the combined metadata
        const toSave = unique.map(t => ({ id: t.id, name: t.name, filePath: t.filePath }));
        localStorage.setItem("eq-lab-library", JSON.stringify(toSave));

        // Restore last selected track
        const lastId = (window as any).__lastTrackId;
        if (lastId) {
          const matched = unique.find(t => t.id === lastId);
          if (matched) setCurrentTrack(matched);
          delete (window as any).__lastTrackId;
        }

        console.log(`Library sync complete: ${unique.length} tracks`);
        return unique;
      });
    };

    syncLibrary();
    return () => { isMounted = false; };
  }, [session?.user?.email, status]);

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

  // Sync Presets
  useEffect(() => {
    setUpdatedAt(new Date().toLocaleString("ja-JP"));
    const userEmail = session?.user?.email;
    if (isLoadingSession || !userEmail) return;
    const fetchPresets = async () => {
      const { data } = await supabase.from("presets").select("*").eq("user_email", userEmail).order("id", { ascending: true });
      if (data) {
        const formatted = data.map((p: any) => ({
          id: p.id,
          name: p.name,
          eqGains: p.eq_gains || [],
          reverbDry: p.reverb_dry,
          reverbWet: p.reverb_wet,
          volume: p.volume
        }));
        setPresets(prev => {
          // Merge logic: Update existing presets if data matches, add new ones
          const defaultIds = new Set(defaultPresets.map(p => p.id));
          const customInPrev = prev.filter(p => !defaultIds.has(p.id));

          // Re-create the list starting with defaults
          const merged = [...defaultPresets];

          formatted.forEach((cloudP: Preset) => {
            const indexInMerged = merged.findIndex(p => p.id === cloudP.id);
            if (indexInMerged > -1) {
              merged[indexInMerged] = cloudP;
            } else {
              merged.push(cloudP);
            }
          });

          return merged;
        });
      }
    };
    fetchPresets();
  }, [session?.user?.email, isLoadingSession]);

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
    const playing = getIsPlaying();
    setIsPlaying(playing);
    if (playing && !isDragging) {
      const currentTime = getCurrentTime();
      setProgress(currentTime);
      setDuration(getDuration());
      // Sync control center progress with OS
      if ('mediaSession' in navigator) {
        updateMediaPositionState();
      }
    }
    requestRef.current = requestAnimationFrame(updateProgress);
  };

  useEffect(() => {
    requestRef.current = requestAnimationFrame(updateProgress);
    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isDragging]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, mode: "library" | "source" | "target") => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      let buffer: AudioBuffer | undefined;
      let trackId = Math.random().toString(36).substr(2, 9);
      let filePath = "";

      const userEmail = session?.user?.email;

      // On mobile, large files + parsing = crash.
      // We skip local decode if we are uploading to cloud.
      if (mode !== "library" || !userEmail) {
        buffer = await loadAudio(file);
      }

      if (userEmail && mode === "library") {
        // Use raw email for folder (essential for RLS policies) but safe name for file
        const ext = file.name.includes('.') ? file.name.split('.').pop() : 'bin';
        const safeName = `${Date.now()}-${Math.random().toString(36).substr(2, 5)}.${ext}`;
        filePath = `${userEmail}/${safeName}`;

        console.log(`Uploading to Supabase: ${filePath}`);

        const { error: uploadError } = await supabase.storage
          .from("eq-lab-tracks")
          .upload(filePath, file, { cacheControl: '3600', upsert: false });

        if (uploadError) {
          console.error("Cloud Storage Upload Error:", uploadError);
          const errorMsg = uploadError.message || JSON.stringify(uploadError, Object.getOwnPropertyNames(uploadError));
          throw new Error(`Storage upload failed: ${errorMsg}`);
        }

        const { data, error: dbError } = await supabase
          .from("tracks")
          .insert([{ user_email: userEmail, name: file.name, file_path: filePath }])
          .select();

        if (dbError) {
          console.error("Database Insert Error:", dbError);
          // Cleanup storage if DB failed
          await supabase.storage.from("eq-lab-tracks").remove([filePath]);
          throw new Error(`Database entry failed: ${dbError.message || JSON.stringify(dbError)}`);
        }

        if (data) trackId = data[0].id;
      }

      const newTrack: Track = { id: trackId, name: file.name, buffer, filePath };

      if (mode === "library") {
        setLibrary(prev => {
          if (prev.find(t => t.id === newTrack.id)) return prev;
          const updated = [newTrack, ...prev];
          const toSave = updated.map(t => ({ id: t.id, name: t.name, filePath: t.filePath }));
          localStorage.setItem("eq-lab-library", JSON.stringify(toSave));
          return updated;
        });
        if (window.innerWidth > 768) {
          setCurrentTrack(curr => curr || newTrack);
        }
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
    }

    e.target.value = "";
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
    if (file && file.type.startsWith("audio/")) {
      // Mock an event structure for handleFileUpload compatibility or just call a shared logic
      const mockEvent = { target: { files: [file], value: "" } } as any;
      handleFileUpload(mockEvent, "library");
    }
  };

  const togglePlay = async () => {
    // 1. Context Init
    await initContext();

    if (isPlaying) {
      stop();
      setIsPlaying(false);
    } else {
      if (!currentTrack) {
        alert("再生する曲をライブラリから選択してください。");
        return;
      }

      console.log(`Attempting to play: ${currentTrack.name}`);
      if (!currentTrack.buffer) setIsBuffering(true);

      try {
        const buffer = await loadTrackBuffer(currentTrack);
        if (buffer) {
          // Re-resume context right before play in case async fetch suspended it
          await initContext();
          playBuffer(buffer, progress, volume, eqGains, reverbDry, reverbWet);
          setIsPlaying(true);
        } else {
          console.error("No buffer returned from loadTrackBuffer");
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
    setOffsetTime(time);
    if (isPlaying && currentTrack) {
      const buffer = await loadTrackBuffer(currentTrack);
      if (buffer) playBuffer(buffer, time, volume, eqGains, reverbDry, reverbWet);
    }
    // Immediate sync to lock screen after manual seek
    updateMediaPositionState();
  };

  const deleteTrack = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const track = library.find(t => t.id === id);
    if (!track || id === "default") return;
    if (!confirm(`楽曲 "${track.name}" を削除しますか？`)) return;

    try {
      if (track.filePath) {
        console.log("Removing track from cloud storage/DB...");
        const { error: sErr } = await supabase.storage.from("eq-lab-tracks").remove([track.filePath]);
        if (sErr) console.warn("Storage removal warning:", sErr);

        const { error: dbErr } = await supabase.from("tracks").delete().eq("id", id);
        if (dbErr) throw new Error(`Database deletion failed: ${dbErr.message}`);
      }

      setLibrary(prev => {
        const filtered = prev.filter(t => t.id !== id);
        // Force immediate persistence to localStorage
        const toSave = filtered.map(t => ({ id: t.id, name: t.name, filePath: t.filePath }));
        localStorage.setItem("eq-lab-library", JSON.stringify(toSave));
        return filtered;
      });

      if (currentTrack?.id === id) setCurrentTrack(null);
      console.log("Track deleted successfully");
    } catch (e: any) {
      console.error("Delete failed:", e);
      alert(`削除に失敗しました: ${e.message || JSON.stringify(e)}`);
    }
  };

  const applyPreset = (p: Preset) => {
    setActivePresetId(p.id);
    setEqGains([...p.eqGains]); setRevDry(p.reverbDry); setRevWet(p.reverbWet); setGlobalVolume(p.volume);
    p.eqGains.forEach((g, i) => setEqGain(i, g));
    setReverbDry(p.reverbDry); setReverbWet(p.reverbWet); setVolume(p.volume);
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

    // 2. Debounce server update
    const userEmail = session?.user?.email;
    if (isCustom && userEmail) {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(async () => {
        const payload: any = {};
        if (updatedFields.eqGains) payload.eq_gains = updatedFields.eqGains;
        if (updatedFields.reverbDry !== undefined) payload.reverb_dry = updatedFields.reverbDry;
        if (updatedFields.reverbWet !== undefined) payload.reverb_wet = updatedFields.reverbWet;
        if (updatedFields.volume !== undefined) payload.volume = updatedFields.volume;

        console.log("Syncing preset to server...", payload);
        const { error } = await supabase.from("presets").update(payload).eq("id", activePresetId);
        if (error) console.error("Server sync failed:", error);
      }, 1000);
    }
  };

  const handleEqChange = (index: number, value: number) => {
    const next = [...eqGains]; next[index] = value;
    setEqGains(next); setEqGain(index, value);
    updateActivePreset({ eqGains: next });
  };

  const savePreset = async () => {
    const userEmail = session?.user?.email;
    if (!userEmail) return alert("Login required");
    const name = prompt("Preset Name", "My Preset");
    if (!name) return;
    const { data } = await supabase.from("presets").insert([{ name, user_email: userEmail, eq_gains: eqGains, reverb_dry: reverbDry, reverb_wet: reverbWet, volume }]).select();
    if (data) setPresets(v => [...v, { id: data[0].id, name, eqGains: [...eqGains], reverbDry, reverbWet, volume }]);
  };

  const deletePreset = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("このプリセットを削除しますか？")) return;

    const { error } = await supabase.from("presets").delete().eq("id", id);
    if (!error) {
      setPresets(prev => prev.filter(p => p.id !== id));
      if (activePresetId === id) setActivePresetId(null);
    } else {
      alert("削除に失敗しました。");
    }
  };

  const handleMatch = async () => {
    const sTrack = sourceTrack || currentTrack;
    if (!sTrack || !targetTrack) return;
    setIsMatching(true);
    try {
      const sBuf = await loadTrackBuffer(sTrack);
      const tBuf = await loadTrackBuffer(targetTrack);

      if (sBuf && tBuf) {
        const matchedGains = await getMatchingEq(sBuf, tBuf);
        setEqGains(matchedGains);
        matchedGains.forEach((g, i) => setEqGain(i, g));

        // Auto-save result if user wants
        const name = prompt("Matchingが完了しました。この設定をプリセットとして保存しますか？（未入力でキャンセル）", "Matched Preset");
        const userEmail = session?.user?.email;
        if (name && userEmail) {
          const { data } = await supabase.from("presets").insert([{
            name,
            user_email: userEmail,
            eq_gains: matchedGains,
            reverb_dry: reverbDry,
            reverb_wet: reverbWet,
            volume
          }]).select();
          if (data) setPresets(v => [...v, { id: data[0].id, name, eqGains: [...matchedGains], reverbDry, reverbWet, volume }]);
          alert(`プリセット "${name}" を保存しました。`);
        } else {
          alert("Matching Complete!");
        }
      } else {
        alert("Could not load tracks for matching.");
      }
    } catch (e) {
      console.error(e);
      alert("Matching Error");
    } finally {
      setIsMatching(false);
    }
  };

  return (
    <main className={`main-layout ${theme === "light" ? "light-theme" : ""}`}>
      <header className="header">
        <div className="header-left">
          <h1 className="logo">EQ LAB <small className="last-updated">更新: {updatedAt}</small></h1>
          <button onClick={() => setTheme(t => t === "dark" ? "light" : "dark")} className="theme-btn">{theme === "dark" ? "☀️" : "🌙"}</button>
        </div>
        <div className="auth">
          {isLoadingSession ? <span>...</span> : session ? <button onClick={() => signOut()} className="btn-s">{session.user?.name} (Logout)</button> : <button onClick={() => signIn()} className="btn-s">Login</button>}
        </div>
      </header>

      <div className="content-grid">
        {/* Left Sidebar: Library */}
        <aside className={`left-sidebar ${activeTab === "library" ? "show-mobile" : "hide-mobile"}`}>
          <section
            className={`glass-panel library-section ${isDraggingFile ? "drag-active" : ""}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="section-head-row">
              <h2 className="section-title">ライブラリ</h2>
              <button
                className="add-icon-btn"
                onClick={() => fileInputRef.current?.click()}
                title="AUDIOを追加"
              >
                +
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*, .mp3, .wav, .m4a, .aac, .ogg"
                onChange={(e) => handleFileUpload(e, "library")}
                style={{ display: "none" }}
              />
            </div>

            <div className="track-list">
              {isLoadingLibrary && (
                <div className="library-loading">
                  <span className="loader-s"></span>
                  <span>Syncing with Cloud...</span>
                </div>
              )}
              {isUploading && (
                <div className="uploading-indicator">
                  <span className="loader-s"></span>
                  <span>Uploading to Cloud...</span>
                </div>
              )}
              {library.length === 0 && !isUploading && (
                <p style={{ fontSize: "0.7rem", opacity: 0.5, textAlign: "center", padding: "40px 20px" }}>
                  音声ファイルがありません。<br />ここにドロップするか、上の＋ボタンから追加してください。
                </p>
              )}
              {library.map((track) => (
                <div
                  key={track.id}
                  onClick={async () => {
                    await initContext();
                    setCurrentTrack(track);
                    setProgress(0);
                    if (isPlaying) {
                      const buf = await loadTrackBuffer(track);
                      if (buf) playBuffer(buf, 0, volume, eqGains, reverbDry, reverbWet);
                    }
                  }}
                  className={`library-item ${currentTrack?.id === track.id ? "active" : ""}`}
                >
                  <div className="item-meta">
                    <span className="track-name">{track.name}</span>
                    <span className="track-dur">{track.buffer ? formatTime(track.buffer.duration) : "--:--"}</span>
                  </div>
                  {track.id !== "default" && (
                    <button onClick={(e) => deleteTrack(track.id, e)} className="del-btn">×</button>
                  )}
                </div>
              ))}
            </div>
            {isDraggingFile && <div className="drag-overlay">ファイルをドロップして追加</div>}
          </section>
        </aside>

        {/* EQ Panel (Center) */}
        <section className={`panel eq-panel ${activeTab === "eq" ? "show-mobile" : "hide-mobile"}`}>
          <div className="panel-head"><h2>EQ & EFFECTS</h2><button onClick={savePreset} className="btn-xs">Save</button></div>
          <div className="eq-scroll pc-only">
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
          <div className="mobile-eq-hint mobile-only">
            <p>※ 31バンドEQの詳細調整はPC版のみ可能です。<br />スマホ版ではプリセットを選択してください。</p>
          </div>
          <div className="fx-grid">
            <div className="fx-box">
              <label>Reverb Dry: {Math.round(reverbDry * 100)}%</label>
              <input type="range" min="0" max="1" step="0.01" value={reverbDry} onChange={e => {
                const v = parseFloat(e.target.value);
                setRevDry(v); setReverbDry(v);
                updateActivePreset({ reverbDry: v });
              }} className="fx-range" />
            </div>
            <div className="fx-box">
              <label>Reverb Wet: {Math.round(reverbWet * 100)}%</label>
              <input type="range" min="0" max="1" step="0.01" value={reverbWet} onChange={e => {
                const v = parseFloat(e.target.value);
                setRevWet(v); setReverbWet(v);
                updateActivePreset({ reverbWet: v });
              }} className="fx-range" />
            </div>
            <div className="fx-box full-width">
              <label>Output Gain: {Math.round(volume * 100)}%</label>
              <input type="range" min="0" max="1.5" step="0.01" value={volume} onChange={e => {
                const v = parseFloat(e.target.value);
                setGlobalVolume(v); setVolume(v);
                updateActivePreset({ volume: v });
              }} className="fx-range wide" />
            </div>
          </div>
          <div className="pre-box">
            <label>PRESETS LIST</label>
            <div className="preset-list">
              {presets.map(p => (
                <div key={p.id} onClick={() => applyPreset(p)} className={`preset-item ${activePresetId === p.id ? "active-preset" : ""}`}>
                  <span className="preset-name">{p.name} {activePresetId === p.id && <small>(選択中)</small>}</span>
                  {(p.id !== 'flat' && p.id !== 'concert-hall') && (
                    <button onClick={e => { deletePreset(p.id, e); }} className="p-del-btn">×</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Right Sidebar: Matching */}
        <section className={`panel m-panel ${activeTab === "matching" ? "show-mobile" : "hide-mobile"}`}>
          <h2>AI MATCHING</h2>
          <div className="m-field">
            <div className="m-row"><span>Src:</span> <b>{sourceTrack?.name || currentTrack?.name || "-"}</b> <label className="btn-s">File<input type="file" accept="audio/*, .mp3, .wav, .m4a, .aac, .ogg" hidden onChange={e => handleFileUpload(e, "source")} /></label></div>
            <div className="m-row"><span>Tgt:</span> <b>{targetTrack?.name || "-"}</b> <label className="btn-s">File<input type="file" accept="audio/*, .mp3, .wav, .m4a, .aac, .ogg" hidden onChange={e => handleFileUpload(e, "target")} /></label></div>
          </div>
          <button onClick={handleMatch} disabled={isMatching || !targetTrack} className="btn-primary">{isMatching ? "Processing..." : "Run Match Process"}</button>
        </section>
      </div>

      <footer className="player">
        <button onClick={togglePlay} className={`p-btn ${isBuffering ? "buffering" : ""}`} disabled={isBuffering}>
          {isBuffering ? <span className="loader-s"></span> : (isPlaying ? "Ⅱ" : "▶")}
        </button>
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

      <nav className="mobile-nav">
        <button onClick={() => setActiveTab("library")} className={`nav-item ${activeTab === "library" ? "active" : ""}`}>
          <span className="nav-icon">📚</span>
          <span className="nav-label">ライブラリ</span>
        </button>
        <button onClick={() => setActiveTab("eq")} className={`nav-item ${activeTab === "eq" ? "active" : ""}`}>
          <span className="nav-icon">🎚️</span>
          <span className="nav-label">EQプリセット</span>
        </button>
        <button onClick={() => setActiveTab("matching")} className={`nav-item ${activeTab === "matching" ? "active" : ""}`}>
          <span className="nav-icon">🤖</span>
          <span className="nav-label">AI比較</span>
        </button>
      </nav>

      <style jsx>{`
        .main-layout { --accent: #a855f7; --bg: #000; --p-bg: #0c0c0e; --text: #fff; --text-m: #888; --border: #222; --hover: #161618; --player: rgba(10,10,12,0.85); height: 100dvh; display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: hidden; transition: 0.3s; }
        .main-layout.light-theme { --bg: #f9f7ff; --p-bg: #fff; --text: #1d1d1f; --text-m: #86868b; --border: #ede9fe; --hover: #f5f0ff; --player: rgba(255,255,255,0.85); }
        .header { padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); background: var(--p-bg); flex-shrink: 0; }
        .header-left { display: flex; align-items: center; gap: 15px; }
        .logo { font-size: 1.1rem; font-weight: 900; color: var(--accent); white-space: nowrap; }
        .last-updated { font-size: 0.6rem; color: var(--text-m); font-weight: normal; margin-left: 10px; opacity: 0.7; }
        .theme-btn { background: none; border: none; font-size: 1.2rem; cursor: pointer; }
        .btn-s { background: var(--border); border: none; color: var(--text); padding: 6px 12px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; }
        .btn-xs { background: var(--accent); color: #fff; border: none; padding: 4px 10px; border-radius: 4px; font-size: 0.75rem; font-weight: bold; cursor: pointer; }
        .btn-primary { width: 100%; background: var(--accent); color: #fff; border: none; padding: 14px; border-radius: 8px; font-weight: bold; margin-top: 15px; cursor: pointer; }
        .content-grid { flex: 1; display: grid; grid-template-columns: 320px 1fr 300px; overflow: hidden; }
        .panel { display: flex; flex-direction: column; border-right: 1px solid var(--border); background: var(--p-bg); overflow: hidden; }
        .panel-head { padding: 20px; display: flex; justify-content: space-between; align-items: center; }
        h2 { font-size: 0.7rem; color: var(--text-m); letter-spacing: 1px; margin: 0; }
        .library-section { display: flex; flex-direction: column; height: 100%; overflow: hidden; border-right: 1px solid var(--border); position: relative; transition: 0.2s; }
        .library-section.drag-active { background: rgba(168, 85, 247, 0.05); outline: 2px dashed var(--accent); outline-offset: -10px; }
        .section-head-row { padding: 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); }
        .p-btn { width: 45px; height: 45px; border-radius: 50%; background: var(--accent); border: none; font-size: 1rem; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #fff; position: relative; }
        .p-btn.buffering { background: var(--border); color: var(--text-m); cursor: wait; }
        .loader-s { width: 20px; height: 20px; border: 2px solid var(--accent); border-bottom-color: transparent; border-radius: 50%; display: inline-block; animation: rotation 1s linear infinite; }
        @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .uploading-indicator { padding: 20px; display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 0.8rem; color: var(--accent); background: rgba(168, 85, 247, 0.1); border-radius: 8px; margin: 10px; border: 1px dashed var(--accent); }
        .library-loading { padding: 30px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 15px; font-size: 0.85rem; color: var(--text-m); border-bottom: 1px solid var(--border); }
        .library-loading .loader-s { width: 24px; height: 24px; }
        .p-info { flex: 1; display: flex; flex-direction: column; gap: 5px; }
        .add-icon-btn:hover { background: var(--accent); color: #000; }
        .drag-overlay { position: absolute; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; font-size: 0.9rem; color: var(--accent); pointer-events: none; z-index: 10; font-weight: bold; }
        .track-list { flex: 1; overflow-y: auto; padding: 10px; }
        .library-item { padding: 10px 12px; border-radius: 6px; cursor: pointer; font-size: 0.85rem; display: flex; justify-content: space-between; align-items: center; }
        .library-item:hover { background: var(--hover); }
        .active { background: var(--hover); color: var(--accent); }
        .item-meta { display: flex; justify-content: space-between; width: 100%; align-items: center; }
        .track-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
        .del-btn { background: none; border: none; color: var(--text-m); font-size: 1.2rem; cursor: pointer; margin-left:10px;}
        .del-btn:hover { color: #f00; }
        .upload-label { padding: 15px; border-top: 1px solid var(--border); text-align: center; cursor: pointer; font-size: 0.8rem; display: flex; justify-content: center; align-items: center; gap: 10px; color: var(--text-m); }
        .upload-label:hover { color: var(--text); }
        .add-btn { width: 24px; height: 24px; background: var(--border); border-radius: 50%; display: flex; align-items: center; justify-content: center; }
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
        .fx-range { -webkit-appearance: none; width: 100%; height: 6px; background: var(--border); border-radius: 3px; outline: none; margin: 10px 0; }
        .fx-range::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; background: var(--accent); border-radius: 50%; border: 3px solid #fff; cursor: pointer; box-shadow: 0 2px 5px rgba(0,0,0,0.3); }
        .pre-box { padding: 0 20px 20px; flex: 1; overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
        .preset-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 10px 0 160px; }
        .preset-item { padding: 12px 16px; background: var(--hover); border: 1px solid var(--border); border-radius: 8px; color: var(--text); font-size: 0.85rem; cursor: pointer; display: flex; justify-content: space-between; align-items: center; transition: 0.2s; }
        .preset-item:hover { border-color: var(--accent); background: rgba(168, 85, 247, 0.05); }
        .preset-item.active-preset { border-color: var(--accent); background: rgba(168, 85, 247, 0.15); box-shadow: 0 0 10px rgba(168, 85, 247, 0.2); }
        .active-preset .preset-name { color: var(--accent); font-weight: bold; }
        .p-del-btn { background: none; border: none; color: var(--text-m); font-size: 1.2rem; cursor: pointer; padding: 0 5px; }
        .p-del-btn:hover { color: #f00; }
        .m-panel { padding: 20px; }
        .m-field { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
        .m-row { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; }
        .m-row b { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .mobile-only { display: none; }
        .mobile-eq-hint { padding: 20px; text-align: center; color: var(--text-m); font-size: 0.75rem; line-height: 1.6; }
        .player { position: fixed; bottom: 20px; left: 20px; right: 20px; z-index: 2000; padding: 15px 25px; background: var(--player); backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); border: 1px solid var(--border); border-radius: 20px; display: flex; align-items: center; gap: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.4); }
        .mobile-nav { display: none; }
        .left-sidebar { display: flex; flex-direction: column; background: var(--p-bg); border-right: 1px solid var(--border); overflow: hidden; }

        @media (max-width: 768px) {
          .pc-only { display: none; }
          .mobile-only { display: block; }
          .fx-grid { grid-template-columns: 1fr; gap: 15px; padding: 15px; }
          .fx-box.full-width { grid-column: 1; }
          .fx-range { height: 10px; }
          .fx-range::-webkit-slider-thumb { width: 28px; height: 28px; }
          .content-grid { grid-template-columns: 1fr; flex: 1; overflow: hidden; }
          .left-sidebar, .panel { height: 100%; overflow: hidden; display: flex; flex-direction: column; }
          .left-sidebar.show-mobile { width: 100%; border-right: none; }
          .hide-mobile { display: none; }
          .show-mobile { display: flex; flex-direction: column; width: 100%; }
          .player { bottom: 75px; left: 0; right: 0; border-radius: 24px 24px 0 0; border: none; border-top: 1px solid var(--border); padding: 15px 20px 20px; box-shadow: 0 -10px 30px rgba(0,0,0,0.5); }
          .p-btn { width: 45px; height: 45px; font-size: 1.1rem; }
          .p-bar { height: 5px; }
          .p-bar::-webkit-slider-thumb { width: 14px; height: 14px; }
          .mobile-nav { display: flex; position: fixed; bottom: 0; left: 0; right: 0; height: 75px; background: var(--p-bg); border-top: 1px solid var(--border); z-index: 2001; padding-bottom: env(safe-area-inset-bottom); }
          .nav-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; background: none; border: none; color: var(--text-m); gap: 4px; transition: 0.2s; }
          .nav-item.active { color: var(--accent); }
          .nav-icon { font-size: 1.2rem; }
          .nav-label { font-size: 0.65rem; font-weight: bold; }
        }
      `}</style>
    </main >
  );
}
