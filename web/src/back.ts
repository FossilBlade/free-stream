import { useEffect, useRef } from 'react';

/**
 * A stack of "Back" handlers. The most recently mounted one wins (e.g. an open menu
 * closes before the page navigates back). Return true when the press was handled.
 */
const stack: { current: () => boolean }[] = [];

export function useBackHandler(handler: () => boolean, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const entry = { current: () => ref.current() };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [enabled]);
}

export function runBackHandlers(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].current()) return true;
  return false;
}
