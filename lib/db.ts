import Dexie, { type Table } from 'dexie';

export interface TrackData {
    id?: string;
    name: string;
    data: Blob;
    createdAt: number;
}

export interface PresetData {
    id?: string;
    name: string;
    eqGains: number[];
    reverbDry: number;
    reverbWet: number;
    volume: number;
    createdAt: number;
}

export class EQLabDatabase extends Dexie {
    tracks!: Table<TrackData>;
    presets!: Table<PresetData>;

    constructor() {
        super('EQLabDB');
        this.version(1).stores({
            tracks: '++id, name, createdAt',
            presets: '++id, name, createdAt'
        });
    }
}

export const db = new EQLabDatabase();
