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
