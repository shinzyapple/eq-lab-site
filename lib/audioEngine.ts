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
let streamDest: MediaStreamAudioDestinationNode | null = null;
let proxyAudio: HTMLAudioElement | null = null;

let currentBuffer: AudioBuffer | null = null;
let startTime = 0;
let offsetTime = 0;
let isPlayingInternal = false;

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
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

    // Create a proxy audio element to keep playback alive in background
    streamDest = audioContext.createMediaStreamDestination();
    proxyAudio = new Audio();
    proxyAudio.srcObject = streamDest.stream;
    // Essential for background audio
    proxyAudio.setAttribute("playsinline", "true");
  }
  if (audioContext.state === "suspended") {
    audioContext.resume();
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

export async function loadAudio(urlOrFile: string | File): Promise<AudioBuffer> {
  const ctx = await initContext();
  if (!ctx) throw new Error("AudioContext not initialized");

  let arrayBuffer: ArrayBuffer;

  try {
    if (typeof urlOrFile === "string") {
      console.log(`Loading audio from URL: ${urlOrFile}`);
      const res = await fetch(urlOrFile);
      if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
      arrayBuffer = await res.arrayBuffer();
    } else {
      console.log(`Loading audio from File: ${urlOrFile.name} (${urlOrFile.size} bytes)`);
      arrayBuffer = await urlOrFile.arrayBuffer();
    }

    // Support both promise-based and callback-based decodeAudioData
    return await new Promise<AudioBuffer>((resolve, reject) => {
      const successCallback = (decodedBuffer: AudioBuffer) => resolve(decodedBuffer);
      const errorCallback = (error: Error) => {
        console.error("decodeAudioData error:", error);
        reject(error);
      };

      const result = ctx.decodeAudioData(arrayBuffer, successCallback, errorCallback);
      if (result && typeof result.then === "function") {
        result.then(resolve).catch(reject);
      }
    });

  } catch (e) {
    console.warn("Failed to load audio source:", e);
    // Only return sample buffer for URLs (like base.wav) as a safe fallback.
    // For Files, throw so the UI can catch it and alert the user.
    if (typeof urlOrFile !== "string") {
      throw e;
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
  if (!audioContext) return;

  stop();

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

  // Pipe to BOTH context destination and proxy audio
  mainGainNode.connect(audioContext.destination);
  if (streamDest) {
    mainGainNode.connect(streamDest);
  }

  if (proxyAudio) {
    proxyAudio.play().catch(e => console.log("Proxy audio play failed:", e));
  }

  source.start(0, startAt);
  isPlayingInternal = true;

  source.onended = () => {
    if (!source) return; // Already stopped manually
    const playedTime = audioContext!.currentTime - startTime;
    if (playedTime >= (buffer.duration - startAt - 0.1)) {
      isPlayingInternal = false;
      offsetTime = 0;
    }
  };
}

export async function analyzeBuffer(buffer: AudioBuffer): Promise<number[]> {
  // Analytical logic placeholder
  return EQ_FREQUENCIES.map(() => 0);
}

export async function getMatchingEq(sourceBuffer: AudioBuffer, targetBuffer: AudioBuffer): Promise<number[]> {
  // Matching logic placeholder
  return EQ_FREQUENCIES.map(() => (Math.random() * 10 - 5));
}

export function getIsPlaying() {
  return isPlayingInternal;
}

export function getCurrentTime() {
  if (!isPlayingInternal || !audioContext) return offsetTime;
  const curr = offsetTime + (audioContext.currentTime - startTime);
  return Math.min(curr, currentBuffer?.duration || 0);
}

export function setOffsetTime(time: number) {
  offsetTime = time;
}

export function getDuration() {
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

export function stop() {
  if (proxyAudio) {
    proxyAudio.pause();
  }
  if (source) {
    try {
      source.stop();
    } catch (e) {
    }
    source.onended = null;
    source = null;
  }
  isPlayingInternal = false;
}
