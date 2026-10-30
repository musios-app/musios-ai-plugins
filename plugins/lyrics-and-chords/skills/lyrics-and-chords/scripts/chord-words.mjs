// Lyrics & Chords: shared test for "does this text look like a chord name?".
// Used by parse.mjs and check.mjs so both agree. Accepts D, Am7, Gmaj7/D, Em7(♭5)/D,
// Gminmaj79, F#m, Bb/D. The letters after the root come from a closed list, so
// ordinary words such as "And" or "Feel" are not mistaken for chords.
const QUALITY = "(?:maj|min|dim|aug|sus|add|alt|m|M|[0-9]|[#b♭♯+\\-()])*";
// Marks that sit in a chord line besides chords: bar lines, slashes, repeat counts, no-chord.
// A hold mark ("G …", "G...") says to keep the chord going.
export const MARK = /^(\||\|\||\/|x|-|N\.C\.|\(?[0-9]+x\)?|\(?x[0-9]+\)?|:\|\|?|\|:|…|\.{2,})$/;
// The words of a chord line with their columns. A bar mark is a word of its own even when it touches a chord
// ("Emaj7|" is "Emaj7" and "|").
// A hold mark touching a chord ("G…") is a word of its own too.
export const chordTokens = (line) =>
  [...line.matchAll(/\|+|[^\s|]+/g)].flatMap((m) => {
    const hold = m[0].match(/^(.*[^.…])(…|\.{2,})$/);
    return hold ? [{ text: hold[1], index: m.index }, { text: hold[2], index: m.index + hold[1].length }] : [{ text: m[0], index: m.index }];
  });
export const CHORD = new RegExp(`^[A-G][#b♭♯]?${QUALITY}(?:\\/[A-G][#b♭♯]?${QUALITY})?$`);

// A section label written without brackets: "Verse 1", "CHORUS", "V1", "Pre-Chorus:", "Chorus x2", and with a
// performer or two after a colon: "Verse 1: Singer A". The performer part is short and is not a sentence.
// Used by parse.mjs (to make it a section) and check.mjs (to count the sections that should exist).
export const SECTION_HEADER = /^\s*(?:(?:intro|outro|verse|chorus|pre[- ]?chorus|post[- ]?chorus|bridge|solo|interlude|instrumental|hook|refrain|tag|coda|break(?:down)?|middle\s*8?)(?:\s*\d+)?|v\d+|ch\d+|pre\d*|post\d*|br\d*)\s*(?::\s*(?:[^\s.!?\[\]:][^.!?\[\]:]{0,60})?)?\s*(?:\(?x\d+\)?)?\s*$/i;

