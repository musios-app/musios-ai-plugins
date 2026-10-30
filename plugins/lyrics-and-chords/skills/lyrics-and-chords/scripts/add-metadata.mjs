// Lyrics & Chords: add song facts (title, credits, key, tempo...) to parsed JSON.
// Usage: node scripts/parse.mjs song.txt | node scripts/add-metadata.mjs --meta facts.json
// facts.json is a flat object, for example:
//   { "title": "Because", "artist": "Guy d'Hardelot", "lyricist": ["A", "B"], "key": "G", "tempo": "124 bpm" }
// The lyric lines are never touched. Facts already in the song with the same name are replaced.
import { readFileSync } from "node:fs";

const ALLOWED = [
  "title", "subtitle", "artist", "composer", "lyricist", "copyright",
  "writer", "album", "year", "date", "version", "key", "time", "tempo", "duration", "capo",
];

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/parse.mjs <song> | node scripts/add-metadata.mjs --meta <facts.json>

Adds song facts as metadata lines at the top of the parsed JSON.
Reads the parsed JSON on standard input; writes the updated JSON to standard output.

Options:
  --meta FILE   JSON file: a flat object of fact names to a text value or a list of text values.
  --help        Show this message.

Allowed fact names: ${ALLOWED.join(", ")}
Values are kept exactly as given, so write the unit in: "tempo": "124 bpm".
Empty values (null, "", []) are skipped. Any other name is an error.

Exit codes: 0 done; 1 input could not be read; 2 bad option or bad facts file.`);
  process.exit(0);
}

const at = args.indexOf("--meta");
if (at < 0 || !args[at + 1]) {
  console.error("Error: --meta FILE is required. Example: --meta facts.json (see --help).");
  process.exit(2);
}

let facts;
try {
  facts = JSON.parse(readFileSync(args[at + 1], "utf8"));
} catch (err) {
  console.error(`Error: cannot read facts file "${args[at + 1]}": ${err.message}`);
  process.exit(2);
}
if (facts === null || typeof facts !== "object" || Array.isArray(facts)) {
  console.error("Error: the facts file must hold one JSON object, such as {\"title\": \"...\"}.");
  process.exit(2);
}
const unknown = Object.keys(facts).filter((k) => !ALLOWED.includes(k));
if (unknown.length) {
  console.error(`Error: unknown fact name(s): ${unknown.join(", ")}.\nAllowed: ${ALLOWED.join(", ")}`);
  process.exit(2);
}

let song;
try {
  song = JSON.parse(readFileSync(0, "utf8"));
  if (song.type !== "chordSheet" || !Array.isArray(song.lines)) throw new Error("not parsed song JSON");
} catch (err) {
  console.error(`Error: standard input must be the JSON from parse.mjs (${err.message}).`);
  process.exit(1);
}

const values = (v) => (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined && String(x).trim() !== "");
const tagLine = (name, value) => ({ type: "line", items: [{ type: "tag", name, value: String(value), attributes: {} }] });

const names = Object.keys(facts).filter((k) => values(facts[k]).length);
const replaced = new Set(names);
const kept = song.lines.filter((l) => !(l.items.length === 1 && l.items[0].type === "tag" && replaced.has(l.items[0].name)));
song.lines = [...names.flatMap((k) => values(facts[k]).map((v) => tagLine(k, v))), ...kept];

console.error(`added: ${names.join(", ") || "(nothing)"}`);
console.log(JSON.stringify(song, null, 2));
