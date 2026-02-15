export type Preset = {
  id: string;
  name: string;
  eqGains: number[];
  reverbDry: number;
  reverbWet: number;
  echoDelay: number;
  echoFeedback: number;
  echoWet: number;
  echoDry: number;
  isMono: boolean;
  volume: number;
};

export const defaultPresets: Preset[] = [
  {
    id: "flat",
    name: "フラット",
    eqGains: new Array(10).fill(0),
    reverbDry: 1.0,
    reverbWet: 0,
    echoDelay: 0.3,
    echoFeedback: 0.3,
    echoWet: 0,
    echoDry: 1.0,
    isMono: false,
    volume: 0.5,
  },
  {
    id: "concert-hall",
    name: "コンサートホール",
    eqGains: [1, 2, 1, 0, 0, 0, 1, 2, 3, 2],
    reverbDry: 0.7,
    reverbWet: 0.5,
    echoDelay: 0.4,
    echoFeedback: 0.4,
    echoWet: 0.2,
    echoDry: 1.0,
    isMono: false,
    volume: 0.5,
  },
];
