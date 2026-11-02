#!/usr/bin/env python3
"""Song status board: turns the log of checks run so far into an HTML page, a
text board for the chat, and one summary line per assessment.

Usage: python3 status_board.py <status.jsonl> [--add '<json line>']... [--out DIR]

The log is a JSON Lines file, one flat object per line, read top to bottom
(later lines win). --add appends lines to the log first (each is checked) so
the coach never has to hand-edit the file. Then the page is rewritten.

Lines:
  {"event":"song","title":"Ballad of Lorem Ipsum"}
  {"event":"section","name":"Verse 1","abbrev":"V1"}          (+ "instrumental":true)
  {"event":"section-order","names":["Verse 1","Chorus"]}      (sections not listed go last)
  {"event":"section-rename","name":"Verse 1","new_name":"Verse One","abbrev":"V1"}
  {"event":"section-replace","name":"Verse 2"}                (new text: results cleared)
  {"event":"section-delete","name":"Verse 1"}
  {"event":"unsupported","test":"Song dynamics graph"}       (this platform can't run it: shown "Not yet supported")
  {"event":"run","test":"Cliche scan"}                        (clears that check's results)
  {"event":"result","test":"Cliche scan","section":"Verse 1","status":"concern","note":"..."}
  {"event":"result","test":"Emotional arc review","section":"whole","status":"strong"}
  {"event":"edit","section":"Verse 1"}                        (marks results stale)

status: strong | observation | concern | issue. After a "run", a section with no
result is clean. A section added or replaced after a run shows "not run".
Section names are unique; a repeated chorus is "Chorus 2".

The page checks for a new version of the board every second and reloads only when the
log has changed, so a tab left open stays current without flashing.

Output (printed as JSON): html_file, chat_lines, markdown (the board as text).
Standard library only.
"""

import hashlib
import html
import json
import re
import sys
from pathlib import Path

TIP_DELAY_MS = 350  # how long to hover before a tooltip opens
CHECK_SECONDS = 1  # how often an open page looks for a newer board
ORDER = ["green", "blue", "amber", "red"]
LABEL = {"green": "Strength / clean", "blue": "Observation", "amber": "Concern", "red": "Issue"}
EMOJI = {"green": "🟢", "blue": "🔵", "amber": "🟡", "red": "🔴"}
STATUS_TO_RESULT = {"strong": "green", "observation": "blue", "concern": "amber", "issue": "red"}

# The assessments the board shows, in Tool List order: (name, what it is, checks), each
# check being (name, scope, what it does). Scope: section = findings pinned to sections;
# whole = looks across the song. The descriptions are the first-column tooltips, one short
# sentence each. tests/test_status_board.py keeps the names and scopes in step with SKILL.md.
# Assessments that have no place in the table; listed under it.
NOT_COVERED = ["Super-Thesaurus", "Audience Check", "Song Idea Development", "Song Idea Assessment"]

