# Report as PDF

*Turning a report the coach has already given into a PDF*

When the writer asks for the report as a PDF ("make that a PDF", "export the report", "PDF of the full report"), the PDF holds the report they have already been given: the same findings in the same words, with the Report depth numbers as they were. Nothing new is judged for it. If no report has been given yet in this conversation, say so in one line and offer the Core Assessment.

Make the file with the PDF skill (`pdf`, which uses ReportLab). If that skill isn't available in this session, say so in one line and leave the report in the chat as it stands.

## Layout, in order

1. **Title**, then a subtitle line: the coaching settings (style, information depth, report depth), the song's title and the skill version (0.2.5).
2. **The lyrics**: the song's title, each section's label, every line exactly as given, then a rule.
3. **1. Song overview**
4. **2. Key points**
5. **3. Whole song**, grouped by assessment, one block per check. A check's name is bold, followed by a short grey description of what it looks at (its Tool List line, shortened).
6. **4. Open questions**
7. **5. Appendix**: the dynamics graph (see below)
8. **The report footer line** from "Report footer" in SKILL.md, in italics

## Findings

Each finding is one row: a pill in the left column and the finding text in the right, with a thin rule under the row. The left column is 0.95 in wide and the right 5.55 in; the pill column has no left padding.

The pill kinds follow the emoji key:

| Kind | Emoji | Colour |
|---|---|---|
| Strength | 🟢 | `#2e8b57` |
| Note | 🔵 | `#2f6fb3` |
| Concern | 🟡 | `#d49a00` |
| Issue | 🔴 | `#c0392b` |
| Clear | ✅ | `#5b7083` |

A ✅ line ("Cliche, Singability: nothing flagged") becomes one row with a Clear pill.

A pill is a rounded rectangle 14 pt high and 0.8 in wide with fully rounded ends. Its fill is the colour at 16% opacity and its outline the colour at 55% opacity, 0.6 pt. Its label is the kind in capitals, Helvetica-Bold 7.5 pt, centred, in the colour darkened to 70%. Use this ReportLab flowable:

```python
class Pill(Flowable):
    def __init__(self, kind, w=0.8*inch, h=14):
        super().__init__(); self.kind, self.w, self.h = kind, w, h
    def wrap(self, aw, ah): return (self.w, self.h)
    def draw(self):
        base = colors.HexColor(COL[self.kind]); c = self.canv
        c.saveState()
        c.setFillColor(base); c.setFillAlpha(0.16)
        c.setStrokeColor(base); c.setStrokeAlpha(0.55); c.setLineWidth(0.6)
        c.roundRect(0, 0, self.w, self.h, self.h/2, stroke=1, fill=1)
        c.setFillAlpha(1)
        c.setFillColor(colors.Color(base.red*0.7, base.green*0.7, base.blue*0.7))
        c.setFont('Helvetica-Bold', 7.5)
        c.drawCentredString(self.w/2, 4, self.kind.upper())
        c.restoreState()
```

where `COL` maps `"Strength"`, `"Note"`, `"Concern"`, `"Issue"` and `"Clear"` to the colours above.

## The dynamics graph (appendix)

A line graph of the song's sections on the 1 to 5 scale (1 low, 3 mid, 5 high; half-steps such as 3.5 sit between the gridlines), each level in its own colour, cool to warm: 1 `#5b9fd6`, 2 `#3db88a`, 3 `#c9a227`, 4 `#e08a3c`, 5 `#e8593c`. The section names run along the bottom. Label it "inferred, not yet confirmed" unless the writer set the levels.

## Giving the file to the writer

Name it after the song (for example `whirlwind-mind-report.pdf`).
Give it as the PDF skill describes, so the app shows it as an output file, and say where it is saved.
