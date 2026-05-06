#!/usr/bin/env python3
"""
heavy-50slides.gen.py — generates test/data/heavy-50slides.pptx

Builds a deliberately complex 50-slide deck for stress-testing the WASM
LibreOffice viewer's snapshot/warm-restore performance and rendering
correctness.

Includes: mixed layouts, raster images, native PPT charts (bar/column/
line/pie/scatter), tables, animations, transitions, grouped shapes,
speaker notes, formatted text (bold/italic/underline/multi-font/bullets),
hyperlinks, and a final summary/TOC slide.

Deterministic: uses fixed RNG seeds.

Run:    python3 heavy-50slides.gen.py
Output: heavy-50slides.pptx (next to this script)
"""

import io
import os
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pptx import Presentation
from pptx.chart.data import CategoryChartData, XyChartData
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_SHAPE
from pptx.dml.color import RGBColor
from pptx.util import Inches, Pt, Emu
from pptx.oxml.ns import qn
from lxml import etree

random.seed(42)

HERE = Path(__file__).resolve().parent
OUT = HERE / "heavy-50slides.pptx"


# ---------------------------------------------------------------------------
# Image generation (Pillow) — deterministic gradients with shape + label.
# ---------------------------------------------------------------------------

def _font(size=28):
    """Try a real TTF; fall back to PIL default if missing."""
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                pass
    return ImageFont.load_default()


