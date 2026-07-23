// Gemini appropriateness check (DESIGN.md §5). ADVISORY ONLY: a pass approves; a
// flag (or ANY error/timeout) routes to NEEDS_REVIEW — never an auto-reject, and
// fail-safe not fail-open. The caller owns that policy; this module just asks Gemini
// and returns a structured verdict, throwing on transport/parse failure.

const PROMPT = [
  'You are screening an image submitted as a paid advertisement to display on a',
  'scoreboard at a family youth swim meet. Flag it if EITHER: (a) it contains',
  'offensive or adult content — profanity, nudity, sexual content, graphic violence,',
  'hate, or anything not family-friendly; OR (b) it is clearly not an advertisement —',
  'e.g. blank, a personal photo, a screenshot, or unrelated content. Do not consider',
  'anything else. Respond JSON {appropriate: boolean, reason: string}.',
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
