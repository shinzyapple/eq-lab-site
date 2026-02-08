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
let masterInput: GainNode | null = null;

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
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      latencyHint: 'playback'
    });

    // 1. Core Input
    masterInput = audioContext.createGain();

    // 2. EQ Chain
    filters = [];
    let current: AudioNode = masterInput;
    EQ_FREQUENCIES.forEach((freq) => {
      const filter = audioContext!.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = freq;
      filter.Q.value = 1.4;
      filter.gain.value = 0;
      current.connect(filter);
      filters.push(filter);
      current = filter;
    });

    // 3. Reverb Section
    reverbDryGain = audioContext.createGain();
    reverbNode = audioContext.createConvolver();
    reverbNode.buffer = createImpulseResponse(audioContext, 2, 2);
    reverbWetGain = audioContext.createGain();

    current.connect(reverbDryGain);
    current.connect(reverbNode);
    reverbNode.connect(reverbWetGain);

    // 4. Output Mixing
    mainGainNode = audioContext.createGain();
    reverbDryGain.connect(mainGainNode);
    reverbWetGain.connect(mainGainNode);

    analyzerNode = audioContext.createAnalyser();
    analyzerNode.fftSize = 256;
    mainGainNode.connect(analyzerNode);
    analyzerNode.connect(audioContext.destination);

    // 5. Background / MediaSession Support
    streamDest = audioContext.createMediaStreamDestination();
    analyzerNode.connect(streamDest);

    proxyAudio = new Audio();
    proxyAudio.srcObject = streamDest.stream;
    proxyAudio.setAttribute("playsinline", "true");
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    proxyAudio.muted = !isMobile;
    proxyAudio.play().catch(() => { });

    // 6. Streaming Element
    mediaElement = new Audio();
    mediaElement.crossOrigin = "anonymous";
    mediaElement.setAttribute("playsinline", "true");
    mediaSourceNode = audioContext.createMediaElementSource(mediaElement);
    mediaSourceNode.connect(masterInput);
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
  return audioContext;
}

export function playBuffer(
  buffer: AudioBuffer,
  startAt = 0,
  volume = 0.5,
  eqGains: number[],
  reverbDry = 1.0,
  reverbWet = 0.2
) {
  if (!audioContext || !masterInput) return;

  immediateStop();

  currentBuffer = buffer;
  offsetTime = startAt;
  startTime = audioContext.currentTime;

  source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(masterInput);

  // Sync parameters
  setVolume(volume);
  eqGains.forEach((g, i) => setEqGain(i, g));
  setReverbDry(reverbDry);
  setReverbWet(reverbWet);

  source.start(0, startAt);
  isPlayingInternal = true;
  playbackMode = 'buffer';

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
    updateMediaMetadata(lastTitle);
  }

  source.onended = () => {
    if (playbackMode === 'buffer') {
      isPlayingInternal = false;
      if (onPlaybackChange) onPlaybackChange(false);
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
  if (!audioContext || !mediaElement) return;

  immediateStop();

  currentBuffer = null;
  offsetTime = startAt;

  // Sync parameters
  setVolume(volume);
  eqGains.forEach((g, i) => setEqGain(i, g));
  setReverbDry(reverbDry);
  setReverbWet(reverbWet);

  mediaElement.src = url;
  mediaElement.load();

  mediaElement.onloadedmetadata = () => {
    if (mediaElement) {
      updateMediaPositionState();
    }
  };

  mediaElement.onerror = (e) => {
    console.error("Stream error occurred", e);
    isPlayingInternal = false;
    if (onPlaybackChange) onPlaybackChange(false);
  };

  mediaElement.play()
    .then(() => {
      if (mediaElement && startAt > 0) {
        mediaElement.currentTime = startAt;
      }
    })
    .catch(e => {
      console.error("Play failed", e);
      isPlayingInternal = false;
      if (onPlaybackChange) onPlaybackChange(false);
    });

  if (proxyAudio) proxyAudio.play().catch(() => { });

  isPlayingInternal = true;
  playbackMode = 'stream';

  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
    updateMediaMetadata(lastTitle);
  }

  mediaElement.onended = () => {
    isPlayingInternal = false;
    if (onPlaybackChange) onPlaybackChange(false);
  };
}

