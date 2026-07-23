// Gemini appropriateness check (DESIGN.md §5). ADVISORY ONLY: a pass approves; a
// flag (or ANY error/timeout) routes to NEEDS_REVIEW — never an auto-reject, and
// fail-safe not fail-open. The caller owns that policy; this module just asks Gemini
// and returns a structured verdict, throwing on transport/parse failure.

const PROMPT = [
  'You are screening an image submitted as a paid advertisement to be shown on a large',
  'LED scoreboard at a family youth swim meet. Ads may be business/sponsor promotions OR',
  'personal and team recognition messages — e.g. a parent congratulating a swimmer',
  '("Congrats Emma!") or a team celebrating its athletes — and these often include a photo',
  'of the swimmer, which is expected and completely fine. Set appropriate=false only if ANY',
  'of these fail, and name the failing check in `reason`:',
  '(a) Family-friendly: no profanity, nudity, sexual content, graphic violence, hate, or',
  'other content unsuitable for children. An ordinary photo of a child swimmer is NOT a',
  'problem.',
  '(b) It is a real scoreboard ad or a genuine recognition/congrats message — not blank, a',
  'random screenshot, or unrelated content with no message at all.',
  '(c) It has a black or very dark background. The board requires dark backgrounds with',
  'light text — flag any image whose background is white or predominantly light or bright.',
  'Respond JSON {appropriate: boolean, reason: string}; keep reason short and specific.',
].join(' ');

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    appropriate: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['appropriate', 'reason'],
};

export function createGeminiChecker({ apiKey, model, timeoutMs = 15000, fetchImpl = fetch }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  /**
   * @returns {Promise<{appropriate:boolean, reason:string}>}
   * @throws on network/timeout/parse errors — caller maps that to NEEDS_REVIEW.
   */
  return async function checkAppropriateness(buffer, contentType) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: PROMPT },
                { inline_data: { mime_type: contentType, data: buffer.toString('base64') } },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: RESPONSE_SCHEMA,
            temperature: 0,
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`Gemini responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Gemini returned no text part');

      const parsed = JSON.parse(text);
      return {
        appropriate: parsed.appropriate === true,
        reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
