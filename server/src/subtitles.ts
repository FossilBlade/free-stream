/** Converts SubRip (.srt) text to WebVTT, which is what <track> elements accept. */
export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    // 00:00:01,000 --> 00:00:04,000  =>  00:00:01.000 --> 00:00:04.000
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    // drop the numeric cue counters that precede timing lines
    .replace(/^\d+\n(?=\d{1,2}:\d{2}:\d{2}\.\d{3} -->)/gm, '')
    // SubRip font/position tags that VTT doesn't understand
    .replace(/<\/?font[^>]*>/gi, '')
    .replace(/\{\\an?\d+\}/g, '')
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

/** Shifts every cue in a WebVTT file back by `offsetSec` (for converted streams that start mid-file); drops cues that end before 0. */
export function shiftVtt(vtt: string, offsetSec: number): string {
  if (!offsetSec) return vtt;
  const toSec = (t: string) => {
    const p = t.split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  const fmt = (s: number) => {
    const ms = Math.round(Math.max(0, s) * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const sec = (ms % 60000) / 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
  };
  const [head, ...blocks] = vtt.replace(/\r\n?/g, '\n').split(/\n\n+/);
  const kept = blocks.flatMap((b) => {
    const m = b.match(/^(.*\n)?((?:\d+:)?\d{2}:\d{2}\.\d{3}) --> ((?:\d+:)?\d{2}:\d{2}\.\d{3})(.*)\n([\s\S]*)$/);
    if (!m) return [b];
    const start = toSec(m[2]) - offsetSec;
    const end = toSec(m[3]) - offsetSec;
    if (end <= 0) return [];
    return [`${m[1] || ''}${fmt(start)} --> ${fmt(end)}${m[4]}\n${m[5]}`];
  });
  return [head, ...kept].join('\n\n') + '\n';
}
