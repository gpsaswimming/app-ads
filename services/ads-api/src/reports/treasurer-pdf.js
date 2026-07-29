// Treasurer report → PDF (docs/TODO.md #1). The deliverable the treasurer actually uses:
// page 1 is the league summary (a row per team, the amount due highlighted, grand total at
// the foot); then one page per team listing that team's ads, each amount, and the total due.
//
// Rendered with pdfkit's built-in Helvetica — no font files or images are bundled, so the
// image stays small and the report needs no network at run time. Brand colors only.

import PDFDocument from 'pdfkit';

const NAVY = '#002366';
const INK = '#14213d';
const MUTED = '#5b6473';
const LINE = '#d7deeb';
const TINT = '#eef2fb';
const ZEBRA = '#f7f9ff';
const AMBER = '#8a5a00';

const MARGIN = 48;
const PAGE = { width: 612, height: 792 };
const CONTENT = PAGE.width - MARGIN * 2; // 516
const BOTTOM = PAGE.height - MARGIN - 24; // leave room for the page footer

// Column layouts. Widths sum to CONTENT so both tables share the same rules.
const SUMMARY_COLS = [
  { key: 'team', label: 'Team', width: 150 },
  { key: 'full', label: 'Full', width: 50, align: 'right' },
  { key: 'half', label: 'Half', width: 50, align: 'right' },
  { key: 'ads', label: 'Ads', width: 50, align: 'right' },
  { key: 'gross', label: 'Ad revenue', width: 100, align: 'right' },
  { key: 'due', label: 'Due to GPSA', width: 116, align: 'right' },
];

// Widths are sized to the *header* labels, which never wrap — a wrapped label would
// collide with the band below it.
const TEAM_COLS = [
  { key: 'who', label: 'Advertiser / Ad', width: 154 },
  { key: 'placement', label: 'Placement', width: 66 },
  { key: 'submitted', label: 'Submitted', width: 66 },
  { key: 'status', label: 'Status', width: 60 },
  { key: 'payment', label: 'Payment', width: 60 },
  { key: 'amount', label: 'Amount', width: 54, align: 'right' },
  { key: 'share', label: 'GPSA 50%', width: 56, align: 'right' },
];

const money = (cents) => {
  const dollars = (Number(cents) || 0) / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
  });
};

const shortDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

const longDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
};

const placementLabel = (p) => (p === 'FULL_SCREEN' ? 'Full' : p === 'HALF_SCREEN' ? 'Half' : '—');
const words = (enumValue) => String(enumValue || '').replace(/_/g, ' ').toLowerCase();
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Left edge of each column, derived from the widths. */
function columnX(cols) {
  const xs = [];
  let x = MARGIN;
  for (const c of cols) {
    xs.push(x);
    x += c.width;
  }
  return xs;
}

/** The navy title band at the top of a page. Returns the y to continue at. */
function banner(doc, title, subtitle) {
  doc.rect(0, 0, PAGE.width, 78).fill(NAVY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17).text(title, MARGIN, 24, { width: CONTENT });
  if (subtitle) {
    doc.fillColor('#9fb3e0').font('Helvetica').fontSize(9).text(subtitle, MARGIN, 48, { width: CONTENT });
  }
  doc.fillColor(INK);
  return 110;
}

/**
 * The highlighted amount — the number the whole report exists to communicate. Drawn as a
 * navy-ruled box with the figure large, optionally with supporting figures beside it.
 */
function dueBox(doc, y, { label, amount, note, aside = [] }) {
  const height = 64;
  const width = aside.length ? 250 : CONTENT;
  doc.roundedRect(MARGIN, y, width, height, 6).lineWidth(2).fillAndStroke(TINT, NAVY);
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5)
    .text(label.toUpperCase(), MARGIN + 14, y + 12, { width: width - 28, characterSpacing: 0.8 });
  doc.fillColor(NAVY).font('Helvetica-Bold').fontSize(24)
    .text(amount, MARGIN + 14, y + 25, { width: width - 28 });
  if (note) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text(note, MARGIN + 14, y + 51, { width: width - 28 });
  }

  // Supporting figures sit to the right of the box, one per line.
  let ay = y + 6;
  for (const item of aside) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5)
      .text(item.label, MARGIN + width + 22, ay, { width: CONTENT - width - 130 });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9.5)
      .text(item.value, MARGIN + width + 22, ay, { width: CONTENT - width - 22, align: 'right' });
    ay += 17;
  }

  doc.lineWidth(1).fillColor(INK);
  return y + height + 22;
}

/** Table header band. Returns the y of the first data row. */
function tableHeader(doc, y, cols) {
  const xs = columnX(cols);
  doc.rect(MARGIN, y, CONTENT, 20).fill(NAVY);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5);
  cols.forEach((c, i) => {
    doc.text(c.label.toUpperCase(), xs[i] + 6, y + 6.5, {
      width: c.width - 12,
      align: c.align || 'left',
      characterSpacing: 0.5,
      lineBreak: false, // a wrapped header would spill out of the band
    });
  });
  doc.fillColor(INK);
  return y + 20;
}

