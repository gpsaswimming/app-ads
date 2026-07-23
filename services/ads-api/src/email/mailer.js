// Email via nodemailer + Eta templates (DESIGN.md §9). Templates use `<%= %>` which
// Eta auto-escapes (invariant 10) — never `<%~ %>` or string concatenation of user
// text. One outcome email per submission (approved/rejected/needs-review) to the
// submitter, plus a one-line internal notification on every outcome.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Eta } from 'eta';
import nodemailer from 'nodemailer';

import { PLACEMENT_SPECS } from '../constants.js';
import { formatMoney } from '../util.js';

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), 'templates');

/** Human payment instruction line for the APPROVED email (DESIGN.md §9). */
export function paymentInstructions(method, amount, team, checkAddress) {
  switch (method) {
    case 'PAY_TEAM':
      return `Please pay your team (${team}) directly — ${amount}.`;
    case 'CHECK':
      return `Mail a ${amount} check to GPSA at ${checkAddress}.`;
    case 'SQUARE_INVOICE':
      return `GPSA will email you a Square invoice for ${amount}.`;
    default:
      return `Amount due: ${amount}.`;
  }
}

export function createMailer({ smtpUrl, from, notifyEmail, checkAddress, transport }) {
  // These are text/plain emails, so HTML auto-escaping is wrong — it turns quotes/&/<
  // in names and titles into &quot; etc. in the visible body. Plain text has no markup
  // to escape, and header injection is handled by nodemailer. autoTrim:false preserves
  // the templates' line breaks.
  const eta = new Eta({ views: templatesDir, autoEscape: false, autoTrim: false, cache: true });
  // `transport` injectable for tests; otherwise build from the SMTP URL.
  const tx = transport || nodemailer.createTransport(smtpUrl);

  function placementLabel(placement) {
    return PLACEMENT_SPECS[placement]?.label || placement;
  }

  // refId → an X-Entity-Ref-ID header, which tells Gmail to treat each message as its
  // own conversation instead of threading a run of same-subject emails together.
  async function send({ to, subject, text, refId }) {
    return tx.sendMail({
      from,
      to,
      subject,
      text,
      ...(refId ? { headers: { 'X-Entity-Ref-ID': refId } } : {}),
    });
  }

  return {
    /** Outcome email to the submitter, chosen by the row's final Status. */
    async sendOutcome(row) {
      const amount = formatMoney(row.Payment_Amount);
      const label = placementLabel(row.Placement);
      const common = { name: row.Submitter_Name, adTitle: row.Ad_Title, adId: row.Ad_ID, placementLabel: label };

      if (row.Status === 'APPROVED') {
        const text = eta.render('approved', {
          ...common,
          amount,
          paymentInstructions: paymentInstructions(row.Payment_Method, amount, row.Team, checkAddress),
        });
        return send({ to: row.Submitter_Email, subject: 'Your GPSA scoreboard ad — approved', text, refId: row.Ad_ID });
      }
      if (row.Status === 'REJECTED') {
        const text = eta.render('rejected', { ...common, reason: row.Validation_Notes || 'artwork did not meet the specification' });
        return send({ to: row.Submitter_Email, subject: 'Your GPSA scoreboard ad — could not be accepted', text, refId: row.Ad_ID });
      }
      // NEEDS_REVIEW
      const text = eta.render('needs-review', common);
      return send({ to: row.Submitter_Email, subject: 'Your GPSA scoreboard ad — received', text, refId: row.Ad_ID });
    },

    /** Internal notification to the ad chair (DESIGN.md §9). `aiSummary` (when the AI
     *  ran) gives the reviewer richer context; it is NOT sent to the submitter. */
    async sendInternal(row, { aiSummary = '' } = {}) {
      // Plain text, built directly so the layout is predictable. `aiSummary` (present
      // only when the AI ran) gives the reviewer richer context and never goes to the
      // submitter.
      const lines = [
        `New scoreboard ad submission — ${row.Status}`,
        '',
        `  Submitter: ${row.Submitter_Name} <${row.Submitter_Email}>`,
        `  Company:   ${row.Company_Name}`,
        `  Ad title:  ${row.Ad_Title}`,
        `  Team:      ${row.Team}`,
        `  Placement: ${placementLabel(row.Placement)}`,
        `  Amount:    ${formatMoney(row.Payment_Amount)}`,
        `  Payment:   ${row.Payment_Method}`,
        `  Ad ID:     ${row.Ad_ID}`,
      ];
      if (row.Validation_Notes) lines.push(`  Notes:     ${row.Validation_Notes}`);
      if (aiSummary) lines.push('', 'AI review:', `  ${aiSummary}`);
      // Unique per submission (company + title + status) so each is its own thread, and
      // refId adds the belt-and-suspenders X-Entity-Ref-ID header.
      const subject = `[GPSA Ads] ${row.Company_Name}: ${row.Ad_Title} — ${row.Status}`;
      return send({ to: notifyEmail, subject, text: `${lines.join('\n')}\n`, refId: row.Ad_ID });
    },
  };
}
