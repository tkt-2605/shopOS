//! A PDF writer, small enough to read.
//!
//! Shops need to send a statement to a customer and a report to an accountant,
//! and neither of those travels as a thermal receipt. That means PDF, and PDF
//! means either a dependency tree or about two hundred lines. This is the two
//! hundred lines: no crate, nothing to keep up to date, nothing that can stop
//! the till printing because an upstream release changed its API.
//!
//! It writes one kind of document — a heading, some labelled facts, a table
//! that paginates, and a set of totals — because that is what both a statement
//! and a report are. It is deliberately not a layout engine.
//!
//! Two things it does not do, said here rather than discovered later:
//!
//!   * **Only Latin text.** The fonts are the PDF standard fourteen, which are
//!     guaranteed present in every reader and need no embedding, but they carry
//!     WinAnsi and so cannot render Tamil. A Tamil receipt needs an embedded
//!     font, which is a different job.
//!   * **No rupee sign**, for the same reason — U+20B9 has no glyph in those
//!     fonts. Amounts are written plain and the column says what they are.
//!
//! Right-aligned cells are set in Courier, whose every glyph is exactly 0.6 em
//! wide, so a column of figures can be positioned exactly without carrying a
//! width table for a proportional face.
//!
//! ## Why the invoice is not here
//!
//! This was once meant to grow sections — a header band, a bordered party box,
//! a tax summary, a signature line — and an image XObject, so that it could
//! print the A4 invoice too. It does not, and it should not.
//!
//! The invoice went to HTML instead (`domain/invoiceHtml.ts`), printed through
//! the webview. Three reasons, in the order they mattered:
//!
//!   * The two limits above are fatal for an invoice and merely awkward for a
//!     report. A tax invoice that cannot print a rupee sign, and cannot print a
//!     shop's name in Tamil, is not a tax invoice a shop in Tamil Nadu can hand
//!     anybody. Fixing that here means embedding a font, subsetting it, and
//!     writing a CID-keyed font dictionary — considerably more than the two
//!     hundred lines this file is worth.
//!   * The webview already has a layout engine, a font stack with every script
//!     on the machine, and a print dialog the shopkeeper already knows.
//!   * A format the shop designs itself needs a preview that matches the
//!     printout. With HTML the preview *is* the printout.
//!
//! So this file keeps exactly the two documents it was written for: the ones
//! that are saved silently to a file, where there is no dialog to open and no
//! Indian-language text to set. It stays deliberately small.

use std::fmt::Write as _;

const PAGE_W: f64 = 595.28; // A4 portrait, points
const PAGE_H: f64 = 841.89;
const MARGIN: f64 = 42.0;
const BOTTOM: f64 = 56.0;

const FONT_REGULAR: &str = "F1";
const FONT_BOLD: &str = "F2";
const FONT_MONO: &str = "F3";

/// Courier is metrically fixed at 0.6 em; that is the whole reason figures use it.
const MONO_EM: f64 = 0.6;

/// Helvetica advance widths in 1/1000 em, ASCII 32..=126, from the Adobe metrics.
///
/// Carried because a left-aligned cell has to know when it has run out of
/// column. Without it every long value was simply drawn past its own column and
/// over the top of the next one — a statement whose document numbers sat across
/// the description beside them, which is what a reader sees as a broken page
/// rather than as a missing width table.
const HELVETICA_W: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    278, 278, 584, 584, 584, 556, 1015,
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
    778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
    278, 278, 278, 469, 556, 333,
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
    556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
    334, 260, 334, 584,
];

const HELVETICA_BOLD_W: [u16; 95] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
    333, 333, 584, 584, 584, 611, 975,
    722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667,
    778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
    333, 278, 333, 584, 556, 333,
    556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611,
    611, 389, 556, 333, 611, 556, 778, 556, 556, 500,
    389, 280, 389, 584,
];

/// How wide this string sets, in points.
fn text_width(font: &str, size: f64, s: &str) -> f64 {
    if font == FONT_MONO {
        return s.chars().count() as f64 * size * MONO_EM;
    }
    let table = if font == FONT_BOLD { &HELVETICA_BOLD_W } else { &HELVETICA_W };
    let mils: f64 = s
        .chars()
        .map(|c| {
            let i = c as usize;
            // Anything outside printable ASCII is charged the common width; the
            // encoding is WinAnsi and the shop's own text is Latin either way.
            if (32..=126).contains(&i) { table[i - 32] as f64 } else { 556.0 }
        })
        .sum();
    mils * size / 1000.0
}

