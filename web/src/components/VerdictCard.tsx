import { AlertTriangle, CheckCircle2, Clapperboard, HelpCircle, XCircle } from 'lucide-react';
import { OUTCOME_TONE, type Verdict } from '../api';

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
