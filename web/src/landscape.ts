import { isTV } from './tv';

/**
 * Phones: the player fills the screen and stays in landscape, even with the phone's auto-rotate off.
 * Browsers only lock the orientation of a fullscreen page, and only go fullscreen right after a tap, so
 * this starts from the Play tap itself (before waiting for the server) and the player ends it.
 */

type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void> };

/** Whether landscape is wanted right now: going fullscreen takes a moment, and the player may be gone by then. */
let wanted = false;

const orientation = () => (typeof screen !== 'undefined' ? (screen.orientation as LockableOrientation | undefined) : undefined);

/** A touch device with a phone-sized screen (tablets, computers and TVs are already wide). */
function isPhone(): boolean {
  // Not "(pointer: coarse)": some Android phones don't report it.
  return !isTV && navigator.maxTouchPoints > 0 && Math.min(screen.width, screen.height) < 600;
}

/** A phone whose browser can fill the screen with a page (Android; iPhones have neither that nor the lock). */
export const canLandscape = (): boolean => isPhone() && 'requestFullscreen' in document.documentElement;

export const isFullscreen = (): boolean => !!document.fullscreenElement;

/** On a phone: go fullscreen and lock to landscape. Call it directly from a tap. Does nothing elsewhere. */
export function enterLandscape(): void {
  if (!canLandscape()) return;
  wanted = true;
  const ready = isFullscreen() ? Promise.resolve() : document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  ready
    .then(() => {
      if (!wanted) return leaveLandscape();
      return orientation()?.lock?.('landscape');
    })
    // Not from a tap, or the browser refused: tapping the video tries again.
    .catch(() => {});
}

/** Back to the phone's own rotation. */
export function leaveLandscape(): void {
  if (!canLandscape()) return;
  wanted = false;
  try {
    orientation()?.unlock();
  } catch {
    /* nothing was locked */
  }
  if (isFullscreen()) document.exitFullscreen().catch(() => {});
}
