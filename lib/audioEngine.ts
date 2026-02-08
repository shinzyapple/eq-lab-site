export const EQ_FREQUENCIES = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000
];

let audioContext: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let filters: BiquadFilterNode[] = [];
let reverbNode: ConvolverNode | null = null;
let reverbWetGain: GainNode | null = null;
let reverbDryGain: GainNode | null = null;
let mainGainNode: GainNode | null = null;
let analyzerNode: AnalyserNode | null = null;
let streamDest: MediaStreamAudioDestinationNode | null = null;
let proxyAudio: HTMLAudioElement | null = null;
let mediaElement: HTMLAudioElement | null = null;
let mediaSourceNode: MediaElementAudioSourceNode | null = null;
let onPlaybackChange: ((playing: boolean) => void) | null = null;
let onSeekTo: ((time: number) => void) | null = null;

export function setAudioEngineCallbacks(callbacks: {
  onPlaybackChange?: (playing: boolean) => void;
  onSeekTo?: (time: number) => void;
}) {
  if (callbacks.onPlaybackChange) onPlaybackChange = callbacks.onPlaybackChange;
  if (callbacks.onSeekTo) onSeekTo = callbacks.onSeekTo;
}

let currentBuffer: AudioBuffer | null = null;
let startTime = 0;
let offsetTime = 0;
let isPlayingInternal = false;
let stopTimeout: NodeJS.Timeout | null = null;
let lastTitle = 'Unknown Track';
let lastArtist = 'EQ LAB';
let lastAlbum = 'Audio Library';
let playbackMode: 'buffer' | 'stream' | 'none' = 'none';

function createImpulseResponse(context: AudioContext, duration: number, decay: number) {
  const sampleRate = context.sampleRate;
  const length = sampleRate * duration;
  const impulse = context.createBuffer(2, length, sampleRate);

  for (let channel = 0; channel < 2; channel++) {
    const channelData = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      channelData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

export async function initContext() {
  if (typeof window === "undefined") return null;
  console.log("initContext called, current state:", audioContext?.state);
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    console.log("AudioContext created");

    // Create a proxy audio element to keep playback alive in background
    streamDest = audioContext.createMediaStreamDestination();
    proxyAudio = new Audio();
    proxyAudio.srcObject = streamDest.stream;
    proxyAudio.setAttribute("playsinline", "true");
    proxyAudio.muted = false; // iOS requirement for lock screen

    analyzerNode = audioContext.createAnalyser();
    analyzerNode.fftSize = 256;

    // Create the hidden media element for streaming
    mediaElement = new Audio();
    mediaElement.crossOrigin = "anonymous";
    mediaElement.setAttribute("playsinline", "true");
    mediaSourceNode = audioContext.createMediaElementSource(mediaElement);

    // Prime the proxy audio immediately with a play attempt
    proxyAudio.play().catch(e => console.log("Initial proxy priming:", e));

    // Resume context on first user interaction if it starts suspended
    if (audioContext.state === "suspended") {
      audioContext.resume();
    }
  } else if (audioContext.state === "suspended") {
    console.log("Resuming suspended context");
    await audioContext.resume();
  }
  return audioContext;
}

export function suspendContext() {
  if (audioContext && audioContext.state === "running") {
    audioContext.suspend();
  }
}

export function resumeContext() {
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume();
  }
}

export async function loadAudio(urlOrFile: string | File | Blob): Promise<AudioBuffer> {
  const ctx = await initContext();
  if (!ctx) throw new Error("AudioContext not initialized");

  let arrayBuffer: ArrayBuffer;

  try {
    if (typeof urlOrFile === "string") {
      console.log(`Loading audio from URL: ${urlOrFile}`);
      const res = await fetch(urlOrFile);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      arrayBuffer = await res.arrayBuffer();
    } else if (urlOrFile instanceof Blob) {
      console.log(`Loading audio from Blob/File: size ${urlOrFile.size} bytes`);
      arrayBuffer = await urlOrFile.arrayBuffer();
    } else {
      throw new Error("Unsupported audio source type");
    }

    console.log(`ArrayBuffer obtained: ${arrayBuffer.byteLength} bytes. Starting decode...`);
    if (arrayBuffer.byteLength === 0) throw new Error("File is empty (0 bytes)");

    return await new Promise<AudioBuffer>((resolve, reject) => {
      try {
        const decodePromise = ctx.decodeAudioData(
          arrayBuffer,
          (decoded) => {
            console.log("Audio decoded successfully", { duration: decoded.duration, channels: decoded.numberOfChannels });
            resolve(decoded);
          },
          (err) => {
            console.error("decodeAudioData callback error:", err);
            reject(err);
          }
        );

        // Handle case where decodeAudioData returns a promise (newer browsers)
        if (decodePromise && typeof decodePromise.catch === 'function') {
          decodePromise.catch(e => {
            console.error("decodeAudioData promise error:", e);
            reject(e);
          });
        }
      } catch (e) {
        console.error("Synchronous decodeAudioData error:", e);
        reject(e);
      }
    });
  } catch (err) {
    console.error("loadAudio unexpected error:", err);
    if (typeof urlOrFile !== "string") {
      throw err;
    }
    return createSampleBuffer(ctx);
  }
}