/// The string cut to the room it has, with an ellipsis so nobody reads a
/// truncated document number as a whole one.
fn fit(font: &str, size: f64, s: &str, max: f64) -> String {
    if max <= 0.0 || text_width(font, size, s) <= max {
        return s.to_string();
    }
    let tail = "...";
    let tail_w = text_width(font, size, tail);
    let mut out = String::new();
    let mut used = 0.0;
    for c in s.chars() {
        let w = text_width(font, size, c.encode_utf8(&mut [0u8; 4]));
        if used + w + tail_w > max {
            break;
        }
        out.push(c);
        used += w;
    }
    out.push_str(tail);
    out
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub label: String,
    /// Share of the usable width. Normalised, so callers can pass any scale.
    pub width: f64,
    #[serde(default)]
    pub align_right: bool,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfDoc {
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    /// Shown under the heading, one per line, label then value.
    #[serde(default)]
    pub meta: Vec<(String, String)>,
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<String>>,
    /// Rows that should stand out — a brought-forward line, a subtotal.
    #[serde(default)]
    pub bold_rows: Vec<usize>,
    #[serde(default)]
    pub totals: Vec<(String, String)>,
    #[serde(default)]
    pub footer: Option<String>,
}

/// Escapes the three characters that would otherwise end a PDF string early,
/// and drops anything the standard fonts cannot show rather than emitting a
/// byte the reader would draw as a wrong glyph.
fn pdf_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for ch in s.chars() {
        match ch {
            '(' => out.push_str("\\("),
            ')' => out.push_str("\\)"),
            '\\' => out.push_str("\\\\"),
            // Written the way the fonts can render it; see the note at the top.
            '\u{20B9}' => out.push_str("Rs."),
            '\u{2014}' | '\u{2013}' => out.push('-'),
            '\u{2018}' | '\u{2019}' => out.push('\''),
            '\u{201C}' | '\u{201D}' => out.push('"'),
            '\u{2026}' => out.push_str("..."),
            c if (c as u32) < 128 => out.push(c),
            c if (c as u32) < 256 => out.push(c),
            _ => out.push('?'),
        }
    }
    out
}

struct Page {
    content: String,
}

impl Page {
    fn new() -> Self {
        Page { content: String::new() }
    }

    fn text(&mut self, font: &str, size: f64, x: f64, y: f64, s: &str) {
        let _ = write!(
            self.content,
            "BT /{} {} Tf 1 0 0 1 {:.2} {:.2} Tm ({}) Tj ET\n",
            font, size, x, y, pdf_text(s)
        );
    }

    /// Positioned by measuring, which is exact because the face is monospaced.
    fn text_right(&mut self, size: f64, right_x: f64, y: f64, s: &str) {
        let width = pdf_text(s).chars().count() as f64 * size * MONO_EM;
        self.text(FONT_MONO, size, right_x - width, y, s);
    }

    fn line(&mut self, x1: f64, y: f64, x2: f64, weight: f64) {
        let _ = write!(
            self.content,
            "{:.2} w 0.75 G {:.2} {:.2} m {:.2} {:.2} l S\n",
            weight, x1, y, x2, y
        );
    }
}

