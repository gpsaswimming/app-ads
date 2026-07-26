/* Team-facing scoreboard-ads view (DESIGN.md §12). Read-only.
 *
 * The whole origin sits behind the edge's email auth; this script just calls the
 * same-origin team API the edge fronts:
 *   GET /api/team/scopes                          → affiliations the caller may view
 *   GET /api/team/ads?team=<aff>[&include_rejected=true]
 *
 * Invariants honored here: all ad text is rendered with textContent (never innerHTML);
 * the page holds no secrets and makes no cross-origin calls.
 */
(function () {
  'use strict';

  const CONFIG = window.GPSA_TEAM_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  const STATUS_LABEL = { APPROVED: 'Approved', NEEDS_REVIEW: 'Under review', REJECTED: 'Rejected' };

  let scopes = [];
  let currentScope = null;

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
  const VIEWS = ['loading', 'list', 'empty', 'denied', 'error'];
  function setView(id) {
    VIEWS.forEach((v) => {
      const el = $('view-' + v);
      if (el) el.classList.toggle('hidden', v !== id);
    });
    // Toolbar + switcher belong to the data views only.
    const dataView = id === 'list' || id === 'empty';
    $('toolbar').hidden = !dataView;
    $('switch').hidden = !dataView;
  }

  function showDenied(message) {
    $('denied-msg').textContent = message;
    setView('denied');
  }

  const scopeLabel = (a) => (a === 'GPSA' ? 'GPSA (league-level)' : a);

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // ---- data loading ----
  async function loadScopes() {
    setView('loading');
    let res;
    try {
      res = await fetch('/api/team/scopes', { headers: { accept: 'application/json' } });
    } catch {
      return setView('error');
    }
    if (res.status === 401) return showDenied('You need to sign in to view your team\'s ads.');
    if (res.status === 503) return showDenied('The team view isn\'t available yet. Please check back later.');
    if (!res.ok) return setView('error');

    const data = await res.json().catch(() => ({}));
    scopes = Array.isArray(data.affiliations) ? data.affiliations : [];
    if (scopes.length === 0) {
      const who = data.email ? `${data.email} isn't` : 'This account isn\'t';
      return showDenied(`${who} registered as a GPSA team contact. If you handle ads for a team, email ads@gpsaswimming.org to be added.`);
    }
    buildSwitcher();
    currentScope = scopes[0];
    loadAds();
  }

  function buildSwitcher() {
    const select = $('scope');
    const staticEl = $('scope-static');
    if (scopes.length === 1) {
      staticEl.textContent = scopeLabel(scopes[0]);
      staticEl.hidden = false;
      select.hidden = true;
    } else {
      select.innerHTML = '';
      scopes.forEach((a) => {
        const opt = document.createElement('option');
        opt.value = a;
        opt.textContent = scopeLabel(a); // textContent — affiliation is a fixed enum, escaped structurally
        select.appendChild(opt);
      });
      select.hidden = false;
      staticEl.hidden = true;
    }
  }

  async function loadAds() {
    if (!currentScope) return;
    setView('loading');
    const includeRejected = $('toggle-rejected').checked;
    const url = `/api/team/ads?team=${encodeURIComponent(currentScope)}`
      + (includeRejected ? '&include_rejected=true' : '');

    let res;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch {
      return setView('error');
    }
    if (res.status === 401) return showDenied('Your session expired. Refresh the page to sign in again.');
    if (res.status === 403) { showToast('You\'re not authorized to view that team.', 'error', 6000); return; }
    if (!res.ok) return setView('error');

    const data = await res.json().catch(() => ({}));
    renderAds(Array.isArray(data.ads) ? data.ads : []);
  }

  // ---- rendering ----
  function renderAds(ads) {
    if (ads.length === 0) {
      $('empty-msg').textContent = `No ads have been submitted for ${scopeLabel(currentScope)} yet.`;
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
    // Summary: structurally-escaped scope label + our own enum counts (no ad data).
    $('summary').innerHTML = `<strong>${escapeHtml(scopeLabel(currentScope))}</strong> — `
      + `${ads.length} ad${ads.length === 1 ? '' : 's'}`
      + (bits.length ? ` · ${bits.join(' · ')}` : '');

    const tbody = $('rows');
    tbody.innerHTML = '';
    ads.forEach((a) => tbody.appendChild(rowFor(a)));
    setView('list');
  }

  // Build a table row with textContent throughout (invariant: never innerHTML for ad data).
  function rowFor(a) {
    const tr = document.createElement('tr');

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
    $('scope').addEventListener('change', (e) => { currentScope = e.target.value; loadAds(); });
    $('toggle-rejected').addEventListener('change', loadAds);
    $('refresh').addEventListener('click', loadAds);
    $('retry').addEventListener('click', loadScopes);
    loadScopes();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