ASSESSMENTS = [
    # generated from checks.toml
    ("Core Assessment", "A first listen to the whole lyric.", [
        ("Emotional arc review", "whole", "Does the lyric build, resolve or land as intended?"),
        ("Sliver of hope check", "whole", "Is there a moment of lift, or one unrelenting emotion?"),
        ("Authenticity review", "section", "Does it sound like a real person in a real moment?"),
        ("Cliche scan", "section", "Stock phrases and images listeners have heard many times."),
        ("Beat review", "section", "Checks vowels, stress and syllable count against the melody."),
        ("Singability review", "section", "Does the phrasing feel natural to perform?")]),
    ("Narrative Assessment", "Does the song actually move?", [
        ("Structural review", "whole", "Does each section do distinct work?"),
        ("Verse-swap test", "whole", "Could two same-role sections swap with nothing changing?"),
        ("Outro/resolution review", "whole", "Does the ending feel earned by what was set up?"),
        ("Turn placement review", "whole", "Does the turn arrive at the right moment?"),
        ("Thematic through-line", "whole", "Does the central idea hold, or drift?"),
        ("Callback scan", "whole", "Are repeated words and images intentional echoes or accidents?"),
        ("Narrative arc check", "whole", "Does the lyric move from situation to change, or stay static?"),
        ("List serves a bigger statement", "section", "Does a list of images or events add up to a point?"),
        ("Stakes check", "whole", "Will a listener know why this song matters, and to whom?")]),
    ("Song Dynamics Assessment", "Maps the energy curve of the song.", [
        ("Song dynamics graph", "whole", "The energy curve drawn across the song."),
        ("Dynamics review", "whole", "Is there contrast between sections and a well-placed climax?"),
        ("Section comparison", "whole", "Compares the energy of two sections and the gap between them.")]),
    ("Sound and Rhythm Assessment", "How the words perform in the melody.", [
        ("Rhyme map", "whole", "Phonetic rhyme quality and scheme across the song."),
        ("Hook strength test", "section", "Does the hook earn its repetition?"),
        ("Line-level stress test", "section", "Does syllable stress line up with the melodic emphasis?"),
        ("Ambiguity test", "section", "Is any line unclear or open to unintended misreading?"),
        ("Intentional device review", "section", "Does a flagged element read as craft or as accident?"),
        ("Lean lines test", "section", "Flags filler words and accidental short-range repetition.")]),
    ("Perspective Shifts Assessment", "Sees the lyric from other angles.", [
        ("Angle reframe", "section", "Offers other emotional angles on what a section is saying."),
        ("Understatement vs. declaration", "section", "Would a line land harder pulled back or pushed forward?"),
        ("Specificity probe", "section", "Is the image concrete enough to land?"),
        ("Listener lens", "whole", "How might a first-time listener receive this?"),
        ("Show vs. tell review", "section", "Does it show emotion through image, or just state it?"),
        ("Universal vs. generic check", "whole", "Is it too personal to share, or too smoothed-out to say anything?"),
        ("Balance of Abstract and Specific", "whole", "Is each part as specific or as abstract as it needs to be?")]),
    ("Continuity Assessment", "Keeps the whole song coherent.", [
        ("Tense continuity", "whole", "Does the song stay in one tense unless a shift is deliberate?"),
        ("Pronoun/address continuity", "whole", "Does who is spoken to or about stay consistent?"),
        ("POV/person continuity", "whole", "Does first, second or third person stay stable?"),
        ("Song fingerprint", "whole", "What the song keeps doing, and where it holds or breaks.")]),
    ("Power Positions Assessment", "Where the strongest material sits.", [
        ("Power position test", "section", "Marks the most impactful line in each section."),
        ("Power position analysis", "section", "Is the strongest material in a power position, or buried?"),
        ("Opening line review", "section", "Does the first line earn its place and pull the listener on?"),
        ("Closing line review", "section", "Does the last line land with the right weight?"),
        ("Title placement review", "whole", "Does the title appear in a position of weight?"),
        ("Title strength/quality test", "whole", "Is the title fresh and hooky, or the obvious treatment?")]),
    # end generated
]

PLACEHOLDER_SECTIONS = [("Verse", "V"), ("Chorus", "C")]  # shown until the lyric's sections are declared

NOT_RUN = "⬜"
NA = "▫️"


def esc(text):
    return html.escape(str(text), quote=True)


def worst(results):
    best = -1
    for r in results:
        best = max(best, ORDER.index(r))
    return None if best < 0 else ORDER[best]


def ran(check):
    return check.get("run") is not False


def section_result(check, section):
    return (check.get("cells") or {}).get(section) or {"result": "green"}


def covered(check, section):
    """False when the check ran but not on this section (added or replaced since)."""
    return section not in (check.get("uncovered") or [])


