"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  playBuffer,
  stop,
  setEqGain,
  setReverbWet,
  setReverbDry,
  setVolume,
  setEchoDelay,
  setEchoFeedback,
  setEchoWet,
  setEchoDry,
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
  file?: File | Blob; // Keep raw data for re-analysis or delayed decoding
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
  const [echoDelay, setEchoDelayState] = useState(0.3);
  const [echoFeedback, setEchoFeedbackState] = useState(0.3);
  const [echoWet, setEchoWetState] = useState(0.0);
  const [echoDry, setEchoDryState] = useState(1.0);
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

  // New Playlist & Control states
  const [repeatMode, setRepeatMode] = useState<'none' | 'all' | 'one'>('none');
  const [isShuffle, setIsShuffle] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string>("");
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const requestRef = useRef<number | null>(null);
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const pendingChangesRef = useRef<Partial<Preset>>({});
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

  // Load settings on mount
  useEffect(() => {
    const savedSettings = localStorage.getItem("eq-lab-settings");
    if (savedSettings) {
      try {
        const s = JSON.parse(savedSettings);
        if (s.eqGains) setEqGains(s.eqGains);
        if (s.reverbDry !== undefined) setRevDry(s.reverbDry);
        if (s.reverbWet !== undefined) setRevWet(s.reverbWet);
        if (s.echoDelay !== undefined) setEchoDelayState(s.echoDelay);
        if (s.echoFeedback !== undefined) setEchoFeedbackState(s.echoFeedback);
        if (s.echoWet !== undefined) setEchoWetState(s.echoWet);
        if (s.echoDry !== undefined) setEchoDryState(s.echoDry);
        if (s.volume !== undefined) setGlobalVolume(s.volume);
        if (s.activePresetId) setActivePresetId(s.activePresetId);
        if (s.currentTrackId) {
          db.tracks.get(Number(s.currentTrackId)).then((t: any) => {
            if (t) setCurrentTrack({ id: t.id.toString(), name: t.name });
          });
        }
      } catch (e) {
        console.error("Failed to parse saved settings", e);
      }
    }
    syncLibrary();
  }, []);

  // Update engine whenever basic FX state changes
  useEffect(() => {
    setEqGain(0, eqGains[0]); // Ensure init
    eqGains.forEach((g, i) => setEqGain(i, g));
    setReverbDry(reverbDry);
    setReverbWet(reverbWet);
    setEchoDelay(echoDelay);
    setEchoFeedback(echoFeedback);
    setEchoWet(echoWet);
    setEchoDry(echoDry);
    setVolume(volume);
  }, [eqGains, reverbDry, reverbWet, echoDelay, echoFeedback, echoWet, echoDry, volume]);

  // syncLibrary function
  const syncLibrary = async () => {
    console.log("Starting local library sync...");
    setIsLoadingLibrary(true);
    try {
      const localTracks = await db.tracks.toArray();
      const formattedLocalTracks: Track[] = localTracks.map((t: any) => ({
        id: t.id!.toString(),
        name: t.name,
      }));
      setLibrary(formattedLocalTracks);

      const localPresets = await db.presets.toArray();
      const formattedPresets: Preset[] = [
        ...defaultPresets,
        ...localPresets.map((p: any) => ({
          id: p.id!.toString(),
          name: p.name,
          eqGains: p.eqGains || new Array(10).fill(0),
          reverbDry: p.reverbDry ?? 1.0,
          reverbWet: p.reverbWet ?? 0,
          echoDelay: p.echoDelay ?? 0.3,
          echoFeedback: p.echoFeedback ?? 0.3,
          echoWet: p.echoWet ?? 0,
          echoDry: p.echoDry ?? 1.0,
          volume: p.volume ?? 0.5
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
        setIsPlaying(playing);
      },
      onSeekTo: (time) => {
        handleManualSeek(time);
      },
      onTrackEnd: () => {
        playNextTrack();
      }
    });

    if ('mediaSession' in navigator) {
      navigator.mediaSession.setActionHandler('previoustrack', () => playPreviousTrack());
      navigator.mediaSession.setActionHandler('nexttrack', () => playNextTrack());
    }
  }, [library, isShuffle, repeatMode]);

  // Update Media Metadata when track changes
  useEffect(() => {
    if (currentTrack) {
      updateMediaMetadata(currentTrack.name);
    }
  }, [currentTrack]);

  // No longer needed here as it's handled in the main sync effect or can be unified.
  // Removal of redundant preset fetch effect.

  // Persistence Effect for Settings
  useEffect(() => {
    const settings = {
      eqGains,
      reverbDry,
      reverbWet,
      echoDelay,
      echoFeedback,
      echoWet,
      echoDry,
      volume,
      activePresetId,
      currentTrackId: currentTrack?.id
    };
    localStorage.setItem("eq-lab-settings", JSON.stringify(settings));
  }, [eqGains, reverbDry, reverbWet, echoDelay, echoFeedback, echoWet, echoDry, volume, activePresetId, currentTrack?.id]);

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
        buffer: buffer,
        file: file
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

  const handleTrackSelect = async (track: Track, shouldPlay = true) => {
    await initContext();
    setCurrentTrack(track);
    setProgress(0);
    const source = await prepareTrackSource(track);
    if (source?.buffer) {
      setDuration(source.buffer.duration);
      const updatedTrack = { ...track, buffer: source.buffer };
      setCurrentTrack(updatedTrack);
      if (shouldPlay) {
        playBuffer(source.buffer, 0, volume, eqGains, reverbDry, reverbWet);
        setIsPlaying(true);
      }
      setLibrary((prev: Track[]) => prev.map((t: Track) => t.id === track.id ? updatedTrack : t));
    } else if (source?.url) {
      setCurrentTrack(track);
      if (shouldPlay) {
        playStream(source.url, 0, volume, eqGains, reverbDry, reverbWet);
        setIsPlaying(true);
      }
    }
  };

  const playNextTrack = () => {
    if (library.length === 0) return;
    if (repeatMode === "one" && currentTrack) {
      handleManualSeek(0);
      return;
    }

    const currentIndex = library.findIndex((t: Track) => t.id === currentTrack?.id);
    let nextIndex = 0;

    if (isShuffle) {
      nextIndex = Math.floor(Math.random() * library.length);
      if (nextIndex === currentIndex && library.length > 1) {
        nextIndex = (nextIndex + 1) % library.length;
      }
    } else {
      nextIndex = currentIndex + 1;
      if (nextIndex >= library.length) {
        if (repeatMode === "all") nextIndex = 0;
        else return; // Stop at end
      }
    }
    handleTrackSelect(library[nextIndex], isPlaying);
  };

  const playPreviousTrack = () => {
    if (library.length === 0) return;
    const currentIndex = library.findIndex((t: Track) => t.id === currentTrack?.id);
    let nextIndex = 0;

    if (isShuffle) {
      nextIndex = Math.floor(Math.random() * library.length);
    } else {
      nextIndex = currentIndex - 1;
      if (nextIndex < 0) {
        if (repeatMode === "all") nextIndex = library.length - 1;
        else nextIndex = 0;
      }
    }
    handleTrackSelect(library[nextIndex], isPlaying);
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
    setEqGains([...(p.eqGains || new Array(10).fill(0))]);
    setRevDry(p.reverbDry ?? 1.0);
    setRevWet(p.reverbWet ?? 0);
    setEchoDelayState(p.echoDelay ?? 0.3);
    setEchoFeedbackState(p.echoFeedback ?? 0.3);
    setEchoWetState(p.echoWet ?? 0);
    setEchoDryState(p.echoDry ?? 1.0);
    setGlobalVolume(p.volume ?? 0.5);

    // Engine update is handled by useEffect
  };

  const updateActivePreset = (updatedFields: Partial<Preset>) => {
    if (!activePresetId) return;

    const DEFAULT_IDS = ['flat', 'concert-hall', 'rock', 'pop', 'jazz', 'classical'];
    const isCustom = !DEFAULT_IDS.includes(activePresetId);

    // 1. Update local state immediately
    setPresets((prev: Preset[]) => prev.map((p: Preset) => {
      if (p.id === activePresetId) {
        return { ...p, ...updatedFields };
      }
      return p;
    }));

    // 2. Debounce local DB update for custom presets
    if (isCustom) {
      pendingChangesRef.current = { ...pendingChangesRef.current, ...updatedFields };

      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = setTimeout(async () => {
        const changes = { ...pendingChangesRef.current };
        pendingChangesRef.current = {};

        console.log("Syncing preset to local DB...", activePresetId, changes);
        try {
          await db.presets.update(Number(activePresetId), changes);
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
    const DEFAULT_IDS = ['flat', 'concert-hall', 'rock', 'pop', 'jazz', 'classical'];
    const isCustom = activePresetId && !DEFAULT_IDS.includes(activePresetId);
    let name = "";
    let updateExisting = false;

    if (isCustom) {
      const activePreset = presets.find(p => p.id === activePresetId);
      const choice = confirm(`現在のプリセット「${activePreset?.name}」を変更内容で上書きしますか？\n(キャンセルで新規別名保存)`);
      if (choice) {
        updateExisting = true;
        name = activePreset?.name || "My Preset";
      }
    }

    if (!updateExisting) {
      const input = prompt("プリセットの名前を入力してください", "My Preset");
      if (!input) return;
      name = input;
    }

    try {
      if (updateExisting && activePresetId) {
        const changes = {
          name,
          eqGains: [...eqGains],
          reverbDry,
          reverbWet,
          echoDelay,
          echoFeedback,
          echoWet,
          echoDry,
          volume
        };
        await db.presets.update(Number(activePresetId), changes);
        setPresets((prev: Preset[]) => prev.map((p: Preset) => p.id === activePresetId ? { ...p, ...changes } : p));
        alert("プリセットを上書き保存しました。");
      } else {
        const id = await db.presets.add({
          name,
          eqGains: [...eqGains],
          reverbDry,
          reverbWet,
          echoDelay,
          echoFeedback,
          echoWet,
          echoDry,
          volume,
          createdAt: Date.now()
        });

        const newPreset: Preset = { id: id.toString(), name, eqGains: [...eqGains], reverbDry, reverbWet, echoDelay, echoFeedback, echoWet, echoDry, volume };
        setPresets((v: Preset[]) => [...v, newPreset]);
        applyPreset(newPreset);
        alert("新しいプリセットとして保存しました。");
      }
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

      let sBuffer = sTrack.buffer;
      if (!sBuffer) {
        const sNumericId = Number(sTrack.id);
        if (!isNaN(sNumericId)) {
          const sLocal = await db.tracks.get(sNumericId);
          if (sLocal) sBuffer = await loadBufferForAnalysis(sLocal.data);
        } else if (sTrack.file) {
          sBuffer = await loadBufferForAnalysis(sTrack.file);
        }
      }

      if (!sBuffer) throw new Error("ソース楽曲の読み込みに失敗しました。以前の楽曲データが失われている可能性があります。もう一度ファイルを選択してください。");
      sSpec = await getSpectrum(sBuffer);
      console.log("Source Spectrum Analysis Complete.");

      await new Promise(r => setTimeout(r, 600));

      // 2. Analyze Target Track
      let tSpec: number[] | null = null;
      console.log("Analyzing Target Track...");

      let tBuffer = targetTrack.buffer;
      if (!tBuffer) {
        const tNumericId = Number(targetTrack.id);
        if (!isNaN(tNumericId)) {
          const tLocal = await db.tracks.get(tNumericId);
          if (tLocal) tBuffer = await loadBufferForAnalysis(tLocal.data);
        } else if (targetTrack.file) {
          tBuffer = await loadBufferForAnalysis(targetTrack.file);
        }
      }

      if (!tBuffer) throw new Error("ターゲット音源の読み込みに失敗しました。もう一度ファイルを選択してください。");
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
        echoDelay,
        echoFeedback,
        echoWet,
        echoDry,
        volume,
        createdAt: Date.now()
      });

      const newPreset: Preset = {
        id: id.toString(),
        name,
        eqGains: [...gains],
        reverbDry,
        reverbWet,
        echoDelay,
        echoFeedback,
        echoWet,
        echoDry,
        volume
      };

      setPresets(v => [...v, newPreset]);
      applyPreset(newPreset);
      alert(`Matched preset "${name}" saved!`);
    } catch (err) {
      console.error("Match save failed:", err);
      alert("プリセットの保存に失敗しました。設定は現在のEQに適用されています。");
    }
  };

  // Visualizer Ref
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const expandedCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!isPlaying) return;

    const canvas = canvasRef.current;
    const expandedCanvas = expandedCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    const eCtx = expandedCanvas?.getContext("2d");

    let animId: number;
    const render = () => {
      const visData = getVisualizerData();

      if (ctx && canvas) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const barWidth = (canvas.width / visData.length) * 2.5;
        let x = 0;
        for (let i = 0; i < visData.length; i++) {
          const barHeight = (visData[i] / 255) * canvas.height;
          ctx.fillStyle = `rgba(139, 92, 246, ${visData[i] / 255})`;
          ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
          x += barWidth + 1;
        }
      }

      if (eCtx && expandedCanvas) {
        eCtx.clearRect(0, 0, expandedCanvas.width, expandedCanvas.height);
        const barWidth = (expandedCanvas.width / visData.length) * 2.5;
        let x = 0;
        for (let i = 0; i < visData.length; i++) {
          const barHeight = (visData[i] / 255) * expandedCanvas.height;
          eCtx.fillStyle = `rgba(255, 255, 255, ${visData[i] / 512})`;
          eCtx.fillRect(x, expandedCanvas.height - barHeight, barWidth, barHeight);
          x += barWidth + 1;
        }
      }
      animId = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, isExpanded]);

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
                onClick={() => handleTrackSelect(track, isPlaying)}
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
                    <input type="range" min="-12" max="12" step="0.1" value={eqGains[i] || 0} onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleEqChange(i, parseFloat(e.target.value))} />
                  </div>
                  <div className="freq-label">{freq < 1000 ? freq : `${freq / 1000}k`}</div>
                </div>
              ))}
            </div>

            <div className="fx-grid-premium">
              <div className="fx-section">
                <div className="section-header">
                  <span>Reverb</span>
                  <div className="fx-toggle-placeholder"></div>
                </div>
                <div className="fx-controls">
                  <div className="fx-item">
                    <label>DRY</label>
                    <input type="range" min="0" max="1" step="0.01" value={reverbDry} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setRevDry(parseFloat(e.target.value));
                      updateActivePreset({ reverbDry: parseFloat(e.target.value) });
                    }} />
                  </div>
                  <div className="fx-item">
                    <label>WET</label>
                    <input type="range" min="0" max="1" step="0.01" value={reverbWet} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setRevWet(parseFloat(e.target.value));
                      updateActivePreset({ reverbWet: parseFloat(e.target.value) });
                    }} />
                  </div>
                </div>
              </div>

              <div className="fx-section">
                <div className="section-header">
                  <span>Echo (Delay)</span>
                </div>
                <div className="fx-controls">
                  <div className="fx-item">
                    <label>TIME</label>
                    <input type="range" min="0" max="2" step="0.001" value={echoDelay} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setEchoDelayState(parseFloat(e.target.value));
                      updateActivePreset({ echoDelay: parseFloat(e.target.value) });
                    }} />
                  </div>
                  <div className="fx-item">
                    <label>FEEDBACK</label>
                    <input type="range" min="0" max="1" step="0.01" value={echoFeedback} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setEchoFeedbackState(parseFloat(e.target.value));
                      updateActivePreset({ echoFeedback: parseFloat(e.target.value) });
                    }} />
                  </div>
                  <div className="fx-item">
                    <label>DRY</label>
                    <input type="range" min="0" max="1" step="0.01" value={echoDry} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setEchoDryState(parseFloat(e.target.value));
                      updateActivePreset({ echoDry: parseFloat(e.target.value) });
                    }} />
                  </div>
                  <div className="fx-item">
                    <label>WET</label>
                    <input type="range" min="0" max="1" step="0.01" value={echoWet} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setEchoWetState(parseFloat(e.target.value));
                      updateActivePreset({ echoWet: parseFloat(e.target.value) });
                    }} />
                  </div>
                </div>
              </div>

              <div className="fx-section">
                <div className="section-header">
                  <span>Output</span>
                </div>
                <div className="fx-controls">
                  <div className="fx-item">
                    <label>GAIN</label>
                    <input type="range" min="0" max="1.5" step="0.01" value={volume} onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                      setGlobalVolume(parseFloat(e.target.value));
                      updateActivePreset({ volume: parseFloat(e.target.value) });
                    }} />
                  </div>
                </div>
              </div>
            </div>

            <div style={{ marginTop: 24 }}>
              <h3 className="section-title" style={{ marginBottom: 16 }}>Presets</h3>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {presets.map((p: Preset) => (
                  <div key={p.id} onClick={() => applyPreset(p)} className={`preset-item ${activePresetId === p.id ? "active-preset" : ""}`} style={{ padding: 12, borderRadius: 12, border: "1px solid var(--border)", cursor: "pointer", background: activePresetId === p.id ? "rgba(139, 92, 246, 0.1)" : "var(--hover)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "0.85rem", fontWeight: activePresetId === p.id ? 600 : 400 }}>{p.name}</span>
                    {(p.id !== 'flat' && p.id !== 'concert-hall') && (
                      <button onClick={(e: React.MouseEvent) => deletePreset(p.id, e)} style={{ background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}>×</button>
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
                  Pick <input type="file" accept="audio/*,audio/x-caf,audio/caf,audio/x-m4a,audio/mp3,audio/wav,.caf,.mp3,.wav,.m4a" hidden onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleFileUpload(e, "target")} />
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

      <footer className="player-bar" onClick={(e: React.MouseEvent) => {
        if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'BUTTON') return;
        setIsExpanded(true);
      }}>
        <div className="pc-only" style={{ display: "flex", gap: 8 }}>
          <button className="control-icon" onClick={(e: React.MouseEvent) => { e.stopPropagation(); setIsShuffle(!isShuffle); }} style={{ color: isShuffle ? "var(--accent)" : "inherit" }}>🔀</button>
          <button className="control-icon" onClick={(e: React.MouseEvent) => { e.stopPropagation(); playPreviousTrack(); }}>⏮</button>
        </div>

        <button onClick={(e: React.MouseEvent) => { e.stopPropagation(); togglePlay(); }} className={`play-btn ${isBuffering ? "buffering" : ""}`} disabled={isBuffering}>
          {isBuffering ? "..." : (isPlaying ? "Ⅱ" : "▶")}
        </button>

        <div className="pc-only" style={{ display: "flex", gap: 8 }}>
          <button className="control-icon" onClick={(e: React.MouseEvent) => { e.stopPropagation(); playNextTrack(); }}>⏭</button>
          <button className="control-icon" onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            setRepeatMode((curr: string) => curr === 'none' ? 'all' : curr === 'all' ? 'one' : 'none');
          }} style={{ color: repeatMode !== 'none' ? "var(--accent)" : "inherit" }}>
            {repeatMode === 'one' ? '🔂' : '🔁'}
          </button>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <div style={{ overflow: "hidden", cursor: "pointer" }}>
              <div style={{ fontWeight: 700, fontSize: "0.95rem", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{currentTrack?.name || "No track selected"}</div>
              <div style={{ fontSize: "0.7rem", color: "var(--text-dim)" }}>{isBuffering ? "Decoding..." : (isPlaying ? "Playing" : "Ready")}</div>
            </div>
            <div style={{ fontSize: "0.8rem", fontFamily: "monospace", color: "var(--text-dim)" }}>
              {formatTime(progress)} / {formatTime(duration)}
            </div>
          </div>
          <input
            type="range" min="0" max={duration || 1} step="0.01" value={progress}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            onInput={(e: React.FormEvent<HTMLInputElement>) => { setIsDragging(true); setProgress(parseFloat(e.currentTarget.value)); }}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setIsDragging(false); handleManualSeek(parseFloat(e.target.value)); }}
            style={{ width: "100%", cursor: "pointer" }}
          />
        </div>
      </footer>

      {isExpanded && (
        <div className="expanded-player">
          <div className="expanded-header">
            <button className="close-btn" onClick={() => setIsExpanded(false)}>↓</button>
            <div className="expanded-subtitle">NOW PLAYING</div>
            <button className="close-btn" onClick={() => setIsExpanded(false)} style={{ opacity: 0 }}>↓</button>
          </div>

          <div className="expanded-art">
            <div style={{ fontSize: "5rem" }}>🎵</div>
            <canvas ref={expandedCanvasRef} width="400" height="400" style={{ position: "absolute", inset: 0, opacity: 0.6 }} />
          </div>

          <div className="expanded-info">
            <h2 className="expanded-title">{currentTrack?.name || "No Track"}</h2>
            <p className="expanded-subtitle">EQ LAB PREMIUM PLAYER</p>
          </div>

          <div className="expanded-controls">
            <div style={{ marginBottom: 32 }}>
              <input
                type="range" min="0" max={duration || 1} step="0.01" value={progress}
                onInput={(e: React.FormEvent<HTMLInputElement>) => { setIsDragging(true); setProgress(parseFloat(e.currentTarget.value)); }}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => { setIsDragging(false); handleManualSeek(parseFloat(e.target.value)); }}
                style={{ width: "100%", height: 6, borderRadius: 3, background: "var(--border)" }}
              />
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: "0.85rem", color: "var(--text-dim)" }}>
                <span>{formatTime(progress)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>

            <div className="expanded-main-controls">
              <button className="control-icon" style={{ fontSize: "1.5rem", color: isShuffle ? "var(--accent)" : "inherit" }} onClick={() => setIsShuffle(!isShuffle)}>🔀</button>
              <button className="expanded-prev-next" onClick={playPreviousTrack}>⏮</button>
              <button className="expanded-play-btn" onClick={togglePlay}>
                {isPlaying ? "Ⅱ" : "▶"}
              </button>
              <button className="expanded-prev-next" onClick={playNextTrack}>⏭</button>
              <button className="control-icon" style={{ fontSize: "1.5rem", color: repeatMode !== 'none' ? "var(--accent)" : "inherit" }} onClick={() => setRepeatMode((curr: string) => curr === 'none' ? 'all' : curr === 'all' ? 'one' : 'none')}>
                {repeatMode === 'one' ? '🔂' : '🔁'}
              </button>
            </div>
          </div>

          <div className="playlist-drawer">
            <div className="playlist-header">
              <h3 style={{ fontSize: "1.1rem" }}>Next in Line</h3>
              <span style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>{library.length} tracks</span>
            </div>
            {library.map((t: Track) => (
              <div key={t.id} onClick={() => handleTrackSelect(t, true)} className={`track-item ${currentTrack?.id === t.id ? "active" : ""}`}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 32, height: 32, background: "var(--glass)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.8rem" }}>{currentTrack?.id === t.id ? "▶" : "🎵"}</div>
                  <div style={{ fontWeight: 500 }}>{t.name}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

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