function immediateStop() {
  if (stopTimeout) {
    clearTimeout(stopTimeout);
    stopTimeout = null;
  }
  if (source) {
    try { source.stop(); } catch (e) { }
    source.disconnect();
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
  isPlayingInternal = false;

  if (mainGainNode && audioContext) {
    mainGainNode.gain.setTargetAtTime(0, audioContext.currentTime, fadeTime / 4);
  }

  stopTimeout = setTimeout(() => {
    immediateStop();
    playbackMode = 'none';
  }, fadeTime * 1000);
}

export function updateMediaMetadata(title: string, artist = 'EQ LAB', album = 'Audio Library') {
  lastTitle = title;
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title, artist, album,
      artwork: [{ src: '/favicon.ico', sizes: '128x128', type: 'image/x-icon' }]
    });

    const handlers: MediaSessionAction[] = ['play', 'pause', 'seekto', 'seekbackward', 'seekforward'];
    handlers.forEach(action => {
      navigator.mediaSession.setActionHandler(action, (details) => {
        if (action === 'play') onPlaybackChange?.(true);
        if (action === 'pause') onPlaybackChange?.(false);
        if (action === 'seekto' && details.seekTime !== undefined) onSeekTo?.(details.seekTime);
        if (action === 'seekbackward') onSeekTo?.(Math.max(0, getCurrentTime() - 10));
        if (action === 'seekforward') onSeekTo?.(Math.min(getDuration(), getCurrentTime() + 10));
      });
    });
  }
}

export function updateMediaPositionState() {
  if ('mediaSession' in navigator && (navigator.mediaSession as any).setPositionState) {
    const dur = getDuration();
    const pos = getCurrentTime();
    if (dur > 0 && isFinite(dur) && isFinite(pos)) {
      try {
        (navigator.mediaSession as any).setPositionState({
          duration: dur,
          playbackRate: 1,
          position: Math.min(pos, dur)
        });
      } catch (e) { }
    }
  }
}

export async function getSpectrum(buffer: AudioBuffer): Promise<number[]> {
  const fftSize = 4096;
  const data = buffer.getChannelData(0);
  const frequenciesCount = EQ_FREQUENCIES.length;
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const numSamples = Math.min(isMobile ? 15 : 40, Math.floor(buffer.length / fftSize));
  const skip = Math.floor(buffer.length / numSamples);
  const spectrum = new Array(frequenciesCount).fill(-100);
  const sampleRate = buffer.sampleRate;

  for (let i = 0; i < numSamples; i++) {
    if (isMobile) await new Promise(r => requestAnimationFrame(r));
    const start = i * skip;
    for (let fIdx = 0; fIdx < frequenciesCount; fIdx++) {
      const f = EQ_FREQUENCIES[fIdx];
      let real = 0, imag = 0;
      const angle = (2 * Math.PI * f) / sampleRate;
      const step = isMobile ? 32 : 8;
      for (let j = 0; j < fftSize; j += step) {
        if (start + j >= data.length) break;
        const val = data[start + j];
        real += val * Math.cos(angle * j);
        imag += val * Math.sin(angle * j);
      }
      const mag = Math.sqrt(real * real + imag * imag) / (fftSize / step);
      const db = 20 * Math.log10(mag + 1e-9);
      spectrum[fIdx] = i === 0 ? db : (spectrum[fIdx] + db) / 2;
    }
  }
  return spectrum;
}

export function calculateMatchedGains(s: number[], t: number[]) {
  const diff = t.map((v, i) => v - s[i]);
  const avg = diff.reduce((a, b) => a + b, 0) / diff.length;
  return diff.map(d => Math.max(-12, Math.min(12, d - avg)));
}

export function getIsPlaying() { return isPlayingInternal; }
export function getCurrentTime() {
  if (!audioContext) return offsetTime;
  if (playbackMode === 'stream' && mediaElement) return mediaElement.currentTime;
  return isPlayingInternal ? (audioContext.currentTime - startTime + offsetTime) : offsetTime;
}
export function getDuration() {
  if (playbackMode === 'stream' && mediaElement) return mediaElement.duration || 0;
  return currentBuffer?.duration || 0;
}
export function setEqGain(i: number, db: number) {
  if (filters[i] && audioContext) filters[i].gain.setTargetAtTime(db, audioContext.currentTime, 0.01);
}
export function setReverbDry(v: number) {
  if (reverbDryGain && audioContext) reverbDryGain.gain.setTargetAtTime(v, audioContext.currentTime, 0.01);
}
export function setReverbWet(v: number) {
  if (reverbWetGain && audioContext) reverbWetGain.gain.setTargetAtTime(v, audioContext.currentTime, 0.01);
}
export function setVolume(v: number) {
  if (mainGainNode && audioContext) mainGainNode.gain.setTargetAtTime(v, audioContext.currentTime, 0.01);
}
export function getVisualizerData() {
  if (!analyzerNode) return new Uint8Array(0);
  const data = new Uint8Array(analyzerNode.frequencyBinCount);
  analyzerNode.getByteFrequencyData(data);
  return data;
}
export function seekTo(t: number, v: number, eq: number[], rd: number, rw: number) {
  offsetTime = t;
  if (playbackMode === 'stream' && mediaElement) {
    mediaElement.currentTime = t;
  } else if (playbackMode === 'buffer' && currentBuffer) {
    playBuffer(currentBuffer, t, v, eq, rd, rw);
  }
}