/** One data row: `cells` is keyed by column, each `{ text, sub, color, bold, fill }`. */
function tableRow(doc, y, cols, cells, opts = {}) {
  const xs = columnX(cols);
  const height = opts.height || 20;
  if (opts.fill) doc.rect(MARGIN, y, CONTENT, height).fill(opts.fill);
  doc.moveTo(MARGIN, y + height).lineTo(MARGIN + CONTENT, y + height).strokeColor(LINE).lineWidth(0.5).stroke();

  cols.forEach((c, i) => {
    const cell = cells[c.key];
    if (!cell) return;
    const width = c.width - 12;
    const align = c.align || 'left';
    doc.fillColor(cell.color || INK)
      .font(cell.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(cell.size || 8.5)
      .text(String(cell.text ?? ''), xs[i] + 6, y + (cell.sub ? 4 : (height - 9) / 2), {
        width,
        align,
        lineBreak: false,
        ellipsis: true,
      });
    if (cell.sub) {
      doc.fillColor(MUTED).font('Helvetica').fontSize(7)
        .text(cell.sub, xs[i] + 6, y + 14, { width, align, lineBreak: false, ellipsis: true });
    }
  });

  doc.fillColor(INK);
  return y + height;
}

/** Totals row: ruled off above, tinted, bold. */
function totalsRow(doc, y, cols, cells) {
  doc.moveTo(MARGIN, y).lineTo(MARGIN + CONTENT, y).strokeColor(NAVY).lineWidth(1).stroke();
  const next = tableRow(doc, y, cols, cells, { fill: TINT, height: 24 });
  doc.lineWidth(1);
  return next;
}

function note(doc, y, text, color = MUTED) {
  doc.fillColor(color).font('Helvetica').fontSize(8).text(text, MARGIN, y, { width: CONTENT });
  return doc.y + 6;
}

// ---- page 1: the league summary ----

function drawSummary(doc, report) {
  const t = report.totals;
  const subtitle = [report.meet, `Generated ${longDate(report.generated_at)}`].filter(Boolean).join('  ·  ');
  let y = banner(doc, 'Scoreboard Ads — Treasurer Report', subtitle);

  y = dueBox(doc, y, {
    label: 'Total due to GPSA',
    amount: money(t.gpsa_due_cents),
    note: 'Teams remit 50% of each approved ad',
    aside: [
      { label: 'Ad revenue (all approved ads)', value: money(t.gross_cents) },
      { label: 'Billed by GPSA directly', value: money(t.gpsa_direct_cents) },
      { label: 'Advertisers not yet paid', value: `${money(t.unpaid_cents)} (${t.unpaid_count})` },
      { label: 'Approved ads', value: `${t.ad_count} — ${t.full_count} full / ${t.half_count} half` },
    ],
  });

  if (!report.teams.length) {
    note(doc, y, 'No approved or under-review ads yet.');
    return;
  }

  y = tableHeader(doc, y, SUMMARY_COLS);
  report.teams.forEach((g, i) => {
    y = tableRow(doc, y, SUMMARY_COLS, {
      team: {
        text: g.team,
        bold: true,
        sub: g.unpaid_count ? `${g.unpaid_count} unpaid · ${money(g.unpaid_cents)}` : null,
      },
      full: { text: String(g.full_count) },
      half: { text: String(g.half_count) },
      ads: { text: String(g.ad_count) },
      gross: { text: money(g.gross_cents) },
      due: g.is_gpsa
        ? { text: 'billed direct', color: MUTED, size: 7.5 }
        : { text: money(g.gpsa_due_cents), bold: true, color: NAVY },
    }, { fill: i % 2 ? ZEBRA : null, height: g.unpaid_count ? 26 : 20 });
  });

  y = totalsRow(doc, y, SUMMARY_COLS, {
    team: { text: 'All teams', bold: true },
    full: { text: String(t.full_count), bold: true },
    half: { text: String(t.half_count), bold: true },
    ads: { text: String(t.ad_count), bold: true },
    gross: { text: money(t.gross_cents), bold: true },
    due: { text: money(t.gpsa_due_cents), bold: true, color: NAVY, size: 10 },
  });

  y += 16;
  y = note(doc, y, 'Teams collect from their advertisers and remit 50% to GPSA. GPSA-affiliation ads '
    + '(check or Square invoice) are billed by GPSA directly and are not a team debt. Amounts due are '
    + 'gross — they do not change when an advertiser pays.');
  if (t.pending_count) {
    note(doc, y, `${plural(t.pending_count, 'ad is', 'ads are')} still under review `
      + `(${money(t.pending_cents)}) and not counted above. They are listed on each team's page.`, AMBER);
  }
}

// ---- one page per team ----

function drawTeamPage(doc, report, g) {
  const subtitle = [report.meet, 'Treasurer Report', longDate(report.generated_at)]
    .filter(Boolean).join('  ·  ');
  let y = banner(doc, g.team, subtitle);

  y = g.is_gpsa
    ? dueBox(doc, y, {
      label: 'Billed by GPSA',
      amount: money(g.gross_cents),
      note: 'Paid to GPSA directly — not a team debt',
      aside: [
        { label: 'Approved ads', value: `${g.ad_count} — ${g.full_count} full / ${g.half_count} half` },
        { label: 'Advertisers not yet paid', value: `${money(g.unpaid_cents)} (${g.unpaid_count})` },
      ],
    })
    : dueBox(doc, y, {
      label: 'Due to GPSA',
      amount: money(g.gpsa_due_cents),
      note: '50% of this team’s approved ads',
      aside: [
        { label: 'Ad revenue (collected by the team)', value: money(g.gross_cents) },
        { label: 'Team keeps', value: money(g.team_keeps_cents) },
        { label: 'Advertisers not yet paid', value: `${money(g.unpaid_cents)} (${g.unpaid_count})` },
        { label: 'Approved ads', value: `${g.ad_count} — ${g.full_count} full / ${g.half_count} half` },
      ],
    });

  y = tableHeader(doc, y, TEAM_COLS);
  g.ads.forEach((a, i) => {
    // A long team could overflow a page — carry the table onto the next one.
    if (y + 26 > BOTTOM) {
      doc.addPage();
      y = banner(doc, `${g.team} (continued)`, subtitle);
      y = tableHeader(doc, y, TEAM_COLS);
    }
    const isPending = a.status !== 'APPROVED';
    y = tableRow(doc, y, TEAM_COLS, {
      who: { text: a.company_name || '—', bold: true, sub: a.ad_title || null },
      placement: { text: placementLabel(a.placement) },
      submitted: { text: shortDate(a.submitted_at), color: MUTED },
      status: { text: words(a.status), color: isPending ? AMBER : INK, size: 7.5 },
      payment: { text: words(a.payment_status) || '—', sub: words(a.payment_method) || null, size: 7.5 },
      amount: { text: money(a.amount_cents), color: isPending ? MUTED : INK },
      share: isPending || g.is_gpsa
        ? { text: '—', color: MUTED }
        : { text: money(a.gpsa_due_cents), bold: true, color: NAVY },
    }, { fill: i % 2 ? ZEBRA : null, height: 26 });
  });

  if (!g.ads.length) {
    y = note(doc, y + 8, 'No ads for this team.');
  }

  y = totalsRow(doc, y, TEAM_COLS, {
    // Keep this label short — the column is 154pt wide and a wrapped label breaks the row.
    who: { text: 'Approved total', bold: true },
    amount: { text: money(g.gross_cents), bold: true },
    share: g.is_gpsa
      ? { text: '—', color: MUTED }
      : { text: money(g.gpsa_due_cents), bold: true, color: NAVY, size: 10 },
  });

  y += 14;
  if (g.pending_count) {
    y = note(doc, y, `${plural(g.pending_count, 'ad is', 'ads are')} still under review `
      + `(${money(g.pending_cents)}). Under-review ads are listed above but are not billed `
      + 'until they are approved.', AMBER);
  }
  note(doc, y, g.is_gpsa
    ? 'These ads are billed to the advertiser by GPSA directly (check or Square invoice). '
      + 'No team remits anything for them.'
    : `Please remit ${money(g.gpsa_due_cents)} to GPSA. Amounts are gross — the total due does `
      + 'not change when an advertiser pays the team.');
}

/** Page N of M, stamped after all pages exist. */
function stampFooters(doc, report) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);
    // The footer sits inside the bottom margin; without this pdfkit treats it as overflow
    // and helpfully appends a blank page for it.
    doc.page.margins.bottom = 0;
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5)
      .text(
        `GPSA Scoreboard Ads · Treasurer report · generated ${longDate(report.generated_at)}`,
        MARGIN,
        PAGE.height - MARGIN + 4,
        { width: CONTENT },
      )
      .text(`Page ${i + 1} of ${range.count}`, MARGIN, PAGE.height - MARGIN + 4, {
        width: CONTENT,
        align: 'right',
      });
  }
}

/** Render the report object (from `reports/treasurer.js`) to a PDF buffer. */
export function renderTreasurerPdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: MARGIN,
      bufferPages: true, // needed to stamp "Page N of M" once the count is known
      info: {
        Title: `GPSA Scoreboard Ads — Treasurer report${report.meet ? ` (${report.meet})` : ''}`,
        Author: 'GPSA Scoreboard Ads',
      },
    });

    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    drawSummary(doc, report);
    for (const g of report.teams) {
      doc.addPage();
      drawTeamPage(doc, report, g);
    }
    stampFooters(doc, report);

    doc.end();
  });
}

/** `gpsa-treasurer-report-2026-07-29.pdf` — sortable, obvious in a downloads folder. */
export function treasurerPdfFilename(report) {
  return `gpsa-treasurer-report-${String(report.generated_at).slice(0, 10)}.pdf`;
}
