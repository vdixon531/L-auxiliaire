// detect-lang.js
// Decides whether a snippet is French or English, so TRANSLATE knows which
// direction to send it.
//
// The case this exists for: a bare word. "chat", "train", "pour" carry almost
// no orthographic signal on their own, and guessing wrong sends the word
// through the API backwards — "chat" treated as English comes back
// "bavardage" instead of "cat". Single words are the most common thing the
// user hovers, so detection leans on the surrounding sentence whenever the
// caller can supply one.

// Accents and ligatures that occur in French but not in native English
// spelling. Not global-flagged — these are reused across calls and /g would
// carry lastIndex between them.
const FRENCH_CHARS = /[àâäéèêëîïôöùûüÿçœæ]/i;

// Elision: l'homme, d'accord, j'ai, qu'il, n'est. Requires a non-letter (or
// string start) before the elided letter, so English possessives ("John's")
// and contractions ("don't") don't match.
const FRENCH_ELISION = /(?:^|[^\p{L}])(?:[cdjlmnst]|qu)'/iu;

const FRENCH_WORDS = new Set(
  `le la les un une des du de au aux et ou où est sont était étaient être
   avoir ont avec pour dans sur par que qui quoi dont ne pas ce cet cette ces
   se sa ses leur leurs mon ma mes ton ta tes notre nos votre vos
   il elle ils elles je tu nous vous mais donc alors comme aussi très
   tout tous toute toutes chez sans sous entre depuis encore déjà toujours
   jamais quand parce bien faire fait dit peut veut sait si en
   lui eux moi toi cela rien peu beaucoup trop assez ainsi pourtant cependant
   puis ensuite afin selon vers pendant avant contre chaque plusieurs autre
   autres fois monde temps chose gens
   quel quelle quels quelles pourquoi combien merci oui bonjour salut
   madame monsieur maintenant enfin ici voici aujourd hui appelle appelez
   appeler parle parlez parler suis sommes sont avez avons allez allons
   veux voulez pouvez pouvons faites faisons`
    .trim()
    .split(/\s+/)
);

const ENGLISH_WORDS = new Set(
  `the is are was were be been being of to in and or this that these those
   it its he she they them we you your his her their have has had not with
   from at by will would can could should must about there here what which
   when who how why all any some more most than then into out over under
   only also very just like does did get got make made said one two first
   new other many such may might no nor so if because while after before
   between during both each few own same too
   i my am do know think want need see say go come time way well back even
   much good day us him thing work year take look use find give tell ask
   feel try leave call people right little long great old new
   you name please thank hello yes okay something anything everything
   nothing someone anyone everyone always never often sometimes really
   maybe because through without around across against among`
    .trim()
    .split(/\s+/)
);

// Words that exist in both languages (a, an, on, son, car, but, plus, me,
// as, note) are deliberately absent from both lists — they add noise rather
// than signal.

// Positive leans French, negative leans English, zero means no evidence.
function frenchScore(text) {
  if (!text) return 0;
  let score = 0;
  if (FRENCH_CHARS.test(text)) score += 3;
  if (FRENCH_ELISION.test(text)) score += 3;
  // Splitting on apostrophes as well as spaces so "l'homme" yields "homme".
  for (const token of text.toLowerCase().match(/[\p{L}\p{M}]+/gu) || []) {
    if (FRENCH_WORDS.has(token)) score += 1;
    else if (ENGLISH_WORDS.has(token)) score -= 1;
  }
  return score;
}

export function detectLang(text, contextSentence = "", defaultLang = "fr") {
  // French orthography in the word itself is decisive; no context needed.
  if (FRENCH_CHARS.test(text) || FRENCH_ELISION.test(text)) return "fr";

  // The selection's OWN evidence is checked first, and context is only a
  // fallback for the case this module exists for — a bare word carrying no
  // signal of its own.
  //
  // Context used to *replace* the text whenever it was longer, which sent
  // whole French sentences backwards on any English page that quoted them:
  // "Comment vous appelez-vous ?" scores +2 for French alone, but surrounded
  // by an English explanation the sample became the explanation, detection
  // said "en", and the sentence was handed to an en->fr translator that
  // returned it essentially unchanged. Language-learning pages — the exact
  // pages this extension is for — are full of French quoted inside English.
  const own = frenchScore(text);
  if (own > 0) return "fr";
  if (own < 0) return "en";

  const fromContext = frenchScore(contextSentence);
  if (fromContext > 0) return "fr";
  if (fromContext < 0) return "en";

  // No evidence either way. Assume the user is reading French, since that is
  // what this extension is for; a wrong guess here is what the old
  // accent-only heuristic got wrong on every unaccented French word.
  return defaultLang;
}