def summarise(assessment, lyric_sections):
    counts = {r: 0 for r in ORDER}
    ran_checks = [c for c in assessment["checks"] if ran(c)]
    for c in ran_checks:
        if c["scope"] == "whole":
            if c.get("result"):
                counts[c["result"]] += 1
        else:
            for s in lyric_sections:
                if covered(c, s):
                    counts[section_result(c, s)["result"]] += 1
    return {
        "counts": counts,
        "ran": len(ran_checks),
        "total": len([c for c in assessment["checks"] if not c.get("unsupported")]),
        "stale": any(c.get("stale") for c in ran_checks),
    }


def chat_line(assessment, lyric_sections):
    s = summarise(assessment, lyric_sections)
    if s["ran"] == 0:
        return f"{assessment['name']} — not started ({s['total']} checks)"
    parts = " · ".join(f"{EMOJI[r]} {s['counts'][r]}" for r in ORDER)
    return f"{assessment['name']} {parts} — {s['ran']} of {s['total']} run"


# ---------------------------------------------------------------- text board

def group_cells(a, sections, instrumental, lyric_sections):
    """The summary cells of one assessment: worst result per column."""
    ran_checks = [c for c in a["checks"] if ran(c)]
    has_whole = any(c["scope"] == "whole" for c in a["checks"])
    has_section = any(c["scope"] == "section" for c in a["checks"])
    whole_worst = worst([c["result"] for c in ran_checks if c["scope"] == "whole" and c.get("result")])
    whole = NA if not has_whole else (EMOJI[whole_worst] if whole_worst else NOT_RUN)
    cells = []
    for s in sections:
        if s in instrumental or not has_section:
            cells.append(NA)
            continue
        w = worst([section_result(c, s)["result"] for c in ran_checks
                   if c["scope"] == "section" and covered(c, s)])
        cells.append(EMOJI[w] if w else NOT_RUN)
    return whole, cells


def text_board(data):
    """The board as one Markdown table: a header row, then per assessment a group
    row (worst result per column) followed by its check rows."""
    sections = data["sections"]
    instrumental = set(data.get("instrumental") or [])
    lyric_sections = [s for s in sections if s not in instrumental]
    view = data.get("view", "status")
    out = [f"**Song Status: {data.get('title') or 'Untitled'}**", ""]
    out += ["  ".join(f"{EMOJI[r]} {LABEL[r]}" for r in ORDER) + f"  {NOT_RUN} Not run yet  {NA} Doesn't apply", ""]
    out += ["| Section: | Whole | " + " | ".join(sections) + " |",
            "|---|---|" + "---|" * len(sections)]
    for a in data["assessments"]:
        sm = summarise(a, lyric_sections)
        whole, cells = group_cells(a, sections, instrumental, lyric_sections)
        mark = " \\*" if sm["stale"] else ""
        out.append(f"| **{a['name']}**{mark} | {whole} | " + " | ".join(cells) + " |")
        if not (view == "detailed" or (view != "summary" and sm["ran"] > 0)):
            continue
        for c in a["checks"]:
            is_run = ran(c)
            name = "– " + c["name"] + (" \\*" if is_run and c.get("stale") else "")
            if c.get("unsupported"):
                whole_cell = NOT_RUN
                row = [NA] * len(sections)
            elif c["scope"] == "whole":
                whole_cell = EMOJI[c.get("result") or "green"] if is_run else NOT_RUN
                row = [NA] * len(sections)
            else:
                whole_cell = NA
                row = [NA if s in instrumental
                       else (EMOJI[section_result(c, s)["result"]] if is_run and covered(c, s) else NOT_RUN)
                       for s in sections]
            out.append(f"| {name} | {whole_cell} | " + " | ".join(row) + " |")
    if any(ran(c) and c.get("stale") for a in data["assessments"] for c in a["checks"]):
        out += ["", "\\* run before the latest edits"]
    out += ["", "Assessments not covered by the table", ""] + [f"* {n}" for n in NOT_COVERED]
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- html board

