// Lyrics & Chords: take the text out of a Word (.docx) file.
// Usage: node scripts/read-docx.mjs song.docx
// Only the text is used: one line for each paragraph, a tab as a space. Comments, deleted text,
// formatting, styles and tables as such are ignored (text inside a table still comes out, one line
// per paragraph). Nothing is run or opened beyond reading the file's zip.
// Prints {"text", "notes"} on standard output.
// Exit codes: 0 read; 1 not a Word file this script can read; 2 bad option or unreadable file.
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h") || args.length !== 1) {
  console.log(`Usage: node scripts/read-docx.mjs <song.docx>

Takes the text out of a Word file: one line for each paragraph, a tab as a space.
Ignored: comments, deleted text (tracked changes), formatting, styles, pictures, headers and footers.

Output (JSON): text, notes (what was read).

Exit codes: 0 read; 1 not a Word file this script can read; 2 bad option or unreadable file.`);
  process.exit(args.includes("--help") || args.includes("-h") ? 0 : 2);
}

let buffer;
try {
  buffer = readFileSync(args[0]);
} catch (err) {
  console.error(`Error: cannot read the file: ${err.message}`);
  process.exit(2);
}

const notWord = (why) => {
  console.error(`Error: this is not a Word (.docx) file I can read (${why}). Save it as .docx, or paste the text.`);
  process.exit(1);
};

// Find one file inside the zip by name, using the zip's own directory at the end of the file.
function zipEntry(buf, wanted) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return null;
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    if (name === wanted) {
      if (buf.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      return null;
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

let xml;
try {
  if (buffer.readUInt32LE(0) !== 0x04034b50) notWord("it is not a zip file");
  const entry = zipEntry(buffer, "word/document.xml");
  if (!entry) notWord("it has no word/document.xml");
  xml = entry.toString("utf8");
} catch (err) {
  notWord(err.message);
}

const decode = (s) =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e];
  });

// A drawing's text box may appear twice (the drawing and a fallback copy): keep one.
xml = xml.replace(/<mc:Fallback[\s\S]*?<\/mc:Fallback>/g, "");

const lines = [];
let current = null;
let deleted = 0;
const token = /<w:p(\s[^>]*?)?(\/)?>|<\/w:p>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/?>|<w:del(?:\s[^>]*)?>|<\/w:del>/g;
for (const m of xml.matchAll(token)) {
  const t = m[0];
  if (t.startsWith("<w:p") && !t.startsWith("<w:pPr") && !t.startsWith("<w:pStyle")) {
    if (m[2]) lines.push("");
    else current = "";
  } else if (t === "</w:p>") {
    if (current !== null) lines.push(current);
    current = null;
  } else if (t.startsWith("<w:del") && !t.startsWith("<w:delText")) {
    if (!t.endsWith("/>")) deleted++; // a self-closing <w:del/> only marks a deleted paragraph mark
  } else if (t === "</w:del>") {
    deleted = Math.max(0, deleted - 1);
  } else if (m[3] !== undefined) {
    if (!deleted && current !== null) current += decode(m[3]);
  } else if (t === "<w:tab/>") {
    if (!deleted && current !== null) current += " ";
  } else if (t.startsWith("<w:br") || t.startsWith("<w:cr")) {
    if (!deleted && current !== null) { lines.push(current); current = ""; }
  }
}
if (current !== null) lines.push(current);

const text = lines.join("\n").replace(/\n+$/, "") + "\n";
if (!text.trim()) notWord("it has no text");
console.log(JSON.stringify({ text, notes: [`read a Word file: ${lines.length} paragraph line(s)`] }, null, 2));
