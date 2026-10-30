// Lyrics & Chords: load a song in one step.
// Usage: node scripts/load.mjs <file | Word file | ->     ("-" reads pasted text on standard input)
//        node scripts/load.mjs <file> --facts facts.json --set-aside 1,2 --as chordpro --output song.cho
// Runs the separate scripts in order: parse, set aside, add facts, check, write out.
// The separate scripts still work on their own; this one only chains them.
// Prints one JSON result on standard output. Exit codes: 0 loaded (status ok or needs-info);
// 1 failed (see "problems"); 2 bad option.
// Everything runs locally; nothing is fetched from the web.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, openSync, readSync, closeSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLineList } from "./lyric-lines.mjs";
import { findChart, blankLines } from "./chart-block.mjs";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/load.mjs <file | Word file | -> [options]

Loads a lyric or chord sheet: parse, set aside non-lyric lines, add song facts, check that the
lyrics and chords are intact, and optionally write the song out. "-" reads pasted text from
standard input. A Word file (.docx) is read for its text only: one line for each paragraph; comments,
deleted text and formatting are ignored. Everything runs locally; nothing is fetched or stored beyond the run.

Options:
  --facts FILE      JSON file of song facts (title, artist, lyricist, composer, date, ... see add-metadata.mjs).
  --set-aside LIST  Original line numbers that are not lyrics (a title, a credit line), such as 1,2.
  --chart FROM-TO   Lines that are a chord chart, not lyrics, such as 10-28. They are set aside and given as "chart".
  --keep-chart      Do not look for a chord chart, and do not ask about one.
  --format NAME     Force the reader: chordpro, chords-over-words, ultimate-guitar or lyrics-only.
  --as NAME         Also write the song out: text, chordpro, chords-over-words or lyrics-only.
  --output FILE     With --as, save the written song to FILE instead of putting it in the result.
  --save FOLDER     Save the song as a readable file in FOLDER (made if missing), named "<title> - <artist>.txt".
                    FOLDER can be "default": the user's Documents folder (macOS and Windows), else Desktop, else
                    the home folder. A leading ~/ means the home folder.
                    with the chords above the words if the song has chords. An existing file is never replaced:
                    a number is added to the name. The result gives "savedTo".
  --open            With --save, open the saved file in the computer's default app.
  --help            Show this message.

Result (JSON on standard output):
  status     "ok", "needs-info" (loaded, but a title, credits or date is missing) or "failed"
  missing    which of title, credits, date are not in the song (never copyright)
  questions  plain questions for the writer, one for each missing item
  problems   why it failed (parse or check problems), or empty
  notes      what the reader repaired or noticed
  setAside   the lines set aside, if any
  chart      a chord chart found in front of the lyrics: its first and last line and its text (see below)
  song       the loaded song (not given when status is "failed")
  output     the written song, when --as is given without --output
  savedTo    the file written by --save

A chord chart in front of the lyrics (a "Chords" or "Chart" heading, bar lines, notes such as "2x repeat",
then a "Lyrics" heading) is set aside on its own and given in "chart", with the line numbers kept. When four or
more chord-only rows come before any lyric line and there are no such headings, nothing is changed and a
question asks the writer: answer it with --chart FROM-TO (set them aside) or --keep-chart (keep them).

