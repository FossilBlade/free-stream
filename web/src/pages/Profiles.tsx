import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, LANGUAGE_NAMES, type Profile } from '../api';
import { Avatar } from '../components/Avatar';
import { FocusGroup, Focusable } from '../components/Focusable';
import { PinGate } from '../components/PinGate';
import { TextField } from '../components/Sources';
import { toast } from '../components/Toast';
import { Button, Spinner } from '../components/ui';
import { useProfile } from '../profile';

/** "Who's watching?" — shown on a device that hasn't picked a profile, and from the avatar in the nav. */
export function WhoIsWatching() {
  const { profiles, loaded, choose } = useProfile();
  const navigate = useNavigate();

  useEffect(() => {
    if (profiles.length) setTimeout(() => setFocus('who-0'), 50);
  }, [profiles.length]);

  if (!loaded) return <Spinner />;
  return (
    <div className="page who">
      <h1>Who’s watching?</h1>
      <FocusGroup focusKey="who" className="who-grid">
        {profiles.map((p, i) => (
          <Focusable
            key={p.id}
            focusKey={`who-${i}`}
            className="who-tile"
            onSelect={() => {
              choose(p);
              navigate('/', { replace: true });
            }}
          >
            <Avatar p={p} size="lg" />
            <span className="who-name">{p.name}</span>
          </Focusable>
        ))}
      </FocusGroup>
      <FocusGroup focusKey="who-manage" className="actions who-actions">
        <Button icon={<Pencil />} onSelect={() => navigate('/profiles/manage')}>
          Manage profiles
        </Button>
      </FocusGroup>
    </div>
  );
}

const COLORS = ['#2ec4b6', '#ffb547', '#f472b6', '#60a5fa', '#a78bfa', '#4ade80', '#f87171', '#facc15'];
const EMOJIS = ['', '🦁', '🐼', '🦊', '🐯', '🐨', '🦄', '🚀', '⚽', '🎮', '🌸', '⭐'];
const AGES: { v: 7 | 12 | 16; label: string; hint: string }[] = [
  { v: 7, label: 'Up to 7', hint: 'U, G, PG, UA 7+, TV-Y7' },
  { v: 12, label: 'Up to 12', hint: 'adds UA 12, 12A' },
  { v: 16, label: 'Up to 16', hint: 'adds PG-13, UA 13+/16+, TV-14' },
];

