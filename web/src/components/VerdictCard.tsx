import { AlertTriangle, CheckCircle2, Clapperboard, HelpCircle, XCircle } from 'lucide-react';
import { OUTCOME_TONE, type Verdict } from '../api';
import { canDecodeAudio, canDecodeVideo } from '../playback';

/** What the measured codecs mean on this device (the check judges the file, not whether it plays here). */
function playbackNote(v: Verdict): string | null {
  const p = v.probe;
  if (!p) return null;
  const audio = p.audio[0]?.codec;
  const videoOk = !p.videoCodec || canDecodeVideo(p.videoCodec);
  const audioOk = !audio || canDecodeAudio(audio);
  if (videoOk && audioOk) return null;
  const what = [!videoOk && `${p.videoCodec.toUpperCase()} video`, !audioOk && `${audio.toUpperCase()} audio`].filter(Boolean).join(' and ');
  return `This device can’t play its ${what} directly, so FreeStream converts it while you watch${videoOk ? '' : ' (slower to start, uses more of the server’s CPU)'}.`;
}

const ICON = { verified: CheckCircle2, theater: Clapperboard, suspect: HelpCircle, rejected: XCircle } as const;
const HEADLINE = { verified: 'Verified', theater: 'Theater copy', suspect: 'Not confirmed', rejected: 'Rejected' } as const;

/** What the deep check found about a source: outcome, measured facts, and the AI's take. */
export function VerdictCard({ v, compact }: { v: Verdict; compact?: boolean }) {
  const Icon = ICON[v.outcome];
  return (
    <div className={`verdict verdict-${OUTCOME_TONE[v.outcome]}${compact ? ' verdict-compact' : ''}`}>
      <div className="verdict-head">
        <Icon />
        <strong>{HEADLINE[v.outcome]}</strong>
        <span>{v.label}</span>
      </div>
      {v.ai?.summary && <p className="verdict-summary">{v.ai.summary}</p>}
      {playbackNote(v) && <p className="verdict-summary muted small">{playbackNote(v)}</p>}
      {!compact && (v.ai?.issues.length || v.fileIssues.length || v.runtimeCheck === 'short') ? (
        <ul className="verdict-issues">
          {v.runtimeCheck === 'short' && <li>Shorter than the film's listed runtime — may be incomplete.</li>}
          {[...v.fileIssues, ...(v.ai?.issues || [])].map((i) => (
            <li key={i}>
              <AlertTriangle /> {i}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="verdict-by muted small">
        {v.ai ? `Checked by ${v.ai.provider} · ${v.ai.model}${v.ai.usedFrames ? ' (with frames)' : ''}` : 'Checked by runtime and file list'}
        {v.aiError ? ` · AI unavailable: ${v.aiError}` : ''}
      </p>
    </div>
  );
}
