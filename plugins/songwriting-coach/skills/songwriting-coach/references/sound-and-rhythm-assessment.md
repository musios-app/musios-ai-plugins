# Sound and Rhythm Assessment

*How words perform in the melody*

- **Rhyme map** — phonetic rhyme quality (perfect, near, forced), scheme assessment, and interactive visualisation using cmudict. Use this tool for any rhyme-related visualisation or analysis request, regardless of how it is phrased. If a genre is known, calibrate what counts as an acceptable near-rhyme or forced rhyme against that genre's conventions — jazz and hip-hop traditions tolerate looser and more inventive rhyme than, say, traditional hymn form.

**Tool call:** run the analysis script's `rhyme-map` command on the cleaned lyric text (see "Local analysis" in SKILL.md), adding `--title "<the song's title>"` if the text has no `Title:` line — apply the same normalisation described in `references/upload-lyrics.md` (bracketed section headers, chords and annotations stripped) first, even if the writer didn't explicitly run Upload Lyrics. The output contains `analysis` with sections, rhyme groups, and a `word_map` (vowel family + stressed-syllable span per word).

**Visualisation — always output this after running rhyme-map, regardless of how the request was phrased:**
The output includes an `html_file` field — the path of the interactive rhyme map the script wrote. Present the analysis findings in your response (using the fields listed below), then after the analysis, share that file with the writer as a prominent, clearly-labelled item: open it for them as described below, or if that fails give a link, like:

> 🔗 **[Interactive rhyme map](HTML_FILE)** — open in your browser (shows per-syllable colours, rhyme scheme, isolated families)

The page is fully interactive. Share the file the script wrote — do not try to generate or embed the visualization yourself.

On ChatGPT, open `html_file` in the app's browser with `mcp__codex_app__open_in_codex`, `target.type` `"browser"` and `target.url` the absolute file URL (`file:///…`). A request for the rhyme map authorizes this; don't ask first. If it can't be opened, give a bold, clickable link to `html_file` on its own line and say briefly that it couldn't be opened automatically.

**For written analysis**, use these fields:
- `analysis.sections[].rhyme_scheme` — per-section scheme string (e.g. `ABCB`)
- `analysis.sections[].lines[].rhyme_type` — `"perfect"` or `"slant"` for a line end-word that shares a scheme letter with another line in its section, and `"none"` for one that rhymes with nothing
- `analysis.rhyme_groups` — cross-song end-word groups with phoneme tails
- `analysis.meta.unresolved_words` — words not in cmudict; flag these as manually assessed

- **Hook strength test** — does the hook earn its repetition? Is it memorable, specific, and singable?
- **Line-level stress test** — isolate a single line: does the syllable stress align with likely melodic emphasis? When a genre or specific rhythm/time signature is known, weigh "likely melodic emphasis" against that context rather than a generic 4/4 pop assumption.
- **Ambiguity test** — is any line unclear, unintentionally double-meaning, or open to misreading?
- **Intentional device review** — confirm whether an element noticed during another test (an echoed phrase from Callback scan, a double-meaning from Ambiguity test, a structural repeat) — or one the writer points to directly — reads as craft or accident. If it reads as craft, ask a second question: is this device serving the listener's connection to the song, or is it there to be admired — by the writer, or by other songwriters — rather than felt? A clever rhyme, an unusual word, or a fancy turn of phrase the average listener won't register or care about is a cost, not a win, unless the song's whole premise is built around cleverness (a novelty song, say), in which case cleverness is the point.

*(Draft — this description still needs work.)*
- **Lean lines test** — flag filler/padding words (articles, "just," "that," redundant modifiers) that add syllables without adding meaning or rhythm, and short-range word repetition that isn't a deliberate callback. Defer to Beat review before recommending a cut — a "filler" word is sometimes load-bearing for syllable count against the melody
