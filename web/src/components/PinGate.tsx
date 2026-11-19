import { setFocus } from '@noriginmedia/norigin-spatial-navigation';
import { Lock } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, parentToken, setParentToken } from '../api';
import { useProfile } from '../profile';
import { FocusGroup } from './Focusable';
import { TextField } from './Sources';
import { Button, Message, Spinner } from './ui';

/**
 * Shows its children only to a parent: asks for the parent PIN when one is set (unlocks for 30 minutes
 * in this tab). Kids' profiles are always turned away.
 */
export function PinGate({ children, title }: { children: ReactNode; title: string }) {
  const { isKid } = useProfile();
  const [state, setState] = useState<'checking' | 'locked' | 'open'>('checking');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .profiles()
      .then((r) => setState(!r.hasPin || r.parentUnlocked ? 'open' : 'locked'))
      .catch(() => setState('locked'));
  }, []);

  useEffect(() => {
    if (state === 'locked') setTimeout(() => setFocus('pin-input'), 50);
  }, [state]);

  if (isKid) {
    return (
      <div className="page page-center">
        <Message title="Ask a grown-up">{title} can only be changed from a parent’s profile.</Message>
      </div>
    );
  }
  if (state === 'checking') return <Spinner />;
  if (state === 'open') return <>{children}</>;

  const submit = async () => {
    setError(null);
    try {
      const r = await api.unlockParent(pin);
      setParentToken(r.token);
      setState('open');
    } catch (e) {
      setError((e as ApiError).message);
      setPin('');
      if (parentToken()) setParentToken(null);
    }
  };

  return (
    <div className="page page-center">
      <div className="pin-box">
        <Lock className="pin-icon" />
        <h1>Parent PIN</h1>
        <p className="muted">Enter the parent PIN to open {title}.</p>
        <FocusGroup focusKey="pin" className="pin-form">
          <TextField focusKey="pin-input" type="password" value={pin} onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 8))} onSubmit={submit} placeholder="PIN" autoFocus />
          <Button variant="primary" disabled={pin.length < 4} onSelect={submit}>
            Unlock
          </Button>
        </FocusGroup>
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
