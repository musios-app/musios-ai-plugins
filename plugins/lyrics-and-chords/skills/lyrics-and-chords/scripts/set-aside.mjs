// Lyrics & Chords: take lines that are not lyrics (title, credits...) out of a parsed song.
// Usage: node scripts/parse.mjs song.txt | node scripts/set-aside.mjs --original song.txt --lines 1,2
// The lines are named by their line number in the original text, never retyped.
// Prints the updated song JSON on standard output and the lines set aside on standard error.
// Exit codes: 0 done; 1 a named line is not a lyric line in the song (nothing is changed); 2 bad option or input.
import { readFileSync } from "node:fs";
import { songLyrics, originalLines, matchInOrder, parseLineList } from "./lyric-lines.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/parse.mjs <song> | node scripts/set-aside.mjs --original <song> --lines 1,2

Removes lines from the song's lyrics because they are not lyrics (a title, a credit line).
The lines are named by their line number in the original text. Ranges work: 1-3,7.
Pass the same --lines to check.mjs as --set-aside so it knows they were removed on purpose.

Options:
  --original FILE   The text the song was parsed from (required).
  --lines LIST      Line numbers in the original to set aside (required).
  --help            Show this message.

The updated song goes to standard output; the removed lines are listed on standard error.
Nothing is changed if any named line is not a lyric line in the song.

Exit codes: 0 done; 1 a named line is not a lyric line (for example a header or blank line); 2 bad option or input.`);
  process.exit(0);
}

const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
if (!value("--original") || !value("--lines")) {
  console.error("Error: --original FILE and --lines LIST are both required. Example: --original song.txt --lines 1,2 (see --help).");
  process.exit(2);
}
const wanted = parseLineList(value("--lines"));
if (!wanted) {
  console.error(`Error: --lines must be line numbers such as 1,2 or 1-3,7. Received: "${value("--lines")}"`);
  process.exit(2);
}

let original, song;
try {
  original = readFileSync(value("--original"), "utf8");
} catch (err) {
  console.error(`Error: cannot read the original "${value("--original")}": ${err.message}`);
  process.exit(2);
}
try {
  song = JSON.parse(readFileSync(0, "utf8"));
  if (song.type !== "chordSheet" || !Array.isArray(song.lines)) throw new Error("not parsed song JSON");
} catch (err) {
  console.error(`Error: standard input must be the JSON from parse.mjs (${err.message}).`);
  process.exit(2);
}

const lyrics = songLyrics(song);
const orig = originalLines(original);
const { matchedAt } = matchInOrder(lyrics, orig);
const byOriginalLine = new Map([...matchedAt].map(([lyricIndex, k]) => [orig[k].n, lyricIndex]));

const notLyrics = wanted.filter((n) => !byOriginalLine.has(n));
if (notLyrics.length) {
  console.error(
    `Error: nothing changed. Original line(s) ${notLyrics.join(", ")} are not lyric lines in the song` +
    ` (they may be a header, a blank line, a chord line or a fact already read).\n` +
    notLyrics.map((n) => `  line ${n}: ${orig[n - 1] ? orig[n - 1].raw : "(past the end of the file)"}`).join("\n"),
  );
  process.exit(1);
}

const drop = new Set(wanted.map((n) => lyrics[byOriginalLine.get(n)].lineIndex));
song.lines = song.lines.filter((_, i) => !drop.has(i));
console.error(`set aside ${wanted.length} line(s), now not part of the lyrics:`);
wanted.forEach((n) => console.error(`  line ${n}: ${orig[n - 1].raw.trim()}`));
console.log(JSON.stringify(song, null, 2));
