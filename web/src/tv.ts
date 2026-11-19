/** LG webOS remote key codes, plus keyboard equivalents for desktop browsers. */
export const KEY = {
  LEFT: 37,
  UP: 38,
  RIGHT: 39,
  DOWN: 40,
  ENTER: 13,
  BACK: 461, // webOS remote "Back"
  ESC: 27,
  BACKSPACE: 8,
  SPACE: 32,
  PLAY: 415,
  PAUSE: 19,
  PLAY_PAUSE: 179,
  STOP: 413,
  FAST_FWD: 417,
  REWIND: 412,
} as const;

export const isTV = /web0s|webos|smart-?tv|netcast/i.test(navigator.userAgent);
export const isSafari = /^((?!chrome|chromium|android|crios).)*safari/i.test(navigator.userAgent);

/** Dolby Digital (AC3 / E-AC3) decodes on LG TVs and in Safari, but not in Chrome/Firefox/Edge on a computer. */
export const canPlayDolbyAudio = isTV || isSafari;

export function isBackKey(e: KeyboardEvent): boolean {
  if (e.keyCode === KEY.BACK || e.keyCode === KEY.ESC) return true;
  // Backspace means "back" only when not typing in a field.
  if (e.keyCode === KEY.BACKSPACE) {
    const t = e.target as HTMLElement | null;
    return !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
  }
  return false;
}

export function isTyping(): boolean {
  const a = document.activeElement as HTMLElement | null;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}