Exit codes: 0 loaded; 1 failed; 2 bad option.`);
  process.exit(0);
}

const here = fileURLToPath(new URL(".", import.meta.url));
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
// "default" is the user's Documents folder (the same name on macOS and Windows), else Desktop, else home.
const saveFolder = (name) => {
  const home = homedir();
  if (name === "default") {
    for (const folder of ["Documents", "Desktop"]) if (existsSync(join(home, folder))) return join(home, folder);
    return home;
  }
  if (name === "~") return home;
  return /^~[\\/]/.test(name) ? join(home, name.slice(2)) : name;
};
const flagsWithValue = ["--facts", "--set-aside", "--chart", "--format", "--as", "--output", "--save"];
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && flagsWithValue.includes(args[i - 1])));

if (positional.length !== 1) {
  console.error("Error: give one file to load, or - to read pasted text from standard input. See --help.");
  process.exit(2);
}
const asValue = value("--as");
if (asValue && !["text", "chordpro", "chords-over-words", "lyrics-only"].includes(asValue)) {
  console.error(`Error: --as must be text, chordpro, chords-over-words or lyrics-only. Received: "${asValue}"`);
  process.exit(2);
}
if (args.includes("--open") && !value("--save")) {
  console.error("Error: --open needs --save, to say which file to open. See --help.");
  process.exit(2);
}
if (value("--output") && !asValue) {
  console.error("Error: --output needs --as, to say what to write. See --help.");
  process.exit(2);
}
const setAsideList = value("--set-aside");
if (setAsideList && !parseLineList(setAsideList)) {
  console.error(`Error: --set-aside must be line numbers such as 1,2 or 1-3,7. Received: "${setAsideList}"`);
  process.exit(2);
}

const chartLines = value("--chart");
const chartRange = chartLines && chartLines.match(/^(\d+)-(\d+)$/);
if (chartLines && (!chartRange || Number(chartRange[1]) < 1 || Number(chartRange[2]) < Number(chartRange[1]))) {
  console.error(`Error: --chart must be a range of line numbers such as 10-28. Received: "${chartLines}"`);
  process.exit(2);
}

// Pasted text, and the text of a Word file, goes to a temporary file, so every step reads
// the same original. The temporary folder is removed at the end.
const given = positional[0]; // as the writer named it; `original` may become a temporary copy of a Word file
let original = given;
let tempDir = null;
if (original === "-") {
  tempDir = mkdtempSync(join(tmpdir(), "lyrics-and-chords-"));
  original = join(tempDir, "pasted.txt");
  writeFileSync(original, readFileSync(0, "utf8"));
}
let factsPath = value("--facts");
const isWordFile = (path) => {
  try {
    const fd = openSync(path, "r");
    const head = Buffer.alloc(4);
    readSync(fd, head, 0, 4, 0);
    closeSync(fd);
    return head.toString("latin1") === "PK\x03\x04"; // a zip file; read-docx.mjs decides if it is Word
  } catch {
    return false;
  }
};

const run = (script, scriptArgs, input) =>
  spawnSync(process.execPath, [join(here, script), ...scriptArgs], { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
const lines = (text) => text.split("\n").map((l) => l.trim()).filter(Boolean);

class Stop extends Error {}
const result = { status: "failed", missing: [], questions: [], problems: [], notes: [], setAside: [] };
const finish = (code) => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  const summary =
    result.status === "failed"
      ? `load: failed (${result.problems.length} problem(s), see output)`
      : `load: ${result.status}${result.missing.length ? ` (missing: ${result.missing.join(", ")})` : ""}`;
  // Write everything out before exiting (a large result cut short would be unreadable), then the summary.
  process.stdout.write(JSON.stringify(result, null, 2) + "\n", () => {
    console.error(summary);
    process.exit(code);
  });
  throw new Stop(); // nothing after finish() may run
};
const fail = (kind, message) => {
  result.problems.push({ kind, message });
  finish(1);
};

try {
  // A. Is it something we can read at all? Say so plainly if not (the file kinds are told apart by their first bytes).
  let bytes;
  try {
    bytes = readFileSync(original);
  } catch (err) {
    const why = err.code === "ENOENT" ? "there is no file with that name. Check the name and the folder."
      : err.code === "EISDIR" ? "that is a folder, not a file."
      : `it can't be read (${err.code || err.message}).`;
    fail("file", `I can't open ${given === "-" ? "the pasted text" : `"${given}"`}: ${why}`);
  }
  const named = given === "-" ? "This" : `"${basename(given)}"`;
  const head = bytes.subarray(0, 8);
  const starts = (text) => head.toString("latin1").startsWith(text);
  const zipped = starts("PK\x03\x04");
  const tryInstead = "The skill reads plain text, ChordPro and Word (.docx) files. Save the song in one of those, or paste the text.";
  if (starts("%PDF")) fail("file", `${named} is a PDF. ${tryInstead}`);
  if (head.toString("hex") === "d0cf11e0a1b11ae1") fail("file", `${named} is an old Word file (.doc). Open it in Word and save it as .docx, or paste the text.`);
  if (starts("{\\rtf")) fail("file", `${named} is a Rich Text (.rtf) file. ${tryInstead}`);
  if (!zipped && bytes.subarray(0, 1000).includes(0)) fail("file", `${named} does not look like a text file. ${tryInstead}`);
  if (!zipped && bytes.toString("utf8").trim() === "") fail("file", `${named} is empty, or has only blank lines, so there is nothing to load.`);

  // 0. A Word file: take its text (one line for each paragraph) and carry on with that.
  if (!tempDir && isWordFile(original)) {
    const word = run("read-docx.mjs", [original]);
    if (word.status !== 0) fail("word", word.stderr.trim());
    const read = JSON.parse(word.stdout);
    tempDir = mkdtempSync(join(tmpdir(), "lyrics-and-chords-"));
    original = join(tempDir, "word-text.txt");
    writeFileSync(original, read.text);
    result.source = { type: "word" };
    result.notes.push(...read.notes);
  }

  // 0b. A chord chart in front of the lyrics is not part of the song. Its lines are blanked in a copy of the text,
  // so every other line keeps its number, and the chart is given as its own part of the result.
  if (!args.includes("--keep-chart")) {
    const text = readFileSync(original, "utf8");
    const found = findChart(text);
    const block = chartRange ? { from: Number(chartRange[1]), to: Number(chartRange[2]) } : found.block;
    if (block) {
      const copy = text.replace(/\r\n?/g, "\n").split("\n");
      result.chart = { from: block.from, to: block.to, text: copy.slice(block.from - 1, block.to).join("\n") };
      result.setAside.push(`lines ${block.from}-${block.to}: a chord chart, kept in "chart"`);
      result.notes.push(`note: lines ${block.from}-${block.to} are a chord chart; they were set aside, and the lyrics start after them`);
      tempDir = tempDir || mkdtempSync(join(tmpdir(), "lyrics-and-chords-"));
      original = join(tempDir, "without-chart.txt");
      writeFileSync(original, blankLines(text, block.from, block.to));
    } else if (found.ask) {
      result.questions.push(`Lines ${found.ask.from} to ${found.ask.to} look like a chord chart, not lyrics. Should I set them aside, or keep them as part of the song?`);
    }
  }

  // 1. Read the sheet.
  const readerFormat = value("--format");
  const parsed = run("parse.mjs", [original, ...(readerFormat ? ["--format", readerFormat] : [])]);
  result.notes.push(...lines(parsed.stderr).filter((l) => l.startsWith("note:") || l.startsWith("format:")));
  if (parsed.status !== 0) {
    // Name the file (a pasted text has none), and leave out the progress notes.
    const body = lines(parsed.stderr).filter((l) => !l.startsWith("note:") && !l.startsWith("format:")).join("\n").trim();
    fail("parse", given === "-" ? body : `In ${basename(given)}: ${body}`);
  }
  let song = parsed.stdout;

  // 2. Set aside lines that are not lyrics.
  if (setAsideList) {
    const aside = run("set-aside.mjs", ["--original", original, "--lines", setAsideList], song);
    if (aside.status !== 0) fail("set-aside", aside.stderr.trim());
    song = aside.stdout;
    result.setAside = lines(aside.stderr).filter((l) => l.startsWith("line ") || l.startsWith("  line ")).map((l) => l.replace(/^\s+/, ""));
  }

  // 3. Add the song facts.
  if (factsPath) {
    const facts = run("add-metadata.mjs", ["--meta", factsPath], song);
    if (facts.status !== 0) fail("facts", facts.stderr.trim());
    song = facts.stdout;
  }

  // 4. Check that the lyrics and chords are intact.
  const checked = run("check.mjs", ["--original", original, ...(setAsideList ? ["--set-aside", setAsideList] : [])], song);
  if (checked.status === 2 || !checked.stdout.trim()) fail("check", checked.stderr.trim());
  const checkResult = JSON.parse(checked.stdout);
  if (!checkResult.ok) {
    result.problems = checkResult.problems;
    finish(1);
  }

  // 5. Report what is missing. Copyright is never asked for.
  const songJson = JSON.parse(song);
  const tags = new Set(songJson.lines.flatMap((l) => l.items.filter((x) => x.type === "tag" && x.value).map((x) => x.name)));
  const wanted = [
    ["title", ["title"], "What is the title of the song?"],
    ["credits", ["artist", "lyricist", "composer"], "Who wrote or performs it (artist, lyricist or composer)?"],
    ["date", ["year", "date"], "When was it written or published?"],
  ];
  for (const [name, tagNames, question] of wanted) {
    if (!tagNames.some((t) => tags.has(t))) {
      result.missing.push(name);
      result.questions.push(question);
    }
  }
  result.status = result.questions.length ? "needs-info" : "ok";
  result.song = songJson;

  // 6. Write the song out, if asked.
  if (asValue) {
    const written = run("format.mjs", ["--as", asValue], song);
    if (written.status !== 0) fail("format", written.stderr.trim());
    if (value("--output")) {
      writeFileSync(value("--output"), written.stdout);
      result.notes.push(`wrote ${asValue} to ${value("--output")}`);
    } else {
      result.output = written.stdout;
    }
  }
  // 7. Save a readable copy for the user to open (for a song whose lyrics are not to be printed in chat).
  if (value("--save")) {
    const hasChords = songJson.lines.some((l) => l.items.some((x) => x.type === "chordLyricsPair" && x.chords));
    const readable = run("format.mjs", ["--as", hasChords ? "chords-over-words" : "text"], song);
    if (readable.status !== 0) fail("save", readable.stderr.trim());
    const factValue = (name) => {
      for (const l of songJson.lines) for (const x of l.items) if (x.type === "tag" && x.name === name && x.value) return String(x.value);
      return "";
    };
    const clean = (t) => t.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
    const base = clean([factValue("title"), factValue("artist")].filter(Boolean).join(" - ")) || "song";
    const folder = saveFolder(value("--save"));
    mkdirSync(folder, { recursive: true });
    let target = join(folder, `${base}.txt`);
    for (let n = 2; existsSync(target); n++) target = join(folder, `${base} (${n}).txt`);
    writeFileSync(target, readable.stdout);
    result.savedTo = target;
    result.notes.push(`saved ${hasChords ? "with chords" : "as text"} to ${target}`);
    if (args.includes("--open")) {
      const opener = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
      try {
        const child = spawn(opener[0], opener[1], { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
        result.notes.push("opened the file");
      } catch {
        result.notes.push("could not open the file; it is saved at the path above");
      }
    }
  }
  finish(0);
} catch (err) {
  if (!(err instanceof Stop)) throw err;
}
