// Cloudflare Turnstile server-side verification (DESIGN.md §3 invariant 5).
// Must pass before anything is created. Any error/timeout → not verified (fail closed).

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export function createTurnstileVerifier({ secret, timeoutMs = 10000 }) {
  return async function verifyTurnstile(token, remoteip) {
    if (!token) return false;

    const form = new URLSearchParams();
    form.set('secret', secret);
    form.set('response', token);
    if (remoteip) form.set('remoteip', remoteip);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: controller.signal,
      });
      if (!res.ok) return false;
      const data = await res.json();
      return data.success === true;
    } catch {
      return false; // network error / timeout → treat as not verified
    } finally {
      clearTimeout(timer);
    }
  };
}
