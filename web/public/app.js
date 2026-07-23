/* Scoreboard Ads submission form (DESIGN.md §2, §8).
 *
 * Two-step submit:
 *   1. POST metadata JSON  →  same-origin /api/submit  →  { ad_id, presign }
 *   2. Direct multipart POST of the file  →  presign.url (the public upload host)
 *
 * Invariants honored here (DESIGN.md §3):
 *   - All submitter/company/team text is rendered with textContent — never innerHTML.
 *   - Only the PUBLIC Turnstile site key ships to the browser (via config.js).
 *   - The API is called same-origin at /api/*; the upload goes cross-origin to UPLOAD_URL.
 *   - Size/type are enforced by the presign policy on the server; the client byte_size /
 *     type checks are only a friendly early error.
 */
(function () {
  'use strict';

  const CONFIG = window.GPSA_ADS_CONFIG || {};
  const PRICING = { FULL_SCREEN: 75, HALF_SCREEN: 40 }; // display only; API is authoritative
  const MAX_BYTES = 52428800; // 50 MB — friendly early guard; presign policy is the real gate
  const ALLOWED_TYPES = ['image/png', 'image/jpeg'];

  let turnstileToken = null;
  let turnstileWidgetId = null;
  let turnstileRendered = false;
  let submitting = false;

  const $ = (id) => document.getElementById(id);

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

  const money = (n) => `$${n}`;
  const getVal = (id) => ($(id) ? $(id).value.trim() : '');

  // ---- Turnstile (explicit render so we can supply the injected site key) ----
  function renderTurnstile() {
    if (turnstileRendered || !window.turnstile) return;
    const siteKey = CONFIG.turnstileSiteKey;
    if (!siteKey || siteKey.indexOf('${') === 0) {
      // No real site key injected (e.g. un-rendered template) — leave a note, don't crash.
      console.warn('Turnstile site key is not configured; the widget will not render.');
      return;
    }
    turnstileRendered = true;
    turnstileWidgetId = window.turnstile.render('#turnstile-widget', {
      sitekey: siteKey,
      theme: 'light',
      size: 'flexible', // expand to the container width (full-width) to match the form
      callback: (token) => { turnstileToken = token; },
      'error-callback': () => { turnstileToken = null; },
      'expired-callback': () => { turnstileToken = null; },
    });
  }
  // Cloudflare's api.js calls this onload; also invoked from init() in case api.js
  // finished loading before app.js ran. Either path is idempotent.
  window.onTurnstileLoad = renderTurnstile;

  function resetTurnstile() {
    turnstileToken = null;
    if (turnstileRendered && window.turnstile && turnstileWidgetId !== null) {
      window.turnstile.reset(turnstileWidgetId);
    }
  }

  // ---- Deadline / closed state ----
  function isClosed() {
    const raw = CONFIG.submissionDeadline;
    if (!raw || raw.indexOf('${') === 0) return false; // unset/un-rendered → rely on API backstop
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return false;
    return Date.now() > ms;
  }

  function showClosed() {
    $('ad-form').classList.add('hidden');
    $('success-state').classList.add('hidden');
    $('closed-state').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- Conditional UI ----
  function selectedPlacement() {
    const el = document.querySelector('input[name="placement"]:checked');
    return el ? el.value : '';
  }

  function updateAdvertiserVisibility() {
    const isAdv = $('submitter_is_advertiser').checked;
    const block = $('advertiser-contact');
    block.classList.toggle('hidden', isAdv);
    // Advertiser contact is required only when it's shown.
    $('advertiser_name').required = !isAdv;
    $('advertiser_email').required = !isAdv;
  }

  function updatePayment() {
    const team = $('team').value;
    const placement = selectedPlacement();
    const empty = $('payment-empty');
    const teamBox = $('payment-team');
    const gpsaBox = $('payment-gpsa');

    empty.classList.add('hidden');
    teamBox.classList.add('hidden');
    gpsaBox.classList.add('hidden');

    if (!team || !placement) {
      empty.classList.remove('hidden');
      return;
    }
    const amount = PRICING[placement];
    if (team === 'GPSA') {
      gpsaBox.classList.remove('hidden');
    } else {
      teamBox.classList.remove('hidden');
      // textContent — team is a fixed enum value, but we escape structurally regardless.
      $('pay-team-label').textContent = `Pay your team (${team}) directly — ${money(amount)}.`;
    }
  }

  function updatePlacementCards() {
    const chosen = selectedPlacement();
    document.querySelectorAll('.placement-card').forEach((card) => {
      card.classList.toggle('selected', card.dataset.placement === chosen);
    });
  }

  // ---- Progress ----
  function setProgress(frac) {
    const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
    $('progress-bar').style.width = `${pct}%`;
    $('progress-pct').textContent = `${pct}%`;
  }

  function setSubmitting(on, label) {
    submitting = on;
    const btn = $('submit-btn');
    btn.disabled = on;
    btn.textContent = label || 'Submit ad';
  }

  // ---- Gather + validate ----
  function collect() {
    const isAdv = $('submitter_is_advertiser').checked;
    const submitterName = getVal('submitter_name');
    const submitterEmail = getVal('submitter_email');
    const submitterPhone = getVal('submitter_phone');
    const team = $('team').value;
    const placement = selectedPlacement();
    const file = $('artwork').files[0] || null;

    const paymentMethod = team === 'GPSA'
      ? (document.querySelector('input[name="payment_method_gpsa"]:checked') || {}).value
      : 'PAY_TEAM';

    return {
      isAdv,
      file,
      team,
      placement,
      paymentMethod,
      body: {
        submitter_name: submitterName,
        submitter_email: submitterEmail,
        submitter_phone: submitterPhone,
        submitter_is_advertiser: isAdv,
        company_name: getVal('company_name'),
        advertiser_name: isAdv ? submitterName : getVal('advertiser_name'),
        advertiser_email: isAdv ? submitterEmail : getVal('advertiser_email'),
        advertiser_phone: isAdv ? submitterPhone : getVal('advertiser_phone'),
        team,
        ad_title: getVal('ad_title'),
        placement,
        payment_method: paymentMethod,
        rights_confirmed: $('rights_confirmed').checked,
        filename: file ? file.name : '',
        content_type: file ? file.type : '',
        byte_size: file ? file.size : 0,
        turnstile_token: turnstileToken || '',
      },
    };
  }

  function validate(data) {
    const b = data.body;
    const fail = (msg, focusId) => {
      showToast(msg, 'error', 6000);
      if (focusId && $(focusId)) $(focusId).focus();
      return false;
    };
    if (!b.submitter_name) return fail('Please enter your name.', 'submitter_name');
    if (!b.submitter_email) return fail('Please enter your email.', 'submitter_email');
    if (!b.company_name) return fail('Please enter the company / business name.', 'company_name');
    if (!b.team) return fail('Please choose an affiliation.', 'team');
    if (!b.ad_title) return fail('Please enter an ad title.', 'ad_title');
    if (!data.isAdv && !b.advertiser_name) return fail("Please enter the advertiser's name.", 'advertiser_name');
    if (!data.isAdv && !b.advertiser_email) return fail("Please enter the advertiser's email.", 'advertiser_email');
    if (!b.placement) return fail('Please choose a placement.');
    if (!data.file) return fail('Please choose an artwork file.', 'artwork');
    if (ALLOWED_TYPES.indexOf(data.file.type) === -1) return fail('Artwork must be a PNG or JPG image.', 'artwork');
    if (data.file.size > MAX_BYTES) return fail('That file is larger than 50 MB. Please export a smaller image.', 'artwork');
    if (data.team === 'GPSA' && !b.payment_method) return fail('Please choose how you want to pay GPSA.');
    if (!b.rights_confirmed) return fail('Please confirm you have the right to use this artwork.', 'rights_confirmed');
    if (!b.turnstile_token) return fail('Please complete the "I\'m not a robot" check.');
    return true;
  }

  // ---- Two-step submit ----
  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;

    const data = collect();
    if (!validate(data)) return;

    setSubmitting(true, 'Submitting…');

    let result;
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data.body),
      });

      if (res.status === 403) {
        const err = await res.json().catch(() => ({}));
        if (err.error === 'SUBMISSIONS_CLOSED') { showClosed(); return; }
        showToast('The robot check didn\'t pass — please try again.', 'error', 6000);
        resetTurnstile();
        setSubmitting(false);
        return;
      }
      if (!res.ok) {
        showToast('We couldn\'t accept the submission. Please review your entries and try again.', 'error', 6000);
        resetTurnstile();
        setSubmitting(false);
        return;
      }
      result = await res.json();
    } catch (err) {
      showToast('Network error reaching the server. Please try again.', 'error', 6000);
      resetTurnstile();
      setSubmitting(false);
      return;
    }

    if (!result || !result.presign || !result.presign.url) {
      showToast('The server response was incomplete. Please try again.', 'error', 6000);
      resetTurnstile();
      setSubmitting(false);
      return;
    }

    uploadFile(result, data);
  }

  function uploadFile(result, data) {
    const target = result.presign.url;
    // Security: only ever upload to the host we were configured to trust (UPLOAD_URL),
    // never blindly to whatever the API returned.
    if (CONFIG.uploadUrl && target.indexOf(CONFIG.uploadUrl) !== 0) {
      showToast('Unexpected upload destination — submission halted.', 'error', 8000);
      setSubmitting(false);
      return;
    }

    const fd = new FormData();
    Object.keys(result.presign.fields || {}).forEach((k) => fd.append(k, result.presign.fields[k]));
    fd.append('file', data.file); // MUST be appended last for the POST policy to apply

    $('upload-progress').classList.remove('hidden');
    setProgress(0);
    setSubmitting(true, 'Uploading…');

    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener('progress', (ev) => {
      if (ev.lengthComputable) setProgress(ev.loaded / ev.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        setProgress(1);
        showSuccess(result, data);
      } else {
        showToast('Upload failed (' + xhr.status + '). Please try submitting again.', 'error', 8000);
        $('upload-progress').classList.add('hidden');
        setSubmitting(false);
      }
    });
    xhr.addEventListener('error', () => {
      showToast('Upload failed — network error. Please try again.', 'error', 8000);
      $('upload-progress').classList.add('hidden');
      setSubmitting(false);
    });
    xhr.open('POST', target);
    xhr.send(fd);
  }

  function payInstruction(data, amount) {
    const t = money(amount);
    switch (data.paymentMethod) {
      case 'PAY_TEAM': return `Please pay your team (${data.team}) directly — ${t}.`;
      case 'CHECK': return `Mail a ${t} check to GPSA — the mailing address is in your confirmation email.`;
      case 'SQUARE_INVOICE': return `GPSA will email you a Square invoice for ${t}.`;
      default: return `Amount due: ${t}.`;
    }
  }

  function showSuccess(result, data) {
    const amount = PRICING[data.placement];
    $('success-ad-id').textContent = result.ad_id || '';
    $('success-amount').textContent = money(amount);
    // textContent throughout — team is an enum, but escaping is structural (§3 inv 10).
    $('success-pay').textContent = payInstruction(data, amount);
    $('ad-form').classList.add('hidden');
    $('success-state').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---- Init ----
  function init() {
    renderTurnstile(); // in case api.js already loaded before this script

    if (isClosed()) { showClosed(); return; }

    $('submitter_is_advertiser').addEventListener('change', updateAdvertiserVisibility);
    $('team').addEventListener('change', updatePayment);
    document.querySelectorAll('input[name="placement"]').forEach((el) => {
      el.addEventListener('change', () => { updatePlacementCards(); updatePayment(); });
    });
    $('ad-form').addEventListener('submit', handleSubmit);

    updateAdvertiserVisibility();
    updatePayment();
    updatePlacementCards();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
