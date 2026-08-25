// fuzzy-match.js
// Small utilities for pronunciation-matching (stretch goal #5).

export function stripAccents(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalize(str) {
  return stripAccents(str.toLowerCase()).replace(/[^\p{L}\s]/gu, "").trim();
}

// Same shape as normalize(), but keeps the accents — phoneticKey() needs to
// see é/è/ç to fold them correctly, so the pronunciation path must not have
// them stripped out from under it before tokenizing.
export function normalizeAccented(str) {
  return String(str ?? "")
    .toLowerCase()
    // A hyphen joins two spoken words ("allez-vous"), an apostrophe elides
    // into one ("s'il") — so the first becomes a break and the second doesn't.
    .replace(/[-–—]/g, " ")
    .replace(/[^\p{L}\p{M}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
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

// Alignment-based word diff (LCS backtrace). Unlike wordDiff()'s strict
// positional comparison, an inserted or dropped word only affects itself
// here, not every word after it. Returns one entry per target word plus the
// spoken words that aligned to nothing.
//
// `opts.eq` overrides the word-equality test and `opts.tokenize` the word
// split — alignPronunciation() below passes both to get accent-preserving,
// sounds-alike alignment. The defaults reproduce the original exact-match
// behaviour, so existing callers are unaffected.
export function alignWords(target, spoken, opts = {}) {
  const eq = opts.eq || ((a, b) => a === b);
  const tokenize = opts.tokenize || ((str) => normalize(str).split(/\s+/).filter(Boolean));
  const t = tokenize(target);
  const s = tokenize(spoken);
  const dp = Array.from({ length: t.length + 1 }, () => new Array(s.length + 1).fill(0));
  for (let i = t.length - 1; i >= 0; i--) {
    for (let j = s.length - 1; j >= 0; j--) {
      dp[i][j] = eq(t[i], s[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const words = [];
  const extras = [];
  let i = 0;
  let j = 0;
  while (i < t.length && j < s.length) {
    if (eq(t[i], s[j])) {
      // `heard` is what the recognizer actually produced for this target word
      // — identical under exact equality, but worth showing back to the user
      // when a phonetic match let a differently-spelled word through.
      words.push({ word: t[i], match: true, heard: s[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      words.push({ word: t[i], match: false });
      i++;
    } else {
      extras.push(s[j]);
      j++;
    }
  }
  while (i < t.length) words.push({ word: t[i++], match: false });
  while (j < s.length) extras.push(s[j++]);
  return { words, extras };
}

// -----------------------------
// Pronunciation-tolerant matching
// -----------------------------
//
// Scoring a spoken attempt on its *spelling* punishes the learner for things
// they got right: the recognizer hears "ç'a" for "ça", "et" for "est",
// "parlé" for "parler" — all correct out loud, all a fistful of Levenshtein
// edits on paper. So pronunciation scoring runs on a phonetic key instead: a
// crude French grapheme→sound folding that collapses the spellings French
// pronounces identically (silent finals, -er/-ez/-é, s/ss/z, c/qu/k, ph/f,
// ou/u, au/eau/o, the nasals) onto one form.
//
// It is deliberately lossy and deliberately not IPA — the goal is "did they
// say the right thing", not a transcription. It over-merges (a few real
// minimal pairs collapse together); for a practice drill that errs the right
// way, since a false pass costs a learner far less than a false fail.

// Keys are recomputed constantly — the live match redraws on every interim
// recognition result, and each redraw runs an O(target × spoken) alignment
// over the same handful of words. Vocabulary is tiny, so cache outright.
const keyCache = new Map();
const KEY_CACHE_MAX = 2000;

// Order matters throughout — each rule assumes the ones above it already ran.
export function phoneticKey(word) {
  const cached = keyCache.get(word);
  if (cached !== undefined) return cached;
  const key = computePhoneticKey(word);
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(word, key);
  return key;
}

function computePhoneticKey(word) {
  let w = String(word || "").toLowerCase().trim();
  if (!w) return "";

  // é/è/ê are a *pronounced* e — mark them before accent-stripping so the
  // silent-final-e rule below can't eat them ("parlé" must not become "parl-").
  w = w.replace(/[éèêë]/g, "E").replace(/ç/g, "s");
  w = stripAccents(w).replace(/[^a-zE]/g, ""); // drops apostrophes: "j'ai" → "jai"
  if (!w) return "";

  // Digraphs, before the single letters they contain get rewritten.
  w = w.replace(/ph/g, "f");
  w = w.replace(/ch/g, "S"); // /ʃ/
  w = w.replace(/gn/g, "N"); // /ɲ/
  w = w.replace(/h/g, "");   // silent everywhere else
  w = w.replace(/qu/g, "k").replace(/q/g, "k");

  // Nasal vowels — only when the n/m closes the syllable ("bon" nasal,
  // "bonne" not), hence the following-vowel lookahead. The uppercase markers
  // stand for vowels too, so an earlier rule's output must block a later one
  // ("coman" → "comA": that m is followed by a vowel, not closing a syllable).
  w = w.replace(/(ain|aim|ein|eim|yn|ym|in|im|un|um)(?![aeiouEAIO2mn])/g, "I");
  w = w.replace(/(an|am|en|em)(?![aeiouEAIO2mn])/g, "A");
  w = w.replace(/(on|om)(?![aeiouEAIO2mn])/g, "O");

  // Vowel digraphs.
  w = w.replace(/eaux?/g, "o").replace(/aux?/g, "o").replace(/au/g, "o");
  w = w.replace(/oeu|eu/g, "2"); // /ø~œ/
  w = w.replace(/ou/g, "u");
  w = w.replace(/oi/g, "wa");
  w = w.replace(/ai|ei/g, "E");
  w = w.replace(/y/g, "i");

  // Verb/noun endings that all land on /e/ — the single biggest source of
  // spurious misses ("parler" vs "parlé" vs "parlez" vs "parlait").
  w = w.replace(/(er|ez|es|ent|ait|aient|ais|ait)$/g, "E");

  // Soft/hard c and g, then s-between-vowels voicing.
  w = w.replace(/c(?=[eiEy])/g, "s").replace(/c/g, "k");
  w = w.replace(/g(?=[eiEy])/g, "j");
  w = w.replace(/([aeiouE2])s([aeiouE2])/g, "$1z$2");
  w = w.replace(/x(?!$)/g, "ks"); // a *final* x is silent ("deux"), handled below

  // Doubled letters are never two sounds in French.
  w = w.replace(/(.)\1+/g, "$1");

  // Silent finals: the mute e, then the consonants French drops at word end
  // (keeping the "careful" c/r/f/l set audible). The cluster, not just one
  // letter — "est" and "temps" drop two.
  w = w.replace(/e$/g, "");
  w = w.replace(/[tdspzgx]+$/g, "");

  return w || String(word).toLowerCase();
}

// 0..1, on the phonetic keys rather than the spellings.
export function phoneticSimilarity(a, b) {
  const ka = phoneticKey(a);
  const kb = phoneticKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  return 1 - levenshtein(ka, kb) / Math.max(ka.length, kb.length);
}

// How close two single words are out loud. Identical phonetic keys are a
// flat 1 — that's the whole point of the folding. Otherwise the two views are
// blended with sound leading: spelling still gets a vote (it rescues words
// phoneticKey() over-folds or mangles), but on its own it is a poor judge of
// how alike two words *sound* — "gare"/"plage" share most of their letters
// and almost none of their pronunciation.
export function wordSimilarity(a, b) {
  const phon = phoneticSimilarity(a, b);
  if (phon === 1) return 1;
  return 0.7 * phon + 0.3 * similarity(a, b);
}

// Word-equality test for alignWords(). 0.78 is loose enough to forgive an
// ending or a swallowed consonant, tight enough that distinct short words
// ("mon"/"ton", "et"/"eu") still count as different.
const WORD_MATCH_THRESHOLD = 0.78;

export function wordsSoundAlike(a, b) {
  return wordSimilarity(a, b) >= WORD_MATCH_THRESHOLD;
}

const tokenizeAccented = (str) => normalizeAccented(str).split(/\s+/).filter(Boolean);

// alignWords() with the phonetic equality test. `near` flags a word that
// missed the match threshold but is still recognisably an attempt at the
// right word — worth showing the learner differently from a word they simply
// didn't say.
export function alignPronunciation(target, spoken) {
  const aligned = alignWords(target, spoken, {
    eq: wordsSoundAlike,
    tokenize: tokenizeAccented
  });
  const spokenWords = tokenizeAccented(spoken);
  return {
    ...aligned,
    words: aligned.words.map((w) => {
      if (w.match) return { ...w, near: false };
      // Unmatched: was anything the user said at least in the neighbourhood?
      const best = spokenWords.reduce((m, s) => Math.max(m, wordSimilarity(w.word, s)), 0);
      return { ...w, near: best >= 0.5 };
    })
  };
}

// Overall 0..1 score for a spoken attempt. This is a *word*-level edit
// distance, not a character one: getting one word wrong in a ten-word line
// should cost about a tenth, whatever the length of the word — and a
// character-level score on a long line makes a single flubbed word look like
// a near-perfect read, while on a short one it looks like a total failure.
//
// The three costs are deliberately asymmetric: a substitution costs only as
// much as the two words actually differ, a dropped target word costs full
// price, and an extra word is cheap — recognizers hallucinate filler
// ("euh", a repeated article) constantly, and that isn't the learner's error.
export function pronunciationScore(reference, spoken) {
  const t = tokenizeAccented(reference);
  const s = tokenizeAccented(spoken);
  if (!t.length) return 0;
  if (!s.length) return 0;

  const INSERT_COST = 0.35; // extra word the user said
  const DELETE_COST = 1; // reference word the user didn't say
  // Below this the two words aren't a mispronunciation of each other, they're
  // different words — partial credit there would quietly pass wrong answers.
  const PARTIAL_CREDIT_FLOOR = 0.5;

  const dp = Array.from({ length: t.length + 1 }, () => new Array(s.length + 1).fill(0));
  for (let i = 1; i <= t.length; i++) dp[i][0] = i * DELETE_COST;
  for (let j = 1; j <= s.length; j++) dp[0][j] = j * INSERT_COST;
  for (let i = 1; i <= t.length; i++) {
    for (let j = 1; j <= s.length; j++) {
      const ws = wordSimilarity(t[i - 1], s[j - 1]);
      const sub = ws >= PARTIAL_CREDIT_FLOOR ? 1 - ws : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j - 1] + sub,
        dp[i - 1][j] + DELETE_COST,
        dp[i][j - 1] + INSERT_COST
      );
    }
  }
  return Math.max(0, 1 - dp[t.length][s.length] / t.length);
}
