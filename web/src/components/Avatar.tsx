import type { Profile } from '../api';

/** Coloured tile with an emoji or the first letter of the name. */
export function Avatar({ p, size = 'md' }: { p: Pick<Profile, 'name' | 'color' | 'emoji' | 'kind'>; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`avatar avatar-${size}`} style={{ background: p.color }}>
      {p.emoji || (p.name.trim()[0] || '?').toUpperCase()}
      {p.kind === 'kid' && <span className="avatar-kid">KIDS</span>}
    </span>
  );
}