pub fn render(doc: &PdfDoc) -> Vec<u8> {
    let usable = PAGE_W - MARGIN * 2.0;
    let total_share: f64 = doc.columns.iter().map(|c| c.width).sum::<f64>().max(0.0001);

    // Left edge and width of every column, worked out once.
    let mut xs: Vec<(f64, f64)> = Vec::with_capacity(doc.columns.len());
    let mut cursor = MARGIN;
    for col in &doc.columns {
        let w = usable * (col.width / total_share);
        xs.push((cursor, w));
        cursor += w;
    }

    let mut pages: Vec<Page> = Vec::new();
    let mut page = Page::new();
    let mut y = PAGE_H - MARGIN;

    // ── heading ────────────────────────────────────────────────────────────
    page.text(FONT_BOLD, 16.0, MARGIN, y, &doc.title);
    y -= 19.0;
    if let Some(sub) = &doc.subtitle {
        page.text(FONT_REGULAR, 10.5, MARGIN, y, sub);
        y -= 15.0;
    }
    for (label, value) in &doc.meta {
        page.text(FONT_REGULAR, 9.5, MARGIN, y, label);
        page.text(FONT_REGULAR, 9.5, MARGIN + 110.0, y, value);
        y -= 13.0;
    }
    y -= 6.0;

    let header = |page: &mut Page, y: f64| {
        page.line(MARGIN, y + 11.0, PAGE_W - MARGIN, 0.7);
        for (i, col) in doc.columns.iter().enumerate() {
            let (x, w) = xs[i];
            if col.align_right {
                page.text_right(8.5, x + w - 3.0, y, &col.label);
            } else {
                page.text(FONT_BOLD, 8.5, x, y, &fit(FONT_BOLD, 8.5, &col.label, w - 4.0));
            }
        }
        page.line(MARGIN, y - 4.0, PAGE_W - MARGIN, 0.7);
    };

    header(&mut page, y);
    y -= 17.0;

    // ── rows ───────────────────────────────────────────────────────────────
    for (r, row) in doc.rows.iter().enumerate() {
        if y < BOTTOM + 40.0 {
            pages.push(page);
            page = Page::new();
            y = PAGE_H - MARGIN;
            header(&mut page, y);
            y -= 17.0;
        }

        let bold = doc.bold_rows.contains(&r);
        for (i, cell) in row.iter().enumerate() {
            if i >= xs.len() {
                break;
            }
            let (x, w) = xs[i];
            if doc.columns[i].align_right {
                page.text_right(9.0, x + w - 3.0, y, cell);
            } else {
                let font = if bold { FONT_BOLD } else { FONT_REGULAR };
                // Four points of gutter, so two columns never touch even when
                // one of them is full.
                page.text(font, 9.0, x, y, &fit(font, 9.0, cell, w - 4.0));
            }
        }
        y -= 13.5;
    }

    // ── totals ─────────────────────────────────────────────────────────────
    if !doc.totals.is_empty() {
        if y < BOTTOM + 30.0 + doc.totals.len() as f64 * 14.0 {
            pages.push(page);
            page = Page::new();
            y = PAGE_H - MARGIN;
        }
        y -= 4.0;
        page.line(PAGE_W - MARGIN - 220.0, y + 10.0, PAGE_W - MARGIN, 0.7);
        y -= 4.0;
        for (i, (label, value)) in doc.totals.iter().enumerate() {
            let last = i + 1 == doc.totals.len();
            let size = if last { 11.0 } else { 9.5 };
            page.text(
                if last { FONT_BOLD } else { FONT_REGULAR },
                size,
                PAGE_W - MARGIN - 220.0,
                y,
                label,
            );
            page.text_right(size, PAGE_W - MARGIN, y, value);
            y -= if last { 17.0 } else { 14.0 };
        }
    }

    if let Some(footer) = &doc.footer {
        page.text(FONT_REGULAR, 8.5, MARGIN, BOTTOM - 14.0, footer);
    }

    pages.push(page);

    // Page numbers last, when how many there are is finally known.
    let count = pages.len();
    for (i, p) in pages.iter_mut().enumerate() {
        let label = format!("Page {} of {}", i + 1, count);
        let width = label.chars().count() as f64 * 8.0 * MONO_EM;
        p.text(FONT_MONO, 8.0, PAGE_W - MARGIN - width, BOTTOM - 14.0, &label);
    }

    assemble(&pages)
}