export function createSampleBuffer(context: AudioContext): AudioBuffer {
  console.log("Creating fallback sample buffer (Sine 440Hz)");
  const duration = 2.0;
  const sampleRate = context.sampleRate;
  const buffer = context.createBuffer(1, sampleRate * duration, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    // 440Hz Sine with fade out
    data[i] = Math.sin(2 * Math.PI * 440 * i / sampleRate) * Math.exp(-i / (sampleRate * 0.5));
  }
  return buffer;
}

export function playBuffer(
  buffer: AudioBuffer,
  startAt = 0,
  volume = 0.5,
  eqGains: number[],
  reverbDry = 1.0,
  reverbWet = 0.2
) {
  if (!audioContext) {
    console.error("playBuffer failed: AudioContext not initialized");
    return;
  }

  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }

  immediateStop();

  currentBuffer = buffer;
  offsetTime = startAt;
  startTime = audioContext.currentTime;

  source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.loop = false;

  // Re-create EQ Chain
  filters = [];
  let current: AudioNode = source;
  EQ_FREQUENCIES.forEach((freq, i) => {
    const filter = audioContext!.createBiquadFilter();
    filter.type = "peaking";
    filter.frequency.value = freq;
    filter.Q.value = 1.4;
    filter.gain.value = eqGains[i] || 0;
    current.connect(filter);
    filters.push(filter);
    current = filter;
  });

  reverbDryGain = audioContext.createGain();
  reverbDryGain.gain.setTargetAtTime(reverbDry, audioContext.currentTime, 0.01);

  reverbNode = audioContext.createConvolver();
  reverbNode.buffer = createImpulseResponse(audioContext, 2, 2);
  reverbWetGain = audioContext.createGain();
  reverbWetGain.gain.setTargetAtTime(reverbWet, audioContext.currentTime, 0.01);

  mainGainNode = audioContext.createGain();
  mainGainNode.gain.setTargetAtTime(volume, audioContext.currentTime, 0.01);

  current.connect(reverbDryGain);
  current.connect(reverbNode);
  reverbNode.connect(reverbWetGain);

  reverbDryGain.connect(mainGainNode);
  reverbWetGain.connect(mainGainNode);

  mainGainNode.connect(analyzerNode!);

  // PIPE OUTPUT
  if (streamDest) {
    analyzerNode!.connect(streamDest);
  } else {
    analyzerNode!.connect(audioContext.destination);
  }

  if (proxyAudio) {
    proxyAudio.play().catch(e => console.log("Proxy play error:", e));
  }

  source.start(0, startAt);
  isPlayingInternal = true;
  playbackMode = 'buffer';

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
    updateMediaMetadata(lastTitle || 'Unknown Track');
    updateMediaPositionState();
  }

  source.onended = () => {
    if (!source) return;
    isPlayingInternal = false;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }
  };
}

export function playStream(
  url: string,
  startAt = 0,
  volume = 0.5,
  eqGains: number[],
  reverbDry = 1.0,
  reverbWet = 0.2
) {
  if (!audioContext || !mediaElement || !mediaSourceNode) {
    console.error("playStream failed: Engine not ready");
    return;
  }

  stop();
  currentBuffer = null;
  offsetTime = startAt;

  // Setup Graph Connection
  filters = [];
  let current: AudioNode = mediaSourceNode;
  EQ_FREQUENCIES.forEach((freq, i) => {
    const filter = audioContext!.createBiquadFilter();
    filter.type = "peaking";
    filter.frequency.value = freq;
    filter.Q.value = 1.4;
    filter.gain.value = eqGains[i] || 0;
    current.connect(filter);
    filters.push(filter);
    current = filter;
  });

  reverbDryGain = audioContext.createGain();
  reverbDryGain.gain.value = reverbDry;
  reverbNode = audioContext.createConvolver();
  try {
    reverbNode.buffer = createImpulseResponse(audioContext, 2, 2);
  } catch (e) { }
  reverbWetGain = audioContext.createGain();
  reverbWetGain.gain.value = reverbWet;
  mainGainNode = audioContext.createGain();
  mainGainNode.gain.value = volume;

  current.connect(reverbDryGain);
  current.connect(reverbNode);
  reverbNode.connect(reverbWetGain);
  reverbDryGain.connect(mainGainNode);
  reverbWetGain.connect(mainGainNode);

  if (streamDest) {
    mainGainNode.connect(streamDest);
  } else {
    mainGainNode.connect(audioContext.destination);
  }

  mediaElement.src = url;
  mediaElement.onloadedmetadata = () => {
    console.log("Stream metadata loaded. Duration:", mediaElement?.duration);
    if (mediaElement) mediaElement.currentTime = startAt;
    updateMediaPositionState();
  };

  mediaElement.play().catch(e => console.error("Stream play failed:", e));

  if (proxyAudio) {
    proxyAudio.play().catch(e => { });
  }

  isPlayingInternal = true;
  playbackMode = 'stream';

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
    updateMediaMetadata(lastTitle || 'Streaming Track');
    // We update position state again here just in case, but loadedmetadata is more reliable for duration
    updateMediaPositionState();
  }

  mediaElement.onended = () => {
    isPlayingInternal = false;
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }
  };
}

