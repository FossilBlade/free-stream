/**
 * The resolution of the screen this device shows video on, so source picks don't waste
 * bandwidth on 4K for a 1080p screen. Detected automatically; can be overridden per device in Settings.
 */
import { isTV } from './tv';

export type ScreenChoice = 'auto' | '2160' | '1080' | '720';
const KEY = 'fs-screen';

/** LG webOS apps can read the panel size; the TV browser itself reports a 1920×1080 page even on 4K panels. */
function webOsPanelHeight(): number | null {
  try {
    const info = (window as unknown as { PalmSystem?: { deviceInfo?: string } }).PalmSystem?.deviceInfo;
    if (!info) return null;
    const d = JSON.parse(info) as { screenHeight?: number; screenWidth?: number };
    return d.screenHeight || null;
  } catch {
    return null;
  }
}

export function detectScreen(): number {
  if (isTV) {
    const h = webOsPanelHeight();
    return h && h >= 2000 ? 2160 : 1080;
  }
  // Phones and tablets: 1080p is plenty on a small screen.
  if (/android|iphone|ipad|mobile/i.test(navigator.userAgent)) return 1080;
  const ratio = window.devicePixelRatio || 1;
  const long = Math.max(window.screen.width, window.screen.height) * ratio;
  return long >= 3400 ? 2160 : long >= 1700 ? 1080 : 720;
}

export function screenChoice(): ScreenChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === '2160' || v === '1080' || v === '720' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setScreenChoice(v: ScreenChoice): void {
  try {
    if (v === 'auto') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, v);
  } catch {
    /* private mode */
  }
}

/** The screen height to rank sources for: the saved choice, or the detected one. */
export const screenHeight = (): number => {
  const c = screenChoice();
  return c === 'auto' ? detectScreen() : Number(c);
};

export const screenLabel = (h: number) => (h >= 2160 ? '4K' : `${h}p`);
