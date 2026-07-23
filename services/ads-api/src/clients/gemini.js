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
  '(c) It is not mostly white or washed-out. Large areas of white or near-white can damage',
  'the LED board, so flag artwork whose background is white or light-gray, or that is',
  'predominantly white — for example a white logo, or a logo placed on a plain white',
  'background. A full-color photograph is fine even when it is bright or shot outdoors;',
  'only flag images DOMINATED by white or very light tones, not images that are merely',
  '"not dark".',
  'ALWAYS also fill `summary`: 2-3 sentences of context for the human ad reviewer —',
  'describe what the ad shows (its subject and any people), transcribe the main text/',
  'message, note the dominant colors and background, and call out anything the reviewer',
  'should double-check. Write the summary even when appropriate is true; keep `reason`',
  'short. Respond JSON {appropriate: boolean, reason: string, summary: string}.',
].join(' ');

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    appropriate: { type: 'boolean' },
    reason: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['appropriate', 'reason', 'summary'],
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
        summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      };
    } finally {
      clearTimeout(timer);
    }
  };
}