export function updateMediaMetadata(title: string, artist: string = 'EQ LAB', album: string = 'Audio Library', artworkUrl?: string) {
  lastTitle = title;
  lastArtist = artist;
  lastAlbum = album;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: title,
      artist: artist,
      album: album,
      artwork: artworkUrl ? [{ src: artworkUrl, sizes: '512x512', type: 'image/png' }] : [
        { src: '/favicon.ico', sizes: '128x128', type: 'image/x-icon' }
      ]
    });

    updateMediaPositionState();

    // REGISTER HANDLERS EVERY TIME METADATA UPDATES
    navigator.mediaSession.setActionHandler('play', () => {
      console.log("MediaSession: play");
      if (onPlaybackChange) onPlaybackChange(true);
    });
    navigator.mediaSession.setActionHandler('pause', () => {
      console.log("MediaSession: pause");
      if (onPlaybackChange) onPlaybackChange(false);
    });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      console.log("MediaSession: seekto", details.seekTime);
      if (details.seekTime !== undefined && onSeekTo) {
        onSeekTo(details.seekTime);
      }
    });
    navigator.mediaSession.setActionHandler('seekbackward', (details) => {
      const skipTime = details.seekOffset || 10;
      console.log("MediaSession: seekbackward", skipTime);
      if (onSeekTo) onSeekTo(Math.max(0, getCurrentTime() - skipTime));
    });
    navigator.mediaSession.setActionHandler('seekforward', (details) => {
      const skipTime = details.seekOffset || 10;
      console.log("MediaSession: seekforward", skipTime);
      if (onSeekTo) onSeekTo(Math.min(getDuration(), getCurrentTime() + skipTime));
    });
  }
}

export function updateMediaPositionState() {
  if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
    const dur = getDuration();
    const pos = getCurrentTime();
    if (dur > 0 && !isNaN(dur) && !isNaN(pos) && isFinite(dur) && isFinite(pos)) {
      try {
        navigator.mediaSession.setPositionState({
          duration: dur,
          playbackRate: 1,
          position: Math.min(pos, dur)
        });
      } catch (e) {
        console.warn("setPositionState failed:", e);
      }
    }
  }
}

export async function getSpectrum(buffer: AudioBuffer): Promise<number[]> {
  const fftSize = 4096;
  const data = buffer.getChannelData(0);
  const frequenciesCount = EQ_FREQUENCIES.length;
  const spectrum = new Float32Array(frequenciesCount).fill(-100);
  const counts = new Int32Array(frequenciesCount).fill(0);
  const sampleRate = buffer.sampleRate;

  const isMobile = typeof window !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

  // Mobile needs stay well below the 5s watchdog limit.
  // We reduce sample segments to 20 for mobile - still accurate enough for EQ balance.
  const numSamples = Math.min(isMobile ? 20 : 50, Math.floor(buffer.length / fftSize));

  if (numSamples <= 0) return Array.from(spectrum);

  const skip = Math.floor(buffer.length / numSamples);
  const subStep = isMobile ? 64 : 16; // Even lighter sampling for mobile
  const numPoints = Math.ceil(fftSize / subStep);

  console.log(`Analyzing spectrum: ${numSamples} segments, ${subStep} subStep`);

  // Pre-calculate sinusoids
  const sinusoids = EQ_FREQUENCIES.map(f => {
    const angle = (2 * Math.PI * f) / sampleRate;
    const cos = new Float32Array(numPoints);
    const sin = new Float32Array(numPoints);
    for (let p = 0; p < numPoints; p++) {
      cos[p] = Math.cos(angle * p * subStep);
      sin[p] = Math.sin(angle * p * subStep);
    }
    return { cos, sin };
  });

  for (let i = 0; i < numSamples; i++) {
    // Heavy yielding for iOS: use requestAnimationFrame to ensure the main thread stays green
    if (isMobile) {
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 20)));
    } else if (i % 10 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const start = i * skip;
    const maxN = Math.min(fftSize, data.length - start);
    const pointsCount = Math.floor(maxN / subStep);

    if (pointsCount <= 0) continue;

    for (let bandIdx = 0; bandIdx < frequenciesCount; bandIdx++) {
      let real = 0, imag = 0;
      const { cos, sin } = sinusoids[bandIdx];

      for (let p = 0; p < pointsCount; p++) {
        const val = data[start + p * subStep];
        real += val * cos[p];
        imag += val * sin[p];
      }

      const mag = Math.sqrt(real * real + imag * imag) / pointsCount;
      const db = 20 * Math.log10(mag + 1e-9);

      if (counts[bandIdx] === 0) spectrum[bandIdx] = db;
      else spectrum[bandIdx] += db;
      counts[bandIdx]++;
    }
  }

  return Array.from(spectrum.map((val, i) => counts[i] > 0 ? val / counts[i] : -100));
}

