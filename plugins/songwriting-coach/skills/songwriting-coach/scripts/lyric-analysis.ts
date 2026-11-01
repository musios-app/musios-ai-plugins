/**
 * Lyric analysis — runs locally, no network.
 * ==========================================
 *
 * Run with Node 22.6+ (type stripping; on Node < 22.18 add --experimental-strip-types):
 *   node scripts/lyric-analysis.ts parse       <lyrics-file | ->
 *   node scripts/lyric-analysis.ts rhyme-map   <lyrics-file | -> [--title "Song title"] [--out DIR]
 *   node scripts/lyric-analysis.ts rhythm-map  <lyrics-file | -> [--time 3/4] [--out DIR]
 *   node scripts/lyric-analysis.ts status-board <status.jsonl> [--add '<json line>']... [--view status|summary|detailed] [--out DIR]
 *     (rhythm-map is not used by the skill yet — its SVG output isn't working; see TODO.md)
 *
 * Results are printed as JSON. rhyme-map also writes <song>-rhyme-map.html and
 * rhythm-map writes <song>-rhythm-map.svg to the output folder
 * (default: /mnt/user-data/outputs if it exists, otherwise the current folder).
 *
 * cmudict.json.gz: the CMU Pronouncing Dictionary (cmudict-LICENSE.txt), as packaged
 * by the cmu-pronouncing-dictionary npm package 3.0.0 (cmu-pronouncing-dictionary-LICENSE.txt).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ─── Constants ────────────────────────────────────────────────────────────────

const VOWELS = new Set([
  "AA","AE","AH","AO","AW","AY","EH","ER","EY","IH","IY","OW","OY","UH","UW",
]);

const OBSTRUENTS = new Set([
  "B","C","D","F","G","H","JH","K","P","S","SH","T","TH","V","Z","ZH",
]);

const SONORANTS = new Set([
  "L","M","N","NG","R","W","Y",
]);

// ─── Types ────────────────────────────────────────────────────────────────────

interface SyllableData {
  chars: [number, number];  // [start, end] char positions in the word
  vowel: string | null;     // ARPAbet vowel nucleus (no stress digit)
  stress: 0 | 1 | 2;       // 0 = unstressed, 1 = primary, 2 = secondary
}

interface PhoneticStreamItem {
  syllable_index: number;
  phonemes: string[];
  stress: 0 | 1 | 2;
  ipa_approx: string;
  text: string;
}

interface WordData {
  vowel: string | null;         // primary stressed vowel (for rhyme grouping)
  tail: string[] | null;
  tail_type: string | null;
  span: [number, number] | null;  // kept for compat; use syllables where possible
  syllables: SyllableData[] | null;
  phonetic_stream: PhoneticStreamItem[] | null;  // syllables derived from phonotactics
}

type WordIndex = Record<string, WordData | null>;

interface LyricEntry {
  type: "section" | "line" | "blank";
  text: string;
}

interface SectionLine {
  text: string;
  end_word: string | null;
  rhyme_tail: string[] | null;
  rhyme_vowel: string | null;
  rhyme_type: string | null;
  rhyme_label: string;
}

interface AnalysisSection {
  label: string | null;
  rhyme_scheme: string;
  lines: SectionLine[];
}

interface RhymeGroup {
  tail: string[];
  vowel: string | null;
  rhyme_type: string;
  members: Array<{ word: string; section: string | null; line_index: number }>;
}

// ─── CMU Dict helpers ─────────────────────────────────────────────────────────

const _dict: Record<string, string> = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(SCRIPT_DIR, "cmudict.json.gz"))).toString("utf8"));

function getPhones(word: string): string[] | null {
  const w = word.toLowerCase();
  const candidates = [w];
  if (w.endsWith("'s")) candidates.push(w.slice(0, -2));
  if (w.endsWith("s"))  candidates.push(w.slice(0, -1));
  if (w.endsWith("'"))  candidates.push(w.slice(0, -1));
  if (w.endsWith("in'")) candidates.push(w.slice(0, -1) + "g");
  for (const c of candidates) {
    if (c in _dict) return _dict[c].split(" ");
  }
  return null;
}

function primaryStressedVowel(phones: string[]): string | null {
  for (const p of phones) {
    if (p.endsWith("1") && VOWELS.has(p.slice(0, -1))) return p.slice(0, -1);
  }
  for (const p of phones) {
    if (p.endsWith("2") && VOWELS.has(p.slice(0, -1))) return p.slice(0, -1);
  }
  for (const p of phones) {
    const base = p.replace(/[012]$/, "");
    if (VOWELS.has(base)) return base;
  }
  return null;
}

function rhymeTail(phones: string[]): string[] | null {
  const tail: string[] = [];
  let found = false;
  for (const p of phones) {
    const base = p.replace(/[012]$/, "");
    const stress = /[012]$/.test(p) ? p[p.length - 1] : null;
    if (!found && VOWELS.has(base) && stress === "1") found = true;
    if (found) tail.push(base);
  }
  if (!found) {
    for (const p of phones) {
      const base = p.replace(/[012]$/, "");
      if (!found && VOWELS.has(base)) found = true;
      if (found) tail.push(base);
    }
  }
  return tail.length > 0 ? tail : null;
}

function rhymeTypeFn(tail: string[] | null): string | null {
  if (!tail) return null;
  return tail.length > 1 ? "perfect" : "slant";
}

function tailKey(tail: string[] | null): string | null {
  return tail ? tail.join(",") : null;
}

// ─── Core analysis ────────────────────────────────────────────────────────────

function analyseWord(word: string): WordData | null {
  const phones = getPhones(word);
  if (!phones) return null;
  const vowel = primaryStressedVowel(phones);
  const tail = rhymeTail(phones);
  return {
    vowel,
    tail,
    tail_type: rhymeTypeFn(tail),
    span: syllableSpanPosition(word, phones),
    syllables: syllableBreakdown(word, phones),
    phonetic_stream: derivePhoneticStream(phones),
  };
}

// A curly apostrophe (U+2019, or U+2018, U+02BC) inside a word is the same as a straight one, so
// "I’ll" is looked up as "i'll" and not split into "i" and "ll".
const CURLY_APOSTROPHES = /[\u2018\u2019\u02BC]/g;

function lineWords(text: string): string[] {
  return (text.replace(CURLY_APOSTROPHES, "'").match(/[A-Za-z']+/g) ?? []).map(w => w.toLowerCase().replace(/^'|'$/g, ""));
}


function buildWordIndex(parsed: LyricEntry[]): WordIndex {
  const index: WordIndex = {};
  for (const entry of parsed) {
    if (entry.type !== "line") continue;
    for (const w of lineWords(entry.text)) {
      if (w && !(w in index)) index[w] = analyseWord(w);
    }
  }
  return index;
}

function assignRhymeLabels(lines: LyricEntry[], wordIndex: WordIndex): [string[], string] {
  const labelMap: Record<string, string> = {};
  const labels: string[] = [];
  let code = 65; // "A"
  for (const line of lines) {
    const words = lineWords(line.text);
    const endWord = words.length > 0 ? words[words.length - 1] : null;
    const data = endWord ? wordIndex[endWord] : null;
    const tk = data?.tail ? tailKey(data.tail) : null;
    if (!tk) {
      labels.push("?");
    } else {
      if (!(tk in labelMap)) labelMap[tk] = String.fromCharCode(code++);
      labels.push(labelMap[tk]);
    }
  }
  return [labels, labels.join("")];
}

function buildSections(parsed: LyricEntry[], wordIndex: WordIndex): AnalysisSection[] {
  const sections: AnalysisSection[] = [];
  let currentLabel: string | null = null;
  let currentLines: LyricEntry[] = [];

  function flush() {
    if (currentLines.length === 0) return;
    const [rhymeLabels, scheme] = assignRhymeLabels(currentLines, wordIndex);
    // perfect / slant only for end words that share a scheme letter with another line in the section
    const labelCount: Record<string, number> = {};
    for (const l of rhymeLabels) labelCount[l] = (labelCount[l] ?? 0) + 1;
    const linesOut: SectionLine[] = currentLines.map((line, i) => {
      const words = lineWords(line.text);
      const endWord = words.length > 0 ? words[words.length - 1] : null;
      const data = endWord ? wordIndex[endWord] : null;
      return {
        text: line.text,
        end_word: endWord,
        rhyme_tail: data?.tail ?? null,
        rhyme_vowel: data?.vowel ?? null,
        rhyme_type: data?.tail_type && rhymeLabels[i] !== "?" && labelCount[rhymeLabels[i]] > 1 ? data.tail_type : "none",
        rhyme_label: rhymeLabels[i],
      };
    });
    sections.push({ label: currentLabel, rhyme_scheme: scheme, lines: linesOut });
    currentLabel = null;
    currentLines = [];
  }

  for (const entry of parsed) {
    if (entry.type === "section") { flush(); currentLabel = entry.text; }
    else if (entry.type === "line") { currentLines.push(entry); }
    // blank: don't flush — sections can contain blank lines between stanzas
  }
  flush();
  return sections;
}

function buildRhymeGroups(sections: AnalysisSection[], _wordIndex: WordIndex): RhymeGroup[] {
  const tailMap: Record<string, Array<{ word: string; section: string | null; line_index: number }>> = {};
  for (const section of sections) {
    section.lines.forEach((line, i) => {
      if (line.rhyme_tail && line.end_word) {
        const tk = tailKey(line.rhyme_tail) ?? "";
        if (!tailMap[tk]) tailMap[tk] = [];
        tailMap[tk].push({ word: line.end_word, section: section.label, line_index: i });
      }
    });
  }
  const groups: RhymeGroup[] = [];
  for (const [tk, members] of Object.entries(tailMap)) {
    if (members.length < 2) continue;
    const tailList = tk.split(",");
    const vowel = tailList[0] && VOWELS.has(tailList[0]) ? tailList[0] : null;
    groups.push({
      tail: tailList,
      vowel,
      rhyme_type: tailList.length > 1 ? "perfect" : "slant",
      members,
    });
  }
  return groups.sort((a, b) => b.members.length - a.members.length);
}

function buildAnalysis(title: string, parsed: LyricEntry[], wordIndex: WordIndex) {
  const unresolved = Object.entries(wordIndex)
    .filter(([, d]) => d === null).map(([w]) => w).sort();
  const sections = buildSections(parsed, wordIndex);
  const rhymeGroups = buildRhymeGroups(sections, wordIndex);
  const wordMap = Object.fromEntries(
    Object.entries(wordIndex).filter(([, d]) => d !== null)
  ) as Record<string, WordData>;
  return {
    title,
    meta: { cmudict_version: "0.7b", dialect: "North American English", unresolved_words: unresolved },
    sections,
    rhyme_groups: rhymeGroups,
    word_map: wordMap,
  };
}


function splitIntoSyllables(phones: string[]): [string[][], number] {
  const syllables: string[][] = [];
  let current: string[] = [];
  let stressedIdx = -1;
  for (const p of phones) {
    const base = p.replace(/[012]$/, "");
    const stress = /[012]$/.test(p) ? p[p.length - 1] : null;
    if (VOWELS.has(base)) {
      current.push(p);
      if (stress === "1") stressedIdx = syllables.length;
      syllables.push(current);
      current = [];
    } else { current.push(p); }
  }
  if (current.length > 0 && syllables.length > 0) syllables[syllables.length - 1].push(...current);
  else if (current.length > 0) syllables.push(current);
  return [syllables, stressedIdx < 0 ? 0 : stressedIdx];
}

// Derive syllable boundaries using phonotactic consonant binding rules
function derivePhoneticStream(phones: string[]): PhoneticStreamItem[] {
  // Step 1: Identify syllable nuclei (vowels with stress markers)
  const nucleiIndices: number[] = [];
  for (let i = 0; i < phones.length; i++) {
    const base = phones[i].replace(/[012]$/, "");
    if (VOWELS.has(base)) {
      nucleiIndices.push(i);
    }
  }

  if (nucleiIndices.length === 0) {
    // No vowels — return single syllable with all consonants
    return [{
      syllable_index: 0,
      phonemes: phones,
      stress: 0,
      ipa_approx: "",
      text: "",
    }];
  }

  // Calculate syllable boundaries using consonant binding rules
  const boundaries: number[] = [0]; // Start of first syllable

  for (let i = 0; i < nucleiIndices.length - 1; i++) {
    const currentNuclei = nucleiIndices[i];
    const nextNuclei = nucleiIndices[i + 1];
    const consonantsBetween = nextNuclei - currentNuclei - 1;

    if (consonantsBetween === 0) {
      // Adjacent vowels — boundary between them
      boundaries.push(nextNuclei);
    } else if (consonantsBetween === 1) {
      // Rule A: Single consonant goes with following vowel
      boundaries.push(currentNuclei + 1);
    } else {
      // Multiple consonants between vowels
      const firstConsonant = phones[currentNuclei + 1];
      const firstBase = firstConsonant.replace(/[012]$/, "");
      const secondConsonant = phones[currentNuclei + 2];
      const secondBase = secondConsonant.replace(/[012]$/, "");

      // Check for obstruent-sonorant cluster (Rule B)
      // Clusters like TR, DR, BL, etc. stay together and go with following vowel
      if (OBSTRUENTS.has(firstBase) && SONORANTS.has(secondBase)) {
        // Obstruent-sonorant cluster stays together, goes with following vowel
        boundaries.push(currentNuclei + 1);
      } else if (SONORANTS.has(firstBase) && OBSTRUENTS.has(secondBase)) {
        // Sonorant-obstruent (like LG): split between them
        // Sonorant stays with previous vowel, obstruent goes with next
        boundaries.push(currentNuclei + 2);
      } else if (OBSTRUENTS.has(firstBase) && OBSTRUENTS.has(secondBase)) {
        // Rule C: Multiple obstruents — split after first
        boundaries.push(currentNuclei + 2);
      } else {
        // Default: single consonant rule
        boundaries.push(currentNuclei + 1);
      }
    }
  }

  boundaries.push(phones.length); // End of last syllable

  // Step 4: Build syllables with phonemes assigned to each
  const syllables: PhoneticStreamItem[] = [];

  for (let i = 0; i < nucleiIndices.length; i++) {
    const startBound = boundaries[i];
    const endBound = boundaries[i + 1];
    const phonemesInSyllable = phones.slice(startBound, endBound);

    // Extract stress from the nucleus
    const nucleusPhoneme = phones[nucleiIndices[i]];
    const stress = nucleusPhoneme.endsWith("1") ? 1 :
                   nucleusPhoneme.endsWith("2") ? 2 : 0;

    syllables.push({
      syllable_index: i,
      phonemes: phonemesInSyllable,
      stress: stress as 0 | 1 | 2,
      ipa_approx: "", // Could be enhanced with IPA mapping
      text: "", // Could be enhanced with orthographic text
    });
  }

  return syllables;
}

function syllableBreakdown(word: string, phones: string[]): SyllableData[] {
  const [syllables] = splitIntoSyllables(phones);
  const w = word.toLowerCase();

  const sylMeta = syllables.map(syl => {
    const vowelPhone = syl.find(p => VOWELS.has(p.replace(/[012]$/, "")));
    const vowel = vowelPhone ? vowelPhone.replace(/[012]$/, "") : null;
    const stress = (vowelPhone && /[012]$/.test(vowelPhone)
      ? Number(vowelPhone[vowelPhone.length - 1])
      : 0) as 0 | 1 | 2;
    return { vowel, stress };
  });

  if (syllables.length <= 1) {
    return [{ chars: [0, word.length] as [number, number], ...(sylMeta[0] ?? { vowel: null, stress: 0 as const }) }];
  }

  // Find orthographic vowel runs to approximate syllable character boundaries
  const orthoVowels = "aeiouy";
  const vowelRuns: [number, number][] = [];
  let i = 0;
  while (i < w.length) {
    if (orthoVowels.includes(w[i])) {
      let j = i;
      while (j < w.length && orthoVowels.includes(w[j])) j++;
      vowelRuns.push([i, j]); i = j;
    } else { i++; }
  }

  // Onset-preference: put all consonants except the onset cluster with the
  // following syllable. Default: 1 character at onset (nextVStart - 1).
  // Exception: English onset digraphs (th, wh, ch, sh, ph) stay together —
  // if the last 2 chars before the next vowel run form a digraph, keep both.
  const ONSET_DIGRAPHS = new Set(["th","wh","ch","sh","ph","gh","wr","kn","qu"]);
  const boundaries: number[] = [0];
  for (let si = 0; si < syllables.length - 1; si++) {
    if (si < vowelRuns.length - 1) {
      const vEnd = vowelRuns[si][1];
      const nextVStart = vowelRuns[si + 1][0];
      const clusterLen = nextVStart - vEnd;
      const useTwo = clusterLen >= 2 && ONSET_DIGRAPHS.has(w.slice(nextVStart - 2, nextVStart));
      boundaries.push(Math.max(vEnd, nextVStart - (useTwo ? 2 : 1)));
    } else {
      boundaries.push(Math.round((si + 1) * w.length / syllables.length));
    }
  }
  boundaries.push(word.length);

  return sylMeta.map((meta, si) => ({
    chars: [boundaries[si], boundaries[si + 1]] as [number, number],
    ...meta,
  }));
}

function syllableSpanPosition(word: string, phones: string[]): [number, number] {
  const [syllables, stressedIdx] = splitIntoSyllables(phones);
  const w = word.toLowerCase();
  if (syllables.length <= 1) return [0, word.length];
  const orthoVowels = "aeiouy";
  const vowelRuns: [number, number][] = [];
  let i = 0;
  while (i < w.length) {
    if (orthoVowels.includes(w[i])) {
      let j = i;
      while (j < w.length && orthoVowels.includes(w[j])) j++;
      vowelRuns.push([i, j]); i = j;
    } else { i++; }
  }
  if (vowelRuns.length === 0 || stressedIdx >= vowelRuns.length) return [0, w.length];
  const [vStart, vEnd] = vowelRuns[stressedIdx];
  const sylStart = vStart;
  let sylEnd: number;
  if (stressedIdx + 1 < vowelRuns.length) {
    const nextVStart = vowelRuns[stressedIdx + 1][0];
    sylEnd = vEnd + Math.min(nextVStart - vEnd, 2);
  } else { sylEnd = w.length; }
  return [sylStart, sylEnd];
}


// ─── Rhyme map HTML template (injected server-side on format=html) ────────────

const RHYME_MAP_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Rhyme Map</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400&family=Lora:ital,wght@0,400;0,500;0,600;1,400&family=JetBrains+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #FAFAF7; color: #1A1A2E; font-family: 'Lora', serif; font-size: 14px; line-height: 1.9; padding: 48px 40px 80px; max-width: 900px; margin: 0 auto; }
  h1 { font-family: 'Playfair Display', serif; font-size: 28px; font-weight: 600; color: #1A1A2E; margin-bottom: 6px; }
  .subtitle { font-size: 11px; color: #5A5270; letter-spacing: 0.07em; text-transform: uppercase; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #E4DFF5; }

  /* Controls */
  .controls { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 24px; }
  .toggle { display: flex; align-items: center; gap: 7px; font-size: 11px; color: #5A5270; cursor: pointer; border: 1px solid #E4DFF5; border-radius: 4px; padding: 6px 12px; transition: border-color 0.15s, color 0.15s, background-color 0.15s; user-select: none; }
  .toggle:hover { border-color: #7C5CFC; color: #7C5CFC; background: #F0ECFF; }
  .toggle.active { border-color: #7C5CFC; color: #7C5CFC; background: #F3F0FF; }
  .toggle .dot { width: 8px; height: 8px; border-radius: 50%; background: #E4DFF5; transition: background 0.15s; flex-shrink: 0; }
  .toggle.active .dot { background: #7C5CFC; }

  /* Legend */
  .legend { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 2px 16px; margin-bottom: 32px; padding: 16px 20px; background: #F3F0FF; border: 1px solid #E4DFF5; border-radius: 6px; }
  .legend-title { grid-column: 1 / -1; font-size: 10px; letter-spacing: 0.13em; text-transform: uppercase; color: #5A5270; margin-bottom: 8px; }
  .legend-item { display: flex; align-items: flex-start; gap: 6px; font-size: 11px; color: #5A5270; margin-bottom: 4px; cursor: pointer; border-radius: 4px; padding: 4px 6px; transition: background 0.15s, opacity 0.2s; }
  .legend-item:hover { background: rgba(124,92,252,0.08); }
  .legend-swatch { width: 11px; height: 11px; border-radius: 2px; flex-shrink: 0; margin-top: 3px; }
  .legend-label { color: #1A1A2E; }
  .legend-words { color: #5A5270; }

  /* Sections */
  .section-label { font-size: 10px; letter-spacing: 0.14em; text-transform: uppercase; color: #5A5270; margin: 20px 0 6px 2px; font-weight: 600; }
  .stanza { padding: 13px 18px; background: #FAFAF7; border: 1px solid #E4DFF5; border-radius: 4px; margin-bottom: 4px; }
  .line { padding: 1px 0; white-space: pre-wrap; display: flex; align-items: baseline; gap: 12px; }
  .line-text { flex: 1; font-family: 'Lora', serif; }
  .line-label { font-size: 10px; color: #9B92B8; letter-spacing: 0.06em; min-width: 14px; text-align: right; flex-shrink: 0; transition: color 0.15s; font-family: 'JetBrains Mono', monospace; }
  .spacer { height: 16px; }

  /* Word highlights */
  .rh-word { cursor: pointer; }
  .rh-syl { border-radius: 3px; padding: 0 2px; transition: filter 0.15s; }
  .rh-syl.slant { text-decoration: underline dashed; text-underline-offset: 3px; text-decoration-thickness: 1px; }

  /* Notes */
  .notes { font-size: 11px; color: #5A5270; margin-top: 32px; padding: 14px 18px; border: 1px dashed #E4DFF5; border-radius: 4px; line-height: 1.9; background: #F3F0FF; }
  .notes strong { color: #1A1A2E; font-weight: 600; }
  .notes .key { margin-top: 10px; padding-top: 8px; border-top: 1px solid #E4DFF5; font-size: 10.5px; font-family: 'JetBrains Mono', monospace; }
  .unresolved { font-size: 11px; color: #5A5270; margin-top: 10px; }

  /* Isolation state */
  body.isolated .rh-word { opacity: 0.50; transition: opacity 0.2s; }
  body.isolated .rh-word.active { opacity: 1; }
  body.isolated .rh-word.active .rh-syl { filter: brightness(0.85); }
  body.isolated { color: rgba(90,82,112,0.55); transition: color 0.2s; }
  body.isolated .legend-item { opacity: 0.40; }
  body.isolated .legend-item.active { opacity: 1; background: rgba(124,92,252,0.1); }
  body.isolated .line-label { color: #9B92B8; }
  body.isolated .line-label.active { color: #7C5CFC; }
</style>
</head>
<body>

<h1 id="title"></h1>
<div class="subtitle" id="subtitle"></div>

<div class="controls">
  <div class="toggle active" id="toggle-stress" title="Highlight the primary stressed syllable within each word">
    <span class="dot"></span> Stress syllable
  </div>
  <div class="toggle" id="toggle-eol" title="Show vowel highlights on end-of-line words only">
    <span class="dot"></span> End-of-line only
  </div>
  <div class="toggle active" id="toggle-scheme" title="Show rhyme scheme labels (A B C\u2026) beside each line">
    <span class="dot"></span> Scheme labels
  </div>
  <div class="toggle active" id="toggle-compact" title="Compact legend: swatch, vowel code, example word, count">
    <span class="dot"></span> Compact legend
  </div>
</div>

<div class="legend" id="legend"></div>
<div id="lyrics"></div>
<div class="notes" id="notes"></div>

<script>
// \u2500\u2500\u2500 Injected data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const RHYME_DATA = null; // <<<INJECT>>>

// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function hexToRgb(hex) {
  const m = /^#?([a-f\\d]{2})([a-f\\d]{2})([a-f\\d]{2})$/i.exec(hex);
  return m ? \`\${parseInt(m[1],16)},\${parseInt(m[2],16)},\${parseInt(m[3],16)}\` : '0,0,0';
}

// \u2500\u2500\u2500 Palette \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const PALETTE = [
  { vowel:"AY", color:"#e8593c", bg:"rgba(232,89,60,0.18)" },
  { vowel:"EY", color:"#c9a227", bg:"rgba(201,162,39,0.18)" },
  { vowel:"OW", color:"#3db88a", bg:"rgba(61,184,138,0.18)" },
  { vowel:"UW", color:"#5b9fd6", bg:"rgba(91,159,214,0.18)" },
  { vowel:"IY", color:"#b87fc8", bg:"rgba(184,127,200,0.18)" },
  { vowel:"AW", color:"#e0784a", bg:"rgba(224,120,74,0.18)" },
  { vowel:"AA", color:"#8ab8d6", bg:"rgba(138,184,214,0.18)" },
  { vowel:"ER", color:"#9fb870", bg:"rgba(159,184,112,0.18)" },
  { vowel:"IH", color:"#d4a060", bg:"rgba(212,160,96,0.18)" },
  { vowel:"AE", color:"#c06080", bg:"rgba(192,96,128,0.18)" },
  { vowel:"AO", color:"#60a0b0", bg:"rgba(96,160,176,0.18)" },
  { vowel:"UH", color:"#a08060", bg:"rgba(160,128,96,0.18)" },
  { vowel:"OY", color:"#a0c040", bg:"rgba(160,192,64,0.18)" },
  { vowel:"OE", color:"#c080a0", bg:"rgba(192,128,160,0.18)" },
];
const PALETTE_BY_VOWEL = Object.fromEntries(PALETTE.map(p => [p.vowel, p]));

// \u2500\u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
let selectedFamily = null;
let showStress    = true;
let endOfLineOnly = false;
let showScheme    = true;
let compactLegend = true;

// \u2500\u2500\u2500 Colour map \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function buildColourMap(wordMap) {
  const familyCounts = {};
  for (const d of Object.values(wordMap)) {
    const syls = d?.syllables;
    if (syls) {
      for (const s of syls) {
        if (s.vowel) familyCounts[s.vowel] = (familyCounts[s.vowel] ?? 0) + 1;
      }
    } else if (d?.vowel) {
      familyCounts[d.vowel] = (familyCounts[d.vowel] ?? 0) + 1;
    }
  }
  const active = Object.entries(familyCounts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]);
  const colourMap = {};
  const used = [];
  for (const [v] of active) {
    const matched = PALETTE_BY_VOWEL[v];
    if (matched && !used.includes(matched)) { colourMap[v] = matched; used.push(matched); }
    else { for (const p of PALETTE) { if (!used.includes(p)) { colourMap[v] = p; used.push(p); break; } } }
  }
  return colourMap;
}

// \u2500\u2500\u2500 Tokenise \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function tokenize(text) {
  return (text.match(/[A-Za-z'\u2018\u2019\u02BC]+|[^A-Za-z'\u2018\u2019\u02BC]+/g) ?? []).map(t => ({
    text: t,
    isWord: /[A-Za-z'\u2018\u2019\u02BC]/.test(t[0]),
    key: t.toLowerCase().replace(/[\u2018\u2019\u02BC]/g, "'").replace(/^'|'$/g, ''),
  }));
}

// \u2500\u2500\u2500 Render a single word token \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderWordToken(token, wordMap, colourMap, isEndWord) {
  const span = document.createElement('span');
  span.className = 'rh-word';
  const key = token.key;
  const data = wordMap[key];

  if (!data || (endOfLineOnly && !isEndWord)) {
    span.textContent = token.text;
    return span;
  }

  // \u2500\u2500 New path: per-syllable data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  if (data.syllables) {
    const hasColour = data.syllables.some(s => s.vowel && colourMap[s.vowel]);
    if (!hasColour) { span.textContent = token.text; return span; }

    if (data.vowel) {
      span.dataset.family = data.vowel;
      span.title = \`\${data.vowel} vowel\`;
      span.addEventListener('click', e => { e.stopPropagation(); toggleFamily(data.vowel); });
    }

    const isMulti = data.syllables.length > 1;
    for (const syl of data.syllables) {
      const [s, e] = syl.chars;
      const text = token.text.slice(s, e);
      const colour = syl.vowel ? colourMap[syl.vowel] : null;
      if (!colour) { span.appendChild(document.createTextNode(text)); continue; }
      const sylEl = document.createElement('span');
      sylEl.textContent = text;
      sylEl.dataset.family = syl.vowel;
      sylEl.style.color = colour.color;
      // Stress markers only on polysyllabic words \u2014 on monosyllabic words the
      // colour alone is sufficient and a border on every word is visual noise
      if (showStress && isMulti) {
        if (syl.stress === 1) {
          sylEl.style.border = \`1px solid \${colour.color}\`;
          sylEl.style.borderRadius = '3px';
          sylEl.style.padding = '0 1px';
        } else if (syl.stress === 2) {
          sylEl.style.textDecoration = 'underline';
          sylEl.style.textUnderlineOffset = '2px';
          sylEl.style.textDecorationThickness = '1px';
          sylEl.style.textDecorationColor = colour.color;
        }
      }
      span.appendChild(sylEl);
    }
    return span;
  }

  // \u2500\u2500 Legacy path: no syllables field (pre-update API response) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  const colour = data.vowel ? colourMap[data.vowel] : null;
  if (!colour) { span.textContent = token.text; return span; }

  span.dataset.family = data.vowel;
  span.title = \`\${data.vowel} vowel\`;
  span.addEventListener('click', e => { e.stopPropagation(); toggleFamily(data.vowel); });

  if (showStress && data.span) {
    const [s, e] = data.span;
    const pre = token.text.slice(0, s);
    const mid = token.text.slice(s, e);
    const post = token.text.slice(e);
    if (pre) span.appendChild(document.createTextNode(pre));
    const syl = document.createElement('span');
    syl.style.cssText = \`color:\${colour.color};border:1px solid \${colour.color};border-radius:3px;padding:0 1px;\`;
    syl.textContent = mid;
    span.appendChild(syl);
    if (post) span.appendChild(document.createTextNode(post));
  } else {
    span.style.color = colour.color;
    span.textContent = token.text;
  }
  return span;
}

// \u2500\u2500\u2500 Render lyrics \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderLyrics(analysis, colourMap) {
  const container = document.getElementById('lyrics');
  container.innerHTML = '';

  for (const section of analysis.sections) {
    if (section.label) {
      const lbl = document.createElement('div');
      lbl.className = 'section-label';
      lbl.textContent = section.label;
      container.appendChild(lbl);
    }

    let stanza = null;
    for (const line of section.lines) {
      if (!stanza) { stanza = document.createElement('div'); stanza.className = 'stanza'; container.appendChild(stanza); }

      const lineEl = document.createElement('div');
      lineEl.className = 'line';

      const textEl = document.createElement('span');
      textEl.className = 'line-text';

      const tokens = tokenize(line.text);
      const lastWordIdx = tokens.reduce((last, t, i) => t.isWord ? i : last, -1);
      tokens.forEach((tok, i) => {
        const isEndWord = tok.isWord && tok.key === line.end_word && i === lastWordIdx;
        if (tok.isWord) {
          textEl.appendChild(renderWordToken(tok, analysis.word_map, colourMap, isEndWord));
        } else {
          textEl.appendChild(document.createTextNode(tok.text));
        }
      });

      lineEl.appendChild(textEl);

      const labelEl = document.createElement('span');
      labelEl.className = 'line-label' + (line.rhyme_vowel ? ' active' : '');
      labelEl.dataset.label = line.rhyme_label;
      labelEl.textContent = showScheme ? (line.rhyme_label !== '?' ? line.rhyme_label : '') : '';
      lineEl.appendChild(labelEl);

      stanza.appendChild(lineEl);
    }
  }
}

// \u2500\u2500\u2500 Render legend \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderLegend(analysis, colourMap) {
  const container = document.getElementById('legend');
  container.innerHTML = '';

  container.style.gridTemplateColumns = compactLegend
    ? 'repeat(auto-fill, minmax(160px, 1fr))'
    : 'repeat(auto-fill, minmax(200px, 1fr))';

  const title = document.createElement('div');
  title.className = 'legend-title';
  title.textContent = 'Active vowel families \u00b7 click to isolate';
  container.appendChild(title);

  const familyWords = {};
  for (const [w, d] of Object.entries(analysis.word_map)) {
    if (d?.vowel && colourMap[d.vowel]) {
      (familyWords[d.vowel] = familyWords[d.vowel] ?? []).push(w);
    }
  }

  for (const [v, c] of Object.entries(colourMap)) {
    const words = (familyWords[v] ?? []).sort((a, b) => a.length - b.length);
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.dataset.family = v;

    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.background = c.color;
    item.appendChild(swatch);

    if (compactLegend) {
      // Prefer shortest single-syllable word as the example
      const mono = words.filter(wd => {
        const d = analysis.word_map[wd];
        return d?.syllables ? d.syllables.length === 1 : true;
      });
      const example = (mono[0] ?? words[0] ?? v).toLowerCase();
      const textEl = document.createElement('span');
      textEl.style.fontSize = '11px';
      const vLabel = document.createElement('span');
      vLabel.style.color = c.color;
      vLabel.style.letterSpacing = '0.04em';
      vLabel.textContent = v;
      const rest = document.createElement('span');
      rest.style.color = '#6b6760';
      rest.textContent = \` \u00b7 "\${example}" (\${words.length})\`;
      textEl.appendChild(vLabel);
      textEl.appendChild(rest);
      item.appendChild(textEl);
    } else {
      const info = document.createElement('div');
      const label = document.createElement('span');
      label.className = 'legend-label';
      label.textContent = \`\${v} vowel\`;
      const wds = document.createElement('div');
      wds.className = 'legend-words';
      wds.textContent = words.slice(0, 14).join(', ') + (words.length > 14 ? '\u2026' : '');
      info.appendChild(label);
      info.appendChild(wds);
      item.appendChild(info);
    }

    item.addEventListener('click', e => { e.stopPropagation(); toggleFamily(v); });
    container.appendChild(item);
  }
}

// \u2500\u2500\u2500 Render notes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderNotes(analysis) {
  const el = document.getElementById('notes');
  const unresolved = analysis.meta?.unresolved_words ?? [];
  el.innerHTML = \`<strong>Notes</strong><br>
\u2014 Each syllable is coloured by its own vowel (cmudict ARPAbet)<br>
\u2014 Bordered syllable = primary stress \u00b7 underlined syllable = secondary stress<br>
\u2014 Click any word or legend row to isolate that vowel family \u00b7 click again to clear
\${unresolved.length ? \`<div class="unresolved">Unresolved (not in cmudict): \${unresolved.join(', ')}</div>\` : ''}
<div class="key">lyric-analysis-api \u00b7 cmu-pronouncing-dictionary \u00b7 North American English</div>\`;
}

// \u2500\u2500\u2500 Isolation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function toggleFamily(fam) {
  if (selectedFamily === fam) {
    selectedFamily = null;
    document.body.classList.remove('isolated');
    document.querySelectorAll('.rh-word.active').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.legend-item.active').forEach(el => el.classList.remove('active'));
  } else {
    selectedFamily = fam;
    document.body.classList.add('isolated');
    document.querySelectorAll('.rh-word').forEach(el => {
      el.classList.toggle('active', el.dataset.family === fam);
    });
    document.querySelectorAll('.legend-item').forEach(el => {
      el.classList.toggle('active', el.dataset.family === fam);
    });
  }
}

// \u2500\u2500\u2500 Full re-render \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function rerender() {
  const a = RHYME_DATA.analysis;
  const colourMap = buildColourMap(a.word_map);
  renderLegend(a, colourMap);
  renderLyrics(a, colourMap);
  renderNotes(a);
  selectedFamily = null;
  document.body.classList.remove('isolated');
}

// \u2500\u2500\u2500 Controls \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function initControls() {
  const tStress  = document.getElementById('toggle-stress');
  const tEol     = document.getElementById('toggle-eol');
  const tScheme  = document.getElementById('toggle-scheme');
  const tCompact = document.getElementById('toggle-compact');

  tStress.addEventListener('click', () => {
    showStress = !showStress;
    tStress.classList.toggle('active', showStress);
    rerender();
  });
  tEol.addEventListener('click', () => {
    endOfLineOnly = !endOfLineOnly;
    tEol.classList.toggle('active', endOfLineOnly);
    rerender();
  });
  tScheme.addEventListener('click', () => {
    showScheme = !showScheme;
    tScheme.classList.toggle('active', showScheme);
    document.querySelectorAll('.line-label').forEach(el => {
      el.textContent = showScheme ? (el.dataset.label !== '?' ? el.dataset.label : '') : '';
    });
  });
  tCompact.addEventListener('click', () => {
    compactLegend = !compactLegend;
    tCompact.classList.toggle('active', compactLegend);
    const a = RHYME_DATA.analysis;
    renderLegend(a, buildColourMap(a.word_map));
  });

  document.addEventListener('click', () => {
    if (selectedFamily) { selectedFamily = null; document.body.classList.remove('isolated'); document.querySelectorAll('.active').forEach(el => el.classList.remove('active')); }
  });
}

// \u2500\u2500\u2500 Init \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function init() {
  if (!RHYME_DATA) { document.body.innerHTML = '<p style="color:#6b6760;padding:48px">No data injected.</p>'; return; }
  const a = RHYME_DATA.analysis;
  document.title = \`\${a.title} \u2014 Rhyme Map\`;
  document.getElementById('title').textContent = a.title;
  document.getElementById('subtitle').innerHTML =
    'Rhyme map \u00b7 each syllable coloured by its vowel \u00b7 ' +
    '<span style="border:1px solid currentColor;border-radius:2px;padding:0 2px">bordered</span>' +
    ' = primary stress \u00b7 <span style="text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px">underlined</span>' +
    ' = secondary stress';
  initControls();
  rerender();
}

init();
</script>
</body>
</html>`;

function injectRhymeData(analysis: ReturnType<typeof buildAnalysis>): string {
  return RHYME_MAP_TEMPLATE.replace(
    "const RHYME_DATA = null; // <<<INJECT>>>",
    `const RHYME_DATA = ${JSON.stringify({ analysis })};`,
  );
}

// ─── Parse lyrics ─────────────────────────────────────────────────────────────

const _CHORD_PAT = "[A-G][b#]?(?:maj|min|m|dim|aug|sus|add)?(?:\\d+)?(?:/[A-G][b#]?)?";
const INLINE_CHORD_RE  = new RegExp(`\\[(${_CHORD_PAT})\\]`, "g");
const CHORD_LINE_RE    = new RegExp(`^\\s*(${_CHORD_PAT})(\\s+(${_CHORD_PAT}))*\\s*$`);
const SECTION_BRACKET_RE = /^\[([^\]]{2,})\]$/;

// Header lines that are neither bracketed nor strict ALLCAPS, e.g. "V1 (reprise)",
// "Chorus 2", "Pre-Chorus". Only checked at the start of a stanza (see parsePlain).
const SECTION_KEYWORDS_RE = /^(verse|chorus|pre-?chorus|post-?chorus|bridge|intro|outro|hook|refrain|interlude|tag|vamp|breakdown)\s*\d*\s*(?:\([^)]*\))?$/i;
const SECTION_ABBR_RE = /^(v|c|b|pc)\d+\s*(?:\([^)]*\))?$/i;
const LOOSE_HEADER_RE = new RegExp(`${SECTION_KEYWORDS_RE.source}|${SECTION_ABBR_RE.source}`, "i");

function detectFormat(raw: string): string {
  const lines = raw.trim().split("\n").filter(l => l.trim());
  if (lines.some(l => /^\{[a-z_]+/.test(l.trim()))) return "chordpro";
  const bracketLines = lines.map(l => l.trim()).filter(l => l.startsWith("["));
  const sectionBrackets = bracketLines.filter(l => !new RegExp(`^\\[(${_CHORD_PAT})\\]$`).test(l));
  if (sectionBrackets.length > 0) return "bracketed";
  const allcaps = lines.filter(l => /^[A-Z][A-Z\s\-\d]{2,}$/.test(l.trim()));
  if (allcaps.length > 0) return "allcaps";
  const chordLines = lines.filter(l => CHORD_LINE_RE.test(l));
  if (chordLines.length >= 2) return "ultimate_guitar";
  return "plain";
}

function extractMetadata(lines: string[]): [Record<string, string>, string[], string | null] {
  const metadata: Record<string, string> = {};
  let title: string | null = null;
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].trim().match(/^([A-Za-z][A-Za-z /]*?):\s*(.+)/);
    if (m) {
      const key = m[1].trim().toLowerCase();
      const value = m[2].trim();
      if (key === "title") title = value; else metadata[key] = value;
      i++;
    } else break;
  }
  return [metadata, lines.slice(i), title];
}

function inferTitle(lines: string[], parseNotes: string[]): [string | null, string[]] {
  if (lines.length === 0) return [null, lines];
  const first = lines[0].trim();
  const words = first.split(/\s+/);
  if (first && words.length >= 1 && words.length <= 8
      && first[0] === first[0].toUpperCase()
      && !first.startsWith("[")
      && !/^[A-Z][A-Z\s\-\d]{2,}$/.test(first)
      && !first.endsWith(",")) {
    parseNotes.push(`Title inferred from first line: "${first}"`);
    return [first, lines.slice(1)];
  }
  return [null, lines];
}

function stripInlineChords(line: string): string {
  return line.replace(INLINE_CHORD_RE, "").trim();
}

function stanzaHint(lines: string[], priorSections: Array<{label?: string}>): string {
  const count = lines.length;
  const hasChorus = priorSections.some(s => (s.label ?? "").toLowerCase().includes("chorus"));
  if (count <= 2) return "possible_outro_or_hook";
  if (count === 4) return hasChorus ? "possible_verse" : "possible_verse_or_chorus";
  if (count >= 6) return "possible_verse";
  return "unknown";
}

function makeResult(title: string | null, fmt: string, metadata: Record<string, string>,
  sections: object[], unparsedBlocks: object[], parseNotes: string[]) {
  return { title, format_detected: fmt, metadata, sections, unparsed_blocks: unparsedBlocks,
    requires_llm: unparsedBlocks.length > 0, parse_notes: parseNotes };
}

function parseChordpro(raw: string) {
  const lines = raw.trim().split("\n");
  let title: string | null = null;
  const metadata: Record<string, string> = {};
  const sections: object[] = [];
  const parseNotes: string[] = [];
  let currentLabel: string | null = null;
  let currentLines: string[] = [];
  let inSection = false;
  let verseN = 0, chorusN = 0, partN = 0;

  const SECTION_START: Record<string, string> = {
    start_of_verse: "Verse", start_of_chorus: "Chorus",
    start_of_bridge: "Bridge", start_of_part: "Part",
  };
  const SKIP_START = new Set(["start_of_tab","start_of_grid"]);

  function flush() {
    const lyricLines = currentLines.filter(l => l);
    if (lyricLines.length > 0 && currentLabel !== null) {
      sections.push({ label: `[${currentLabel}]`, confidence: "high", lines: lyricLines });
    } else if (lyricLines.length > 0) {
      sections.push({ label: "[Unlabelled]", confidence: "low",
        alternatives: ["[Verse]","[Chorus]"],
        reason: "Lyric lines appeared outside a {start_of_*} directive.", lines: lyricLines });
    }
    currentLabel = null; currentLines = []; inSection = false;
  }

  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    const d = stripped.match(/^\{([a-z_]+)(?::\s*(.*?))?\}$/);
    if (d) {
      const directive = d[1], value = (d[2] ?? "").trim();
      if (directive === "title") { title = value; }
      else if (["artist","composer","lyricist","album","year","key","tempo","time","copyright","capo","meta"].includes(directive)) {
        metadata[directive] = value;
      } else if (directive in SECTION_START) {
        flush();
        const kind = SECTION_START[directive];
        if (value) { currentLabel = value; }
        else if (kind === "Verse")  { verseN++;  currentLabel = `Verse ${verseN}`; }
        else if (kind === "Chorus") { chorusN++; currentLabel = chorusN === 1 ? "Chorus" : `Chorus ${chorusN}`; }
        else if (kind === "Bridge") { currentLabel = "Bridge"; }
        else { partN++; currentLabel = `Part ${partN}`; }
        inSection = true;
      } else if (SKIP_START.has(directive)) { flush(); inSection = false; }
      else if (directive.startsWith("end_of_")) { /* flush on next start */ }
      else if (directive === "comment") { parseNotes.push(`Source comment: "${value}"`); }
      continue;
    }
    const clean = stripInlineChords(stripped);
    if (inSection && clean) currentLines.push(clean);
    else if (clean && !stripped.startsWith("#")) currentLines.push(clean);
  }
  flush();
  if (!title) parseNotes.push("No {title} directive found — title unknown.");
  return makeResult(title, "chordpro", metadata, sections, [], parseNotes);
}

function parseBracketed(raw: string) {
  const allLines = raw.trim().split("\n");
  const [metadata, remaining, extractedTitle] = extractMetadata(allLines);
  const parseNotes: string[] = [];
  let lines = remaining;
  let title = extractedTitle;
  if (!title) [title, lines] = inferTitle(lines, parseNotes);

  const sections: object[] = [];
  const unparsedBlocks: object[] = [];
  let currentLabel: string | null = null;
  let currentLines: string[] = [];

  function flush() {
    const lyricLines = currentLines.filter(l => l.trim());
    if (lyricLines.length === 0) { currentLabel = null; currentLines = []; return; }
    if (currentLabel !== null) {
      sections.push({ label: currentLabel, confidence: "high", lines: lyricLines });
    } else {
      unparsedBlocks.push({ raw: lyricLines.join("\n"), issue: "no_header",
        hint: stanzaHint(lyricLines, sections as Array<{label?:string}>) });
    }
    currentLabel = null; currentLines = [];
  }

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) { flush(); }
    else if (SECTION_BRACKET_RE.test(stripped) && !new RegExp(`^\\[(${_CHORD_PAT})\\]$`).test(stripped)) {
      flush(); currentLabel = stripped;
    } else { currentLines.push(stripped); }
  }
  flush();

  if (unparsedBlocks.length > 0)
    parseNotes.push(`${unparsedBlocks.length} block(s) have no section header — LLM labelling needed.`);
  return makeResult(title, "bracketed", metadata, sections, unparsedBlocks, parseNotes);
}

function parseAllcaps(raw: string) {
  const allLines = raw.trim().split("\n");
  const [metadata, remaining, extractedTitle] = extractMetadata(allLines);
  const parseNotes: string[] = [];
  let lines = remaining;
  let title = extractedTitle;
  if (!title) [title, lines] = inferTitle(lines, parseNotes);

  const sections: object[] = [];
  const unparsedBlocks: object[] = [];
  let currentLabel: string | null = null;
  let currentLines: string[] = [];

  function flush() {
    const lyricLines = currentLines.filter(l => l.trim());
    if (lyricLines.length === 0) { currentLabel = null; currentLines = []; return; }
    if (currentLabel !== null) {
      const label = currentLabel.charAt(0) + currentLabel.slice(1).toLowerCase();
      sections.push({ label: `[${label}]`, confidence: "high", lines: lyricLines });
    } else {
      unparsedBlocks.push({ raw: lyricLines.join("\n"), issue: "no_header",
        hint: stanzaHint(lyricLines, sections as Array<{label?:string}>) });
    }
    currentLabel = null; currentLines = [];
  }

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) { flush(); }
    else if (/^[A-Z][A-Z\s\-\d]{2,}$/.test(stripped)) { flush(); currentLabel = stripped; }
    else { currentLines.push(stripped); }
  }
  flush();

  if (unparsedBlocks.length > 0)
    parseNotes.push(`${unparsedBlocks.length} block(s) have no section header — LLM labelling needed.`);
  return makeResult(title, "allcaps", metadata, sections, unparsedBlocks, parseNotes);
}

function parsePlain(raw: string) {
  const allLines = raw.trim().split("\n");
  const [metadata, remaining, extractedTitle] = extractMetadata(allLines);
  const parseNotes: string[] = [];
  let lines = remaining;
  let title = extractedTitle;
  if (!title) [title, lines] = inferTitle(lines, parseNotes);

  const sections: object[] = [];
  const unparsedBlocks: object[] = [];
  let currentLabel: string | null = null;
  let currentLines: string[] = [];
  let stanzaIndex = 0;

  function flush() {
    const lyricLines = currentLines.filter(l => l.trim());
    if (lyricLines.length === 0) { currentLabel = null; currentLines = []; return; }
    if (currentLabel !== null) {
      sections.push({ label: currentLabel, confidence: "medium", lines: lyricLines });
    } else {
      unparsedBlocks.push({ raw: lyricLines.join("\n"), issue: "no_header",
        hint: stanzaHint(lyricLines, sections as Array<{label?:string}>), stanza_index: stanzaIndex++ });
    }
    currentLabel = null; currentLines = [];
  }

  for (const line of lines) {
    const stripped = line.trim();
    if (!stripped) { flush(); }
    else if (currentLines.length === 0 && LOOSE_HEADER_RE.test(stripped)) { flush(); currentLabel = stripped; }
    else { currentLines.push(stripped); }
  }
  flush();

  if (unparsedBlocks.length > 0)
    parseNotes.push(`${unparsedBlocks.length} block(s) have no section header — LLM labelling needed.`);
  return makeResult(title, "plain", metadata, sections, unparsedBlocks, parseNotes);
}

function parseUltimateGuitar(raw: string) {
  const lines = raw.trim().split("\n");
  const lyricLines = lines.filter(l => !CHORD_LINE_RE.test(l));
  const cleaned = lyricLines.join("\n");
  const fmt = detectFormat(cleaned);
  const result = fmt === "bracketed" ? parseBracketed(cleaned)
               : fmt === "allcaps"   ? parseAllcaps(cleaned)
               : parsePlain(cleaned);
  result.format_detected = "ultimate_guitar";
  (result.parse_notes as string[]).unshift("Chord-above-lines stripped before section detection.");
  return result;
}

function parseLyrics(raw: string) {
  const fmt = detectFormat(raw);
  return fmt === "chordpro"       ? parseChordpro(raw)
       : fmt === "bracketed"      ? parseBracketed(raw)
       : fmt === "allcaps"        ? parseAllcaps(raw)
       : fmt === "ultimate_guitar"? parseUltimateGuitar(raw)
       : parsePlain(raw);
}

// Convert parse result sections → flat LyricEntry list for rhyme analysis
function toFlatEntries(parseResult: ReturnType<typeof parseLyrics>): LyricEntry[] {
  const entries: LyricEntry[] = [];
  for (const section of parseResult.sections as Array<{label:string; lines:string[]}>) {
    entries.push({ type: "section", text: section.label });
    for (const line of section.lines) {
      entries.push({ type: "line", text: line });
    }
  }
  // Include unparsed block lines so rhyme analysis still runs on them. Each
  // block gets its own section entry so distinct stanzas don't get merged
  // into each other or into the preceding recognized section once flattened.
  const unparsedBlocks = (parseResult.unparsed_blocks as Array<{raw:string}>) ?? [];
  unparsedBlocks.forEach((block, i) => {
    entries.push({ type: "section", text: `[Unparsed ${i + 1}]` });
    for (const line of block.raw.split("\n")) {
      if (line.trim()) entries.push({ type: "line", text: line.trim() });
    }
  });
  return entries;
}


// ─── Rhythm Map SVG generation ────────────────────────────────────────────────

interface BeatPattern {
  beatsPerBar: number;
  beatWeights: number[]; // 0=weak, 1=medium, 2=strong, indexed 0..beatsPerBar-1
  label: string;
}

const COMMON_BEAT_PATTERNS: Record<string, BeatPattern> = {
  "4/4":  { beatsPerBar: 4,  beatWeights: [2,0,1,0],                  label: "4/4" },
  "3/4":  { beatsPerBar: 3,  beatWeights: [2,0,0],                    label: "3/4" },
  "2/4":  { beatsPerBar: 2,  beatWeights: [2,0],                      label: "2/4" },
  "2/2":  { beatsPerBar: 2,  beatWeights: [2,0],                      label: "2/2" },
  "6/8":  { beatsPerBar: 6,  beatWeights: [2,0,0,1,0,0],              label: "6/8" },
  "3/8":  { beatsPerBar: 3,  beatWeights: [2,0,0],                    label: "3/8" },
  "12/8": { beatsPerBar: 12, beatWeights: [2,0,0,1,0,0,1,0,0,1,0,0], label: "12/8" },
  "5/4":  { beatsPerBar: 5,  beatWeights: [2,0,1,0,0],                label: "5/4" },
  "7/8":  { beatsPerBar: 7,  beatWeights: [2,0,1,0,1,0,0],            label: "7/8" },
  "9/8":  { beatsPerBar: 9,  beatWeights: [2,0,0,1,0,0,1,0,0],       label: "9/8" },
};

function getBeatPattern(timeSig: string): BeatPattern {
  const known = COMMON_BEAT_PATTERNS[timeSig];
  if (known) return known;
  const [num, denom] = timeSig.split("/").map(Number);
  if (!Number.isNaN(num) && num > 0 && !Number.isNaN(denom)) {
    const weights = Array(num).fill(0);
    weights[0] = 2;
    return { beatsPerBar: num, beatWeights: weights, label: timeSig };
  }
  return COMMON_BEAT_PATTERNS["4/4"];
}

function generateRhythmMapSvg(title: string, sections: AnalysisSection[], wordIndex: WordIndex, beatPattern: BeatPattern): string {
  const CELL_W = 48;
  const CELL_H = 40;
  const LABEL_W = 32;
  const LABEL_H = 16;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 ${sections.length * 300}" font-family="'JetBrains Mono', monospace">
<defs>
  <style>
    .beat { font-size: 9px; fill: #7C5CFC; text-anchor: middle; font-weight: 700; }
    .beat-normal { font-size: 9px; fill: #7C5CFC; text-anchor: middle; }
    .lnum { font-size: 10px; fill: #9B92B8; text-anchor: end; }
    .ph1 { font-size: 11px; font-weight: 700; text-decoration: underline; fill: #1A1A2E; }
    .ph2 { font-size: 11px; fill: #1A1A2E; opacity: 0.7; }
    .ph0 { font-size: 11px; fill: #5A5270; opacity: 0.5; }
    .grid-line { stroke: #E4DFF5; stroke-width: 0.5; }
    .grid-bar { stroke: #7C5CFC; stroke-width: 1.5; }
    .sec-label { font-size: 10px; font-weight: 700; fill: #5A5270; letter-spacing: 0.12em; }
    .title { font-size: 20px; font-weight: 600; fill: #1A1A2E; font-family: serif; }
  </style>
</defs>
<text x="20" y="24" class="title">${escapeXml(title)}</text>
`;

  let y = 50;

  for (const section of sections) {
    svg += `<text x="20" y="${y}" class="sec-label">${escapeXml(section.label ?? "")}</text>\n`;
    y += 18;

    // Beat row
    svg += `<line x1="0" y1="${y - 2}" x2="1200" y2="${y - 2}" class="grid-bar"/>\n`;
    svg += `<text x="${LABEL_W - 4}" y="${y + 8}" class="lnum">♪ ${beatPattern.label}</text>\n`;
    for (let b = 0; b < beatPattern.beatsPerBar; b++) {
      const bx = LABEL_W + b * CELL_W;
      svg += `<text x="${bx + CELL_W / 2}" y="${y + 8}" class="${b === 0 ? 'beat' : 'beat-normal'}">${b + 1}</text>\n`;
    }
    y += LABEL_H + 4;

    // Lines
    for (let li = 0; li < section.lines.length; li++) {
      const line = section.lines[li];
      const words = lineWords(line.text);

      svg += `<text x="${LABEL_W - 4}" y="${y + 18}" class="lnum">L${li + 1}</text>\n`;

      let x = LABEL_W;
      let beatPos = 0; // Reset beat counter for each line
      for (const word of words) {
        const data = wordIndex[word];
        if (!data || !data.phonetic_stream) continue;

        for (const syl of data.phonetic_stream) {
          const stressClass = syl.stress === 1 ? "ph1" : syl.stress === 2 ? "ph2" : "ph0";
          const phonText = syl.phonemes.map(p => p.replace(/[012]$/, "")).join("");

          // Draw bar line before this cell if it starts a new bar (and not the first beat)
          if (beatPos > 0 && beatPos % beatPattern.beatsPerBar === 0) {
            svg += `<line x1="${x}" y1="${y}" x2="${x}" y2="${y + CELL_H}" stroke="#7C5CFC" stroke-width="1.5"/>\n`;
          }

          // Determine beat position and shading
          const weight = beatPattern.beatWeights[beatPos % beatPattern.beatsPerBar];
          const cellFill = weight === 2 ? "#EDE9FF" : weight === 1 ? "#F5F3FF" : "white";

          // Cell background
          svg += `<rect x="${x}" y="${y}" width="${CELL_W}" height="${CELL_H}" fill="${cellFill}" stroke="#E4DFF5" stroke-width="0.5"/>\n`;

          // Phoneme text
          svg += `<text x="${x + CELL_W / 2}" y="${y + 20}" class="${stressClass}" text-anchor="middle">${escapeXml(phonText)}</text>\n`;

          // Word text below
          svg += `<text x="${x + CELL_W / 2}" y="${y + 34}" font-size="8" fill="#5A5270" text-anchor="middle">${escapeXml(word.slice(0, 4))}</text>\n`;

          x += CELL_W;
          beatPos++;
        }
      }

      // Grid line at end of line
      svg += `<line x1="0" y1="${y + CELL_H}" x2="${x}" y2="${y + CELL_H}" class="grid-line"/>\n`;

      y += CELL_H + 2;
    }

    y += 16;
  }

  svg += `</svg>`;
  return svg;
}

function escapeXml(str: string): string {
  return str.replace(/[<>&"']/g, c => {
    const m: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
    return m[c] ?? c;
  });
}

// ─── Song status board ────────────────────────────────────────────────────────
// Input: an append-only log, status.jsonl: one flat JSON object per line, read top to bottom
// (later lines win). --add appends lines to the log first (each is checked), so the coach never
// edits the file by hand; then the page is rewritten. This is the same design as the Python
// scripts/status_board.py, which is the reference: keep the two in step (tests/test_status_parity.py).
//
//   {"event":"song","title":"Ballad of Lorem Ipsum"}
//   {"event":"section","name":"Verse 1","abbrev":"V1"}            (+ "instrumental":true)
//   {"event":"section-order","names":["Verse 1","Chorus"]}        (sections not listed go last)
//   {"event":"section-rename","name":"Verse 1","new_name":"Verse One","abbrev":"V1"}
//   {"event":"section-replace","name":"Verse 2"}                  (new text: results cleared)
//   {"event":"section-delete","name":"Verse 1"}
//   {"event":"run","test":"Cliche scan"}                          (clears that check's results)
//   {"event":"result","test":"Cliche scan","section":"Verse 1","status":"concern","note":"..."}
//   {"event":"result","test":"Emotional arc review","section":"whole","status":"strong"}
//   {"event":"edit","section":"Verse 1"}                          (marks results stale)
//
// status: strong | observation | concern | issue. After a "run", a section with no result is
// clean. A section added or replaced after a run shows "not run". Section names are unique; a
// repeated chorus is "Chorus 2".

type StatusResult = "green" | "blue" | "amber" | "red";
interface StatusCell { result: StatusResult; note?: string }
interface StatusCheck {
  name: string;
  scope: "section" | "whole";
  run?: boolean;
  stale?: boolean;
  result?: StatusResult;
  note?: string;
  cells?: Record<string, StatusCell>;
  uncovered?: string[];
  unsupported?: boolean;
}
interface StatusAssessment { name: string; checks: StatusCheck[] }
interface StatusData {
  title?: string | null;
  view?: "status" | "summary" | "detailed";
  sections: string[];
  instrumental?: string[];
  section_names?: Record<string, string>;
  assessments: StatusAssessment[];
}

const STATUS_ORDER: StatusResult[] = ["green", "blue", "amber", "red"];
const STATUS_LABEL: Record<StatusResult, string> = { green: "Strength / clean", blue: "Observation", amber: "Concern", red: "Issue" };
const STATUS_EMOJI: Record<StatusResult, string> = { green: "🟢", blue: "🔵", amber: "🟡", red: "🔴" };
const STATUS_TO_RESULT: Record<string, StatusResult> = { strong: "green", observation: "blue", concern: "amber", issue: "red" };
const NOT_RUN = "⬜";
const NA = "▫️";
const TIP_DELAY_MS = 350;      // how long to hover before a tooltip opens
const CHECK_SECONDS = 1;      // how often an open page looks for a newer board
const PLACEHOLDER_SECTIONS: [string, string][] = [["Verse", "V"], ["Chorus", "C"]];  // shown until the lyric's sections are declared

// The assessments the board shows, in Tool List order: [name, what it is, checks], each check being
// [name, scope, what it does]. The same list as in status_board.py.
// Assessments that have no place in the table; listed under it.
const NOT_COVERED = ["Super-Thesaurus", "Audience Check", "Song Idea Development", "Song Idea Assessment"];

const ASSESSMENTS: [string, string, [string, "section" | "whole", string][]][] = [
  [
    "Core Assessment",
    "A first listen to the whole lyric.",
    [
      [
        "Emotional arc review",
        "whole",
        "Does the lyric build, resolve or land as intended?"
      ],
      [
        "Sliver of hope check",
        "whole",
        "Is there a moment of lift, or one unrelenting emotion?"
      ],
      [
        "Authenticity review",
        "section",
        "Does it sound like a real person in a real moment?"
      ],
      [
        "Cliche scan",
        "section",
        "Flags overused words, images and phrases."
      ],
      [
        "Beat review",
        "section",
        "Checks vowels, stress and syllable count against the melody."
      ],
      [
        "Singability review",
        "section",
        "Does the phrasing feel natural to perform?"
      ]
    ]
  ],
  [
    "Narrative Assessment",
    "Does the song actually move?",
    [
      [
        "Structural review",
        "whole",
        "Does each section do distinct work?"
      ],
      [
        "Verse-swap test",
        "whole",
        "Could two same-role sections swap with nothing changing?"
      ],
      [
        "Outro/resolution review",
        "whole",
        "Does the ending feel earned by what was set up?"
      ],
      [
        "Turn placement review",
        "whole",
        "Does the turn arrive at the right moment?"
      ],
      [
        "Thematic through-line",
        "whole",
        "Does the central idea hold, or drift?"
      ],
      [
        "Callback scan",
        "whole",
        "Are repeated words and images intentional echoes or accidents?"
      ],
      [
        "Narrative arc check",
        "whole",
        "Does the lyric move from situation to change, or stay static?"
      ],
      [
        "List serves a bigger statement",
        "section",
        "Does a list of images or events add up to a point?"
      ],
      [
        "Stakes check",
        "whole",
        "Will a listener know why this song matters, and to whom?"
      ]
    ]
  ],
  [
    "Song Dynamics Assessment",
    "Maps the energy curve of the song.",
    [
      [
        "Song dynamics graph",
        "whole",
        "The energy curve drawn across the song."
      ],
      [
        "Dynamics review",
        "whole",
        "Is there contrast between sections and a well-placed climax?"
      ],
      [
        "Section comparison",
        "whole",
        "Compares the energy of two sections and the gap between them."
      ]
    ]
  ],
  [
    "Sound and Rhythm Assessment",
    "How the words perform in the melody.",
    [
      [
        "Rhyme map",
        "whole",
        "Phonetic rhyme quality and scheme across the song."
      ],
      [
        "Hook strength test",
        "section",
        "Does the hook earn its repetition?"
      ],
      [
        "Line-level stress test",
        "section",
        "Does syllable stress line up with the melodic emphasis?"
      ],
      [
        "Ambiguity test",
        "section",
        "Is any line unclear or open to unintended misreading?"
      ],
      [
        "Intentional device review",
        "section",
        "Does a flagged element read as craft or as accident?"
      ],
      [
        "Lean lines test",
        "section",
        "Flags filler words and accidental short-range repetition."
      ]
    ]
  ],
  [
    "Perspective Shifts Assessment",
    "Sees the lyric from other angles.",
    [
      [
        "Angle reframe",
        "section",
        "Offers other emotional angles on what a section is saying."
      ],
      [
        "Understatement vs. declaration",
        "section",
        "Would a line land harder pulled back or pushed forward?"
      ],
      [
        "Specificity probe",
        "section",
        "Is the image concrete enough to land?"
      ],
      [
        "Listener lens",
        "whole",
        "How might a first-time listener receive this?"
      ],
      [
        "Show vs. tell review",
        "section",
        "Does it show emotion through image, or just state it?"
      ],
      [
        "Universal vs. generic check",
        "whole",
        "Is it too personal to share, or too smoothed-out to say anything?"
      ],
      [
        "Balance of Abstract and Specific",
        "whole",
        "Is each part as specific or as abstract as it needs to be?"
      ]
    ]
  ],
  [
    "Continuity Assessment",
    "Keeps the whole song coherent.",
    [
      [
        "Tense continuity",
        "whole",
        "Does the song stay in one tense unless a shift is deliberate?"
      ],
      [
        "Pronoun/address continuity",
        "whole",
        "Does who is spoken to or about stay consistent?"
      ],
      [
        "POV/person continuity",
        "whole",
        "Does first, second or third person stay stable?"
      ],
      [
        "Song fingerprint",
        "whole",
        "What the song keeps doing, and where it holds or breaks."
      ]
    ]
  ],
  [
    "Power Positions Assessment",
    "Where the strongest material sits.",
    [
      [
        "Power position test",
        "section",
        "Marks the most impactful line in each section."
      ],
      [
        "Power position analysis",
        "section",
        "Is the strongest material in a power position, or buried?"
      ],
      [
        "Opening line review",
        "section",
        "Does the first line earn its place and pull the listener on?"
      ],
      [
        "Closing line review",
        "section",
        "Does the last line land with the right weight?"
      ],
      [
        "Title placement review",
        "whole",
        "Does the title appear in a position of weight?"
      ],
      [
        "Title strength/quality test",
        "whole",
        "Is the title fresh and hooky, or the obvious treatment?"
      ]
    ]
  ]
];;

const CHECKS = new Map<string, string>();
const TIPS = new Map<string, string>();
for (const [group, tip, checks] of ASSESSMENTS) {
  TIPS.set(group, tip);
  for (const [name, scope, what] of checks) { CHECKS.set(name, scope); TIPS.set(name, what); }
}

class LogError extends Error {}

function worst(results: StatusResult[]): StatusResult | null {
  let best = -1;
  for (const r of results) best = Math.max(best, STATUS_ORDER.indexOf(r));
  return best < 0 ? null : STATUS_ORDER[best];
}

// Same escaping as Python's html.escape(quote=True), so the two pages match.
function escapeHtml(str: string): string {
  return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" } as Record<string, string>)[c]);
}

const checkRan = (check: StatusCheck): boolean => check.run !== false;
const sectionResult = (check: StatusCheck, section: string): StatusCell => check.cells?.[section] ?? { result: "green" };
const covered = (check: StatusCheck, section: string): boolean => !(check.uncovered ?? []).includes(section);

function summariseAssessment(a: StatusAssessment, lyricSections: string[]) {
  const counts: Record<StatusResult, number> = { green: 0, blue: 0, amber: 0, red: 0 };
  const ran = a.checks.filter(checkRan);
  for (const c of ran) {
    if (c.scope === "whole") { if (c.result) counts[c.result]++; }
    else for (const s of lyricSections) if (covered(c, s)) counts[sectionResult(c, s).result]++;
  }
  return { counts, ran: ran.length, total: a.checks.filter(c => !c.unsupported).length, stale: ran.some(c => c.stale) };
}

function chatLine(a: StatusAssessment, lyricSections: string[]): string {
  const { counts, ran, total } = summariseAssessment(a, lyricSections);
  if (ran === 0) return `${a.name} — not started (${total} checks)`;
  const parts = STATUS_ORDER.map(r => `${STATUS_EMOJI[r]} ${counts[r]}`).join(" · ");
  return `${a.name} ${parts} — ${ran} of ${total} run`;
}

// ─── The board as text (for the chat) ─────────────────────────────────────────

function groupCells(a: StatusAssessment, sections: string[], instrumental: Set<string>) {
  const ran = a.checks.filter(checkRan);
  const hasWhole = a.checks.some(c => c.scope === "whole");
  const hasSection = a.checks.some(c => c.scope === "section");
  const wholeWorst = worst(ran.filter(c => c.scope === "whole" && c.result).map(c => c.result as StatusResult));
  const whole = !hasWhole ? NA : (wholeWorst ? STATUS_EMOJI[wholeWorst] : NOT_RUN);
  const cells = sections.map(s => {
    if (instrumental.has(s) || !hasSection) return NA;
    const w = worst(ran.filter(c => c.scope === "section" && covered(c, s)).map(c => sectionResult(c, s).result));
    return w ? STATUS_EMOJI[w] : NOT_RUN;
  });
  return { whole, cells };
}

function textBoard(data: StatusData): string {
  const sections = data.sections;
  const instrumental = new Set(data.instrumental ?? []);
  const lyricSections = sections.filter(s => !instrumental.has(s));
  const view = data.view ?? "status";
  const out: string[] = [`**Song Status: ${data.title || "Untitled"}**`, ""];
  out.push(STATUS_ORDER.map(r => `${STATUS_EMOJI[r]} ${STATUS_LABEL[r]}`).join("  ") + `  ${NOT_RUN} Not run yet  ${NA} Doesn't apply`, "");
  out.push("| Section: | Whole | " + sections.join(" | ") + " |", "|---|---|" + "---|".repeat(sections.length));
  for (const a of data.assessments) {
    const sm = summariseAssessment(a, lyricSections);
    const { whole, cells } = groupCells(a, sections, instrumental);
    out.push(`| **${a.name}**${sm.stale ? " \\*" : ""} | ${whole} | ` + cells.join(" | ") + " |");
    if (!(view === "detailed" || (view !== "summary" && sm.ran > 0))) continue;
    for (const c of a.checks) {
      const isRun = checkRan(c);
      const name = "– " + c.name + (isRun && c.stale ? " \\*" : "");
      let wholeCell: string, row: string[];
      if (c.unsupported) {
        wholeCell = NOT_RUN;
        row = sections.map(() => NA);
      } else if (c.scope === "whole") {
        wholeCell = isRun ? STATUS_EMOJI[c.result ?? "green"] : NOT_RUN;
        row = sections.map(() => NA);
      } else {
        wholeCell = NA;
        row = sections.map(s => instrumental.has(s) ? NA : (isRun && covered(c, s) ? STATUS_EMOJI[sectionResult(c, s).result] : NOT_RUN));
      }
      out.push(`| ${name} | ${wholeCell} | ` + row.join(" | ") + " |");
    }
  }
  if (data.assessments.some(a => a.checks.some(c => checkRan(c) && c.stale))) out.push("", "\\* run before the latest edits");
  out.push("", "Assessments not covered by the table", "", ...NOT_COVERED.map(n => `* ${n}`));
  return out.join("\n") + "\n";
}

// ─── The board as a page ──────────────────────────────────────────────────────

function statusCell(kind: string, title = "", label = ""): string {
  const dot = (STATUS_ORDER as string[]).includes(kind) ? kind : (kind === "notrun" ? "notrun" : "");
  const t = title ? ` data-tip="${escapeHtml(title)}"` : "";
  const d = title && dot ? ` data-dot="${dot}"` : "";
  return `<td class="cell ${kind}"${t}${d}>${label}</td>`;
}

function resultCell(c: { result: StatusResult; note?: string | null } | null, what: string, where: string): string {
  if (!c) return statusCell("notrun", `${where} · ${what}: not run yet`);
  const note = c.note || STATUS_LABEL[c.result];
  return statusCell(c.result, `${where} · ${what}: ${note}`);
}

const STATUS_CSS = `
  :root { --green:#3E9E5C; --blue:#4A7FC1; --amber:#E0A93B; --red:#D0533F; --ink:#1A1A2E; --muted:#8A85A3; --line:#E4DFF5; --bg:#FAFAF7; }
  body { background:var(--bg); color:var(--ink); font-family:Georgia, serif; margin:0 auto; padding:40px 24px 64px; max-width:1000px; }
  h1 { font-weight:600; margin:0 0 4px; }
  .sub { color:var(--muted); margin-bottom:20px; }
  .key { display:flex; flex-wrap:wrap; gap:16px; font-size:13px; margin-bottom:24px; }
  .key span { display:inline-flex; align-items:center; gap:6px; }
  .chip { width:14px; height:14px; border-radius:3px; display:inline-block; }
  details { border:1px solid var(--line); border-radius:8px; background:#fff; margin-bottom:12px; overflow-x:auto; width:fit-content; max-width:100%; box-sizing:border-box; }
  summary { list-style:none; cursor:pointer; padding:6px 8px 0; }
  summary::-webkit-details-marker { display:none; }
  summary tr.summary .name::before { content:"▸ "; color:var(--muted); }
  details[open] summary tr.summary .name::before { content:"▾ "; }
  table { border-collapse:separate; border-spacing:4px; }
  .checks { padding:0 8px 8px; }
  th { font-weight:600; font-size:12px; color:var(--muted); text-align:center; min-width:30px; }
  th.name { text-align:left; color:var(--ink); font-size:14px; width:240px; min-width:240px; white-space:nowrap; padding-right:8px; }
  tr.head th.name { text-align:right; color:var(--muted); font-size:12px; font-weight:400; }
  th, td { padding:0; box-sizing:border-box; }
  td.cell, tr.head th:not(.name) { width:30px; min-width:30px; max-width:30px; }
  tr.check th.name { font-weight:400; padding-left:18px; }
  tr.notrun-row th.name { color:var(--muted); }
  td.cell { width:30px; height:22px; border-radius:4px; }
  #tip { position:fixed; z-index:10; display:none; max-width:50ch; padding:8px 12px; border-radius:6px; background:#F1EFF7; border:1px solid var(--line); color:#4A4660; font-family:inherit; font-size:14px; font-weight:400; line-height:1.4; pointer-events:none; box-shadow:0 3px 10px rgba(26,26,46,.12); }
  #tip i { display:inline-block; width:11px; height:11px; border-radius:50%; margin-right:7px; vertical-align:-1px; }
  #tip i.green { background:var(--green); } #tip i.blue { background:var(--blue); }
  #tip i.amber { background:var(--amber); } #tip i.red { background:var(--red); }
  #tip i.notrun { background:#E4DFF5; }
  tr > :nth-child(2) { width:44px; min-width:44px; max-width:44px; }
  td.green { background:var(--green); } td.blue { background:var(--blue); }
  td.amber { background:var(--amber); } td.red { background:var(--red); }
  td.notrun { background:#E7E4F3; }
  td.na, .chip.na { background:#fff url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'><path d='M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5' stroke='%23D2CEE2' stroke-width='1' fill='none'/></svg>") center/12px no-repeat; box-shadow:inset 0 0 0 1px #E6E3F1; }
  td.run { font-size:12px; color:var(--muted); padding-left:8px; white-space:nowrap; }
  .notcovered { margin-top:28px; font-size:14px; color:var(--muted); }
  .foot { font-size:12px; color:var(--muted); margin-top:8px; }
`;

function generateStatusBoard(data: StatusData, version = ""): string {
  const sections = data.sections;
  const names = data.section_names ?? {};
  const nameOf = (s: string) => names[s] ?? s;
  const instrumental = new Set(data.instrumental ?? []);
  const lyricSections = sections.filter(s => !instrumental.has(s));
  const view = data.view ?? "status";
  const head = `<tr class="head"><th class="name">Section:</th><th>Whole</th>${sections.map(s => `<th>${escapeHtml(s)}</th>`).join("")}</tr>`;

  const blocks = data.assessments.map(a => {
    const sm = summariseAssessment(a, lyricSections);
    const ran = a.checks.filter(checkRan);
    const wholeWorst = worst(ran.filter(c => c.scope === "whole" && c.result).map(c => c.result as StatusResult));
    const hasWhole = a.checks.some(c => c.scope === "whole");
    const hasSection = a.checks.some(c => c.scope === "section");
    const wholeCell = !hasWhole ? statusCell("na", "No whole-song checks")
      : wholeWorst ? resultCell({ result: wholeWorst }, a.name, "Whole song")
      : statusCell("notrun", "Whole-song checks not run yet");
    const sectionCells = sections.map(s => {
      if (instrumental.has(s) || !hasSection) return statusCell("na", instrumental.has(s) ? `${s}: instrumental` : "No section checks");
      const w = worst(ran.filter(c => c.scope === "section" && covered(c, s)).map(c => sectionResult(c, s).result));
      return w ? resultCell({ result: w }, a.name, nameOf(s)) : statusCell("notrun", `${nameOf(s)} · ${a.name}: not run yet`);
    }).join("");
    const mark = sm.stale ? " *" : "";
    const summaryRow = `<tr class="summary"><th class="name" data-tip="${escapeHtml(TIPS.get(a.name) ?? "")}">${escapeHtml(a.name)}${mark}</th>${wholeCell}${sectionCells}</tr>`;

    const rows = a.checks.map(c => {
      const isRun = checkRan(c);
      const whole = c.unsupported ? statusCell("notrun", `Whole song · ${c.name}: Not yet supported`)
        : c.scope === "whole"
        ? (isRun ? resultCell({ result: c.result ?? "green", note: c.note }, c.name, "Whole song") : resultCell(null, c.name, "Whole song"))
        : statusCell("na");
      const cells = sections.map(s => {
        if (c.scope === "whole" || instrumental.has(s)) return statusCell("na");
        return isRun && covered(c, s) ? resultCell(sectionResult(c, s), c.name, nameOf(s)) : resultCell(null, c.name, nameOf(s));
      }).join("");
      const cmark = isRun && c.stale ? " *" : "";
      return `<tr class="check${isRun ? "" : " notrun-row"}"><th class="name" data-tip="${escapeHtml(TIPS.get(c.name) ?? "")}">${escapeHtml(c.name)}${cmark}</th>${whole}${cells}</tr>`;
    }).join("");

    const open = view === "detailed" || (view !== "summary" && sm.ran > 0);
    return `<details${open ? " open" : ""}><summary><table>${head}${summaryRow}</table></summary>\n<table class="checks">${rows}</table></details>`;
  }).join("\n");

  const notCovered = NOT_COVERED.map(n => `<li>${escapeHtml(n)}</li>`).join("");
  const stale = data.assessments.some(a => a.checks.some(c => checkRan(c) && c.stale));
  const title = escapeHtml(data.title || "Untitled");
  const key = STATUS_ORDER.map(r => `<span><i class="chip" style="background:var(--${r})"></i>${STATUS_LABEL[r]}</span>`).join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Song Status: ${title}</title>
<style>${STATUS_CSS}</style></head><body>
<h1>Song Status: ${title}</h1>
<div class="sub">Song status — hover a square to see the finding; click an assessment to show or hide its checks.</div>
<div class="key">${key}<span><i class="chip" style="background:#E7E4F3;box-shadow:inset 0 0 0 1px #DAD6EA"></i>Not run yet</span><span><i class="chip na"></i>Doesn't apply</span></div>
${blocks}
${stale ? '<div class="foot">* run before the latest edits</div>' : ""}
<div id="tip"></div>
<div class="notcovered"><div>Assessments not covered by the table</div><ul>${notCovered}</ul></div>
<script>
// An open tab looks for a newer board (a small .version.js file next to the page) and reloads
// only when it has changed. Which panels are open is remembered across reloads.
const VERSION = "${version}";
const versionUrl = location.href.replace(/\\.html(\\?.*)?$/, ".version.js");
setInterval(() => {
  const probe = document.createElement("script");
  probe.src = versionUrl + "?t=" + Date.now();
  probe.onload = () => { if (window.statusVersion && window.statusVersion !== VERSION) location.reload(); probe.remove(); };
  probe.onerror = () => probe.remove();
  document.head.appendChild(probe);
}, ${CHECK_SECONDS * 1000});
const tip = document.getElementById("tip");
let tipTimer, hideTimer;
function showTip(el) {
  tip.textContent = "";
  if (el.dataset.dot) { const dot = document.createElement("i"); dot.className = el.dataset.dot; tip.appendChild(dot); }
  tip.appendChild(document.createTextNode(el.dataset.tip));
  tip.style.display = "block";
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(r.left + 16, innerWidth - w - 8)) + "px";
  tip.style.top = (r.bottom + h + 12 > innerHeight ? r.top - h - 6 : r.bottom + 6) + "px";
}
document.querySelectorAll("[data-tip]").forEach(el => {
  if (!el.dataset.tip) return;
  el.addEventListener("mouseenter", () => {
    clearTimeout(hideTimer);
    clearTimeout(tipTimer);
    // Moving between neighbouring boxes swaps the tooltip at once; a first hover waits a moment.
    if (tip.style.display === "block") showTip(el);
    else tipTimer = setTimeout(() => showTip(el), ${TIP_DELAY_MS});
  });
  el.addEventListener("mouseleave", () => {
    clearTimeout(tipTimer);
    hideTimer = setTimeout(() => { tip.style.display = "none"; }, 150);
  });
});
try {
  const key = "status-open:" + document.title;
  const saved = JSON.parse(sessionStorage.getItem(key) || "null");
  const panels = [...document.querySelectorAll("details")];
  if (saved) panels.forEach((d, i) => { d.open = !!saved[i]; });
  panels.forEach(d => d.addEventListener("toggle", () => sessionStorage.setItem(key, JSON.stringify(panels.map(p => p.open)))));
} catch (e) {}
</script>
</body></html>`;
}

// ─── The log ──────────────────────────────────────────────────────────────────

interface LogSection { name: string; abbrev: string; instrumental: boolean }
interface LogTest { cells: Map<string, StatusCell>; whole: StatusCell | null; stale: boolean; covered: Set<string> }

function readStatusLog(lines: string[]): StatusData {
  let title: string | null = null;
  let sections: LogSection[] = [];
  const tests = new Map<string, LogTest>();
  const unsupported = new Set<string>();   // checks this platform cannot run (shown as "Not yet supported")

  const find = (name: unknown, number: number): LogSection => {
    const s = sections.find(x => x.name === name);
    if (!s) throw new LogError(`line ${number}: no section called '${name}' (sections: ${sections.map(x => x.name).join(", ") || "none yet"})`);
    return s;
  };
  const freshTest = (): LogTest => ({ cells: new Map(), whole: null, stale: false, covered: new Set(sections.filter(s => !s.instrumental).map(s => s.name)) });

  lines.forEach((rawLine, index) => {
    const number = index + 1;
    const raw = rawLine.trim();
    if (!raw) return;
    let line: any;
    try { line = JSON.parse(raw); } catch (problem) { throw new LogError(`line ${number}: not valid JSON (${(problem as Error).message})`); }
    switch (line.event) {
      case "song":
        title = line.title ?? null;
        break;
      case "section": {
        const { name, abbrev } = line;
        if (!name || !abbrev) throw new LogError(`line ${number}: a section needs a name and an abbrev`);
        if (sections.some(s => s.name === name)) throw new LogError(`line ${number}: there is already a section called '${name}'; name a repeat 'Chorus 2'`);
        if (sections.some(s => s.abbrev === abbrev)) throw new LogError(`line ${number}: the abbrev '${abbrev}' is already used`);
        sections.push({ name, abbrev, instrumental: !!line.instrumental });
        break;
      }
      case "section-order": {
        const ordered = ((line.names as string[]) ?? []).map(n => find(n, number));
        sections = [...ordered, ...sections.filter(s => !ordered.includes(s))];
        break;
      }
      case "section-rename": {
        const s = find(line.name, number);
        const newName = line.new_name || s.name;
        if (newName !== s.name && sections.some(o => o.name === newName)) throw new LogError(`line ${number}: there is already a section called '${newName}'`);
        const old = s.name;
        s.name = newName;
        if (line.abbrev) s.abbrev = line.abbrev;
        for (const t of tests.values()) {
          if (t.cells.has(old)) { t.cells.set(newName, t.cells.get(old)!); t.cells.delete(old); }
          if (t.covered.has(old)) { t.covered.delete(old); t.covered.add(newName); }
        }
        break;
      }
      case "section-replace": {
        const s = find(line.name, number);
        for (const t of tests.values()) { t.cells.delete(s.name); t.covered.delete(s.name); }
        break;
      }
      case "section-delete": {
        const s = find(line.name, number);
        sections = sections.filter(x => x !== s);
        for (const t of tests.values()) { t.cells.delete(s.name); t.covered.delete(s.name); }
        break;
      }
      case "unsupported":
        if (!CHECKS.has(line.test)) throw new LogError(`line ${number}: unknown check '${line.test}'`);
        unsupported.add(line.test);
        break;
      case "run":
        if (!CHECKS.has(line.test)) throw new LogError(`line ${number}: unknown check '${line.test}'`);
        tests.set(line.test, freshTest());
        break;
      case "result": {
        const test = line.test as string;
        if (!CHECKS.has(test)) throw new LogError(`line ${number}: unknown check '${test}'`);
        if (!(line.status in STATUS_TO_RESULT)) throw new LogError(`line ${number}: status must be one of ${Object.keys(STATUS_TO_RESULT).join(", ")}`);
        if (!tests.has(test)) tests.set(test, freshTest());
        const t = tests.get(test)!;
        const cell: StatusCell = { result: STATUS_TO_RESULT[line.status] };
        if (line.note) cell.note = line.note;
        const where = line.section;
        if (where === "whole") {
          if (CHECKS.get(test) !== "whole") throw new LogError(`line ${number}: '${test}' is a section check; give a section name`);
          t.whole = cell;
        } else {
          if (CHECKS.get(test) !== "section") throw new LogError(`line ${number}: '${test}' is a whole-song check; use "section":"whole"`);
          find(where, number);
          t.cells.set(where, cell);
          t.covered.add(where);
        }
        break;
      }
      case "edit": {
        const where = line.section;
        find(where, number);
        for (const [test, t] of tests) if (CHECKS.get(test) === "whole" || t.covered.has(where)) t.stale = true;
        break;
      }
      default:
        throw new LogError(`line ${number}: unknown event '${line.event}'`);
    }
  });

  if (sections.length === 0) {
    // Nothing declared yet: show a plain Verse / Chorus board so the table isn't empty.
    sections = PLACEHOLDER_SECTIONS.map(([name, abbrev]) => ({ name, abbrev, instrumental: false }));
    for (const t of tests.values()) t.covered = new Set(sections.map(s => s.name));
  }
  const lyric = sections.filter(s => !s.instrumental).map(s => s.name);
  const abbrevOf = (name: string) => sections.find(s => s.name === name)!.abbrev;
  const assessments: StatusAssessment[] = ASSESSMENTS.map(([aName, , checks]) => ({
    name: aName,
    checks: checks.map(([name, scope]) => {
      const row: StatusCheck = { name, scope };
      const t = tests.get(name);
      if (unsupported.has(name)) { row.run = false; row.unsupported = true; }
      else if (!t) row.run = false;
      else if (scope === "whole") {
        const cell = t.whole ?? { result: "green" as StatusResult };
        row.result = cell.result;
        row.note = cell.note;
      } else {
        row.cells = Object.fromEntries([...t.cells].map(([n, c]) => [abbrevOf(n), c]));
        row.uncovered = lyric.filter(n => !t.covered.has(n)).map(abbrevOf);
      }
      if (t?.stale) row.stale = true;
      return row;
    }),
  }));
  return {
    title,
    view: "status",
    sections: sections.map(s => s.abbrev),
    instrumental: sections.filter(s => s.instrumental).map(s => s.abbrev),
    section_names: Object.fromEntries(sections.map(s => [s.abbrev, s.name])),
    assessments,
  };
}


// ─── Command line ─────────────────────────────────────────────────────────────

function usage(): never {
  console.error("Usage: node lyric-analysis.ts <parse|rhyme-map|rhythm-map> <lyrics-file | -> [--time 3/4] [--title 'Song title'] [--out DIR]\n       node lyric-analysis.ts status-board <status.jsonl> [--add '<json line>']... [--view status|summary|detailed] [--out DIR]");
  process.exit(2);
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "song";
}

function defaultOutDir(): string {
  const sandbox = "/mnt/user-data/outputs";
  return fs.existsSync(sandbox) ? sandbox : process.cwd();
}

function runStatusBoard(input: string, adds: string[], view: string | undefined, outDir: string) {
  const text = fs.existsSync(input) ? fs.readFileSync(input, "utf8") : "";
  const existing = text === "" ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/);   // same line numbers as Python's splitlines()
  try {
    readStatusLog([...existing, ...adds]);           // check the new lines before saving them
  } catch (problem) {
    if (problem instanceof LogError) { console.error(`Not saved: ${problem.message}`); process.exit(1); }
    throw problem;
  }
  if (adds.length) fs.appendFileSync(input, adds.map(line => line.trim() + "\n").join(""));
  const data = readStatusLog([...existing, ...adds]);
  if (view) data.view = view as StatusData["view"];
  fs.mkdirSync(outDir, { recursive: true });
  const htmlFile = path.join(outDir, `${slugify(data.title || "song")}-status.html`);
  const version = crypto.createHash("sha1").update(JSON.stringify(data)).digest("hex").slice(0, 12);
  fs.writeFileSync(htmlFile, generateStatusBoard(data, version));
  fs.writeFileSync(htmlFile.replace(/\.html$/, ".version.js"), `window.statusVersion = "${version}";\n`);
  const instrumental = new Set(data.instrumental ?? []);
  const lyricSections = data.sections.filter(s => !instrumental.has(s));
  console.log(JSON.stringify({
    html_file: htmlFile,
    chat_lines: data.assessments.map(a => chatLine(a, lyricSections)),
    markdown: textBoard(data),
  }, null, 2));
}

function main(argv: string[]) {
  const [command, input, ...rest] = argv;
  if (!command || !input) usage();

  let timeArg: string | undefined;
  let titleArg: string | undefined;
  let outDir = defaultOutDir();
  const adds: string[] = [];
  let view: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--time") timeArg = rest[++i];
    else if (rest[i] === "--title") titleArg = rest[++i];
    else if (rest[i] === "--out") outDir = rest[++i];
    else if (rest[i] === "--add") adds.push(rest[++i]);
    else if (rest[i] === "--view") view = rest[++i];
    else usage();
  }

  if (command === "status-board") {
    runStatusBoard(input, adds, view, outDir);
    return;
  }

  const lyrics = fs.readFileSync(input === "-" ? 0 : input, "utf8");
  if (!lyrics.trim()) { console.error("No lyrics found in input."); process.exit(1); }

  if (command === "parse") {
    console.log(JSON.stringify(parseLyrics(lyrics), null, 2));
    return;
  }

  const parseResult = parseLyrics(lyrics);
  const title       = titleArg ?? parseResult.title ?? "Untitled";   // --title: the song's title, when the text has no Title line (the loader sets it aside)
  const parsed      = toFlatEntries(parseResult);
  const wordIndex   = buildWordIndex(parsed);
  const analysis    = buildAnalysis(title, parsed, wordIndex);
  fs.mkdirSync(outDir, { recursive: true });

  if (command === "rhyme-map") {
    const htmlFile = path.join(outDir, `${slugify(title)}-rhyme-map.html`);
    fs.writeFileSync(htmlFile, injectRhymeData(analysis));
    console.log(JSON.stringify({ analysis, html_file: htmlFile }, null, 2));
    return;
  }

  if (command === "rhythm-map") {
    // Resolve time signature: --time → metadata → default 4/4
    let timeSig = timeArg;
    if (!timeSig && parseResult.metadata) {
      timeSig = parseResult.metadata.time || parseResult.metadata.time_signature;
    }
    const resolvedTimeSig = timeSig || "4/4";
    const svg = generateRhythmMapSvg(title, analysis.sections, analysis.word_map, getBeatPattern(resolvedTimeSig));
    const svgFile = path.join(outDir, `${slugify(title)}-rhythm-map.svg`);
    fs.writeFileSync(svgFile, svg);
    const result: Record<string, unknown> = { svg_file: svgFile, title, time_signature: resolvedTimeSig, sections: analysis.sections.length };
    if (!timeSig) result.note = "Time signature not specified — defaulting to 4/4. Add {time: 3/4} to your lyrics or pass --time to change.";
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  usage();
}

main(process.argv.slice(2));
