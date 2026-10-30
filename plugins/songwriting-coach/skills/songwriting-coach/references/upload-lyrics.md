# Upload Lyrics

*Preparing lyrics for any tool*

**Upload lyrics** — the writer submits lyrics. If the greeting's title line (the bold line with the version, see the greeting in SKILL.md) hasn't been shown yet in this conversation, it is the first line of your reply, before anything about loading or checking the lyrics. ChatGPT identifies the section structure and shows it in one short list, in the same message as the opening question (see Intake in SKILL.md). Do not wait for approval, and do not ask about the structure or about anything you set aside. Say what you assumed in one short line each (e.g. "I read {breathe} in Verse 2 as a breath mark and left it out of the critique; tell me if that's wrong") and carry on. Don't comment on whether the structure is complete or intended (no bridge, no final chorus): that is for the Structural review. The opening question is the only question in the message. If something truly can't be read, say what you couldn't read and what you did instead.

Supported formats:
- **Preferred** — plain text with bracketed section headers: `[Verse 1]`, `[Chorus]`, `[Bridge]`
- **Also supported** — ALL CAPS headers (`VERSE 1`), bare headers (`Chorus`, `V1`), or blank-line separated blocks with no headers (infer the structure and say what you inferred)
- **Needs the lyrics-and-chords skill, otherwise set the chords aside and work on the words** — chords inline or above the lines, lead sheets. Word documents: with the skill, load them as they are; without it, ask the writer to paste the text.

## With the lyrics-and-chords skill

If a skill named lyrics-and-chords is installed, use it for every upload, so the lyric text is checked and not trusted to a retype. Don't mention it to the writer unless it fails or they ask. The skill says which Node to run its scripts with.

1. Save the writer's text exactly as given: the original. (A Word file is loaded as it is.)
2. Run the skill's all-in-one load on the original. A title or credit line to leave out is named by its line number with the skill's set-aside option, never retyped. The title you set aside is still a fact: give it to the load with the `--facts` option (a small JSON file such as `{"title": "Whirlwind Mind"}`, with the writer and date too if the lines had them), copied from that line, so the lyrics-only view starts with `Title: …` and the rhyme map and the board carry the song's name.
3. Read its `status`:
   - `ok` — carry on.
   - `needs-info` — the title, credits or date is missing. Don't ask the skill's questions here; carry on.
   - A `chart` in the result (`{from, to, text}`) is a chord chart that came before the lyrics and was set aside for you. It is chord data, not lyrics: don't assess it as lyrics and don't drop it. Keep its text in your working notes, and say in one of your assumption lines which lines it was (the other lines keep their original numbers, so a later `--set-aside` still uses them).
   - `needs-info` with a question that says some lines (named by number) look like a chord chart, not lyrics: this is the one question you ask before going on. Ask it as the only question in that message (the opening question comes after the answer), in plain words and not in the skill's own: "Lines 3 to 6 look like a chord chart, not lyrics. Should I leave them out of the lyrics, or keep them as part of the song?" If they say leave them out (drop them, don't include them), run the load again with `--chart FROM-TO`; if they say keep them, run it again with `--keep-chart`.
   - `failed` — tell the writer plainly what it found (line numbers, what was wrong) and fix it with them. If it still can't be read, use "Without it".
4. If the check reports a changed, missing or extra lyric line, or a lost chord, the song is not used. Say what the check found, then fix it or ask.
5. If it passes, ask the skill for its lyrics-only view (`--as lyrics-only`) and use that text as the lyrics: the facts as `Key: value` lines, then each section under its `[Header]`, with the chords removed and every lyric line copied by the skill. Skip the steps below.
6. If the skill is missing, or says it can't find the app's Node.js, say so in one line (with the feedback address it gives) and use "Without it". A Word file or a chord sheet then needs the writer to paste the lyrics.

## Without it

Steps:

1. Keep the writer's text exactly as given; it is what is shown back to them and used for every check.
2. Work out the sections: use the writer's own labels, keeping their wording (`V1` stays `V1`). Where a blank line is the only break, name the sections by position and say so.
3. Set aside only what isn't lyric or structure: chord and tab lines, and pure performance notes (`(repeat x2)`, `capo 2`, timestamps). If it's unclear whether a line is lyric, a label or an annotation, treat it as an annotation and say so in your line about what you set aside.
4. A backslash at the very end of a line in text that came from a chat or a Markdown preview is a line-break marker, not lyric: leave it out silently, without mentioning it or asking. Keep a backslash that is plainly part of the lyric, and ask only if it is genuinely unclear which it is. Otherwise never add, drop, merge or reword a lyric line. If a line had to be set aside, say which.
5. Present the section list (label, number of lines) as a short bulleted list or on one line (e.g. "V1 (4) · C (4) · V2 (4)"), not as a table: chat tables stretch to the full width of the window. Say which labels you inferred, in one line, without asking.
