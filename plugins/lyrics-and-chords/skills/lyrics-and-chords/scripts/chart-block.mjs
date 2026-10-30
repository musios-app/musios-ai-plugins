// Lyrics & Chords: find a chord chart that sits in front of the lyrics.
// Used by load.mjs. Some sheets open with a chart (a "Chords" heading, bar lines, notes such as "2x repeat")
// and then a "Lyrics" heading. The chart is not lyrics and should not be read as part of the song.
//
// Two cases, kept apart on purpose:
//   clear      a "Chords" or "Chart" heading, then a "Lyrics" heading, with chord rows between them.
//              The block is set aside without asking.
//   ambiguous  four or more chord-only rows in a row before any lyric line, with no such headings.
//              Nothing is changed; the writer is asked.
// Anything else is left exactly as the readers get it.
import { CHORD, MARK, SECTION_HEADER, chordTokens } from "./chord-words.mjs";

const CHART_HEADING = /^\s*(?:chord\s+chart|chords?|chart)\s*:?\s*$/i;
const LYRICS_HEADING = /^\s*lyrics?\s*:?\s*$/i;

// A line made only of chords and marks (bar lines, repeat counts), with at least one chord.
const isChartRow = (line) => {
  const tokens = chordTokens(line).map((t) => t.text);
  return tokens.length > 0 && tokens.every((t) => CHORD.test(t) || MARK.test(t)) && tokens.some((t) => CHORD.test(t));
};

// A chart row may carry a note ("| Am | F | C | G | 2x repeat"): most of its words are chords and marks.
const isChartRowWithNote = (line) => {
  const tokens = chordTokens(line).map((t) => t.text);
  const known = tokens.filter((t) => CHORD.test(t) || MARK.test(t)).length;
  return tokens.some((t) => CHORD.test(t)) && known / tokens.length >= 0.6;
};

// A line that reads as words to sing: not a chart row, not a section label, not a fact such as "Key: Dmin".
const isLyricLine = (line) => {
  const text = line.trim();
  if (!text || isChartRow(text) || SECTION_HEADER.test(text) || /^[\[{]/.test(text) || /^[A-Za-z][A-Za-z &]{0,24}:\s/.test(text)) return false;
  return text.split(/\s+/).length >= 3;
};

// Returns { block: {from, to} | null, ask: {from, to} | null }; line numbers start at 1.
export function findChart(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const head = lines.findIndex((l) => CHART_HEADING.test(l));
  if (head >= 0) {
    const tail = lines.findIndex((l, i) => i > head && LYRICS_HEADING.test(l));
    if (tail > head && lines.slice(head + 1, tail).filter(isChartRowWithNote).length >= 2) {
      return { block: { from: head + 1, to: tail + 1 }, ask: null };
    }
  }
  const firstLyric = lines.findIndex(isLyricLine);
  const limit = firstLyric < 0 ? lines.length : firstLyric;
  let start = -1;
  for (let i = 0; i <= limit; i++) {
    if (i < limit && isChartRow(lines[i])) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= 4) return { block: null, ask: { from: start + 1, to: i } };
    start = -1;
  }
  return { block: null, ask: null };
}

// The text with the given lines made blank, so every other line keeps its number.
export function blankLines(text, from, to) {
  return text.replace(/\r\n?/g, "\n").split("\n").map((l, i) => (i + 1 >= from && i + 1 <= to ? "" : l)).join("\n");
}