function ProfileEditor({ initial, onDone }: { initial?: Profile; onDone: () => void }) {
  const [p, setP] = useState<Partial<Profile>>(initial || { name: '', kind: 'adult', color: COLORS[1], emoji: '', languages: ['en', 'hi'], maxAge: 7 });
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof Profile>(k: K, v: Profile[K]) => setP({ ...p, [k]: v });

  useEffect(() => {
    setTimeout(() => setFocus('edit-name'), 50);
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      if (initial) await api.updateProfile(initial.id, p);
      else await api.createProfile(p);
      onDone();
    } catch (e) {
      toast((e as ApiError).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const langs = p.languages || [];
  const toggleLang = (code: string) => set('languages', langs.includes(code) ? langs.filter((l) => l !== code) : [...langs, code]);

  return (
    <FocusGroup focusKey="profile-edit" className="form profile-editor">
      <div className="profile-editor-head">
        <Avatar p={{ name: p.name || '?', color: p.color || COLORS[0], emoji: p.emoji || '', kind: p.kind || 'adult' }} size="lg" />
        <div className="form-field">
          <label>Name</label>
          <TextField focusKey="edit-name" value={p.name || ''} onChange={(v) => set('name', v)} placeholder="Name" />
        </div>
      </div>
      <div className="form-field">
        <label>Icon</label>
        <div className="chips">
          {EMOJIS.map((e) => (
            <Focusable key={e || 'letter'} className={`chip${(p.emoji || '') === e ? ' is-active' : ''}`} onSelect={() => set('emoji', e)}>
              {e || 'Initial'}
            </Focusable>
          ))}
        </div>
      </div>
      <div className="form-field">
        <label>Colour</label>
        <div className="chips">
          {COLORS.map((c) => (
            <Focusable key={c} className={`chip swatch${p.color === c ? ' is-active' : ''}`} onSelect={() => set('color', c)}>
              <span className="swatch-dot" style={{ background: c }} />
            </Focusable>
          ))}
        </div>
      </div>
      <div className="form-field">
        <label>Profile type</label>
        <div className="chips">
          {(['adult', 'kid'] as const).map((k) => (
            <Focusable key={k} className={`chip${p.kind === k ? ' is-active' : ''}`} onSelect={() => set('kind', k)}>
              {k === 'adult' ? 'Adult' : 'Kid'}
            </Focusable>
          ))}
        </div>
      </div>
      {p.kind === 'kid' && (
        <div className="form-field">
          <label>Age limit</label>
          <div className="chips">
            {AGES.map((a) => (
              <Focusable key={a.v} className={`chip${p.maxAge === a.v ? ' is-active' : ''}`} onSelect={() => set('maxAge', a.v)}>
                {a.label}
              </Focusable>
            ))}
          </div>
          <p className="muted small">
            Ratings allowed: {AGES.find((a) => a.v === p.maxAge)?.hint}. Titles without a rating are hidden. Kids get a simple Play button — no source lists, downloads or settings.
          </p>
        </div>
      )}
      <div className="form-field">
        <label>Languages</label>
        <div className="chips">
          {Object.entries(LANGUAGE_NAMES).map(([code, name]) => (
            <Focusable key={code} className={`chip${langs.includes(code) ? ' is-active' : ''}`} onSelect={() => toggleLang(code)}>
              {langs.includes(code) && <Check />} {name}
            </Focusable>
          ))}
        </div>
        <p className="muted small">Search ranking, Home rows and sources prefer these, in the order chosen.</p>
      </div>
      <div className="actions">
        <Button variant="primary" icon={<Check />} disabled={saving || !(p.name || '').trim()} onSelect={save}>
          {initial ? 'Save' : 'Add profile'}
        </Button>
        <Button icon={<X />} onSelect={onDone}>
          Cancel
        </Button>
      </div>
    </FocusGroup>
  );
}

function PinSettings() {
  const { hasPin, reload } = useProfile();
  const [pin, setPin] = useState('');
  const save = async () => {
    try {
      await api.setParentPin(pin);
      setPin('');
      await reload();
      toast(hasPin ? 'Parent PIN changed.' : 'Parent PIN set. Settings and profile changes now need it.');
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };
  return (
    <div className="form pin-settings">
      <h2>Parent PIN</h2>
      <p className="muted small form-intro">
        {hasPin ? 'Needed to open Settings and to change profiles or kids’ limits.' : 'No PIN yet — anyone can open Settings and change kids’ limits. Set one to lock them.'}
      </p>
      <FocusGroup focusKey="pin-set" className="pin-form">
        <TextField type="password" value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 8))} onSubmit={save} placeholder={hasPin ? 'New PIN (4–8 digits)' : 'Choose a PIN (4–8 digits)'} />
        <Button variant="primary" disabled={pin.length < 4} onSelect={save}>
          {hasPin ? 'Change PIN' : 'Set PIN'}
        </Button>
      </FocusGroup>
    </div>
  );
}

export function ManageProfiles() {
  const { profiles, reload, profile: current } = useProfile();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Profile | 'new' | null>(null);

  const done = async () => {
    setEditing(null);
    await reload();
  };

  const remove = async (p: Profile) => {
    try {
      await api.deleteProfile(p.id);
      toast(`Removed ${p.name}.`);
      await reload();
    } catch (e) {
      toast((e as ApiError).message, 'error');
    }
  };

  return (
    <PinGate title="profile management">
      <div className="page page-padded page-narrow">
        <h1 className="page-title">Manage profiles</h1>
        {editing ? (
          <ProfileEditor initial={editing === 'new' ? undefined : editing} onDone={done} />
        ) : (
          <>
            <FocusGroup focusKey="manage" className="manage-list">
              {profiles.map((p) => (
                <div className="manage-row" key={p.id}>
                  <Avatar p={p} />
                  <div className="manage-body">
                    <div className="download-name">
                      {p.name} {current?.id === p.id && <span className="muted small">(this device)</span>}
                    </div>
                    <div className="muted small">
                      {p.kind === 'kid' ? `Kid · up to ${p.maxAge}` : 'Adult'} · {p.languages.map((l) => LANGUAGE_NAMES[l] || l).join(', ')}
                    </div>
                  </div>
                  <Focusable className="btn btn-secondary btn-icon" title="Edit" onSelect={() => setEditing(p)}>
                    <Pencil />
                  </Focusable>
                  <Focusable className="btn btn-danger btn-icon" title="Remove" onSelect={() => remove(p)}>
                    <Trash2 />
                  </Focusable>
                </div>
              ))}
            </FocusGroup>
            <FocusGroup focusKey="manage-actions" className="actions">
              {profiles.length < 8 && (
                <Button variant="primary" icon={<Plus />} onSelect={() => setEditing('new')}>
                  Add profile
                </Button>
              )}
              <Button onSelect={() => navigate('/profiles')}>Done</Button>
            </FocusGroup>
            <PinSettings />
          </>
        )}
      </div>
    </PinGate>
  );
}