export function calculateMatchedGains(sourceSpec: number[], targetSpec: number[]): number[] {
  // Final gains are target - source
  const diff = sourceSpec.map((s, i) => {
    const d = targetSpec[i] - s;
    return isFinite(d) ? d : 0;
  });

  // Calculate average difference to normalize volume
  const validDiffs = diff.filter(d => !isNaN(d));
  const avgDiff = validDiffs.length > 0 ? validDiffs.reduce((a, b) => a + b, 0) / validDiffs.length : 0;

  return diff.map(d => {
    let final = d - avgDiff;
    if (!isFinite(final)) final = 0;
    // Limit to +/- 12dB for stability
    return Math.max(-12, Math.min(12, final));
  });
}

export function getIsPlaying() {
  return isPlayingInternal;
}

export function getCurrentTime() {
  if (!audioContext) return offsetTime;
  if (playbackMode === 'stream' && mediaElement) {
    return mediaElement.currentTime;
  }
  return isPlayingInternal ? (audioContext.currentTime - startTime + offsetTime) : offsetTime;
}

export function setOffsetTime(time: number) {
  offsetTime = time;
}

export function seekTo(
  time: number,
  volume: number,
  eqGains: number[],
  reverbDry: number,
  reverbWet: number
) {
  offsetTime = time;
  if (playbackMode === 'stream' && mediaElement) {
    mediaElement.currentTime = time;
    updateMediaPositionState();
  } else if (playbackMode === 'buffer' && currentBuffer) {
    playBuffer(currentBuffer, time, volume, eqGains, reverbDry, reverbWet);
  }
}

export function getDuration() {
  if (playbackMode === 'stream' && mediaElement && !isNaN(mediaElement.duration)) {
    return mediaElement.duration;
  }
  return currentBuffer?.duration || 0;
}

export function setEqGain(index: number, db: number) {
  if (filters[index] && audioContext) {
    filters[index].gain.setTargetAtTime(db, audioContext.currentTime, 0.01);
  }
}

export function setReverbDry(value: number) {
  if (reverbDryGain && audioContext) {
    reverbDryGain.gain.setTargetAtTime(value, audioContext.currentTime, 0.01);
  }
}

export function setReverbWet(value: number) {
  if (reverbWetGain && audioContext) {
    reverbWetGain.gain.setTargetAtTime(value, audioContext.currentTime, 0.01);
  }
}

export function setVolume(value: number) {
  if (mainGainNode && audioContext) {
    mainGainNode.gain.setTargetAtTime(value, audioContext.currentTime, 0.01);
  }
}

export function getVisualizerData() {
  if (!analyzerNode) return new Uint8Array(0);
  const dataArray = new Uint8Array(analyzerNode.frequencyBinCount);
  analyzerNode.getByteFrequencyData(dataArray);
  return dataArray;
}

function immediateStop() {
  if (stopTimeout) {
    clearTimeout(stopTimeout);
    stopTimeout = null;
  }
  if (proxyAudio) proxyAudio.pause();
  if (source) {
    try { source.stop(); } catch (e) { }
    source.onended = null;
    source = null;
  }
  if (mediaElement) {
    mediaElement.pause();
    mediaElement.src = "";
    mediaElement.load();
  }
  isPlayingInternal = false;
}

export function stop(fadeTime = 0.1) {
  if (stopTimeout) clearTimeout(stopTimeout);

  if (proxyAudio) {
    proxyAudio.pause();
  }

  isPlayingInternal = false;

  if (mainGainNode && audioContext) {
    const now = audioContext.currentTime;
    mainGainNode.gain.setTargetAtTime(0, now, fadeTime / 4);
  }

  stopTimeout = setTimeout(() => {
    immediateStop();
    playbackMode = 'none';
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }
  }, fadeTime * 1000);
}
