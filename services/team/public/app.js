/* Team-facing scoreboard-ads status list (DESIGN.md §12). Read-only.
 *
 * No app auth and no per-team scoping — like the admin tool, you land on the page and get
 * the list. It calls the same-origin, same-host team API:
 *   GET /api/team/ads[?include_rejected=true]   → every ad's status, newest first
 *
 * Invariants honored here: all ad text is rendered with textContent (never innerHTML);
 * the page holds no secrets and makes no cross-origin calls.
 */
(function () {
  'use strict';

  const CONFIG = window.GPSA_TEAM_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  const STATUS_LABEL = { APPROVED: 'Approved', NEEDS_REVIEW: 'Under review', REJECTED: 'Rejected' };

  // ---- toasts (shared pattern with the submission form) ----
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
      + `<button class="toast-close" aria-label="Close notification">×</button>`;
    container.appendChild(toast);
    const remove = () => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 300); };
    toast.querySelector('.toast-close').addEventListener('click', remove);
    if (duration > 0) setTimeout(remove, duration);
  }

  // ---- view switching ----
  const VIEWS = ['loading', 'list', 'empty', 'error'];
  function setView(id) {
    VIEWS.forEach((v) => {
      const el = $('view-' + v);
      if (el) el.classList.toggle('hidden', v !== id);
    });
    // Toolbar belongs to the data views only.
    $('toolbar').hidden = !(id === 'list' || id === 'empty');
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ---- data loading ----
  async function loadAds() {
    setView('loading');
    const includeRejected = $('toggle-rejected').checked;
    const url = '/api/team/ads' + (includeRejected ? '?include_rejected=true' : '');

    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch {
      return setView('error');
    }
    if (!res.ok) return setView('error');

    const data = await res.json().catch(() => ({}));
    renderAds(Array.isArray(data.ads) ? data.ads : []);
  }

  // ---- rendering ----
  function renderAds(ads) {
    if (ads.length === 0) {
      $('empty-link').href = CONFIG.adsFormUrl || '#';
      setView('empty');
      return;
    }

    const counts = { APPROVED: 0, NEEDS_REVIEW: 0, REJECTED: 0 };
    ads.forEach((a) => { if (counts[a.status] !== undefined) counts[a.status]++; });
    const bits = [];
    if (counts.APPROVED) bits.push(`${counts.APPROVED} approved`);
    if (counts.NEEDS_REVIEW) bits.push(`${counts.NEEDS_REVIEW} under review`);
    if (counts.REJECTED) bits.push(`${counts.REJECTED} rejected`);
    // Summary is built from our own enum counts + fixed text — no ad data interpolated.
    $('summary').textContent = `${ads.length} ad${ads.length === 1 ? '' : 's'}`
      + (bits.length ? ` · ${bits.join(' · ')}` : '');

    const tbody = $('rows');
    tbody.innerHTML = '';
    ads.forEach((a) => tbody.appendChild(rowFor(a)));
    setView('list');
  }

  // Build a table row with textContent throughout (invariant: never innerHTML for ad data).
  function rowFor(a) {
    const tr = document.createElement('tr');

    const teamTd = cell(a.team || '—');
    teamTd.dataset.label = 'Team';
    teamTd.classList.add('nowrap');
    tr.appendChild(teamTd);

    const titleTd = document.createElement('td');
    titleTd.className = 'title';
    titleTd.dataset.label = 'Ad';
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = a.ad_title || '(untitled)';
    titleTd.appendChild(t);
    if (a.status === 'REJECTED' && a.reason) {
      const r = document.createElement('div');
      r.className = 'reason';
      r.textContent = a.reason;
      titleTd.appendChild(r);
    }
    tr.appendChild(titleTd);

    const advTd = cell(a.advertiser || '—');
    advTd.dataset.label = 'Advertiser';
    tr.appendChild(advTd);

    const placeTd = cell(a.placement === 'FULL_SCREEN' ? 'Full' : a.placement === 'HALF_SCREEN' ? 'Half' : '—');
    placeTd.dataset.label = 'Placement';
    placeTd.classList.add('nowrap');
    tr.appendChild(placeTd);

    const dateTd = cell(formatDate(a.submitted_at));
    dateTd.dataset.label = 'Submitted';
    dateTd.classList.add('nowrap', 'muted');
    tr.appendChild(dateTd);

    const statusTd = document.createElement('td');
    statusTd.dataset.label = 'Status';
    const badge = document.createElement('span');
    badge.className = `badge b-${a.status}`;
    badge.textContent = STATUS_LABEL[a.status] || a.status || '—';
    statusTd.appendChild(badge);
    tr.appendChild(statusTd);

    return tr;
  }

  function cell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  // ---- init ----
  function init() {
    $('toggle-rejected').addEventListener('change', loadAds);
    $('refresh').addEventListener('click', loadAds);
    $('retry').addEventListener('click', loadAds);
    loadAds();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