def make_gradient_png(label: str, w=1280, h=800, seed=0) -> bytes:
    """Return PNG bytes of a deterministic colored gradient + shape + label."""
    rng = random.Random(seed)
    img = Image.new("RGB", (w, h))
    px = img.load()
    # vertical gradient between two random colors
    c1 = (rng.randint(20, 200), rng.randint(20, 200), rng.randint(20, 200))
    c2 = (rng.randint(20, 240), rng.randint(20, 240), rng.randint(20, 240))
    for y in range(h):
        t = y / max(1, h - 1)
        r = int(c1[0] + (c2[0] - c1[0]) * t)
        g = int(c1[1] + (c2[1] - c1[1]) * t)
        b = int(c1[2] + (c2[2] - c1[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)

    draw = ImageDraw.Draw(img)
    # decorative shapes
    for _ in range(rng.randint(3, 7)):
        x0 = rng.randint(0, w - 40)
        y0 = rng.randint(0, h - 40)
        x1 = x0 + rng.randint(20, 120)
        y1 = y0 + rng.randint(20, 120)
        col = (rng.randint(0, 255), rng.randint(0, 255), rng.randint(0, 255))
        kind = rng.choice(["ellipse", "rectangle", "line"])
        if kind == "ellipse":
            draw.ellipse([x0, y0, x1, y1], outline=col, width=4)
        elif kind == "rectangle":
            draw.rectangle([x0, y0, x1, y1], outline=col, width=4)
        else:
            draw.line([x0, y0, x1, y1], fill=col, width=5)

    # label
    f = _font(36)
    # readable contrast
    draw.rectangle([0, h - 60, w, h], fill=(0, 0, 0))
    draw.text((12, h - 52), label, fill=(255, 255, 255), font=f)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# XML helpers — animations & transitions (python-pptx has no high-level API).
# ---------------------------------------------------------------------------

P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"

# Minimal but valid <p:transition> blocks. Inserted before <p:timing> (or end).
TRANSITION_XML = {
    "fade":  '<p:transition xmlns:p="%s" spd="med"><p:fade/></p:transition>' % P_NS,
    "push":  '<p:transition xmlns:p="%s" spd="med"><p:push dir="l"/></p:transition>' % P_NS,
    "wipe":  '<p:transition xmlns:p="%s" spd="med"><p:wipe dir="r"/></p:transition>' % P_NS,
    "split": '<p:transition xmlns:p="%s" spd="med"><p:split orient="horz" dir="out"/></p:transition>' % P_NS,
    "cover": '<p:transition xmlns:p="%s" spd="med"><p:cover dir="d"/></p:transition>' % P_NS,
}


def add_transition(slide, kind: str):
    """Insert a <p:transition> child into the slide element."""
    xml = TRANSITION_XML[kind]
    el = etree.fromstring(xml)
    # Append; PowerPoint accepts transition placed before timing.
    slide.element.append(el)


def make_timing_xml(shape_spids, effect_kinds):
    """
    Build a <p:timing> block that animates the given shape spIds with the
    given effect kinds (in parallel within one click).

    effect_kinds: list of {"appear","fade","fly","zoom","emphasis","exit"}
    """
    # presetClass / presetID / presetSubtype are LibreOffice/PowerPoint-recognized.
    PRESET = {
        "appear":   ("entr", 1, 0),    # Appear
        "fade":     ("entr", 10, 0),   # Fade
        "fly":      ("entr", 2, 4),    # Fly In from bottom
        "zoom":     ("entr", 23, 0),   # Zoom
        "emphasis": ("emph", 1, 0),    # Pulse
        "exit":     ("exit", 1, 0),    # Disappear
    }

    child_tnls = []
    for idx, (spid, kind) in enumerate(zip(shape_spids, effect_kinds)):
        cls, pid, psub = PRESET[kind]
        child_tnls.append(f'''
          <p:par>
            <p:cTn id="{10+idx*10}" presetID="{pid}" presetClass="{cls}" presetSubtype="{psub}"
                   fill="hold" grpId="0" nodeType="clickEffect">
              <p:stCondLst><p:cond delay="0"/></p:stCondLst>
              <p:childTnLst>
                <p:set>
                  <p:cBhvr>
                    <p:cTn id="{11+idx*10}" dur="1" fill="hold"/>
                    <p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl>
                    <p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst>
                  </p:cBhvr>
                  <p:to><p:strVal val="visible"/></p:to>
                </p:set>
              </p:childTnLst>
            </p:cTn>
          </p:par>''')

    inner = "".join(child_tnls)
    timing = f'''<p:timing xmlns:p="{P_NS}">
      <p:tnLst>
        <p:par>
          <p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot">
            <p:childTnLst>
              <p:seq concurrent="1" nextAc="seek">
                <p:cTn id="2" dur="indefinite" nodeType="mainSeq">
                  <p:childTnLst>{inner}</p:childTnLst>
                </p:cTn>
                <p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst>
                <p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst>
              </p:seq>
            </p:childTnLst>
          </p:cTn>
        </p:par>
      </p:tnLst>
    </p:timing>'''
    return timing


def add_animations(slide, shape_spids, effect_kinds):
    el = etree.fromstring(make_timing_xml(shape_spids, effect_kinds))
    slide.element.append(el)


# ---------------------------------------------------------------------------
# Builder helpers
# ---------------------------------------------------------------------------

def set_title(slide, text):
    """Set the title placeholder if present; else add a textbox at top."""
    title = None
    for ph in slide.placeholders:
        if ph.placeholder_format.idx == 0:
            title = ph
            break
    if title is None:
        tb = slide.shapes.add_textbox(Inches(0.4), Inches(0.2),
                                       Inches(12.0), Inches(0.8))
        tf = tb.text_frame
        tf.text = text
        tf.paragraphs[0].runs[0].font.size = Pt(28)
        tf.paragraphs[0].runs[0].font.bold = True
        return tb
    title.text = text
    for r in title.text_frame.paragraphs[0].runs:
        r.font.bold = True
    return title


def add_notes(slide, text):
    nslide = slide.notes_slide
    nslide.notes_text_frame.text = text


def add_bullets(slide, items, left=Inches(0.5), top=Inches(1.4),
                width=Inches(6.0), height=Inches(5.0)):
    tb = slide.shapes.add_textbox(left, top, width, height)
    tf = tb.text_frame
    tf.word_wrap = True
    for i, (text, level) in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.text = text
        p.level = level
        for r in p.runs:
            r.font.size = Pt(18 - min(level, 3) * 2)
    return tb


def hyperlink_paragraph(slide, text, url, left, top, width, height,
                        size=18, bold=False):
    tb = slide.shapes.add_textbox(left, top, width, height)
    p = tb.text_frame.paragraphs[0]
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.hyperlink.address = url
    return tb


def make_chart(slide, kind, left, top, width, height, title):
    if kind in ("bar", "column", "line", "pie"):
        cd = CategoryChartData()
        cd.categories = [f"Q{i+1}" for i in range(12)]
        cd.add_series("Series A", [random.randint(20, 100) for _ in range(12)])
        if kind != "pie":
            cd.add_series("Series B", [random.randint(20, 100) for _ in range(12)])
            cd.add_series("Series C", [random.randint(20, 100) for _ in range(12)])
        chart_type = {
            "bar":    XL_CHART_TYPE.BAR_CLUSTERED,
            "column": XL_CHART_TYPE.COLUMN_CLUSTERED,
            "line":   XL_CHART_TYPE.LINE,
            "pie":    XL_CHART_TYPE.PIE,
        }[kind]
        gframe = slide.shapes.add_chart(chart_type, left, top, width, height, cd)
    else:  # scatter
        cd = XyChartData()
        s = cd.add_series("Points")
        for i in range(15):
            s.add_data_point(i, random.randint(10, 90))
        gframe = slide.shapes.add_chart(XL_CHART_TYPE.XY_SCATTER,
                                        left, top, width, height, cd)
    chart = gframe.chart
    chart.has_legend = True
    chart.legend.position = XL_LEGEND_POSITION.BOTTOM
    chart.legend.include_in_layout = False
    chart.has_title = True
    chart.chart_title.text_frame.text = title
    return chart


def make_table(slide, rows, cols, left, top, width, height,
               styled=True, header_text=None):
    shape = slide.shapes.add_table(rows, cols, left, top, width, height)
    table = shape.table
    headers = header_text or [f"Col {c+1}" for c in range(cols)]
    for c in range(cols):
        cell = table.cell(0, c)
        cell.text = headers[c] if c < len(headers) else f"Col {c+1}"
        for p in cell.text_frame.paragraphs:
            for r in p.runs:
                r.font.bold = True
                r.font.size = Pt(12)
    for r in range(1, rows):
        for c in range(cols):
            cell = table.cell(r, c)
            cell.text = f"R{r}C{c+1}={random.randint(1,999)}"
            for p in cell.text_frame.paragraphs:
                for run in p.runs:
                    run.font.size = Pt(11)
            if styled:
                # alternating row fill
                fill = cell.fill
                fill.solid()
                if r % 2 == 0:
                    fill.fore_color.rgb = RGBColor(0xEE, 0xF3, 0xFA)
                else:
                    fill.fore_color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
    return table


def add_grouped_org_chart(slide, left_in, top_in):
    """Add a few connected boxes resembling SmartArt (org chart)."""
    # Top box
    boxes = []

    def box(x, y, w, h, label, fill=RGBColor(0x3B, 0x82, 0xF6)):
        s = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE,
                                    Inches(x), Inches(y),
                                    Inches(w), Inches(h))
        s.fill.solid()
        s.fill.fore_color.rgb = fill
        s.line.color.rgb = RGBColor(0x1E, 0x40, 0xAF)
        tf = s.text_frame
        tf.text = label
        for p in tf.paragraphs:
            p.alignment = 2  # center
            for r in p.runs:
                r.font.bold = True
                r.font.size = Pt(12)
                r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        return s

    def line(x1, y1, x2, y2):
        ln = slide.shapes.add_connector(1,
                                          Inches(x1), Inches(y1),
                                          Inches(x2), Inches(y2))
        ln.line.color.rgb = RGBColor(0x1E, 0x40, 0xAF)
        ln.line.width = Pt(2)
        return ln

    L, T = left_in, top_in
    boxes.append(box(L + 2.5, T + 0.0, 2.0, 0.6, "CEO"))
    boxes.append(box(L + 0.5, T + 1.5, 2.0, 0.6, "VP Eng",
                     RGBColor(0x10, 0xB9, 0x81)))
    boxes.append(box(L + 3.0, T + 1.5, 2.0, 0.6, "VP Sales",
                     RGBColor(0xF5, 0x9E, 0x0B)))
    boxes.append(box(L + 5.5, T + 1.5, 2.0, 0.6, "VP Ops",
                     RGBColor(0xEF, 0x44, 0x44)))
    boxes.append(box(L + 0.0, T + 2.7, 1.5, 0.5, "Backend"))
    boxes.append(box(L + 1.7, T + 2.7, 1.5, 0.5, "Frontend"))
    boxes.append(box(L + 3.4, T + 2.7, 1.5, 0.5, "Field"))
    boxes.append(box(L + 5.1, T + 2.7, 1.5, 0.5, "Inside"))
    line(L + 3.5, T + 0.6, L + 1.5, T + 1.5)
    line(L + 3.5, T + 0.6, L + 4.0, T + 1.5)
    line(L + 3.5, T + 0.6, L + 6.5, T + 1.5)
    line(L + 1.5, T + 2.1, L + 0.75, T + 2.7)
    line(L + 1.5, T + 2.1, L + 2.45, T + 2.7)
    line(L + 4.0, T + 2.1, L + 4.15, T + 2.7)
    line(L + 4.0, T + 2.1, L + 5.85, T + 2.7)
    return boxes


# ---------------------------------------------------------------------------
# Build the deck
# ---------------------------------------------------------------------------

def build():
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    layouts = prs.slide_layouts
    # Common layout indexes in the default template:
    L_TITLE = layouts[0]    # Title slide
    L_TITLE_CONTENT = layouts[1]
    L_TWO_CONTENT = layouts[3]
    L_COMPARISON = layouts[4]
    L_BLANK = layouts[6]

    # Slide topics — specific so per-slide text is recognizable.
    titles = [
        "Slide 1 — Welcome to the Heavy Deck",
        "Slide 2 — Agenda",
        "Slide 3 — Architecture Overview",
        "Slide 4 — WASM Snapshot Pipeline",
        "Slide 5 — Image: Cold Start Timeline",
        "Slide 6 — Image: Warm Restore Timeline",
        "Slide 7 — Chart: Q1 Revenue",
        "Slide 8 — Chart: Active Users by Region",
        "Slide 9 — Two-Content: Pros vs Cons",
        "Slide 10 — Comparison: Cold vs Warm Path",
        "Slide 11 — Table: Latency Budget",
        "Slide 12 — Table: Test Matrix",
        "Slide 13 — SmartArt: Org Chart",
        "Slide 14 — Animation: Entrance Effects",
        "Slide 15 — Animation: Emphasis Pulse",
        "Slide 16 — Image Gallery (Multi)",
        "Slide 17 — Chart: Latency Distribution",
        "Slide 18 — Notes-Heavy: Implementation Tips",
        "Slide 19 — Hyperlinks: External References",
        "Slide 20 — Picture-with-Caption: Diagram",
        "Slide 21 — Bullet Lists with Nesting",
        "Slide 22 — Numbered Workflow Steps",
        "Slide 23 — Mixed Fonts & Sizes",
        "Slide 24 — Chart: Pie of Time Spent",
        "Slide 25 — Halfway: Mid-Deck Checkpoint",
        "Slide 26 — Table: Feature Flags",
        "Slide 27 — Animation: Fly-In Demo",
        "Slide 28 — SmartArt: Process Flow",
        "Slide 29 — Image: Performance Heatmap",
        "Slide 30 — Chart: Scatter Cold-Start vs Size",
        "Slide 31 — Comparison: Browser Support",
        "Slide 32 — Hyperlinks: Internal Anchors",
        "Slide 33 — Notes-Heavy: Edge Cases",
        "Slide 34 — Image Gallery (Wide)",
        "Slide 35 — Table: Memory Profile",
        "Slide 36 — Animation: Zoom + Fade Mix",
        "Slide 37 — SmartArt: Layered Stack",
        "Slide 38 — Picture-with-Caption: Photo",
        "Slide 39 — Chart: Bar of Errors by Module",
        "Slide 40 — Two-Content: API vs UX",
        "Slide 41 — Bullet List: Risks",
        "Slide 42 — Numbered List: Mitigations",
        "Slide 43 — Mixed Formatting Showcase",
        "Slide 44 — Image: Logo Wall",
        "Slide 45 — Hyperlinks: Glossary",
        "Slide 46 — Notes-Heavy: Roll-out Plan",
        "Slide 47 — Comparison: v1 vs v2",
        "Slide 48 — Chart: Line of Throughput",
        "Slide 49 — Final Thoughts",
        "Slide 50 — Summary / Table of Contents",
    ]

    # Track which slides get which feature so the closing summary is accurate.
    feature_log = {
        "image": [],
        "chart": [],
        "table": [],
        "anim":  [],
        "trans": [],
        "group": [],
        "notes": [],
        "link":  [],
    }

    # Bank of pre-rendered images (saved to temp PNGs the deck can reuse).
    image_blobs = {
        i: make_gradient_png(f"IMG #{i}", seed=100 + i) for i in range(20)
    }

    def add_pic(slide, blob_id, left, top, width, height):
        return slide.shapes.add_picture(io.BytesIO(image_blobs[blob_id]),
                                         left, top, width=width, height=height)

    # ---- Build each slide ----
    for n in range(1, 51):
        title = titles[n - 1]
        # Pick layout
        if n == 1:
            layout = L_TITLE
        elif n in (9, 10, 31, 40, 47):
            layout = L_COMPARISON if n in (10, 31, 47) else L_TWO_CONTENT
        elif n in (5, 6, 20, 29, 38, 44):
            layout = L_BLANK  # picture-with-caption emulated manually
        elif n in (13, 25, 28, 37, 50, 16, 34):
            layout = L_BLANK
        else:
            layout = L_TITLE_CONTENT

        slide = prs.slides.add_slide(layout)
        set_title(slide, title)

        # ---- per-slide content ----
        if n == 1:
            # Subtitle
            for ph in slide.placeholders:
                if ph.placeholder_format.idx == 1:
                    ph.text = "A 50-slide stress test for WASM LibreOffice"
            tb = slide.shapes.add_textbox(Inches(0.5), Inches(5.5),
                                           Inches(12), Inches(1.5))
            p = tb.text_frame.paragraphs[0]
            r = p.add_run()
            r.text = "Generated deterministically by heavy-50slides.gen.py"
            r.font.italic = True
            r.font.size = Pt(16)

        elif n == 2:
            items = [
                ("Goals", 0),
                ("Stress test snapshot pipeline", 1),
                ("Validate warm-restore correctness", 1),
                ("Cover diverse OOXML features", 0),
                ("Charts, tables, animations, transitions", 1),
                ("Images, hyperlinks, grouped shapes", 1),
                ("Numbered Workflow", 0),
            ]
            add_bullets(slide, items)
            add_pic(slide, 0, Inches(8.0), Inches(1.6),
                    Inches(4.5), Inches(3.0))
            feature_log["image"].append(n)

        elif n in (5, 6, 29, 38, 44):
            # Picture-with-caption-style
            blob = (n * 3) % len(image_blobs)
            add_pic(slide, blob, Inches(1.5), Inches(1.5),
                    Inches(10), Inches(5))
            tb = slide.shapes.add_textbox(Inches(1.5), Inches(6.6),
                                           Inches(10), Inches(0.6))
            r = tb.text_frame.paragraphs[0].add_run()
            r.text = f"Caption: high-resolution figure for slide {n}."
            r.font.italic = True
            r.font.size = Pt(14)
            feature_log["image"].append(n)

        elif n == 20:
            # Picture-with-caption (explicit)
            add_pic(slide, 7, Inches(1.5), Inches(1.5),
                    Inches(10), Inches(5))
            tb = slide.shapes.add_textbox(Inches(1.5), Inches(6.6),
                                           Inches(10), Inches(0.6))
            r = tb.text_frame.paragraphs[0].add_run()
            r.text = "Diagram: pipeline stages from upload through render."
            r.font.italic = True
            feature_log["image"].append(n)

        elif n in (16, 34):
            # Multi-image gallery
            positions = [
                (Inches(0.4), Inches(1.4), Inches(4.0), Inches(2.7)),
                (Inches(4.7), Inches(1.4), Inches(4.0), Inches(2.7)),
                (Inches(9.0), Inches(1.4), Inches(4.0), Inches(2.7)),
                (Inches(0.4), Inches(4.3), Inches(4.0), Inches(2.7)),
                (Inches(4.7), Inches(4.3), Inches(4.0), Inches(2.7)),
                (Inches(9.0), Inches(4.3), Inches(4.0), Inches(2.7)),
            ]
            for i, (l, t, w, h) in enumerate(positions):
                add_pic(slide, (n + i) % len(image_blobs), l, t, w, h)
            feature_log["image"].append(n)

        elif n == 7:
            make_chart(slide, "column", Inches(0.5), Inches(1.4),
                       Inches(12.0), Inches(5.6), "Q1 Revenue (USD k)")
            feature_log["chart"].append(n)

        elif n == 8:
            make_chart(slide, "bar", Inches(0.5), Inches(1.4),
                       Inches(12.0), Inches(5.6), "Active Users by Region")
            feature_log["chart"].append(n)

        elif n == 17:
            make_chart(slide, "line", Inches(0.5), Inches(1.4),
                       Inches(12.0), Inches(5.6), "Latency Distribution (ms)")
            feature_log["chart"].append(n)

        elif n == 24:
            make_chart(slide, "pie", Inches(2.0), Inches(1.4),
                       Inches(9.0), Inches(5.6), "Time Spent by Phase")
            feature_log["chart"].append(n)

        elif n == 30:
            make_chart(slide, "scatter", Inches(0.5), Inches(1.4),
                       Inches(12.0), Inches(5.6),
                       "Cold-Start Time vs File Size")
            feature_log["chart"].append(n)

        elif n == 39:
            make_chart(slide, "bar", Inches(0.5), Inches(1.4),
                       Inches(12.0), Inches(5.6), "Errors by Module")
            feature_log["chart"].append(n)

        elif n == 48:
            make_chart(slide, "line", Inches(0.5), Inches(1.4),
                       Inches(12.0), Inches(5.6), "Throughput (req/s)")
            feature_log["chart"].append(n)

        elif n == 9:
            # Two-content: pros vs cons
            add_bullets(slide,
                [("Pros", 0),
                 ("Fast warm path (~1s)", 1),
                 ("Smaller bundle on second open", 1),
                 ("Shared code cache", 1)],
                left=Inches(0.5), top=Inches(1.4),
                width=Inches(6), height=Inches(5))
            add_bullets(slide,
                [("Cons", 0),
                 ("Snapshot disk cost", 1),
                 ("Restore-time pthread quirks", 1),
                 ("Doctype-specific edge cases", 1)],
                left=Inches(7.0), top=Inches(1.4),
                width=Inches(6), height=Inches(5))

        elif n in (10, 31, 47):
            # Comparison-style
            left_items = {
                10: [("Cold path", 0), ("Full WASM init", 1),
                     ("Network fetch + decompress", 1), ("~5–10s typical", 1)],
                31: [("Chrome", 0), ("Service Worker OK", 1),
                     ("WebGL2 OK", 1)],
                47: [("v1 viewer", 0), ("Cold-only", 1), ("No co-edit", 1)],
            }[n]
            right_items = {
                10: [("Warm path", 0), ("HEAPU8 snapshot restore", 1),
                     ("Skip slow init", 1), ("~1s typical", 1)],
                31: [("Safari", 0), ("Quirks with COOP/COEP", 1),
                     ("Storage limits", 1)],
                47: [("v2 viewer", 0), ("Cold + warm", 1), ("Co-edit", 1)],
            }[n]
            add_bullets(slide, left_items,
                        left=Inches(0.5), top=Inches(1.4),
                        width=Inches(6), height=Inches(5))
            add_bullets(slide, right_items,
                        left=Inches(7.0), top=Inches(1.4),
                        width=Inches(6), height=Inches(5))

        elif n == 11:
            make_table(slide, 8, 4, Inches(0.5), Inches(1.4),
                       Inches(12), Inches(5.5), styled=True,
                       header_text=["Phase", "Budget ms", "Actual ms",
                                    "Slack ms"])
            feature_log["table"].append(n)

        elif n == 12:
            make_table(slide, 12, 5, Inches(0.5), Inches(1.4),
                       Inches(12), Inches(5.5), styled=True,
                       header_text=["Test", "Doctype", "Path", "P50",
                                    "P95"])
            feature_log["table"].append(n)

        elif n == 26:
            make_table(slide, 7, 3, Inches(0.5), Inches(1.4),
                       Inches(12), Inches(5.5), styled=True,
                       header_text=["Flag", "Default", "Notes"])
            feature_log["table"].append(n)

        elif n == 35:
            make_table(slide, 10, 6, Inches(0.5), Inches(1.4),
                       Inches(12), Inches(5.5), styled=False)
            feature_log["table"].append(n)

        elif n == 4:
            # Architecture: text + small table
            add_bullets(slide, [
                ("WASM bootstrap", 0),
                ("emscripten Module init", 1),
                ("Filesystem mount", 1),
                ("Snapshot capture (deferred HEAPU8)", 0),
                ("Snapshot restore on second init", 0),
            ])
            make_table(slide, 4, 3, Inches(7.0), Inches(1.4),
                       Inches(5.8), Inches(2.5), styled=True,
                       header_text=["Stage", "Cold", "Warm"])
            feature_log["table"].append(n)

        elif n == 13:
            add_grouped_org_chart(slide, left_in=2.5, top_in=2.0)
            feature_log["group"].append(n)

        elif n == 28:
            # SmartArt-like process flow (5 boxes left→right + arrows)
            for i, label in enumerate(["Upload", "Parse", "Snapshot",
                                       "Render", "Serve"]):
                x = 0.5 + i * 2.6
                s = slide.shapes.add_shape(MSO_SHAPE.PENTAGON,
                                            Inches(x), Inches(3.0),
                                            Inches(2.4), Inches(1.2))
                s.fill.solid()
                s.fill.fore_color.rgb = RGBColor(0x6D, 0x28, 0xD9)
                s.line.color.rgb = RGBColor(0x4C, 0x1D, 0x95)
                s.text_frame.text = label
                for p in s.text_frame.paragraphs:
                    p.alignment = 2
                    for r in p.runs:
                        r.font.bold = True
                        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
                        r.font.size = Pt(16)
            feature_log["group"].append(n)

        elif n == 37:
            # SmartArt-like layered stack
            for i, (label, col) in enumerate([
                ("UI Layer", RGBColor(0x60, 0xA5, 0xFA)),
                ("State Layer", RGBColor(0x34, 0xD3, 0x99)),
                ("WASM Bridge", RGBColor(0xFB, 0xBF, 0x24)),
                ("LibreOffice Core", RGBColor(0xF8, 0x71, 0x71)),
            ]):
                s = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
                                            Inches(2.5),
                                            Inches(1.3 + i * 1.3),
                                            Inches(8.0), Inches(1.0))
                s.fill.solid()
                s.fill.fore_color.rgb = col
                s.text_frame.text = label
                for p in s.text_frame.paragraphs:
                    p.alignment = 2
                    for r in p.runs:
                        r.font.bold = True
                        r.font.size = Pt(18)
            feature_log["group"].append(n)

        elif n == 14:
            # Animation slide — three shapes with entrance effects
            spids = []
            kinds = ["appear", "fade", "fly"]
            for i, label in enumerate(["Appear", "Fade", "Fly"]):
                s = slide.shapes.add_shape(MSO_SHAPE.OVAL,
                                            Inches(1 + i * 4),
                                            Inches(3.0),
                                            Inches(3), Inches(2))
                s.fill.solid()
                s.fill.fore_color.rgb = RGBColor(0x1F, 0x6F, 0xEB)
                s.text_frame.text = label
                for p in s.text_frame.paragraphs:
                    p.alignment = 2
                    for r in p.runs:
                        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
                        r.font.bold = True
                        r.font.size = Pt(20)
                spids.append(s.shape_id)
            add_animations(slide, spids, kinds)
            feature_log["anim"].append(n)

        elif n == 15:
            # Emphasis (pulse)
            spids = []
            for i, label in enumerate(["Pulse 1", "Pulse 2", "Pulse 3"]):
                s = slide.shapes.add_shape(MSO_SHAPE.STAR_5_POINT,
                                            Inches(1 + i * 4),
                                            Inches(2.5),
                                            Inches(3), Inches(3))
                s.fill.solid()
                s.fill.fore_color.rgb = RGBColor(0xF5, 0x9E, 0x0B)
                s.text_frame.text = label
                spids.append(s.shape_id)
            add_animations(slide, spids,
                            ["emphasis", "emphasis", "emphasis"])
            feature_log["anim"].append(n)

        elif n == 27:
            # Fly-in demo
            spids = []
            for i, label in enumerate(["A", "B", "C", "D"]):
                s = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE,
                                            Inches(0.5 + i * 3.2),
                                            Inches(3.0),
                                            Inches(2.8), Inches(2.0))
                s.fill.solid()
                s.fill.fore_color.rgb = RGBColor(0x10, 0xB9, 0x81)
                s.text_frame.text = label
                spids.append(s.shape_id)
            add_animations(slide, spids, ["fly", "fly", "fly", "fly"])
            feature_log["anim"].append(n)

        elif n == 36:
            # Mixed zoom + fade + exit
            spids = []
            for i, (label, kind) in enumerate([("Z1", "zoom"),
                                                ("F1", "fade"),
                                                ("X1", "exit"),
                                                ("Z2", "zoom")]):
                s = slide.shapes.add_shape(MSO_SHAPE.HEXAGON,
                                            Inches(0.5 + i * 3.2),
                                            Inches(3.0),
                                            Inches(2.8), Inches(2.0))
                s.fill.solid()
                s.fill.fore_color.rgb = RGBColor(0xEF, 0x44, 0x44)
                s.text_frame.text = label
                spids.append(s.shape_id)
            add_animations(slide, spids,
                            ["zoom", "fade", "exit", "zoom"])
            feature_log["anim"].append(n)

        elif n == 42:
            # 5th animation slide — appear chain
            spids = []
            for i, label in enumerate(["Step1", "Step2", "Step3",
                                         "Step4", "Step5"]):
                s = slide.shapes.add_shape(MSO_SHAPE.CHEVRON,
                                            Inches(0.5 + i * 2.5),
                                            Inches(3.0),
                                            Inches(2.4), Inches(1.5))
                s.fill.solid()
                s.fill.fore_color.rgb = RGBColor(0x6D, 0x28, 0xD9)
                s.text_frame.text = label
                spids.append(s.shape_id)
            add_animations(slide, spids, ["appear"] * 5)
            feature_log["anim"].append(n)

        elif n == 18:
            # Notes-heavy informative slide + decorative image
            add_bullets(slide, [
                ("Implementation Tips", 0),
                ("Always verify remote before destroy", 1),
                ("Commit after every win", 1),
                ("Hot-deploy via cache-bust-build.js", 1),
                ("Snapshot capture is deferred (HEAPU8)", 0),
            ], left=Inches(0.5), top=Inches(1.4),
               width=Inches(7), height=Inches(5))
            add_pic(slide, 5, Inches(8.0), Inches(1.6),
                    Inches(4.8), Inches(3.2))
            feature_log["image"].append(n)

        elif n == 19:
            # Hyperlinks — 5+ links on one slide
            base_y = 1.4
            for i, (txt, url) in enumerate([
                ("python-pptx documentation",
                 "https://python-pptx.readthedocs.io/"),
                ("OOXML PresentationML reference",
                 "https://ecma-international.org/publications-and-standards/standards/ecma-376/"),
                ("LibreOffice WASM repo",
                 "https://gerrit.libreoffice.org/"),
                ("Emscripten Module API",
                 "https://emscripten.org/docs/api_reference/module.html"),
                ("WebAssembly spec",
                 "https://webassembly.github.io/spec/"),
            ]):
                hyperlink_paragraph(slide, txt, url,
                                    Inches(0.5),
                                    Inches(base_y + i * 0.7),
                                    Inches(12), Inches(0.6),
                                    size=18, bold=False)
            feature_log["link"].append(n)

        elif n == 32:
            # Internal-style hyperlinks (still URLs; representational)
            for i, (txt, url) in enumerate([
                ("See Slide 7 chart",
                 "https://example.com/anchor#slide7"),
                ("See Slide 13 org chart",
                 "https://example.com/anchor#slide13"),
                ("See Slide 25 mid-checkpoint",
                 "https://example.com/anchor#slide25"),
            ]):
                hyperlink_paragraph(slide, txt, url,
                                    Inches(0.5), Inches(1.4 + i * 0.8),
                                    Inches(12), Inches(0.6), size=18)
            feature_log["link"].append(n)

        elif n == 45:
            # Glossary hyperlinks
            for i, (txt, url) in enumerate([
                ("WASM",      "https://webassembly.org/"),
                ("Emscripten","https://emscripten.org/"),
                ("Pillow",    "https://pillow.readthedocs.io/"),
            ]):
                hyperlink_paragraph(slide, txt + " — open reference", url,
                                    Inches(0.5),
                                    Inches(1.4 + i * 0.8),
                                    Inches(12), Inches(0.6), size=18,
                                    bold=True)
            feature_log["link"].append(n)

        elif n == 21:
            # Nested bullets
            items = [
                ("Categories", 0),
                ("Performance", 1),
                ("Cold start", 2),
                ("Warm restore", 2),
                ("Correctness", 1),
                ("Rendering parity", 2),
                ("Co-edit consistency", 2),
                ("Robustness", 1),
                ("Crash recovery", 2),
                ("Network flake", 2),
            ]
            add_bullets(slide, items)

        elif n == 22:
            # Numbered workflow
            tb = slide.shapes.add_textbox(Inches(0.5), Inches(1.4),
                                           Inches(12), Inches(5.5))
            tf = tb.text_frame
            steps = ["Receive doc", "Decrypt fragment", "Init WASM",
                     "Restore snapshot if available",
                     "Render first slide", "Notify UI"]
            for i, s in enumerate(steps):
                p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                run = p.add_run()
                run.text = f"{i+1}. {s}"
                run.font.size = Pt(20)
                run.font.bold = (i == 0)

        elif n == 23 or n == 43:
            # Mixed formatting showcase
            tb = slide.shapes.add_textbox(Inches(0.5), Inches(1.4),
                                           Inches(12), Inches(5.5))
            tf = tb.text_frame
            tf.word_wrap = True
            samples = [
                ("Bold text",       {"bold": True,   "size": 22, "font": "Arial"}),
                ("Italic text",     {"italic": True, "size": 22, "font": "Times New Roman"}),
                ("Underlined text", {"underline": True, "size": 22, "font": "Courier New"}),
                ("Big heading",     {"bold": True,   "size": 32, "font": "Verdana"}),
                ("Tiny footnote",   {"italic": True, "size": 10, "font": "Georgia"}),
                ("Mixed combo: ",   {"bold": True,   "size": 18, "font": "Calibri"}),
            ]
            for i, (txt, fmt) in enumerate(samples):
                p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                run = p.add_run()
                run.text = txt
                if fmt.get("bold"):      run.font.bold = True
                if fmt.get("italic"):    run.font.italic = True
                if fmt.get("underline"): run.font.underline = True
                run.font.size = Pt(fmt["size"])
                run.font.name = fmt["font"]

        elif n == 25:
            # Mid-deck checkpoint
            tb = slide.shapes.add_textbox(Inches(2.0), Inches(2.5),
                                           Inches(9), Inches(2.5))
            tf = tb.text_frame
            r = tf.paragraphs[0].add_run()
            r.text = "Halfway there!"
            r.font.bold = True
            r.font.size = Pt(48)
            p2 = tf.add_paragraph()
            r2 = p2.add_run()
            r2.text = "25 slides down, 25 to go."
            r2.font.italic = True
            r2.font.size = Pt(24)

        elif n == 33 or n == 46:
            # Notes-heavy
            add_bullets(slide, [
                ("Edge cases" if n == 33 else "Roll-out plan", 0),
                ("Phase 1: internal dogfood", 1),
                ("Phase 2: opt-in beta", 1),
                ("Phase 3: GA with feature flag", 1),
                ("Phase 4: deprecate v1", 1),
            ], left=Inches(0.5), top=Inches(1.4),
               width=Inches(7.5), height=Inches(5))
            if n == 33:
                # Hyperlinks to bug trackers etc.
                for i, (txt, url) in enumerate([
                    ("Edge case: stale snapshot",
                     "https://example.com/issue/101"),
                    ("Edge case: pthread teardown",
                     "https://example.com/issue/202"),
                    ("Edge case: COOP/COEP",
                     "https://example.com/issue/303"),
                ]):
                    hyperlink_paragraph(slide, txt, url,
                                        Inches(8.2),
                                        Inches(1.6 + i * 0.8),
                                        Inches(5), Inches(0.6),
                                        size=14)
                feature_log["link"].append(n)

        elif n == 41:
            # Risks
            add_bullets(slide, [
                ("Risks", 0),
                ("Snapshot incompatibility across builds", 1),
                ("pthread teardown flake", 1),
                ("Stale serverFreshlyReady atomic", 1),
            ])

        elif n == 49:
            tb = slide.shapes.add_textbox(Inches(1.0), Inches(1.5),
                                           Inches(11), Inches(2))
            r = tb.text_frame.paragraphs[0].add_run()
            r.text = "Final Thoughts"
            r.font.bold = True
            r.font.size = Pt(36)
            p = tb.text_frame.add_paragraph()
            r2 = p.add_run()
            r2.text = ("Snapshot/warm-restore turns the second open into a "
                       "near-instant experience while keeping the cold path "
                       "correct.")
            r2.font.size = Pt(20)
            # Two more hyperlinks to satisfy the "≥5 slides with links" reqt.
            hyperlink_paragraph(slide, "Read the design doc",
                                "https://example.com/design",
                                Inches(1.0), Inches(4.5),
                                Inches(11), Inches(0.6),
                                size=18, bold=True)
            hyperlink_paragraph(slide, "Open the regression test suite",
                                "https://example.com/tests",
                                Inches(1.0), Inches(5.3),
                                Inches(11), Inches(0.6),
                                size=18, bold=True)
            feature_log["link"].append(n)

        elif n == 50:
            # Summary / TOC slide
            tb = slide.shapes.add_textbox(Inches(0.4), Inches(1.0),
                                           Inches(12.5), Inches(0.5))
            r = tb.text_frame.paragraphs[0].add_run()
            r.text = "Table of Contents — 50 slides at a glance"
            r.font.bold = True
            r.font.size = Pt(20)
            # Two-column TOC: 25 entries each
            for col in (0, 1):
                tb = slide.shapes.add_textbox(
                    Inches(0.4 + col * 6.5), Inches(1.6),
                    Inches(6.3), Inches(5.7))
                tf = tb.text_frame
                tf.word_wrap = True
                start = 1 + col * 25
                for i, sn in enumerate(range(start, start + 25)):
                    p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                    run = p.add_run()
                    # Trim long titles
                    title_short = titles[sn - 1]
                    if len(title_short) > 48:
                        title_short = title_short[:45] + "..."
                    run.text = title_short
                    run.font.size = Pt(11)
                    if sn in feature_log["chart"]:
                        run.font.color.rgb = RGBColor(0x1F, 0x6F, 0xEB)
                    elif sn in feature_log["image"]:
                        run.font.color.rgb = RGBColor(0x10, 0xB9, 0x81)
                    elif sn in feature_log["table"]:
                        run.font.color.rgb = RGBColor(0xF5, 0x9E, 0x0B)

        else:
            # Default content — small bullet list + small image
            add_bullets(slide, [
                (f"Key point #{n}A — context for slide {n}", 0),
                (f"Key point #{n}B — supporting detail", 0),
                (f"Key point #{n}C — concrete example", 0),
            ])

        # ---- Speaker notes ----
        # Give 30 slides non-trivial notes (≥ 50 words). Spread across deck.
        if n % 2 == 0 or n in (1, 3, 5, 7, 9, 11, 13, 15, 17, 19,
                                 21, 23, 25, 27, 29):
            words_pool = [
                "snapshot", "warm-restore", "WASM", "LibreOffice", "viewer",
                "rendering", "performance", "co-edit", "transition",
                "animation", "OOXML", "PresentationML", "table", "chart",
                "image", "fixture", "regression", "test", "deterministic",
                "pipeline", "decompress", "fetch", "cache", "fingerprint",
                "service-worker", "browser", "cold-path", "warm-path",
                "memory", "HEAPU8", "Emscripten", "Module", "init",
                "deferred", "thread", "pthread", "atomic", "robust",
            ]
            rng = random.Random(1000 + n)
            note_words = [rng.choice(words_pool) for _ in range(70)]
            note = (
                f"Speaker notes for slide {n}: {titles[n-1]}. "
                + " ".join(note_words) + "."
            )
            add_notes(slide, note)
            feature_log["notes"].append(n)

        # ---- Transitions ----
        # Pick deterministic transitions for ≥10 slides.
        TRANS_MAP = {
            2: "fade",  5: "push",  8: "wipe",  11: "split",
            14: "cover", 17: "fade", 20: "push", 23: "wipe",
            26: "split", 29: "cover", 32: "fade", 35: "push",
            38: "wipe", 41: "split", 44: "cover", 47: "fade",
            50: "fade",
        }
        if n in TRANS_MAP:
            add_transition(slide, TRANS_MAP[n])
            feature_log["trans"].append(n)

    # ---- Save ----
    prs.save(str(OUT))
    return feature_log


def main():
    log = build()
    # Print summary the caller can grep.
    size = OUT.stat().st_size
    print(f"Wrote {OUT}")
    print(f"  size:      {size:,} bytes ({size/1024/1024:.2f} MB)")
    print(f"  images:    slides {log['image']}")
    print(f"  charts:    slides {log['chart']}")
    print(f"  tables:    slides {log['table']}")
    print(f"  anims:     slides {log['anim']}")
    print(f"  trans:     slides {log['trans']}")
    print(f"  groups:    slides {log['group']}")
    print(f"  links:     slides {log['link']}")
    print(f"  notes-on:  {len(log['notes'])} slides")


if __name__ == "__main__":
    main()
