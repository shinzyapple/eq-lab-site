export type Preset = {
  id: string;
  name: string;
  eqGains: number[];
  reverbDry: number;
  reverbWet: number;
  volume: number;
};

export const defaultPresets: Preset[] = [
  {
    id: "flat",
    name: "フラット",
    eqGains: new Array(10).fill(0),
    reverbDry: 1.0,
    reverbWet: 0,
    volume: 0.5,
  },
  {
    id: "concert-hall",
    name: "コンサートホール",
    eqGains: [1, 2, 1, 0, 0, 0, 1, 2, 3, 2],
    reverbDry: 0.7,
    reverbWet: 0.5,
    volume: 0.5,
  },
];
