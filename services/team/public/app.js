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

    // Group by team for readability — a team subheading, then that team's ads (newest first,
    // preserved from the API order). Teams are listed alphabetically.
    const groups = new Map();
    ads.forEach((a) => {
      const key = a.team || '—';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    });

    const tbody = $('rows');
    tbody.innerHTML = '';
    [...groups.keys()].sort((x, y) => x.localeCompare(y)).forEach((team) => {
      const rows = groups.get(team);
      tbody.appendChild(groupHeader(team, rows.length));
      rows.forEach((a) => tbody.appendChild(rowFor(a)));
    });
    setView('list');
  }

  // A full-width team subheading row.
  function groupHeader(team, n) {
    const tr = document.createElement('tr');
    tr.className = 'group';
    const td = document.createElement('td');
    td.colSpan = 5;
    const label = document.createElement('span');
    label.textContent = team; // textContent — team is enum-ish, escaped structurally
    const count = document.createElement('span');
    count.className = 'n';
    count.textContent = String(n);
    td.appendChild(label);
    td.appendChild(count);
    tr.appendChild(td);
    return tr;
  }

  // Build a table row with textContent throughout (invariant: never innerHTML for ad data).
  // Team is the group subheading, not a per-row cell.
  function rowFor(a) {
    const tr = document.createElement('tr');

    const titleTd = document.createElement('td');
    titleTd.className = 'title';
    titleTd.dataset.label = 'Ad';
    // If there's artwork, the title opens it in a lightbox; otherwise it's plain text.
    let t;
    if (a.has_artwork && a.ad_id) {
      t = document.createElement('button');
      t.type = 'button';
      t.className = 't linklike';
      t.title = 'View ad artwork';
      t.addEventListener('click', () => openArtwork(a));
    } else {
      t = document.createElement('div');
      t.className = 't';
    }
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

  // ---- artwork lightbox ----
  // The image is streamed by the API (bucket stays private), reached same-origin via the
  // team front's /api/team/* proxy.
  function openArtwork(a) {
    const img = $('lightbox-img');
    img.onerror = () => { closeLightbox(); showToast('Could not load that ad image.', 'error', 6000); };
    img.src = `/api/team/ads/${encodeURIComponent(a.ad_id)}/artwork`;
    $('lightbox-cap').textContent = `${a.team ? a.team + ' · ' : ''}${a.ad_title || ''}`;
    $('lightbox').classList.add('open');
  }
  function closeLightbox() {
    $('lightbox').classList.remove('open');
    $('lightbox-img').removeAttribute('src');
  }

  // ---- init ----
  function init() {
    $('toggle-rejected').addEventListener('change', loadAds);
    $('refresh').addEventListener('click', loadAds);
    $('retry').addEventListener('click', loadAds);
    $('lightbox-close').addEventListener('click', closeLightbox);
    $('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
    loadAds();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
