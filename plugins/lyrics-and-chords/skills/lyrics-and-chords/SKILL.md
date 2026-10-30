---
name: lyrics-and-chords
description: Loads song lyric and chord files (plain lyrics, chords above words, inline chords, ChordPro, Word files, pasted text), repairs what the readers get wrong, checks that no word or chord was lost, and returns a JSON object: the song with its facts and sections, plus anything it could not resolve. Runs entirely offline. Use to load, parse, convert or check a lyric or chord file, not to critique or write lyrics.
license: GPL-2.0-only
compatibility: Requires Node.js 18 or later. Makes no network requests.
metadata:
  version: "0.1.5"
---

# Lyrics & Chords (provisional)

Version 0.1, provisional. The scripts under "What works now" are built; capabilities marked planned are not.

## Which Node to use

If you have a tool named `load_workspace_dependencies` (ChatGPT's desktop app), call it once at the start of the conversation and run every script with the Node.js path it returns, as `<that path> scripts/load.mjs …`. Do not use `node` from the command line, which may be a different version.

If that tool is there but returns no Node.js path, stop. Say: "I can't find the app's bundled Node.js, so I can't load this song. Please send feedback to lyrics-and-chords@musios.app and say which version of the ChatGPT app you have." Do not read the song by hand instead.

Without that tool (Claude), run the scripts with `node`.

## What works now

Seven scripts in `scripts/`. `load.mjs` runs the others in order; each of them also works on its own. Each takes data on standard input or from a file, prints JSON or text on standard output, and prints notes and errors on standard error.

| Script | Does | Exit codes |
|---|---|---|
| `load.mjs <file \| Word file \| ->` | **The all-in-one.** Takes a file, pasted text (`-`) or a Word file (text only). Parse, set aside lines, add facts, check, optionally write out, in one command: `--facts facts.json`, `--set-aside 1,2`, `--chart 10-28`, `--keep-chart`, `--as chordpro`, `--output song.cho`, `--format`. `--save FOLDER` (or `--save default`: Documents) writes a readable file named `<title> - <artist>.txt` (chords above the words if the song has chords; never replaces a file) and `--open` opens it in the default app. Prints one JSON object (see "What it returns"). A song that fails the check is never returned. | 0 loaded; 1 failed; 2 bad option |
| `parse.mjs <file>` | Reads one well-formed sheet and prints ChordSheetJS's own JSON, unchanged. Picks ChordPro, chords over words or Ultimate Guitar style itself, or takes `--format` (also `lyrics-only`: text with no chords, where a line that is only `[Something]` is a section header and nothing is ever read as a chord). A sheet it cannot read gives the line and column, the lines around it and a hint. | 0 done; 1 could not parse; 2 unknown format |
| `read-docx.mjs <song.docx>` | Takes the text out of a Word file: one line for each paragraph, a tab as a space. Comments, deleted text (tracked changes), formatting, styles and pictures are ignored; text inside a table comes out one line per paragraph. | 0 read; 1 not a Word file it can read; 2 bad option or file |
| `add-metadata.mjs --meta facts.json` | Adds song facts (title, subtitle, artist, writer, composer, lyricist, copyright, album, year, date, version, key, time, tempo, duration, capo) to the parsed JSON as metadata lines. Lyric lines are not touched. Values are kept as written, for example `"tempo": "124 bpm"`. | 0 done; 1 input not from parse; 2 bad option or facts |
| `set-aside.mjs --original <file> --lines 1,2` | Takes lines that are not lyrics (a title, a credit line) out of the parsed song. Lines are named by their number in the original, never retyped. Changes nothing if a named line is not a lyric line. | 0 done; 1 a named line is not a lyric line; 2 bad option or input |
| `check.mjs --original <file> [--set-aside 1,2]` | Confirms the lyric lines in the parsed song match the original, and that every chord is still there. Ignores all spacing; compares words and punctuation exactly. Reports `changed`, `missing` and `extra` lines, `chords-missing`, `not-a-chord` (something other than a chord name sitting in a chord position, such as a header or a word) and `sections-missing` (fewer sections in the song than `[Header]` lines in the original). Lines named in `--set-aside` are not reported as missing and are listed in the output. | 0 match; 1 mismatch; 2 bad option or input |
| `format.mjs [--as text \| chordpro \| chords-over-words \| lyrics-only]` | Turns the parsed JSON back into text (`lyrics-only`: the facts as `Key: value` lines, then each section as a `[Label: Performer]` line and its lyric lines, with no chords or comments). Chord names are written exactly as read (the library would rewrite `maj7` as `ma7`). | 0 done; 1 could not format; 2 unknown output |

```
node scripts/parse.mjs song.cho | node scripts/add-metadata.mjs --meta facts.json | node scripts/format.mjs --as chordpro
node scripts/parse.mjs song.cho | node scripts/check.mjs --original song.cho
```

Text with no chords, where a line that is only `[Something]` is a section header (`--format lyrics-only`), is read so that `[Verse 1: Name]` becomes the section "Verse 1" followed by a `comment` line holding the performer, and a name such as "Ann B" can never be read as a chord.

Parse also makes these repairs, because the library gets them wrong:
- Section labels written without brackets (`V1`, `VERSE 1`, `Chorus`, `Chorus x2`) are read as section headers; the chord readers would take `V1` for chords. Header lines (`[Verse 1]`) become sections, and `[Verse 1: Name]` becomes the section "Verse 1" plus a `comment` with the performer.
- Text with chords written inline (`[Am]word`) and `[Header]` lines is read as ChordPro, with the headers turned into sections first.
- A chord line the library cannot give back exactly as written (`G(maj7)`, `Em7(♭5)/D`, `| Emaj7| Emaj7 |`) is read by this skill instead: its chords are attached to the lyric line below by column. A bar mark touching a chord counts as a mark of its own. `x2` and `2x` are repeat marks.
- A line of two or more bracketed chords (`[D] [Am] [G/D]`) is read as a chord line.
- A section runs from its header to the next header, across blank lines; padding spaces on chords are trimmed.

Known limits: a chord line that has a word in it (`Intro | Gm79 | C7`) is read as a lyric line, and `check` says so; a bracket that is never closed is a parse error that names the file and the line, and says how sure it is (fix it in the file).

Not yet built: labelling sections beyond the headers the writer wrote, annotations read from the text (such as backing vocals), Nashville numbers (a ChordPro file with number chords is read, but `check` does not accept numbers as chords, so it fails). The scripts are self-contained and need only Node.js 18 or later.

## What it returns

`load.mjs` prints one JSON object. The words below are invented.

```json
{
  "status": "ok",
  "missing": [],
  "questions": [],
  "problems": [],
  "notes": ["format: chords-over-words"],
  "setAside": [],
  "song": {
    "type": "chordSheet",
    "lines": [
      { "type": "line", "items": [{ "type": "tag", "name": "title", "value": "Invented Song", "attributes": {} }] },
      { "type": "line", "items": [{ "type": "tag", "name": "start_of_verse", "value": "Verse 1", "attributes": {} }] },
      { "type": "line", "items": [
        { "type": "chordLyricsPair", "chords": "Am", "chord": null, "lyrics": "Some invented ", "annotation": "" },
        { "type": "chordLyricsPair", "chords": "C", "chord": null, "lyrics": "words here", "annotation": "" } ] },
      { "type": "line", "items": [{ "type": "tag", "name": "end_of_verse", "value": "", "attributes": {} }] }
    ]
  }
}
```

- `status` is `ok`, `needs-info` (loaded, but the title, the credits or the date is missing: `missing` names them and `questions` has a plain question for each) or `failed` (nothing is returned as a song; `problems` says why, with line numbers).
- `song` is ChordSheetJS's JSON. It is returned only after the check has confirmed that every lyric word and every chord of the original is still there.
- Song facts are tag lines near the top: `title`, `artist`, `writer`, `lyricist`, `composer`, `album`, `year`, `date`, `version`, `key`, `time`, `tempo`, `capo`.
- Sections are `start_of_verse`, `start_of_chorus`, `start_of_bridge` or `start_of_part` (intro, outro, solo, pre-chorus and the rest), with the writer's own label as the value, closed by the matching `end_of_...`. A performer named in a header is a `comment` tag straight after the start.
- A lyric line is a list of `chordLyricsPair` items. Join their `lyrics` to get the line; `chords` is the chord that starts at that point, or an empty string. A line of chords alone has empty `lyrics`; bar marks (`|`) are items too. A blank line has no items.
- `notes` lists what was repaired; `setAside` lists lines removed because they were not lyrics.
- A chord chart in front of the lyrics (a "Chords" or "Chart" heading, bar lines, notes such as "2x repeat", then a "Lyrics" heading) is set aside on its own and given as `chart` (`from`, `to`, `text`); the other line numbers do not change. If four or more chord-only rows come before any lyric line and there are no such headings, nothing is changed and `questions` asks the writer whether to set them aside: if yes, run again with `--chart FROM-TO`; if they are part of the song, run again with `--keep-chart`.

## What it is for

Turn a lyric or chord sheet in almost any common layout into one predictable JSON structure. It is a helper for other skills (the Songwriting Coach in particular) and is useful on its own.

## What it does not do

- Judge, rate or rewrite lyrics, or suggest chords.
- Analyse rhyme, rhythm or syllables.
- Fetch anything from the web. It works on the text and files it is given, and makes no network requests.
- Read PDFs or images.
- Load a chord chart that has no lyrics (bars and section labels only). It says so plainly and returns nothing.

## Capabilities

Source: **library** = ChordSheetJS (GPL-2.0-only, bundled); **own** = our code on top; **model** = the assistant's judgement; **maybe** = not committed.

### 1. Read these layouts

| Input | Source |
|---|---|
| ChordPro, with `{directives}` | library |
| Chords above words | library |
| Ultimate Guitar style text | library |
| Inline chords `[Am]word [C]word` | library |
| Plain lyrics, no labels (blank-line blocks) | own, then model for labelling |
| Bracketed headers `[Verse 1]`, `[Chorus]` | own |
| Bare or ALL CAPS headers, with colons or `x2` | own |
| Saved Ultimate Guitar and Chordie pages (.html) | own |
| Pasted-text clutter: extra blank lines, smart quotes, non-breaking spaces, HTML leftovers | own |
| Word (.docx) | maybe |
| Nashville numbers, lead sheets | maybe |

### 2. Classify every line

Header, chord line, tab line, metadata, directive, annotation (`x2`, capo, `N.C.`, timestamps) or lyric. Odd cases are reported, not guessed. (own)

### 3. Return JSON

Built, in ChordSheetJS's own shape: `{ "type": "chordSheet", "lines": [...] }`, where each lyric line is a list of chord-and-lyric pairs and the song facts are tag lines at the top. (library)

Decided (9 Oct 2026): this is the output. We define no schema of our own, and no normalised section codes. Sections are the `start_of_...` / `end_of_...` tags; annotations use the `annotation` field and `comment` tags. The Songwriting Coach adapts to this JSON. (library)

### 4. Keep the meaning of the lyrics

Lyric words are copied from the input by a script, never retyped by the model. Spacing may change (indentation, runs of spaces, trailing spaces); words and punctuation may not. (own)

### 5. Check a result against its source

Built (`check.mjs`). Compares the JSON's lyric lines with the original text and reports each difference as `changed`, `missing` or `extra`, so a caller can fix it or fall back safely. (own)

### 6. Say what it could not resolve

Unrecognised blocks, uncertain labels and a list of questions for the writer, instead of a confident wrong answer. The model resolves these or asks. (own plus model)

### 7. Write the structure back out

Built (`format.mjs`): plain text, ChordPro, or chords above words. (library)

### 8. Add song facts

Built (`add-metadata.mjs`): title, artist, credits, key, tempo and the other facts listed above are added after loading, from a facts file. Copyright is added only if the source has it; the user is never asked for it. (own)

### 9. Load

Built (`load.mjs`) for pasted text, files and Word files. One entry point that runs the steps in a fixed order: read, parse, set aside non-lyric lines, add facts, check, then report any missing facts. If title, credits or date of publication are missing, the user is asked and the answers go in with step 8. (own plus model)

## Title, credits and other facts

Plain-text sheets usually open with a title and a credit line that nothing marks as such (`Invented Song`, then `Music & Lyrics: Ann B - 17 April 2025 (v4)`). The parser reads them as lyric lines. Fixing that is Claude's job, with scripts doing the exact steps:

1. After `parse`, read the lines before the first section. Decide which are the title, the credits, a date, a version, a key or a tempo. Labelled lines such as `Key: D major` are already read as facts.
2. Write a facts file for `add-metadata` (title, lyricist, composer, date, version...). Copy words exactly as written. Use only what the lines say: do not guess a year or a role.
3. Run `set-aside.mjs --original <file> --lines N,N` for the lines that held those facts. Name the lines by number; never retype them.
4. Run `check.mjs` with the same line numbers as `--set-aside`. The check lists the lines set aside.
5. Tell the writer which lines you treated as facts and not lyrics, so a mistake can be seen. If it is unclear whether a line is a lyric or a fact, ask; do not set it aside.

If `set-aside` refuses a line, it is not a lyric line in the song (a header, a blank line or a fact already read). Leave it.

## When something goes wrong

Work through three steps, in this order, and stop at the first that solves it.

1. **The scripts.** `parse` and `check` report problems with a line number. Where a script can fix it safely (for example, a section that is never closed), it does.
2. **Claude, up to two more attempts.** Read the script's message and state a line-level fix on the writer's original: "line 1 is page text, remove it", "line 12 is a header, wrap it in brackets". A script applies it. Never retype the document: that is how a lyric word gets changed. Run `check` against the writer's original each time. After two attempts, stop.
3. **The writer.** Tell them plainly. Never pass raw script or parser text to the writer.

### What to tell the writer

Every message to the writer has five parts:
1. **What went wrong,** in one plain sentence with no parser words.
2. **The line or lines involved,** quoted with their line numbers, so they can find them in their own file.
3. **What was already tried,** so they do not repeat it.
4. **One or two concrete choices:** fix line N like this, paste the text here instead, or tell me to leave a line out.
5. **A statement that their file has not been changed.**

Start from each problem's `message`: `check` writes one in plain words for every problem, with the line, what happened to it and what to look for. Join related ones into a single message to the writer rather than listing each. A message gives no more certainty than the skill has: when it says "probably", say so.

Ask them about structure (a bracket, a header, page text). Never ask them to change their lyrics to suit the tool.

Examples:

> I couldn't read your file. Line 4 starts a section with `{` but never closes it with `}`:
> `line 4: {start_of_verse: V1`
> If you add the `}` and load it again, it should work. Or paste the text here and I'll load it that way. Your file hasn't been changed.

> The first line of the lyrics has extra text in front of it: "1 ContributorBecause Lyrics". I didn't want to delete anything from your lyrics on my own. Should I treat that as page text and leave it out?

> This looks like a chord chart with no lyrics, so Lyrics & Chords can't load it. If it has lyrics somewhere that I've missed, tell me where they start.

Not every problem raises an error. A header with a missing bracket (`[Verse 1`) loads as an ordinary lyric line. That comes up as a question when sections are labelled, not as an error.

## Rules

- Everything runs locally. The skill makes no network requests.
- Never change a lyric word, line break or spelling to tidy it.
- When unsure whether a line is lyric, label or annotation, ask.

## Not decided

Nashville numbers; charts with no lyrics; chord lines that contain a word.

## Licence

GPL-2.0-only, because it bundles ChordSheetJS (GPL-2.0-only). Full text in `LICENSE`.
