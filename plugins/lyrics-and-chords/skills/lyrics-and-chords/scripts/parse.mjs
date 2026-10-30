// Lyrics & Chords: read one well-formed sheet and print ChordSheetJS's own JSON.
// Usage: node scripts/parse.mjs <file>      (or pipe text in on standard input)
// Optional: --format chordpro | chords-over-words | ultimate-guitar | lyrics-only
// The detected format goes to standard error; the JSON goes to standard output.
import { readFileSync } from "node:fs";
import {
  ChordProParser,
  ChordsOverWordsParser,
  UltimateGuitarParser,
  ChordSheetSerializer,
} from "./lib/chordsheetjs.mjs";
import { CHORD, MARK, SECTION_HEADER, chordTokens } from "./chord-words.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/parse.mjs <file>        (or pipe the text in on standard input)
       node scripts/parse.mjs --format chordpro | chords-over-words | ultimate-guitar | lyrics-only <file>

Reads one lyric or chord sheet and prints ChordSheetJS's JSON on standard output.
The format is picked from the text unless --format is given. Notes (the format picked, repairs made)
go to standard error.

lyrics-only is for text that has no chords at all (a page's lyrics): a line that is just [Something] is a
section header, every other line is a lyric, and no word is ever read as a chord. [Verse 1: Name] becomes
the section "Verse 1" plus a comment line holding the performer. Pages loaded by load.mjs use it.

Repairs made on the way: a chord line the library cannot give back exactly as written (G(maj7), Em7(♭5)/D) is read by this skill; section labels written without brackets (V1, VERSE 1, Chorus) are read as headers;
a line of two or more bracketed chords in an Ultimate Guitar style sheet is
read as a chord line; a section runs from its header to the next header, across blank lines; padding
spaces on chords are trimmed.

Exit codes: 0 done; 1 could not parse (the message gives the line, column and a hint); 2 unknown format.`);
  process.exit(0);
}
let forced = null;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--format") forced = args[++i];
  else files.push(args[i]);
}

let text = (files.length ? readFileSync(files[0], "utf8") : readFileSync(0, "utf8"))
  .replace(/^﻿/, "")
  .replace(/\r\n?/g, "\n");

// A header with a note after it, "[VERSE 5] (sung quietly)" or "[Chorus] [twice]", is the header with a note
// ("[VERSE 5: sung quietly]"): the note becomes a comment after the section start, as a performer does.
// Only a note wrapped in ( ) or [ ] counts: any other text after a header might be a lyric.
{
  let withNote = 0;
  text = text.split("\n").map((line) => {
    const m = line.match(/^(\s*)\[([^\]]+)\]\s+[(\[]([^()\[\]]+)[)\]]\s*$/);
    if (!m || m[2].trim().split(/\s+/).every((w) => CHORD.test(w) || MARK.test(w))) return line;
    withNote++;
    return `${m[1]}[${m[2].trim()}${m[2].includes(":") ? "; " : ": "}${m[3].trim()}]`;
  }).join("\n");
  if (withNote) console.error(`note: ${withNote} header(s) with a note after them were read as headers with a comment`);
}

function detect(t) {
  if (/^\s*\{\s*[a-z_]+\s*(:|\})/im.test(t)) return "chordpro";
  if (/\[[A-G][^\]\s]*\]/.test(t) && !/^\s*\[[^\]]+\]\s*$/m.test(t)) return "chordpro";
  // Chords inside lines of words ("[Am]word [C]word") with [Header] lines of their own: ChordPro style,
  // with the headers turned into sections before reading.
  const inline = t.split("\n").some((l) => !/^\s*\[[^\]]+\]\s*$/.test(l) && l.replace(/\[[^\]]*\]/g, "").trim() && /\[[A-G][^\]\s]*\]/.test(l));
  if (inline) return "chordpro";
  if (/^\s*\[[^\]]+\]\s*$/m.test(t)) return "ultimate-guitar";
  return "chords-over-words";
}

const parsers = {
  chordpro: ChordProParser,
  "chords-over-words": ChordsOverWordsParser,
  "ultimate-guitar": UltimateGuitarParser,
};

let format = forced || detect(text);
if (!parsers[format] && format !== "lyrics-only") {
  console.error(`Unknown format "${format}". Use: ${[...Object.keys(parsers), "lyrics-only"].join(", ")}`);
  process.exit(2);
}

// Section labels written without brackets (V1, VERSE 1, Chorus) are read by the chord readers as chords
// or as lyrics: "V1" becomes a "V" chord and a "1". Put each such label, and only a label standing on a
// line of its own, in brackets, keeping the writer's wording, so it is read as a section header.
// Not done for ChordPro, where a bracket means a chord, nor for a line under a chord line (that is a lyric).
function wrapBareHeaders(t) {
  let wrapped = 0;
  let previous = "";
  const lines = t.split("\n").map((line) => {
    const above = previous.trim().split(/\s+/).filter(Boolean);
    const underChords = above.length > 0 && above.every((w) => CHORD.test(w) || /^[|/x-]+$/.test(w));
    previous = line;
    if (!underChords && SECTION_HEADER.test(line)) {
      wrapped++;
      return `[${line.trim().replace(/\s*:$/, "")}]`;
    }
    return line;
  });
  return { text: lines.join("\n"), wrapped };
}
// Text that looks like Ultimate Guitar style (bracketed headers over chords and lyrics) is read with the
// chords-over-words reader, and its sections are built here from the header lines. The library's own
// Ultimate Guitar reader drops chord lines made of bar marks and takes a word such as CHORUS for a chord.
// Asking for ultimate-guitar with --format still uses the library's reader.
const ownSections = format === "ultimate-guitar" && !forced;
let bareLabels = 0;
if (format === "chords-over-words" || format === "chordpro" || ownSections) {
  const { text: wrappedText, wrapped } = wrapBareHeaders(text);
  if (wrapped) {
    text = wrappedText;
    bareLabels = wrapped;
    console.error(`note: ${wrapped} section label(s) written without brackets were read as headers`);
  }
}

// The Ultimate Guitar reader takes a line of bracketed chords such as "[D] [Am] [G/D]" for a
// section header and drops the chords. Read such a line (two or more brackets, all chords)
// as a line of chords above words instead, keeping every chord in the same column.
function readBracketChordLines(t) {
  let changed = 0;
  const fixed = t.split("\n").map((line) => {
    const groups = line.match(/\[[^\]]*\]/g);
    if (!groups || groups.length < 2 || line.replace(/\[[^\]]*\]/g, "").trim()) return line;
    const allChords = groups.every((g) => g.slice(1, -1).trim().split(/\s+/).every((tok) => CHORD.test(tok)));
    if (!allChords) return line;
    changed++;
    return line.replace(/[\[\]]/g, " ");
  });
  return { text: fixed.join("\n"), changed };
}

let toParse = text;
let savedChordLines = [];
if (format === "ultimate-guitar") {
  const { text: fixed, changed } = readBracketChordLines(text);
  toParse = fixed;
  if (changed) console.error(`note: ${changed} line(s) of bracketed chords were read as chords above words`);
}

// A section runs from its header to the next header, whatever blank lines lie between.
// Ultimate Guitar style: the reader ends a section at the first blank line, so a header
// followed by a blank line encloses nothing; its own end markers are replaced.
// ChordPro: only sections that are never closed are closed. Headers the reader keeps as
// comments (such as POST-CHORUS) become sections when they were headers in the original.
function restructureSections(lines, originalText, replaceEnds) {
  const headers = new Set(
    originalText.split("\n")
      .map((l) => (l.match(/^\s*\[([^\]]+)\]\s*$/) || [])[1])
      // In ChordPro a lone [C] is a chord; in Ultimate Guitar style chords have lines of their own, so a
      // lone [B] or [A] is a section header.
      .filter((h) => h && (replaceEnds || !h.trim().split(/\s+/).every((tok) => CHORD.test(tok))))
      .map((h) => h.trim().toLowerCase()),
  );
  const tag = (l) => (l.items.length === 1 && l.items[0].type === "tag" ? l.items[0] : null);
  const result = [];
  let open = null;
  let closed = 0;
  let promoted = 0;
  const close = () => {
    if (!open) return;
    let at = result.length;
    while (at > 0 && result[at - 1].items.length === 0) at--;
    result.splice(at, 0, { type: "line", items: [{ type: "tag", name: open.replace("start_of_", "end_of_"), value: "", attributes: {} }] });
    open = null;
  };
  for (const line of lines) {
    const t = tag(line);
    if (t && /^end_of_/.test(t.name)) {
      if (replaceEnds) continue;
      open = null;
    } else if (t && t.name === "comment" && headers.has(String(t.value).trim().toLowerCase())) {
      if (open) { close(); closed++; }
      promoted++;
      open = "start_of_part";
      result.push({ type: "line", items: [{ type: "tag", name: "start_of_part", value: t.value, attributes: {} }] });
      continue;
    } else if (t && /^start_of_/.test(t.name)) {
      if (open) { close(); closed++; }
      open = t.name;
    }
    result.push(line);
  }
  if (open) { close(); closed++; }
  return { lines: result, closed, promoted };
}

// The readers leave chords padded with the spaces of the chord line ("D  ", "      ").
// Trim them, and drop the items that are left with no chord and no lyric.
function tidyChords(lines) {
  let trimmed = 0;
  let dropped = 0;
  for (const line of lines) {
    for (const x of line.items) {
      if (x.type === "chordLyricsPair" && x.chords && x.chords.trim() !== x.chords) {
        x.chords = x.chords.trim();
        trimmed++;
      }
    }
    const kept = line.items.filter((x) => !(x.type === "chordLyricsPair" && !x.chords && !x.lyrics));
    dropped += line.items.length - kept.length;
    line.items = kept;
  }
  return { trimmed, dropped };
}

// Text with no chords: a line that is only [Something] opens a section, every other line is a lyric,
// and nothing is read as a chord. [Label: performers] gives the section "Label" and a comment holding
// the performers. Lines are kept exactly (a trailing carriage return is already gone).
// The library cannot be trusted with every chord line: one chord name it does not know (G(maj7)) and it keeps
// the whole line as lyric text; a half-known one (Em7(♭5)/D) it splits into pieces and rewrites. So before the
// library reads the text, each chord line it does not give back exactly as written is swapped for a placeholder
// line; afterwards the real chords are put back, attached to the lyric line below by column.
const PLACEHOLDER = /^@@CHORDLINE(\d+)@@$/;
function protectChordLines(t) {
  const saved = [];
  const lines = t.split("\n").map((line) => {
    const words = chordTokens(line).map((x) => x.text);
    if (!words.length || !words.every((w) => CHORD.test(w) || MARK.test(w))) return line;
    let exact = false;
    try {
      const alone = new ChordSheetSerializer().serialize(new ChordsOverWordsParser().parse(line));
      const pairs = alone.lines.flatMap((l) => l.items.filter((x) => x.type === "chordLyricsPair"));
      exact = pairs.map((x) => x.chords.trim()).filter(Boolean).join(" ") === words.join(" ") && !pairs.map((x) => x.lyrics).join("").trim();
      // a bar mark touching a chord ("Emaj7|") is not given back exactly: treat as not exact
      if (exact && /[^\s|]\||\|[^\s|]/.test(line)) exact = false;
    } catch {
      exact = false;
    }
    // A bar chart is the progression of its section, not chords to place on words: always keep it as written.
    if (exact && !words.includes("|")) return line;
    saved.push(line);
    return `@@CHORDLINE${saved.length - 1}@@`;
  });
  return { text: lines.join("\n"), saved };
}
function restoreChordLines(lines, saved) {
  const plain = (line) => (line && line.items.length === 1 && line.items[0].type === "chordLyricsPair" && !line.items[0].chords ? line.items[0].lyrics : null);
  const item = (chords, lyrics) => ({ type: "chordLyricsPair", chords, chord: null, lyrics, annotation: "" });
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const marked = (plain(lines[i]) || "").trim().match(PLACEHOLDER);
    if (!marked) { out.push(lines[i]); continue; }
    const raw = saved[Number(marked[1])];
    // A hold mark joins the chord before it ("G …"), written as it was.
    const tokens = [];
    for (const x of chordTokens(raw)) {
      const last = tokens[tokens.length - 1];
      if (last && /^(…|\.{2,})$/.test(x.text)) last[0] = raw.slice(last.index, x.index + x.text.length);
      else tokens.push(Object.assign([x.text], { index: x.index }));
    }
    const below = plain(lines[i + 1]);
    const bars = tokens.some((x) => /^\|+$/.test(x[0]));
    if (!bars && below !== null && below.trim() && !PLACEHOLDER.test(below.trim())) {
      const items = [];
      if (tokens[0].index > 0) items.push(item("", below.slice(0, tokens[0].index)));
      tokens.forEach((t, k) => items.push(item(t[0], below.slice(t.index, k + 1 < tokens.length ? tokens[k + 1].index : below.length))));
      out.push({ type: "line", items });
      i++;
    } else {
      out.push({ type: "line", items: tokens.map((t) => item(t[0], "")) });
    }
  }
  return out;
}

const tagLine = (name, value) => ({ type: "line", items: [{ type: "tag", name, value, attributes: {} }] });
function sectionStart(inner) {
  const trimmed = inner.trim();
  const colon = trimmed.indexOf(":");
  const label = (colon > 0 ? trimmed.slice(0, colon) : trimmed).trim();
  const performers = colon > 0 ? trimmed.slice(colon + 1).trim() : "";
  const kind = /^verse/i.test(label) ? "verse" : /^chorus/i.test(label) ? "chorus" : /^bridge/i.test(label) ? "bridge" : "part";
  return [tagLine(`start_of_${kind}`, label), ...(performers ? [tagLine("comment", performers)] : [])];
}
function readLyricsOnly(t) {
  const lines = [];
  for (const raw of t.replace(/\n+$/, "").split("\n")) {
    const header = raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      lines.push(...sectionStart(header[1]));
    } else if (!raw.trim()) {
      lines.push({ type: "line", items: [] });
    } else {
      lines.push({ type: "line", items: [{ type: "chordLyricsPair", chords: "", chord: null, lyrics: raw, annotation: "" }] });
    }
  }
  return { type: "chordSheet", lines };
}

// A fact written after the last lyric line ("Acknowledgements: ...", "Copyright: ...") belongs with the other facts at the top,
// not inside the last section. Only fact tags move (the known fact names, and "Label: value" lines the reader made into
// tags); sections, comments and directives stay where they are, and so does a fact in the middle of the song.
const KNOWN_FACTS = ["title", "subtitle", "artist", "composer", "lyricist", "writer", "copyright", "album", "year", "date", "version", "key", "time", "tempo", "duration", "capo"];
function liftTrailingFacts(lines) {
  const tagOf = (line) => (line.items.length === 1 && line.items[0].type === "tag" ? line.items[0] : null);
  const isFact = (tag) => tag && !/^(start_of_|end_of_)/.test(tag.name) && tag.name !== "comment" && (KNOWN_FACTS.includes(tag.name.toLowerCase()) || /^[A-Z]/.test(tag.name));
  const hasWords = (line) => line.items.some((x) => x.type === "chordLyricsPair" && (x.lyrics.trim() || x.chords));
  let lastWords = -1;
  lines.forEach((line, i) => { if (hasWords(line)) lastWords = i; });
  if (lastWords < 0) return 0;
  const moved = [];
  for (let i = lines.length - 1; i > lastWords; i--) {
    if (isFact(tagOf(lines[i]))) moved.unshift(...lines.splice(i, 1));
  }
  if (!moved.length) return 0;
  // after the facts that open the song
  let at = 0;
  for (let i = 0; i < lines.length && (isFact(tagOf(lines[i])) || !lines[i].items.length); i++) if (isFact(tagOf(lines[i]))) at = i + 1;
  lines.splice(at, 0, ...moved);
  return moved.length;
}

if (format === "chords-over-words" || format === "ultimate-guitar") {
  const protectedText = protectChordLines(toParse);
  toParse = protectedText.text;
  savedChordLines = protectedText.saved;
}

try {
  let json;
  if (format === "lyrics-only") {
    json = readLyricsOnly(text);
    json.lines = restructureSections(json.lines, "", false).lines;
    console.error(`format: ${format}`);
  } else {
    if (format === "chordpro") {
      // In ChordPro a bracket is a chord, so a line that is only [Verse 1] would become a chord. Turn such
      // header lines (a bracket holding something that is not all chords) into section directives.
      let headers = 0;
      toParse = toParse.split("\n").flatMap((line) => {
        const m = line.match(/^\s*\[([^\]]+)\]\s*$/);
        if (!m || m[1].trim().split(/\s+/).every((w) => CHORD.test(w) || MARK.test(w))) return [line];
        headers++;
        return sectionStart(m[1]).map((l) => `{${l.items[0].name}: ${l.items[0].value}}`);
      }).join("\n");
      if (headers) console.error(`note: ${headers} [Header] line(s) in ChordPro text were read as sections`);
    }
    const Reader = ownSections ? ChordsOverWordsParser : parsers[format];
    const song = new Reader().parse(toParse);
    console.error(`format: ${format}`);
    json = new ChordSheetSerializer().serialize(song);
    const tidy = tidyChords(json.lines);
    if (tidy.trimmed || tidy.dropped) console.error(`note: padding removed from ${tidy.trimmed} chord(s); ${tidy.dropped} empty item(s) dropped`);
    if (savedChordLines.length) {
      json.lines = restoreChordLines(json.lines, savedChordLines);
      console.error(`note: ${savedChordLines.length} chord line(s) the library cannot read exactly were read by this skill`);
    }
    if (bareLabels || ownSections) {
      // Header lines ([Verse 1], or labels put in brackets above) are lyric lines to this reader. Make them sections.
      json.lines = json.lines.flatMap((line) => {
        const only = line.items.length === 1 && line.items[0].type === "chordLyricsPair" && !line.items[0].chords ? line.items[0].lyrics : null;
        const header = only === null ? null : only.match(/^\s*\[([^\]]+)\]\s*$/);
        return header ? sectionStart(header[1]) : [line];
      });
      json.lines = restructureSections(json.lines, "", false).lines;
    }
    if ((format === "ultimate-guitar" && forced) || format === "chordpro") {
      const fixed = restructureSections(json.lines, text, format === "ultimate-guitar");
      json.lines = fixed.lines;
      if (fixed.promoted) console.error(`note: ${fixed.promoted} header(s) read as comments were made sections`);
    }
  }
  const lifted = liftTrailingFacts(json.lines);
  if (lifted) console.error(`note: ${lifted} fact line(s) after the last lyric line were moved up with the other facts`);
  console.log(JSON.stringify(json, null, 2));
} catch (err) {
  console.error(explain(err));
  process.exit(1);
}

// A readable account of a parse failure, for a writer rather than a programmer: one plain sentence
// that says where to look and how sure we are, the lines around it, and the parser's own words last.
// How sure: "very likely" when a bracket opened on the line the reader stopped at (or the one before)
// is never closed; "possibly" when it is a few lines back; otherwise only "look here".
function explain(err) {
  const where = err.location && err.location.start;
  if (!where) return `Could not read this as ${format}: ${err.message}`;
  const lines = text.split("\n");
  const found = err.found === null || err.found === undefined ? "the end of the text" : JSON.stringify(err.found);
  const wanted = [...new Set((err.expected || []).map((x) => (x.text !== undefined ? JSON.stringify(x.text) : x.description)).filter(Boolean))]
    .slice(0, 6)
    .join(" or ");

  // The nearest line at or before the stop with a bracket that is opened and not closed.
  let unclosed = null;
  for (let n = where.line; n >= Math.max(1, where.line - 3) && !unclosed; n--) {
    const line = lines[n - 1] || "";
    for (const [open, close] of [["[", "]"], ["{", "}"]]) {
      if (line.split(open).length > line.split(close).length) {
        unclosed = { n, open, close, certainty: n >= where.line - 1 ? "very likely" : "possibly" };
        break;
      }
    }
  }
  const out = [
    unclosed
      ? `Line ${unclosed.n} has a "${unclosed.open}" that is never closed with "${unclosed.close}". This is ${unclosed.certainty} the problem. Close it, or take it out if it was meant to be something else.`
      : `The reader could not make sense of the text at line ${where.line}. Look at that line, and the one before it.`,
  ];
  const first = Math.max(1, Math.min(where.line, unclosed ? unclosed.n : where.line) - 1);
  const last = Math.min(lines.length, where.line);
  for (let n = first; n <= last; n++) out.push(`  line ${n}: ${lines[n - 1]}`);
  if (!forced) {
    const others = Object.keys(parsers).filter((f) => f !== format).join(" or ");
    out.push(`The file was read as ${format}, which was a guess. If that is wrong, run again with --format ${others}.`);
  }
  out.push(`Detail: the reader stopped at line ${where.line}, column ${where.column}. It found ${found}${wanted ? ` and expected ${wanted}` : ""}.`);
  return out.join("\n");
}
