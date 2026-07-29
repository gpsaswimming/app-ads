// GPSA Scoreboard Ads — admin dashboard (docs/TODO.md #1).
// Talks ONLY to the same-origin /admin-api/* backend (proxied by this container's nginx to
// the Ads API). Holds zero credentials; the VPN boundary is the trust boundary. All
// submitter/company text is rendered via textContent/escapeHtml — never innerHTML with raw
// user input (DESIGN.md §3 inv 10).
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  // ---- toast (same contract as the public form: #toast-container + .toast classes) ----
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  function showToast(message, type = 'info', duration = 4000) {
    const container = $('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icons = { success: '✓', error: '✕', warning: '⚠', info: 'ℹ' };
    toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${icons[type] || icons.info}</span>`
      + `<span class="toast-message">${escapeHtml(message)}</span>`
      + '<button class="toast-close" aria-label="Close notification">×</button>';
    container.appendChild(toast);
    const remove = () => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 300); };
    toast.querySelector('.toast-close').addEventListener('click', remove);
    if (duration > 0) setTimeout(remove, duration);
  }

  // ---- helpers ----
  const money = (cents) => {
    const n = Number(cents);
    if (!Number.isFinite(n)) return '—';
    const d = n / 100;
    return Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`;
  };
  const when = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const contactName = (ad) => (ad.submitter_is_advertiser ? ad.submitter_name : ad.advertiser_name) || ad.submitter_name;

  const placement = (p) => (p === 'FULL_SCREEN' ? 'Full' : p === 'HALF_SCREEN' ? 'Half' : (p || '—'));

  // ---- state ----
  const FILTERS = [
    { key: 'all', label: 'All', match: () => true },
    { key: 'NEEDS_REVIEW', label: 'Needs review', match: (s) => s === 'NEEDS_REVIEW' },
    { key: 'APPROVED', label: 'Approved', match: (s) => s === 'APPROVED' },
    { key: 'REJECTED', label: 'Rejected', match: (s) => s === 'REJECTED' },
    { key: 'open', label: 'Awaiting upload', match: (s) => ['AWAITING_UPLOAD', 'UPLOADED', 'VALIDATING'].includes(s) },
  ];
  let ads = [];
  let adsLoaded = false;
  let report = null; // treasurer payload, fetched lazily
  let active = 'all';
  let current = null; // ad shown in the drawer

  function byNewest(a, b) {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return tb - ta;
  }

  // ---- data ----
  async function load() {
    try {
      const res = await fetch('/admin-api/ads', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      ads = (data.ads || []).slice().sort(byNewest);
      adsLoaded = true;
      render();
    } catch (err) {
      showToast(`Couldn't load submissions: ${err.message}`, 'error', 8000);
    }
  }

  /** Fetch the treasurer report. The API owns the split rule — nothing here recomputes money. */
  async function loadReport() {
    try {
      const res = await fetch('/admin-api/treasurer', { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      report = await res.json();
      return true;
    } catch (err) {
      showToast(`Couldn't load the treasurer report: ${err.message}`, 'error', 8000);
      return false;
    }
  }

  async function act(ad, action, body) {
    const res = await fetch(`/admin-api/ads/${encodeURIComponent(ad.ad_id)}/${action}`, {
      method: 'POST',
      // Only declare a JSON content-type when we actually send a body — a bare POST
      // (approve) with no body must not claim application/json.
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    // An approve/deny changes what a team owes — drop the cached report so the treasurer
    // screens refetch instead of showing pre-decision money.
    report = null;
    // Splice the updated ad back into local state.
    const i = ads.findIndex((a) => a.ad_id === ad.ad_id);
    if (i >= 0 && data.ad) ads[i] = data.ad;
    return data.ad;
  }

  async function approve(ad) {
    if (!confirm(`Approve “${ad.ad_title}” for the scoreboard?`)) return;
    try {
      await act(ad, 'approve');
      showToast('Approved — artwork moved to the approved set.', 'success');
      closeDrawer();
      render();
    } catch (err) {
      const msg = err.message === 'NO_ARTWORK' ? 'No artwork uploaded yet — nothing to approve.'
        : `Approve failed: ${err.message}`;
      showToast(msg, 'error', 8000);
    }
  }

  async function deny(ad) {
    const reason = prompt('Reason for denying (shown to the submitter):', ad.validation_notes || '');
    if (reason === null) return; // cancelled
    try {
      await act(ad, 'deny', { reason: reason.trim() });
      showToast('Denied — submitter notified.', 'success');
      closeDrawer();
      render();
    } catch (err) {
      showToast(`Deny failed: ${err.message}`, 'error', 8000);
    }
  }

  // ---- render ----
  function renderFilters() {
    const el = $('filters');
    el.textContent = '';
    for (const f of FILTERS) {
      const n = ads.filter((a) => f.match(a.status)).length;
      const b = document.createElement('button');
      b.className = `chip${active === f.key ? ' on' : ''}`;
      b.innerHTML = `${escapeHtml(f.label)}<span class="n">${n}</span>`;
      b.addEventListener('click', () => { active = f.key; render(); });
      el.appendChild(b);
    }
  }

  function statusBadge(status) {
    const span = document.createElement('span');
    span.className = `badge b-${status}`;
    span.textContent = String(status || '').replace(/_/g, ' ').toLowerCase();
    return span;
  }

  function actionButton(label, cls, onClick) {
    const b = document.createElement('button');
    b.className = `btn ${cls}`;
    b.textContent = label;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function render() {
    renderFilters();
    const flt = FILTERS.find((f) => f.key === active) || FILTERS[0];
    const rows = ads.filter((a) => flt.match(a.status));
    const tbody = $('rows');
    tbody.textContent = '';

    for (const ad of rows) {
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => openDrawer(ad));

      const co = document.createElement('td');
      co.className = 'company';
      const coName = document.createElement('div'); coName.className = 'co'; coName.textContent = ad.company_name || '—';
      const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = ad.ad_title || '';
      co.append(coName, sub);

      const team = document.createElement('td'); team.textContent = ad.team || '—';
      const place = document.createElement('td');
      place.textContent = ad.placement === 'FULL_SCREEN' ? 'Full' : ad.placement === 'HALF_SCREEN' ? 'Half' : (ad.placement || '—');
      const amt = document.createElement('td'); amt.textContent = money(ad.payment_amount);

      const pay = document.createElement('td');
      pay.className = `pay-${ad.payment_status}`;
      pay.textContent = (ad.payment_status || '').toLowerCase() || '—';

      const st = document.createElement('td'); st.appendChild(statusBadge(ad.status));

      const actions = document.createElement('td');
      actions.className = 'actions';
      if (ad.status === 'NEEDS_REVIEW') {
        actions.append(
          actionButton('Deny', 'btn-deny', () => deny(ad)),
          actionButton('Approve', 'btn-approve', () => approve(ad)),
        );
      } else {
        actions.append(actionButton('View', 'btn-ghost', () => openDrawer(ad)));
      }

      tr.append(co, team, place, amt, pay, st, actions);
      tbody.appendChild(tr);
    }

    $('empty').hidden = rows.length > 0;
  }

  // ---- drawer ----
  function detailRow(dl, label, value) {
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value || '—';
    dl.append(dt, dd);
  }

  function openDrawer(ad) {
    current = ad;
    $('d-title').textContent = ad.ad_title || ad.company_name || 'Ad';

    // Artwork preview — the API streams the object bytes (no public read path exists).
    const prev = $('d-preview');
    prev.textContent = '';
    if (ad.has_artwork) {
      const img = document.createElement('img');
      img.alt = ad.ad_title || 'Ad artwork';
      img.src = `/admin-api/ads/${encodeURIComponent(ad.ad_id)}/artwork?t=${Date.now()}`;
      img.onerror = () => { prev.innerHTML = '<div class="none">Artwork could not be loaded.</div>'; };
      prev.appendChild(img);
    } else {
      prev.innerHTML = '<div class="none">No artwork uploaded yet.</div>';
    }

    const dl = $('d-detail');
    dl.textContent = '';
    detailRow(dl, 'Status', String(ad.status || '').replace(/_/g, ' '));
    detailRow(dl, 'Company', ad.company_name);
    detailRow(dl, 'Team', ad.team);
    detailRow(dl, 'Placement', ad.placement === 'FULL_SCREEN' ? 'Full-screen (9:4)' : ad.placement === 'HALF_SCREEN' ? 'Half-screen (9:8)' : ad.placement);
    detailRow(dl, 'Amount', money(ad.payment_amount));
    detailRow(dl, 'Payment', `${(ad.payment_method || '').replace(/_/g, ' ')} · ${(ad.payment_status || '').toLowerCase()}`);
    detailRow(dl, 'Submitter', `${contactName(ad)} · ${ad.submitter_email}${ad.submitter_phone ? ' · ' + ad.submitter_phone : ''}`);
    if (!ad.submitter_is_advertiser && ad.advertiser_email) {
      detailRow(dl, 'Advertiser', `${ad.advertiser_name} · ${ad.advertiser_email}`);
    }
    if (ad.artwork_width && ad.artwork_height) {
      detailRow(dl, 'Dimensions', `${ad.artwork_width} × ${ad.artwork_height}`);
    }
    detailRow(dl, 'File', ad.artwork_filename);
    detailRow(dl, 'Ad ID', ad.ad_id);

    const notes = $('d-notes');
    if (ad.validation_notes) { notes.hidden = false; notes.textContent = ad.validation_notes; }
    else { notes.hidden = true; notes.textContent = ''; }

    $('scrim').classList.add('open');
  }

  function closeDrawer() {
    $('scrim').classList.remove('open');
    current = null;
  }

  // ---- treasurer report ----
  // Two screens off one payload: the per-team summary and a team's own page. Team names
  // come from the API's enum, but they still go in via textContent like everything else.

  function kpi(label, value, opts = {}) {
    const box = document.createElement('div');
    box.className = `kpi${opts.highlight ? ' due' : ''}`;
    const k = document.createElement('div'); k.className = 'k'; k.textContent = label;
    const v = document.createElement('div'); v.className = 'v'; v.textContent = value;
    box.append(k, v);
    if (opts.note) {
      const n = document.createElement('div'); n.className = 'note'; n.textContent = opts.note;
      box.appendChild(n);
    }
    return box;
  }

  function numCell(text, cls) {
    const td = document.createElement('td');
    td.className = cls ? `num ${cls}` : 'num';
    td.textContent = text;
    return td;
  }

  function renderTreasurer() {
    if (!report) return;
    const t = report.totals;

    $('t-sub').textContent = [
      report.meet,
      `${t.team_count} team${t.team_count === 1 ? '' : 's'}`,
      `as of ${when(report.generated_at) || 'today'}`,
    ].filter(Boolean).join(' · ');

    const kpis = $('t-kpis');
    kpis.textContent = '';
    kpis.append(
      kpi('Total due to GPSA', money(t.gpsa_due_cents), { highlight: true, note: '50% of approved team ads' }),
      kpi('Ad revenue', money(t.gross_cents), { note: `${t.ad_count} approved · ${t.full_count} full / ${t.half_count} half` }),
      kpi('Billed by GPSA directly', money(t.gpsa_direct_cents), { note: 'GPSA-affiliation ads' }),
      kpi('Advertisers unpaid', money(t.unpaid_cents), { note: `${t.unpaid_count} ad${t.unpaid_count === 1 ? '' : 's'} outstanding` }),
    );
    if (t.pending_count) {
      kpis.appendChild(kpi('Under review', money(t.pending_cents), {
        note: `${t.pending_count} ad${t.pending_count === 1 ? '' : 's'} not yet counted`,
      }));
    }

    const tbody = $('t-rows');
    tbody.textContent = '';
    for (const g of report.teams) {
      const tr = document.createElement('tr');
      tr.className = 'team-row';
      tr.addEventListener('click', () => { location.hash = `#/treasurer/${encodeURIComponent(g.team)}`; });

      const name = document.createElement('td');
      name.className = 'team-name';
      name.textContent = g.team;
      if (g.unpaid_count) {
        const chase = document.createElement('span');
        chase.className = 'chase';
        chase.textContent = `${g.unpaid_count} unpaid · ${money(g.unpaid_cents)}`;
        name.appendChild(chase);
      }

      const due = g.is_gpsa
        ? numCell('—')
        : numCell(money(g.gpsa_due_cents), 'due-cell');
      if (g.is_gpsa) due.title = 'Collected by GPSA directly — not a team debt';

      const more = document.createElement('td');
      more.className = 'muted';
      more.textContent = g.pending_count ? `${g.pending_count} under review →` : '→';

      tr.append(
        name,
        numCell(String(g.full_count)),
        numCell(String(g.half_count)),
        numCell(String(g.ad_count)),
        numCell(money(g.gross_cents)),
        due,
        more,
      );
      tbody.appendChild(tr);
    }

    const foot = $('t-foot');
    foot.textContent = '';
    if (report.teams.length) {
      const tr = document.createElement('tr');
      const label = document.createElement('td'); label.textContent = 'All teams';
      tr.append(
        label,
        numCell(String(t.full_count)),
        numCell(String(t.half_count)),
        numCell(String(t.ad_count)),
        numCell(money(t.gross_cents)),
        numCell(money(t.gpsa_due_cents), 'due-cell'),
        document.createElement('td'),
      );
      foot.appendChild(tr);
    }
    $('t-empty').hidden = report.teams.length > 0;
  }

  function renderTeamPage(team) {
    if (!report) return;
    const g = report.teams.find((x) => x.team === team);
    if (!g) {
      showToast(`No report rows for ${team}.`, 'info');
      location.hash = '#/treasurer';
      return;
    }

    $('tm-title').textContent = g.team;
    $('tm-sub').textContent = [
      report.meet,
      `${g.ad_count} approved ad${g.ad_count === 1 ? '' : 's'} · ${g.full_count} full / ${g.half_count} half`,
      g.pending_count ? `${g.pending_count} under review` : '',
    ].filter(Boolean).join(' · ');

    const kpis = $('tm-kpis');
    kpis.textContent = '';
    if (g.is_gpsa) {
      kpis.append(
        kpi('Billed by GPSA', money(g.gross_cents), { highlight: true, note: 'Paid to GPSA directly' }),
        kpi('Unpaid', money(g.unpaid_cents), { note: `${g.unpaid_count} ad${g.unpaid_count === 1 ? '' : 's'} outstanding` }),
      );
    } else {
      kpis.append(
        kpi('Due to GPSA', money(g.gpsa_due_cents), { highlight: true, note: '50% of approved ads' }),
        kpi('Ad revenue', money(g.gross_cents), { note: 'Collected by the team' }),
        kpi('Team keeps', money(g.team_keeps_cents), { note: 'The other 50%' }),
        kpi('Advertisers unpaid', money(g.unpaid_cents), { note: `${g.unpaid_count} ad${g.unpaid_count === 1 ? '' : 's'} outstanding` }),
      );
    }

    const tbody = $('tm-rows');
    tbody.textContent = '';
    for (const a of g.ads) {
      const tr = document.createElement('tr');
      const pendingRow = a.status !== 'APPROVED';

      const who = document.createElement('td');
      who.className = 'company';
      const co = document.createElement('div'); co.className = 'co'; co.textContent = a.company_name || '—';
      const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = a.ad_title || '';
      who.append(co, sub);

      const place = document.createElement('td'); place.textContent = placement(a.placement);
      const date = document.createElement('td'); date.className = 'muted'; date.textContent = when(a.submitted_at) || '—';
      const st = document.createElement('td'); st.appendChild(statusBadge(a.status));

      const pay = document.createElement('td');
      pay.className = `pay-${a.payment_status}`;
      pay.textContent = `${(a.payment_method || '').replace(/_/g, ' ').toLowerCase()} · ${(a.payment_status || '').toLowerCase()}`.trim();

      // An under-review ad shows its rate but contributes nothing until it is approved.
      const amount = numCell(money(a.amount_cents), pendingRow ? 'muted' : '');
      const share = g.is_gpsa || pendingRow ? numCell('—', 'muted') : numCell(money(a.gpsa_due_cents), 'due-cell');

      tr.append(who, place, date, st, pay, amount, share);
      tbody.appendChild(tr);
    }

    const foot = $('tm-foot');
    foot.textContent = '';
    if (g.ads.length) {
      const tr = document.createElement('tr');
      const label = document.createElement('td');
      label.colSpan = 5;
      label.textContent = g.is_gpsa ? 'Approved total (paid to GPSA directly)' : 'Approved total · due to GPSA';
      tr.append(
        label,
        numCell(money(g.gross_cents)),
        g.is_gpsa ? numCell('—') : numCell(money(g.gpsa_due_cents), 'due-cell'),
      );
      foot.appendChild(tr);
    }
    $('tm-empty').hidden = g.ads.length > 0;
  }

  // ---- routing ----
  // #/ → submissions · #/treasurer → summary · #/treasurer/<team> → that team's page.
  const PAGES = ['page-ads', 'page-treasurer', 'page-team'];

  function showPage(id) {
    PAGES.forEach((p) => $(p).classList.toggle('hidden', p !== id));
    $('tab-ads').classList.toggle('on', id === 'page-ads');
    $('tab-treasurer').classList.toggle('on', id !== 'page-ads');
    window.scrollTo(0, 0);
  }

  async function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

    if (parts[0] !== 'treasurer') {
      showPage('page-ads');
      if (!adsLoaded) await load();
      return;
    }

    if (!report && !(await loadReport())) return;
    if (parts[1]) {
      showPage('page-team');
      renderTeamPage(decodeURIComponent(parts[1]));
    } else {
      showPage('page-treasurer');
      renderTreasurer();
    }
  }

  async function refreshReport() {
    if (await loadReport()) route();
  }

  // ---- wire up ----
  $('refresh').addEventListener('click', load);
  $('d-close').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', (e) => { if (e.target === $('scrim')) closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('d-approve').addEventListener('click', () => current && approve(current));
  $('d-deny').addEventListener('click', () => current && deny(current));

  $('t-refresh').addEventListener('click', refreshReport);
  $('t-print').addEventListener('click', () => window.print());
  $('tm-print').addEventListener('click', () => window.print());
  $('tm-back').addEventListener('click', () => { location.hash = '#/treasurer'; });
  window.addEventListener('hashchange', route);

  route();
})();
