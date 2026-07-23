// NocoDB client (v2 REST) for the Ads table (DESIGN.md §4).
// Invariant 10: filters are built through a parameterized helper — never string
// interpolation of raw user input — so a value can't break out of the where clause.

/**
 * Build a single-condition NocoDB `where` expression safely.
 * NocoDB's grammar delimits with parentheses and commas; we percent-escape those
 * (and backslash) in the value so it is always treated as data, never syntax.
 */
export function filterEq(field, value) {
  const safeField = String(field).replace(/[^A-Za-z0-9_ ]/g, '');
  const safeValue = String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/([(),])/g, '\\$1');
  return `(${safeField},eq,${safeValue})`;
}

export function createNocoClient({ url, token, tableId, fetchImpl = fetch }) {
  const base = `${url}/api/v2/tables/${tableId}/records`;
  const headers = {
    'xc-token': token,
    'content-type': 'application/json',
    accept: 'application/json',
  };

  async function request(method, path, body) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`NocoDB ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    /** Create one Ads row. Returns the created record (incl. its NocoDB Id). */
    async createAd(fields) {
      // v2 accepts a single object or an array; return shape mirrors the input.
      const created = await request('POST', '', fields);
      return Array.isArray(created) ? created[0] : created;
    },

    /** Patch one Ads row by its NocoDB primary Id. */
    async updateAd(recordId, fields) {
      return request('PATCH', '', { Id: recordId, ...fields });
    },

    /** Find a row by our Ad_ID UUID (parameterized where). Returns row or null. */
    async findByAdId(adId) {
      const where = encodeURIComponent(filterEq('Ad_ID', adId));
      const data = await request('GET', `?where=${where}&limit=1`);
      const list = data && Array.isArray(data.list) ? data.list : [];
      return list[0] || null;
    },
  };
}