def cell(kind, title="", label=""):
    dot = kind if kind in ORDER else ("notrun" if kind == "notrun" else "")
    t = f' data-tip="{esc(title)}"' if title else ""
    d = f' data-dot="{dot}"' if title and dot else ""
    return f'<td class="cell {kind}"{t}{d}>{label}</td>'


def result_cell(c, what, where):
    """A result box. Its tooltip names the place, the check and the finding."""
    if not c:
        return cell("notrun", f"{where} · {what}: not run yet")
    note = c.get("note") or LABEL[c["result"]]
    return cell(c["result"], f"{where} · {what}: {note}")


CSS = """
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
"""


def html_board(data, version=""):
    sections = data["sections"]
    names = data.get("section_names") or {}
    instrumental = set(data.get("instrumental") or [])
    lyric_sections = [s for s in sections if s not in instrumental]
    view = data.get("view", "status")
    head = ('<tr class="head"><th class="name">Section:</th><th>Whole</th>'
            + "".join(f"<th>{esc(s)}</th>" for s in sections) + '</tr>')

    blocks = []
    for a in data["assessments"]:
        sm = summarise(a, lyric_sections)
        ran_checks = [c for c in a["checks"] if ran(c)]
        whole_worst = worst([c["result"] for c in ran_checks if c["scope"] == "whole" and c.get("result")])
        has_whole = any(c["scope"] == "whole" for c in a["checks"])
        has_section = any(c["scope"] == "section" for c in a["checks"])
        if not has_whole:
            whole_cell = cell("na", "No whole-song checks")
        elif whole_worst:
            whole_cell = result_cell({"result": whole_worst}, a["name"], "Whole song")
        else:
            whole_cell = cell("notrun", "Whole-song checks not run yet")
        section_cells = []
        for s in sections:
            if s in instrumental or not has_section:
                section_cells.append(cell("na", f"{s}: instrumental" if s in instrumental else "No section checks"))
                continue
            w = worst([section_result(c, s)["result"] for c in ran_checks
                       if c["scope"] == "section" and covered(c, s)])
            section_cells.append(result_cell({"result": w}, a["name"], names.get(s, s)) if w else cell("notrun", f"{names.get(s, s)} · {a['name']}: not run yet"))
        mark = " *" if sm["stale"] else ""
        summary_row = (f'<tr class="summary"><th class="name" data-tip="{esc(TIPS.get(a["name"], ""))}">{esc(a["name"])}{mark}</th>{whole_cell}'
                       + "".join(section_cells) + '</tr>')

        rows = []
        for c in a["checks"]:
            is_run = ran(c)
            if c.get("unsupported"):
                whole = cell("notrun", f"Whole song · {c['name']}: Not yet supported")
            elif c["scope"] == "whole":
                whole = (result_cell({"result": c.get("result") or "green", "note": c.get("note")}, c["name"], "Whole song")
                         if is_run else result_cell(None, c["name"], "Whole song"))
            else:
                whole = cell("na")
            cells = []
            for s in sections:
                if c["scope"] == "whole" or s in instrumental:
                    cells.append(cell("na"))
                else:
                    cells.append(result_cell(section_result(c, s), c["name"], names.get(s, s)) if is_run and covered(c, s)
                                 else result_cell(None, c["name"], names.get(s, s)))
            mark = " *" if is_run and c.get("stale") else ""
            rows.append(f'<tr class="check{"" if is_run else " notrun-row"}"><th class="name" data-tip="{esc(TIPS.get(c["name"], ""))}">{esc(c["name"])}{mark}</th>'
                        f'{whole}{"".join(cells)}</tr>')
        open_ = view == "detailed" or (view != "summary" and sm["ran"] > 0)
        blocks.append(f'<details{" open" if open_ else ""}><summary><table>{head}{summary_row}</table></summary>\n'
                      f'<table class="checks">{"".join(rows)}</table></details>')

    not_covered = "".join(f"<li>{esc(n)}</li>" for n in NOT_COVERED)
    stale = any(ran(c) and c.get("stale") for a in data["assessments"] for c in a["checks"])
    title = esc(data.get("title") or "Untitled")
    key = "".join(f'<span><i class="chip" style="background:var(--{r})"></i>{LABEL[r]}</span>' for r in ORDER)
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Song Status: {title}</title>
<style>{CSS}</style></head><body>
<h1>Song Status: {title}</h1>
<div class="sub">Song status — hover a square to see the finding; click an assessment to show or hide its checks.</div>
<div class="key">{key}<span><i class="chip" style="background:#E7E4F3;box-shadow:inset 0 0 0 1px #DAD6EA"></i>Not run yet</span><span><i class="chip na"></i>Doesn't apply</span></div>
{chr(10).join(blocks)}
{'<div class="foot">* run before the latest edits</div>' if stale else ""}
<div id="tip"></div>
<div class="notcovered"><div>Assessments not covered by the table</div><ul>{not_covered}</ul></div>
<script>
// An open tab looks for a newer board (a small .version.js file next to the page) and reloads
// only when it has changed. Which panels are open is remembered across reloads.
const VERSION = "{version}";
const versionUrl = location.href.replace(/\\.html(\\?.*)?$/, ".version.js");
setInterval(() => {{
  const probe = document.createElement("script");
  probe.src = versionUrl + "?t=" + Date.now();
  probe.onload = () => {{ if (window.statusVersion && window.statusVersion !== VERSION) location.reload(); probe.remove(); }};
  probe.onerror = () => probe.remove();
  document.head.appendChild(probe);
}}, {CHECK_SECONDS * 1000});
const tip = document.getElementById("tip");
let tipTimer, hideTimer;
function showTip(el) {{
  tip.textContent = "";
  if (el.dataset.dot) {{ const dot = document.createElement("i"); dot.className = el.dataset.dot; tip.appendChild(dot); }}
  tip.appendChild(document.createTextNode(el.dataset.tip));
  tip.style.display = "block";
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(r.left + 16, innerWidth - w - 8)) + "px";
  tip.style.top = (r.bottom + h + 12 > innerHeight ? r.top - h - 6 : r.bottom + 6) + "px";
}}
document.querySelectorAll("[data-tip]").forEach(el => {{
  if (!el.dataset.tip) return;
  el.addEventListener("mouseenter", () => {{
    clearTimeout(hideTimer);
    clearTimeout(tipTimer);
    // Moving between neighbouring boxes swaps the tooltip at once; a first hover waits a moment.
    if (tip.style.display === "block") showTip(el);
    else tipTimer = setTimeout(() => showTip(el), {TIP_DELAY_MS});
  }});
  el.addEventListener("mouseleave", () => {{
    clearTimeout(tipTimer);
    hideTimer = setTimeout(() => {{ tip.style.display = "none"; }}, 150);
  }});
}});
try {{
  const key = "status-open:" + document.title;
  const saved = JSON.parse(sessionStorage.getItem(key) || "null");
  const panels = [...document.querySelectorAll("details")];
  if (saved) panels.forEach((d, i) => {{ d.open = !!saved[i]; }});
  panels.forEach(d => d.addEventListener("toggle", () => sessionStorage.setItem(key, JSON.stringify(panels.map(p => p.open)))));
}} catch (e) {{}}
</script>
</body></html>"""


# ---------------------------------------------------------------- the log

class LogError(Exception):
    pass


CHECKS = {name: scope for _, _, checks in ASSESSMENTS for name, scope, _ in checks}
TIPS = {name: tip for name, tip, _ in ASSESSMENTS}
TIPS.update({name: tip for _, _, checks in ASSESSMENTS for name, _, tip in checks})


def read_log(lines):
    """Apply the log lines in order and return the board data the renderers use."""
    title = None
    sections = []            # [{"name","abbrev","instrumental"}]
    tests = {}               # check name -> {"cells":{},"whole":None,"covered":set,"stale":bool}
    unsupported = set()      # checks this platform cannot run (shown as "Not yet supported")

    def find(name, number):
        for s in sections:
            if s["name"] == name:
                return s
        raise LogError(f"line {number}: no section called '{name}' (sections: {', '.join(s['name'] for s in sections) or 'none yet'})")

    for number, raw in enumerate(lines, start=1):
        raw = raw.strip()
        if not raw:
            continue
        try:
            line = json.loads(raw)
        except ValueError as problem:
            raise LogError(f"line {number}: not valid JSON ({problem})")
        event = line.get("event")
        if event == "song":
            title = line.get("title")
        elif event == "section":
            name, abbrev = line.get("name"), line.get("abbrev")
            if not name or not abbrev:
                raise LogError(f"line {number}: a section needs a name and an abbrev")
            if any(s["name"] == name for s in sections):
                raise LogError(f"line {number}: there is already a section called '{name}'; name a repeat 'Chorus 2'")
            if any(s["abbrev"] == abbrev for s in sections):
                raise LogError(f"line {number}: the abbrev '{abbrev}' is already used")
            sections.append({"name": name, "abbrev": abbrev, "instrumental": bool(line.get("instrumental"))})
        elif event == "section-order":
            names = line.get("names") or []
            ordered = [find(n, number) for n in names]
            sections[:] = ordered + [s for s in sections if s not in ordered]
        elif event == "section-rename":
            s = find(line.get("name"), number)
            new_name = line.get("new_name") or s["name"]
            if new_name != s["name"] and any(o["name"] == new_name for o in sections):
                raise LogError(f"line {number}: there is already a section called '{new_name}'")
            old = s["name"]
            s["name"] = new_name
            if line.get("abbrev"):
                s["abbrev"] = line["abbrev"]
            for t_ in tests.values():
                if old in t_["cells"]:
                    t_["cells"][new_name] = t_["cells"].pop(old)
                if old in t_["covered"]:
                    t_["covered"].discard(old)
                    t_["covered"].add(new_name)
        elif event == "section-replace":
            s = find(line.get("name"), number)
            for t_ in tests.values():
                t_["cells"].pop(s["name"], None)
                t_["covered"].discard(s["name"])
        elif event == "section-delete":
            s = find(line.get("name"), number)
            sections.remove(s)
            for t_ in tests.values():
                t_["cells"].pop(s["name"], None)
                t_["covered"].discard(s["name"])
        elif event == "unsupported":
            test = line.get("test")
            if test not in CHECKS:
                raise LogError(f"line {number}: unknown check '{test}'")
            unsupported.add(test)
        elif event == "run":
            test = line.get("test")
            if test not in CHECKS:
                raise LogError(f"line {number}: unknown check '{test}'")
            tests[test] = {"cells": {}, "whole": None, "stale": False,
                           "covered": {s["name"] for s in sections if not s["instrumental"]}}
        elif event == "result":
            test = line.get("test")
            if test not in CHECKS:
                raise LogError(f"line {number}: unknown check '{test}'")
            if line.get("status") not in STATUS_TO_RESULT:
                raise LogError(f"line {number}: status must be one of {', '.join(STATUS_TO_RESULT)}")
            if test not in tests:
                tests[test] = {"cells": {}, "whole": None, "stale": False,
                               "covered": {s["name"] for s in sections if not s["instrumental"]}}
            cell = {"result": STATUS_TO_RESULT[line["status"]]}
            if line.get("note"):
                cell["note"] = line["note"]
            where = line.get("section")
            if where == "whole":
                if CHECKS[test] != "whole":
                    raise LogError(f"line {number}: '{test}' is a section check; give a section name")
                tests[test]["whole"] = cell
            else:
                if CHECKS[test] != "section":
                    raise LogError(f"line {number}: '{test}' is a whole-song check; use \"section\":\"whole\"")
                find(where, number)
                tests[test]["cells"][where] = cell
                tests[test]["covered"].add(where)
        elif event == "edit":
            where = line.get("section")
            find(where, number)
            for test, t_ in tests.items():
                if CHECKS[test] == "whole" or where in t_["covered"]:
                    t_["stale"] = True
        else:
            raise LogError(f"line {number}: unknown event '{event}'")

    if not sections:
        # Nothing declared yet: show a plain Verse / Chorus board so the table isn't empty.
        # The writer's real sections replace these as soon as they are declared.
        sections = [{"name": name, "abbrev": abbrev, "instrumental": False} for name, abbrev in PLACEHOLDER_SECTIONS]
        for t_ in tests.values():
            t_["covered"] = {s["name"] for s in sections}
    lyric = [s["name"] for s in sections if not s["instrumental"]]
    assessments = []
    for a_name, _, checks in ASSESSMENTS:
        rows = []
        for name, scope, _ in checks:
            row = {"name": name, "scope": scope}
            t_ = tests.get(name)
            if name in unsupported:
                row["run"] = False
                row["unsupported"] = True
            elif not t_:
                row["run"] = False
            elif scope == "whole":
                cell = t_["whole"] or {"result": "green"}
                row["result"], row["note"] = cell["result"], cell.get("note")
            else:
                row["cells"] = {abbr: c for abbr, c in
                                ((next(s["abbrev"] for s in sections if s["name"] == n), c)
                                 for n, c in t_["cells"].items())}
                row["uncovered"] = [next(s["abbrev"] for s in sections if s["name"] == n)
                                    for n in lyric if n not in t_["covered"]]
            if t_ and t_["stale"]:
                row["stale"] = True
            rows.append(row)
        assessments.append({"name": a_name, "checks": rows})
    return {
        "title": title,
        "view": "status",
        "sections": [s["abbrev"] for s in sections],
        "instrumental": [s["abbrev"] for s in sections if s["instrumental"]],
        "section_names": {s["abbrev"]: s["name"] for s in sections},
        "assessments": assessments,
    }


# ---------------------------------------------------------------- command line

def slugify(title):
    return re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-") or "song"


def main(argv):
    out_dir = Path.cwd()
    adds = []
    args = []
    view = None
    i = 0
    while i < len(argv):
        if argv[i] == "--out" and i + 1 < len(argv):
            out_dir = Path(argv[i + 1])
            i += 2
        elif argv[i] == "--add" and i + 1 < len(argv):
            adds.append(argv[i + 1])
            i += 2
        elif argv[i] == "--view" and i + 1 < len(argv):
            view = argv[i + 1]
            i += 2
        else:
            args.append(argv[i])
            i += 1
    if len(args) != 1:
        print("Usage: python3 status_board.py <status.jsonl> [--add '<json line>']... [--view status|summary|detailed] [--out DIR]", file=sys.stderr)
        return 2
    log = Path(args[0])
    existing = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    try:
        read_log(existing + adds)           # check the new lines before saving them
    except LogError as problem:
        print(f"Not saved: {problem}", file=sys.stderr)
        return 1
    if adds:
        with log.open("a", encoding="utf-8") as f:
            for line in adds:
                f.write(line.strip() + "\n")
    data = read_log(existing + adds)
    if view:
        data["view"] = view
    out_dir.mkdir(parents=True, exist_ok=True)
    html_file = out_dir / f"{slugify(data.get('title') or 'song')}-status.html"
    version = hashlib.sha1(json.dumps(data, sort_keys=True).encode("utf-8")).hexdigest()[:12]
    html_file.write_text(html_board(data, version), encoding="utf-8")
    html_file.with_suffix(".version.js").write_text(f'window.statusVersion = "{version}";\n', encoding="utf-8")
    instrumental = set(data.get("instrumental") or [])
    lyric_sections = [s for s in data["sections"] if s not in instrumental]
    result = {
        "html_file": str(html_file),
        "chat_lines": [chat_line(a, lyric_sections) for a in data["assessments"]],
        "markdown": text_board(data),
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
