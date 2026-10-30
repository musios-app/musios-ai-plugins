// Lyrics & Chords: shared helpers for finding lyric lines in a parsed song and in its source.
// Used by check.mjs and set-aside.mjs so both match lines by the same rules.
import { CHORD, MARK } from "./chord-words.mjs";

// Spacing does not count: runs of spaces, indentation, trailing spaces, non-breaking spaces.
export const norm = (s) => s.replace(/\s+/g, " ").trim();

// The lyric lines of a parsed song: their text and where they sit in song.lines.
export function songLyrics(song) {
  const out = [];
  song.lines.forEach((line, lineIndex) => {
    const pairs = line.items.filter((x) => x.type === "chordLyricsPair");
    const text = pairs.map((p) => p.lyrics).join("");
    if (pairs.length && text.trim()) out.push({ text: norm(text), lineIndex });
  });
  return out;
}

// The original text as numbered lines, with inline [chords] removed as the song would hold them.
export function originalLines(original) {
  return original.replace(/\r\n?/g, "\n").split("\n").map((raw, i) => ({
    n: i + 1,
    raw,
    // Take out [chords] only; a bracketed note such as [spoken] is part of the line.
    text: norm(raw.replace(/\[([^\]\n]*)\]/g, (all, inner) => {
      const words = inner.trim().split(/\s+/).filter(Boolean);
      return words.length && words.every((w) => CHORD.test(w) || MARK.test(w)) ? "" : all;
    })),
  }));
}

// Match each song lyric line to the next equal original line, in order.
// Returns matchedAt (song lyric index -> original index) and the song lyric indexes left over.
export function matchInOrder(lyrics, origLines) {
  const matchedAt = new Map();
  const unmatched = [];
  let cursor = 0;
  lyrics.forEach((lyric, index) => {
    let found = -1;
    for (let k = cursor; k < origLines.length; k++) {
      if (origLines[k].text === lyric.text) { found = k; break; }
    }
    if (found < 0) unmatched.push(index);
    else { matchedAt.set(index, found); cursor = found + 1; }
  });
  return { matchedAt, unmatched };
}

// "1,2,5-7" -> [1, 2, 5, 6, 7]; returns null if the text is not a list of line numbers.
export function parseLineList(text) {
  const out = [];
  for (const part of String(text).split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return null;
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to < from) return null;
    for (let n = from; n <= to; n++) out.push(n);
  }
  return out.length ? out : null;
}
