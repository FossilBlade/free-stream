import { useEffect, useState } from 'react';

type Listener = (msg: string, tone: 'info' | 'error') => void;
let listener: Listener | null = null;

/** Shows a short message at the bottom of the screen. */
export function toast(msg: string, tone: 'info' | 'error' = 'info'): void {
  listener?.(msg, tone);
}

export function Toaster() {
  const [item, setItem] = useState<{ msg: string; tone: 'info' | 'error'; id: number } | null>(null);
  useEffect(() => {
    listener = (msg, tone) => setItem({ msg, tone, id: Date.now() });
    return () => {
      listener = null;
    };
  }, []);
  useEffect(() => {
    if (!item) return;
    const t = setTimeout(() => setItem(null), 4500);
    return () => clearTimeout(t);
  }, [item]);
  return item ? (
    <div key={item.id} className={`toast toast-${item.tone}`} role="status">
      {item.msg}
    </div>
  ) : null;
}
