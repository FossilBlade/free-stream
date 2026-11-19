// Minimal typings for the parts of WebTorrent 3 / parse-torrent this app uses.

declare module 'webtorrent' {
  import type { EventEmitter } from 'node:events';
  import type { Readable } from 'node:stream';

  export interface TorrentFile {
    name: string;
    path: string;
    length: number;
    /** Byte offset of this file within the torrent's concatenated data. */
    offset: number;
    downloaded: number;
    progress: number;
    select(priority?: number): void;
    deselect(): void;
    createReadStream(opts?: { start?: number; end?: number }): Readable;
  }

  /** A connection to one peer (bittorrent-protocol). */
  export interface Wire {
    amChoking: boolean;
    /** Movie data (piece payload) sent to this peer. */
    uploaded: number;
    on(event: 'upload', cb: (bytes: number) => void): void;
    choke(): void;
    unchoke(): void;
  }

  export interface Torrent extends EventEmitter {
    infoHash: string;
    magnetURI: string;
    name: string;
    path: string;
    files: TorrentFile[];
    length: number;
    ready: boolean;
    destroyed: boolean;
    progress: number;
    downloaded: number;
    /** Bytes sent to other peers. */
    uploaded: number;
    downloadSpeed: number;
    uploadSpeed: number;
    numPeers: number;
    metadata: Buffer | null;
    pieceLength: number;
    /** The .torrent file contents (available once metadata is known). */
    torrentFile: Uint8Array | null;
    /** Which pieces we have. */
    bitfield: { buffer: Uint8Array } | null;
    /** Fetch these pieces first. */
    critical(start: number, end: number): void;
  }

  export interface AddOptions {
    path?: string;
    deselect?: boolean;
    strategy?: 'sequential' | 'rarest';
    announce?: string[];
    /** Pieces known to be on disk already; skips re-checking them on startup. */
    bitfield?: Uint8Array;
    /** Upload slots; 0 = never upload. */
    uploads?: number | false;
  }

  export default class WebTorrent extends EventEmitter {
    constructor(opts?: { maxConns?: number; utp?: boolean; dht?: boolean; webSeeds?: boolean; torrentPort?: number });
    torrents: Torrent[];
    downloadSpeed: number;
    uploadSpeed: number;
    get(id: string | Buffer): Promise<Torrent | null>;
    add(id: string | Buffer, opts?: AddOptions, cb?: (t: Torrent) => void): Torrent;
    remove(id: string | Torrent, opts?: { destroyStore?: boolean }): Promise<void>;
    destroy(cb?: (err?: Error) => void): void;
  }
}

declare module 'parse-torrent' {
  export default function parseTorrent(id: string | Buffer | Uint8Array): Promise<{ infoHash: string; name?: string; announce?: string[] }>;
}
