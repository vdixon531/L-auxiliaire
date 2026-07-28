// normalize-url.js
// Vocab is keyed by URL (see CLAUDE.md), so two links to the same article
// that differ only in tracking params, a #fragment, or a trailing slash
// would otherwise fragment one page's workbook into several. This doesn't
// try to be a general-purpose canonicalizer — just strip the specific noise
// that referral links and anchors actually add, without touching query
// params that might be the only thing identifying distinct content (e.g.
// ?id=123, ?p=2) on a given site.

const TRACKING_PARAM_PATTERNS = [
  /^utm_/,
  /^fbclid$/,
  /^gclid$/,
  /^msclkid$/,
  /^mc_(cid|eid)$/,
  /^ref$/,
  /^ref_src$/,
  /^igshid$/,
  /^_ga$/,
  /^si$/,
  /^spm$/
];

export function normalizeUrl(rawUrl) {
  if (!rawUrl) return "unknown";

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl; // not a real URL — leave whatever it is alone
  }

  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  const keptParams = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM_PATTERNS.some((re) => re.test(key)))
    .sort(([a], [b]) => a.localeCompare(b));
  url.search = "";
  for (const [key, value] of keptParams) url.searchParams.append(key, value);

  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}