/// Builds the file itself: objects, the cross-reference table that indexes them
/// by byte offset, and the trailer that points at the catalogue.
fn assemble(pages: &[Page]) -> Vec<u8> {
    let page_count = pages.len();
    // 1 catalog, 2 pages tree, 3 fonts start at 3..=5, then per page: page + content.
    let first_page_obj = 6;
    let total_objects = first_page_obj - 1 + page_count * 2;

    let mut out: Vec<u8> = Vec::new();
    let mut offsets: Vec<usize> = vec![0; total_objects + 1];

    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");

    let push = |out: &mut Vec<u8>, offsets: &mut Vec<usize>, n: usize, body: &str| {
        offsets[n] = out.len();
        out.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", n, body).as_bytes());
    };

    let kids: String = (0..page_count)
        .map(|i| format!("{} 0 R", first_page_obj + i * 2))
        .collect::<Vec<_>>()
        .join(" ");

    push(&mut out, &mut offsets, 1, "<< /Type /Catalog /Pages 2 0 R >>");
    push(
        &mut out,
        &mut offsets,
        2,
        &format!(
            "<< /Type /Pages /Count {} /Kids [{}] >>",
            page_count, kids
        ),
    );

    for (n, base) in [(3, "Helvetica"), (4, "Helvetica-Bold"), (5, "Courier")] {
        push(
            &mut out,
            &mut offsets,
            n,
            &format!(
                "<< /Type /Font /Subtype /Type1 /BaseFont /{} /Encoding /WinAnsiEncoding >>",
                base
            ),
        );
    }

    for (i, page) in pages.iter().enumerate() {
        let page_obj = first_page_obj + i * 2;
        let content_obj = page_obj + 1;
        push(
            &mut out,
            &mut offsets,
            page_obj,
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {:.2} {:.2}] \
                 /Resources << /Font << /{} 3 0 R /{} 4 0 R /{} 5 0 R >> >> \
                 /Contents {} 0 R >>",
                PAGE_W, PAGE_H, FONT_REGULAR, FONT_BOLD, FONT_MONO, content_obj
            ),
        );
        push(
            &mut out,
            &mut offsets,
            content_obj,
            &format!(
                "<< /Length {} >>\nstream\n{}endstream",
                page.content.len(),
                page.content
            ),
        );
    }

    let xref_at = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", total_objects + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for n in 1..=total_objects {
        out.extend_from_slice(format!("{:010} 00000 n \n", offsets[n]).as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n",
            total_objects + 1,
            xref_at
        )
        .as_bytes(),
    );

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(rows: usize) -> PdfDoc {
        PdfDoc {
            title: "Statement of account".into(),
            subtitle: Some("Anand Stores".into()),
            meta: vec![("Customer".into(), "C0001".into())],
            columns: vec![
                Column { label: "Date".into(), width: 1.0, align_right: false },
                Column { label: "Amount".into(), width: 1.0, align_right: true },
            ],
            rows: (0..rows).map(|i| vec![format!("2026-01-{:02}", (i % 28) + 1), "1,200.00".into()]).collect(),
            bold_rows: vec![],
            totals: vec![("Balance due".into(), "3,400.00".into())],
            footer: Some("Please check and tell us at once if anything here is wrong.".into()),
        }
    }

    #[test]
    fn measures_a_proportional_string_rather_than_counting_its_characters() {
        // "MMM" and "iii" are the same three characters and nothing like the
        // same width; a column that assumed otherwise is what put document
        // numbers across the description beside them.
        assert!(text_width(FONT_REGULAR, 9.0, "MMM") > text_width(FONT_REGULAR, 9.0, "iii") * 3.0);
        // Courier stays exact, which is why figures are set in it.
        assert_eq!(text_width(FONT_MONO, 10.0, "1234"), 4.0 * 10.0 * MONO_EM);
    }

    #[test]
    fn cuts_a_cell_that_will_not_fit_rather_than_drawing_over_the_next_column() {
        let long = "INV/MR/26-27/00016";
        let room = text_width(FONT_REGULAR, 9.0, long) / 2.0;
        let cut = fit(FONT_REGULAR, 9.0, long, room);

        assert!(cut.ends_with("..."));
        assert!(text_width(FONT_REGULAR, 9.0, &cut) <= room);
    }

    #[test]
    fn leaves_a_cell_that_fits_exactly_as_it_was() {
        let s = "2026-09-14";
        let room = text_width(FONT_REGULAR, 9.0, s) + 1.0;
        assert_eq!(fit(FONT_REGULAR, 9.0, s, room), s);
    }

    #[test]
    fn writes_something_a_reader_will_open() {
        let out = render(&doc(3));
        assert!(out.starts_with(b"%PDF-1.4"));
        assert!(out.ends_with(b"%%EOF\n"));
        assert!(String::from_utf8_lossy(&out).contains("startxref"));
    }

    /// The cross-reference table is the index a reader seeks by; an offset that
    /// does not land exactly on its object is a file that opens blank.
    #[test]
    fn every_offset_points_at_its_object() {
        let out = render(&doc(3));
        let text = String::from_utf8_lossy(&out);
        let xref_at: usize = text
            .rsplit("startxref").next().unwrap()
            .trim().lines().next().unwrap().parse().unwrap();

        let table = &text[xref_at..];
        for (n, line) in table.lines().skip(2).enumerate() {
            if !line.ends_with(" n ") { break }
            let offset: usize = line[..10].parse().unwrap();
            assert!(
                text[offset..].starts_with(&format!("{} 0 obj", n + 1)),
                "object {} is not at its stated offset", n + 1,
            );
        }
    }

    #[test]
    fn spills_onto_more_pages_when_there_are_more_rows() {
        let one = render(&doc(5));
        let many = render(&doc(200));
        assert!(String::from_utf8_lossy(&one).contains("/Count 1"));
        assert!(!String::from_utf8_lossy(&many).contains("/Count 1"));
        assert!(many.len() > one.len());
    }

    /// An unescaped bracket ends the string early and the rest of the page is
    /// read as instructions, which is how a PDF comes out mangled.
    #[test]
    fn escapes_what_would_end_a_string_early() {
        assert_eq!(pdf_text("Pen (blue) \\ red"), "Pen \\(blue\\) \\\\ red");
    }

    /// The standard fonts have no rupee glyph, so it is spelled rather than
    /// drawn as whatever the reader substitutes.
    #[test]
    fn writes_rupees_in_letters() {
        assert_eq!(pdf_text("\u{20B9}1,200"), "Rs.1,200");
    }
}
