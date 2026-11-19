import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { Download, Play, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SavedSource } from '../api';
import { useBackHandler } from '../back';
import { FocusGroup, Focusable } from './Focusable';
import { TextField } from './Sources';
import { Button } from './ui';

/** "Magnet link" button: paste a magnet, then play or download it. */
export function MagnetModal({ onClose, onPlay, onDownload }: { onClose: () => void; onPlay: (s: SavedSource) => void; onDownload: (s: SavedSource) => void }) {
  const [value, setValue] = useState('');
  const magnet = value.trim();
  const valid = /^magnet:\?/i.test(magnet);
  const source = (): SavedSource => ({ magnet, releaseTitle: 'Magnet link' });

  useEffect(() => {
    const t = setTimeout(() => setFocus('magnet-input'), 50);
    return () => clearTimeout(t);
  }, []);

  useBackHandler(() => {
    onClose();
    return true;
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Magnet link">
      <FocusGroup focusKey="magnet" boundary className="modal magnet-modal">
        <div className="preview-head">
          <div className="preview-name">Magnet link</div>
          <Focusable className="btn btn-ghost btn-icon" title="Close" onSelect={onClose}>
            <X />
          </Focusable>
        </div>
        <TextField focusKey="magnet-input" value={value} onChange={setValue} onSubmit={() => valid && onPlay(source())} placeholder="magnet:?xt=urn:btih:…" autoFocus />
        {magnet && !valid && <p className="muted small magnet-hint">That doesn’t look like a magnet link — it should start with “magnet:?”.</p>}
        <div className="actions">
          <Button variant="primary" icon={<Play />} disabled={!valid} onSelect={() => onPlay(source())}>
            Play
          </Button>
          <Button icon={<Download />} disabled={!valid} onSelect={() => onDownload(source())}>
            Download
          </Button>
        </div>
      </FocusGroup>
    </div>
  );
}
