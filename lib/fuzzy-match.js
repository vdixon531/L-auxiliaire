// fuzzy-match.js
// Small utilities for pronunciation-matching (stretch goal #5).

export function stripAccents(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalize(str) {
  return stripAccents(str.toLowerCase()).replace(/[^\p{L}\s]/gu, "").trim();
}

// Levenshtein distance
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

// 0..1 similarity score, accent-insensitive
export function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - dist / maxLen;
}

// Word-level diff — returns an array of {word, match}
export function wordDiff(target, spoken) {
  const t = normalize(target).split(/\s+/);
  const s = normalize(spoken).split(/\s+/);
  return t.map((word, i) => ({
    word,
    match: s[i] === word
  }));
}
