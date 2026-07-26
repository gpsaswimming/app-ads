// Reps client (NocoDB v2) for the team ad view (DESIGN.md §12). Maps a viewer's
// authenticated email → the set of affiliations (teams and/or GPSA) they may see.
// Read-only. The table is tiny (a few dozen contacts), so we fetch and match the email
// case-insensitively in-process — robust regardless of the DB's collation, and it can't
// miss on a stored-vs-supplied case difference.

import { AFFILIATIONS } from '../constants.js';

const AFFILIATION_SET = new Set(AFFILIATIONS);

// Split a stored affiliations value into a clean, validated list. The column may be a
// MultiSelect (comma-joined) or free text; accept commas/newlines, trim, and keep only
// real affiliation names so a typo in the table can't silently widen access.
function parseAffiliations(raw) {
  return String(raw ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => AFFILIATION_SET.has(s));
}

export function createRepsClient({
  url,
  token,
  tableId,
  emailField = 'Email',
  affiliationsField = 'Affiliations',
  fetchImpl = fetch,
}) {
  const base = `${url}/api/v2/tables/${tableId}/records`;
  const headers = {
    'xc-token': token,
    'content-type': 'application/json',
    accept: 'application/json',
  };

  async function request(method, path) {
    const res = await fetchImpl(`${base}${path}`, { method, headers });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`NocoDB Reps ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  return {
    /**
     * The DISTINCT, validated affiliations authorized for an email (matched
     * case-insensitively). Empty array if the email is not a known contact. Aggregates
     * across rows in case an email appears more than once.
     */
    async findAffiliationsByEmail(email) {
      const normalized = String(email ?? '').trim().toLowerCase();
      if (!normalized) return [];
      const data = await request('GET', '?limit=1000');
      const list = data && Array.isArray(data.list) ? data.list : [];
      const out = new Set();
      for (const row of list) {
        const rowEmail = String(row[emailField] ?? '').trim().toLowerCase();
        if (rowEmail && rowEmail === normalized) {
          for (const aff of parseAffiliations(row[affiliationsField])) out.add(aff);
        }
      }
      return [...out];
    },
  };
}
