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
  // Payment is tracked for LEAGUE ads only — those are invoiced by GPSA (check / Square).
  // A team-affiliation ad is collected by the team from its advertiser; GPSA never sees
  // that transaction, so there is no status to keep and none is shown.
  const isLeagueAd = (ad) => ad.team === 'GPSA';

  // ---- state ----
  const FILTERS = [
    { key: 'all', label: 'All', match: () => true },
    { key: 'NEEDS_REVIEW', label: 'Needs review', match: (s) => s === 'NEEDS_REVIEW' },
    { key: 'APPROVED', label: 'Approved', match: (s) => s === 'APPROVED' },
    { key: 'REJECTED', label: 'Rejected', match: (s) => s === 'REJECTED' },
    { key: 'open', label: 'Awaiting upload', match: (s) => ['AWAITING_UPLOAD', 'UPLOADED', 'VALIDATING'].includes(s) },
  ];
  let ads = [];
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
      render();
    } catch (err) {
      showToast(`Couldn't load submissions: ${err.message}`, 'error', 8000);
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

  async function setPayment(ad, paymentStatus) {
    try {
      await act(ad, 'payment', { payment_status: paymentStatus });
      showToast(`Invoice marked ${paymentStatus.toLowerCase()}.`, 'success');
      if (current && current.ad_id === ad.ad_id) openDrawer(ads.find((a) => a.ad_id === ad.ad_id));
      render();
    } catch (err) {
      const msg = err.message === 'PAY_TEAM_NOT_TRACKED'
        ? 'This ad is collected by the team — GPSA does not track its payment.'
        : `Couldn't update payment: ${err.message}`;
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

  /** Artwork export: label it with what's in it, and switch it off when nothing is approved. */
  function renderExport() {
    const n = ads.filter((a) => a.status === 'APPROVED' && a.has_artwork).length;
    const a = $('export');
    a.textContent = n ? `⤓ Approved artwork (${n})` : '⤓ Approved artwork';
    a.classList.toggle('off', n === 0);
    a.setAttribute('aria-disabled', n === 0 ? 'true' : 'false');
  }

  function render() {
    renderFilters();
    renderExport();
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
      if (isLeagueAd(ad)) {
        pay.className = `pay-${ad.payment_status}`;
        pay.textContent = (ad.payment_status || '').toLowerCase() || '—';
      } else {
        pay.className = 'muted';
        pay.textContent = 'team collects';
      }

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

  /** Invoice status as a set of pills — the current one is on, the others set it. */
  function paymentRow(dl, ad) {
    const dt = document.createElement('dt'); dt.textContent = 'Invoice';
    const dd = document.createElement('dd');
    const group = document.createElement('div');
    group.className = 'pay-picker';
    for (const [value, label] of [['PENDING', 'Pending'], ['PAID', 'Paid'], ['WAIVED', 'Waived']]) {
      const b = document.createElement('button');
      const on = (ad.payment_status || 'PENDING') === value;
      b.type = 'button';
      b.className = `pill p-${value}${on ? ' on' : ''}`;
      b.textContent = label;
      b.disabled = on;
      b.addEventListener('click', () => setPayment(ad, value));
      group.appendChild(b);
    }
    dd.appendChild(group);
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
    if (isLeagueAd(ad)) {
      // GPSA invoiced this one, so GPSA records whether it has been settled — click to set.
      detailRow(dl, 'Billed by', (ad.payment_method || '').replace(/_/g, ' ').toLowerCase());
      paymentRow(dl, ad);
    } else {
      detailRow(dl, 'Payment', `the ${ad.team} team collects from its advertiser`);
    }
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

  // ---- wire up ----
  $('refresh').addEventListener('click', load);
  $('d-close').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', (e) => { if (e.target === $('scrim')) closeDrawer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  $('d-approve').addEventListener('click', () => current && approve(current));
  $('d-deny').addEventListener('click', () => current && deny(current));

  load();
})();
