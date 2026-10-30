// Lyrics & Chords: turn ChordSheetJS JSON (from parse.mjs) back into text.
// Usage: node scripts/parse.mjs song.txt | node scripts/format.mjs [--as text | chordpro | chords-over-words | lyrics-only]
// Chord names are written exactly as they were read.
import { readFileSync } from "node:fs";
import {
  ChordSheetSerializer,
  TextFormatter,
  ChordProFormatter,
  ChordsOverWordsFormatter,
} from "./lib/chordsheetjs.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/parse.mjs <song> | node scripts/format.mjs [--as text | chordpro | chords-over-words | lyrics-only]

Writes the parsed song (the JSON from parse.mjs, on standard input) back out as text.
Chord names are written exactly as they were read.

Options:
  --as NAME   text (default), chordpro, chords-over-words or lyrics-only.
              lyrics-only writes the words only: the song facts as "Key: value" lines, then each section as a
              [Label: Performer] line and its lyric lines, blocks apart by a blank line. No chords or comments.
  --help      Show this message.

Exit codes: 0 done; 1 could not format (input is not parsed song JSON); 2 unknown output.`);
  process.exit(0);
}
const as = args.includes("--as") ? args[args.indexOf("--as") + 1] : "text";
const formatters = {
  text: TextFormatter,
  chordpro: ChordProFormatter,
  "chords-over-words": ChordsOverWordsFormatter,
};
// The words only, for a reader that wants plain lyrics (the Songwriting Coach's rhyme and rhythm script):
//   Key: value          one line for each song fact, in the order they come in the song
//   (lines outside any section, if there are any, under no header; a blank line keeps the stanzas apart)
//   [Label: Performer]  one block for each section, then its lyric lines, with one blank line between blocks
// No chords, bar marks, repeat marks or comment lines. A section with no lyric lines is its [Label] line alone.
// Words and punctuation are copied exactly; runs of spaces become one.
const FACT_NAMES = ["title", "subtitle", "artist", "composer", "lyricist", "writer", "copyright", "album", "year", "date", "version", "key", "time", "tempo", "duration", "capo"];
const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1);
function lyricsOnly(json) {
  const facts = [];
  const loose = [];
  const blocks = [];
  let current = null;
  let justOpened = false; // a comment straight after a section start holds its performers
  for (const line of json.lines) {
    const tag = line.items.length === 1 && line.items[0].type === "tag" ? line.items[0] : null;
    if (tag && /^start_of_/.test(tag.name)) {
      current = { header: tag.value || capital(tag.name.replace(/^start_of_/, "")), lines: [] };
      blocks.push(current);
      justOpened = true;
    } else if (tag && tag.name === "comment") {
      if (justOpened && current && tag.value) current.header += `: ${tag.value}`;
      justOpened = false;
    } else if (tag) {
      justOpened = false;
      if (/^end_of_/.test(tag.name)) current = null;
      else if (FACT_NAMES.includes(tag.name) && String(tag.value).trim()) facts.push(`${capital(tag.name)}: ${String(tag.value).trim()}`);
    } else {
      justOpened = false;
      const text = line.items.map((x) => (x.type === "chordLyricsPair" ? x.lyrics : "")).join("").replace(/\s+/g, " ").trim();
      if (current) {
        if (text) current.lines.push(text);
      } else if (text || (loose.length && loose[loose.length - 1])) {
        loose.push(text);
      }
    }
  }
  while (loose.length && !loose[loose.length - 1]) loose.pop();
  const parts = [];
  if (facts.length) parts.push(facts.join("\n"));
  if (loose.length) parts.push(loose.join("\n"));
  for (const b of blocks) parts.push([`[${b.header}]`, ...b.lines].join("\n"));
  return parts.join("\n\n");
}
if (as !== "lyrics-only" && !formatters[as]) {
  console.error(`Unknown output "${as}". Use: ${[...Object.keys(formatters), "lyrics-only"].join(", ")}`);
  process.exit(2);
}
try {
  const json = JSON.parse(readFileSync(0, "utf8"));
  if (as === "lyrics-only") {
    process.stdout.write(lyricsOnly(json) + "\n");
    process.exit(0);
  }
  const song = new ChordSheetSerializer().deserialize(json);
  // The library rewrites chord names by default (maj7 becomes ma7, min7 becomes m7). Turn that off:
  // chords are written as they were read.
  const keepChords = { normalizeChords: false, normalizeChordSuffix: false };
  process.stdout.write(new formatters[as](keepChords).format(song) + "\n");
} catch (err) {
  console.error(`Could not format: ${err.message}`);
  process.exit(1);
}
