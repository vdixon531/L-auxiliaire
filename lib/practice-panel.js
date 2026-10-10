// lib/practice-panel.js
//
// Conversation-practice session for the side panel's Practice tab. The whole
// live session state machine lives here in the panel — SpeechRecognition and
// speechSynthesis are window-context UI APIs the service worker can't run —
// but translations still route through TRANSLATE messages so the service
// worker keeps owning external calls and the translation cache. Session state
// is deliberately ephemeral (module memory, nothing persisted).
//
// Parsing is two-phase: parseLines() is pure and local (rows, speaker tags,
// stage directions, and a trailing parenthetical lifted as a CANDIDATE
// gloss), then classifyOneLine() settles whether that candidate really was a
// translation by comparing its language with the line's. A dialogue that
// ships its own parenthetical translations needs no machine translation at
// all — only DETECT_LANG, which is local and free.
//
// Caller contract (sidepanel.html must provide these IDs): practiceSetup,
// practiceInput, practiceStart, practiceNotice, practiceSession,
// practiceLines, practiceWave, practiceMicHint, practicePause, practiceSkip,
// practiceStop, practiceResult, practiceInfo, practiceInfoModal,
// practiceInfoClose, micModal, micGrantBtn, micModalDismiss.
//
// The turn loop is fully automatic — there is no mic button. A user turn
// shows a short pre-roll countdown on its line, then the mic opens on its
// own; a turn ends on trailing silence (see listenOnce), not on a button
// press. Scores are withheld until the end-of-session summary UNLESS an
// attempt lands under ADVANCE_GATE, in which case the line's French is
// revealed and one more attempt is offered before the session moves on
// regardless — see resolveAttempt().
//
// WHO speaks a line and HOW it is scored are two separate questions:
//   * Roles come from speaker tags when the text has a named cast ("VOUS:",
//     "CAISSIER:"). Every line of a speaker you claim is yours to say. This
//     beats the mode logic below, because a tag states the answer outright
//     where alternation only guesses it.
//   * Scoring stays language-driven, via isTranslateTurn() — an English line
//     is something to render into French whoever is speaking it.
// The mode logic below is the fallback for text with no cast.
//
// Two modes, inferred from the classified dialogue, plus a `solo` flag:
//   A — every line French, alternating read-aloud turns (app/user).
//   B — mixed French/English: the app reads the French lines; each English
//       line is a translate-turn the user must speak in French, checked
//       (leniently — the machine translation is only ONE valid rendering)
//       against a reference translation.
//   C — every line English: Mode B with no French lines left for the app to
//       read, so every line is a translate-turn — a translation drill.
//   solo — set when the pasted text had no dialogue markers (no leading dash
//       or "Name:" tag) AND every line classified to the same language. A
//       French solo passage is read start to finish with no alternation (the
//       "read this news article aloud" case); an English one is identical to
//       mode C (nothing marks it as two-party, so there's nothing for an app
//       voice to read either way). Editing a session can flip this: adding an
//       English line to a French passage breaks solo even though no line
//       gained a marker, because the language mix itself is now the signal.

import { pronunciationScore, alignPronunciation } from "./fuzzy-match.js";

const $ = (id) => document.getElementById(id);

// Colours the summary's per-line percentage only (see renderSummary) — a
// first-attempt score at or above its mode's bar reads as a strong pass
// rather than a bare clear. It plays no part in advancing a turn; that's
// ADVANCE_GATE, flat across every mode.
const PASS_THRESHOLD = { A: 0.78, B: 0.55, C: 0.55 };

// The only bar a turn is actually gated on. Deliberately low: the point of
// scoring is to catch silence and total misses, not to withhold the reveal
// from anyone who made a real attempt. Set once, by direct request.
const ADVANCE_GATE = 0.2;

// How long the countdown runs before the mic opens on a user turn. Constant
// on purpose — a countdown that got faster once the user "learned the rhythm"
// would be the exact failure this exists to avoid: the one time it fires
// early, the opening word is lost, and dead air is a cheaper cost than that.
const PRE_ROLL_MS = 2500;
// How long a failed attempt's reveal (repeat/struggled-pause) stays up before
// the session moves itself along.
const REPEAT_REVEAL_MS = 4000;
const STRUGGLED_PAUSE_MS = 1800;
// The brief, wordless beat after a clear before the next turn starts — enough
// to register as "that landed" without printing a score.
const CLEARED_PAUSE_MS = 700;

// Recognition runs continuous (see listenOnce) — a turn ends when the user
// stops talking, not when Chrome finalizes its first result, which for a
// multi-word line used to score the whole line on its opening word. Bumped
// from 1800 now that pressing "done" isn't an escape hatch any more — a
// pause to retrieve a word must not read as the end of the turn.
const SILENCE_END_MS = 2500;
// If nothing at all is heard by this point the turn ends as silence. Short
// enough that a genuinely silent mic reaches the two-line pause (see
// resolveAttempt) in well under a minute; the on-screen countdown means the
// user already knows exactly when to start, so nine seconds of nothing was
// longer than it needed to be.
const FIRST_SPEECH_MS = 6000;
const MAX_LISTEN_MS = 30000;

let listenersWired = false;
let session = null; // null = setup screen
let sessionSeq = 0; // bumped on stop/reset so in-flight async turns abandon themselves
let activeRecognition = null;
let micPermission = "prompt"; // last known navigator.permissions state
let micModalDismissed = false; // "Not now" — don't nag again this panel lifetime
let editingLine = null; // index of the ready-screen line currently mid-edit, or null

// -----------------------------
// Public API
// -----------------------------

export async function initPracticePanel() {
  wireListeners();
  await refreshMicPermission();
  renderAll();
}

export function startPracticeFromText(text) {
  $("practiceInput").value = text;
  startSession(text);
}

// Called when the side panel switches away from the Practice tab — kill any
// live audio but keep the session so the user can resume where they were.
export function pausePractice() {
  if (!session) return;
  pauseSession(session.pauseReason || "user");
}

// -----------------------------
// Session setup
// -----------------------------

// -----------------------------
// Dialogue parsing
//
// Phase 1 (here) is pure and local: split rows, lift speaker tags, separate
// stage directions, and EXTRACT a trailing parenthetical as a *candidate*
// gloss. Whether that candidate really is a translation can't be settled here
// — it depends on its language relative to the line it trails — so phase 2
// (classifyOneLine) decides and re-attaches it when it turns out to be part of
// the French, as in "Il est parti (enfin !)".
// -----------------------------

// A speaker tag: a name at the start of a row, an optional parenthetical gloss
// of that name, then a colon. Widened from an earlier letters-only, 12-char
// pattern that "CAISSIER (CASHIER):" failed on two counts — the space and the
// parenthetical both broke the run before the colon.
const SPEAKER_RE = /^\s*([\p{L}][\p{L}\p{M} .'’-]{0,23}?)\s*(?:\([^)]*\))?\s*:\s/u;
// The same tag alone on its row, which is how podcast and interview
// transcripts are usually laid out:
//     Judith:
//     [0:17] Bonjour les amis…
// It names the speaker of the rows that FOLLOW it and is not itself speech.
// SPEAKER_RE can't do this job: it requires whitespace after the colon, and
// here the colon ends the row — which is why a whole transcript used to come
// back with no speakers at all.
const SPEAKER_ONLY_RE = /^\s*([\p{L}][\p{L}\p{M} .'’-]{0,23}?)\s*(?:\([^)]*\))?\s*:\s*$/u;
// A row that is entirely parenthesised is a stage direction, not speech.
const NOTE_RE = /^\s*\(([^)]*)\)\s*$/;
// The other way a two-party exchange gets marked, naming nobody.
const DASH_RE = /^\s*[-–—•]\s+/;
// A trailing parenthetical: candidate gloss, confirmed in phase 2.
const TRAILING_PAREN_RE = /\s*\(([^)]+)\)\s*$/;
// A transcript timestamp at the head of a row — "[0:17]", "(1:02:33)", "0:28".
// Stripped and discarded: it's a cue for finding the spot in the audio, and
// read aloud it is just noise in the middle of a sentence.
const TIMESTAMP_RE = /^\s*[[(]?\d{1,2}:\d{2}(?::\d{2})?[\])]?\s*/;
// Terminal punctuation — used to tell a section heading from a sentence.
const ENDS_SENTENCE_RE = /[.!?…:;]["'»)\]]?\s*$/;

// "CAISSIER (CASHIER)" and "CAISSIER" have to collapse to one speaker, or the
// roster shows two and half the lines get assigned to a phantom.
function speakerKey(name) {
  return name.trim().toUpperCase().replace(/\s+/g, " ");
}

// Does a tag look like somebody's name rather than a label in prose? ALL CAPS,
// or a single capitalised word.
//
// MUST be given the ORIGINAL casing. Checking a normalised name makes every
// tag look ALL CAPS, and "Il a dit : bonjour" sails straight through — which
// is exactly what it did the first time this was written.
function looksLikeName(raw) {
  const t = raw.trim();
  if (t.length >= 2 && /^\p{Lu}[\p{Lu}\p{M} .'’-]+$/u.test(t)) return true;
  return !/\s/.test(t) && /^\p{Lu}/u.test(t);
}

// French writes "Il a dit : bonjour", so SPEAKER_RE on its own finds speakers
// in ordinary prose. Corroboration is what separates a cast from a colon: a
// real dialogue either has somebody who speaks twice, or is made entirely of
// name-shaped tags. A lone "Note:" in a passage satisfies neither.
function tagsAreReal(tags) {
  if (tags.length < 2) return false;
  const counts = new Map();
  const firstRaw = new Map();
  for (const t of tags) {
    counts.set(t.key, (counts.get(t.key) || 0) + 1);
    if (!firstRaw.has(t.key)) firstRaw.set(t.key, t.raw);
  }
  if ([...counts.values()].some((c) => c >= 2)) return true;
  return counts.size >= 2 && [...firstRaw.values()].every(looksLikeName);
}

function makeLine(text, { speaker = null, isNote = false, glossCandidate = null, hadDash = false } = {}) {
  return {
    text,
    speaker, // normalised name, or null when the row carried no tag
    isNote, // stage direction: displayed, never spoken, never scored
    glossCandidate, // trailing parenthetical awaiting phase 2's verdict
    glossLikely: false, // set in parseLines from the document-wide ratio
    // A dash marks an exchange without naming anybody. It still has to count
    // as a marker, or a dash dialogue reads as a solo passage — which is
    // exactly what happened when `hadMarker` was replaced by `speaker`.
    hadDash,
    lang: null,
    reference: null, // what the USER must say on their turns
    gloss: null, // the other-language text, for display
    role: null, // "user" | "app" | "note"
    attempts: [],
    repeats: 0,
    repeatBudget: 0,
    heardAny: false,
    cleared: false,
    struggled: false,
    skipped: false,
    busy: false // mid re-translate after a ready-screen edit
  };
}

// Pull a trailing parenthetical off a row, unless doing so would empty it.
function splitTrailingParen(text) {
  const m = TRAILING_PAREN_RE.exec(text);
  if (!m) return { body: text, glossCandidate: null };
  const body = text.slice(0, m.index).trim();
  if (!body) return { body: text, glossCandidate: null };
  return { body, glossCandidate: m[1].trim() };
}

// A speaking turn long enough to outrun the mic. MAX_LISTEN_MS is 30s and
// unhurried French runs ~150 wpm, so ~75 words is the hard ceiling — this
// sits well under it, because a single score for a minute of speech tells a
// learner nothing about which part went wrong. Transcripts are where this
// bites: a podcast monologue is one "turn" of 120+ words.
const MAX_TURN_WORDS = 30;

function countWords(text) {
  return String(text || "").split(/\s+/).filter(Boolean).length;
}

// Break an over-long turn at sentence boundaries, packing sentences up to the
// budget. The speaker is carried onto every piece, so a split monologue is
// still that person's to say.
function splitLongTurns(lines) {
  const out = [];
  for (const line of lines) {
    // A line carrying its own translation can't be split: the two halves are
    // a pair, and half a sentence has no matching half of the gloss.
    if (line.isNote || line.glossCandidate || countWords(line.text) <= MAX_TURN_WORDS) {
      out.push(line);
      continue;
    }
    const sentences = line.text
      .split(/(?<=[.!?…])\s+/)
      .map((t) => t.trim())
      .filter(Boolean);
    // One enormous sentence can't be broken without inventing a boundary.
    if (sentences.length < 2) {
      out.push(line);
      continue;
    }
    let buf = [];
    let n = 0;
    const flush = () => {
      if (buf.length) out.push(makeLine(buf.join(" "), { speaker: line.speaker }));
      buf = [];
      n = 0;
    };
    for (const sentence of sentences) {
      const w = countWords(sentence);
      if (n && n + w > MAX_TURN_WORDS) flush();
      buf.push(sentence);
      n += w;
    }
    flush();
  }
  return out;
}

// Is this a document that glosses itself? A textbook dialogue puts a
// translation after EVERY line; an isolated parenthetical is far more likely
// to be part of the sentence ("Il est parti (enfin !)").
//
// This matters because detectLang() returns its default when a snippet has no
// evidence either way, and short glosses routinely have none — "Excuse me,
// ma'am." scores +1 for "ma" and -1 for "am" and lands on exactly zero. Which
// way to break that tie is a document-level question, not a line-level one.
function markGlossLikely(lines) {
  const spoken = lines.filter((l) => !l.isNote);
  const withParen = spoken.filter((l) => l.glossCandidate).length;
  const likely = spoken.length > 0 && withParen >= Math.ceil(spoken.length / 2);
  for (const l of lines) l.glossLikely = likely && !!l.glossCandidate;
  return lines;
}

function parseLines(text) {
  const raw = String(text || "");
  const rows = raw
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Gather the cast before deciding whether to believe in it. Both layouts
  // count: "VOUS: text" inline, and "Judith:" alone above its lines.
  const tags = [];
  for (const row of rows) {
    if (NOTE_RE.test(row)) continue;
    const m = SPEAKER_ONLY_RE.exec(row) || SPEAKER_RE.exec(row);
    if (m) tags.push({ raw: m[1].trim(), key: speakerKey(m[1]) });
  }
  const tagged = tagsAreReal(tags);
  const anyDash = rows.some((r) => DASH_RE.test(r));

  // Nothing marks this as an exchange, so every newline is just line-wrap:
  // treat the whole thing as one passage and sentence-split it.
  if (rows.length <= 1 || (!tagged && !anyDash)) {
    const passage = raw
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => {
        const { body, glossCandidate } = splitTrailingParen(t);
        return makeLine(body, { glossCandidate });
      });
    return splitLongTurns(markGlossLikely(passage));
  }

  let lastSpeaker = null;
  const out = [];
  rows.forEach((row, i) => {
    // A row that is nothing but a tag names whoever speaks next; it is not
    // itself a line, so it produces no turn.
    const only = tagged ? SPEAKER_ONLY_RE.exec(row) : null;
    if (only) {
      lastSpeaker = speakerKey(only[1]);
      return;
    }

    const note = NOTE_RE.exec(row);
    if (note) {
      out.push(makeLine(note[1].trim(), { isNote: true }));
      return;
    }

    const m = tagged ? SPEAKER_RE.exec(row) : null;
    let speaker;
    let body;
    let dashed = false;
    if (m) {
      speaker = speakerKey(m[1]);
      body = row.slice(m[0].length);
      lastSpeaker = speaker;
    } else {
      dashed = DASH_RE.test(row);
      body = row.replace(DASH_RE, "");
      // An untagged row following a tagged one is a wrapped continuation of
      // that speech, not a new voice. In a dash-marked dialogue nothing is
      // ever named, so this stays null and mode logic assigns the roles.
      speaker = lastSpeaker;

      // …unless it's a section heading. A transcript breaks itself up with
      // bare labels ("Message d'un auditeur"), which are structure, not
      // speech — and would otherwise be read aloud in the previous speaker's
      // voice. The tell is that it finishes no sentence and the next row
      // introduces somebody.
      const next = rows[i + 1];
      if (
        tagged &&
        !ENDS_SENTENCE_RE.test(row) &&
        next &&
        (SPEAKER_ONLY_RE.test(next) || SPEAKER_RE.test(next))
      ) {
        out.push(makeLine(row.replace(TIMESTAMP_RE, "").trim(), { isNote: true }));
        return;
      }
    }

    body = body.replace(TIMESTAMP_RE, "");
    const split = splitTrailingParen(body.trim());
    if (!split.body) return; // a row that was only a timestamp
    out.push(makeLine(split.body, { speaker, glossCandidate: split.glossCandidate, hadDash: dashed }));
  });
  return splitLongTurns(markGlossLikely(out));
}

async function startSession(text) {
  const parsed = parseLines(text);
  if (parsed.length < 2) {
    session = null;
    renderAll("Paste a dialogue or passage with at least two lines.");
    return;
  }

  sessionSeq++;
  const seq = sessionSeq;
  abortAudio();
  session = {
    mode: null,
    solo: false,
    userStartsFirst: false,
    idx: 0,
    state: "classifying",
    classifyProgress: 0,
    pauseReason: null,
    consecutiveSilentLines: 0,
    speakers: [], // ordered cast, filled by deriveSession()
    userSpeakers: new Set(), // which of them are the user's to speak
    lines: parsed
  };
  renderAll();

  if (!(await classifyLines(seq))) return;
  deriveSession();
  session.state = "ready";
  renderAll();
}

// One TRANSLATE per line, sequential: the response's sourceLang classifies
// the line (fr vs en) AND supplies the Mode B reference / display gloss in
// the same call. The 7d translation cache makes repeat sessions instant.
// Returns false if the session was abandoned or classification failed —
// callers must bail without touching `session` further in that case.
async function classifyLines(seq) {
  for (let i = 0; i < session.lines.length; i++) {
    if (sessionSeq !== seq || !session) return false;
    const line = session.lines[i];
    if (!(await classifyOneLine(line))) {
      session = null;
      renderAll("Couldn't prepare the session (translation failed) — try again in a moment.");
      return false;
    }
    if (sessionSeq !== seq || !session) return false;
    session.classifyProgress = i + 1;
    renderAll();
  }
  return true;
}

async function detectLangOf(text, defaultLang) {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "DETECT_LANG", text, defaultLang });
    return resp?.lang || null;
  } catch (err) {
    console.warn("[FLA practice] detect failed", err);
    return null;
  }
}

async function classifyOneLine(line) {
  // A stage direction is never spoken or scored, so it needs no language and
  // no translation at all.
  if (line.isNote) {
    line.lang = null;
    line.reference = null;
    line.gloss = null;
    return true;
  }

  // Phase 2 of parsing: decide what the trailing parenthetical actually was.
  // A gloss is in the OTHER language; "Il est parti (enfin !)" is not a gloss
  // and has to be put back before anything else looks at the line.
  if (line.glossCandidate) {
    const mainLang = await detectLangOf(line.text);
    // detectLang() returns its DEFAULT whenever a snippet carries no evidence
    // either way, and short glosses routinely carry none — "Excuse me,
    // ma'am." scores +1 for "ma" and -1 for "am" and lands on exactly zero,
    // so it came back French and got merged into the French line.
    //
    // Which way to break that tie is a document-level question (see
    // markGlossLikely): where most lines carry a trailing parenthetical the
    // text is glossing itself, and an ambiguous one is the translation. Where
    // only one line has it, it is far more likely part of the sentence.
    const fallback = line.glossLikely ? (mainLang === "en" ? "fr" : "en") : mainLang;
    const parenLang = await detectLangOf(line.glossCandidate, fallback);
    if (mainLang && parenLang && mainLang !== parenLang) {
      line.lang = mainLang;
      // The author supplied both halves, so no machine translation is needed
      // — and a human rendering is a better reference to be scored against
      // than one machine guess among many.
      if (mainLang === "en") {
        line.reference = line.glossCandidate; // the French to produce
        line.gloss = line.text;
      } else {
        line.reference = line.text; // verbatim reading
        line.gloss = line.glossCandidate;
      }
      line.glossCandidate = null;
      return true;
    }
    // Not a gloss after all — it belongs to the line.
    line.text = `${line.text} (${line.glossCandidate})`;
    line.glossCandidate = null;
  }

  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: "TRANSLATE", text: line.text });
  } catch (err) {
    console.error("[FLA practice] classify failed", err);
    resp = null;
  }
  if (!resp || resp.error || !resp.translation) return false;
  line.lang = resp.sourceLang;
  if (line.lang === "en") {
    line.reference = resp.translation; // the French the user should produce
    line.gloss = line.text;
  } else {
    line.reference = line.text; // verbatim reading
    line.gloss = resp.translation;
  }
  return true;
}

// Re-run after classification and after every ready-screen edit: mode, solo
// and role assignment all depend on the current set of lines, not just the
// original paste.
// Speaker names a dialogue uses for the learner's own part. Matched on the
// normalised key, so "Vous:" and "VOUS:" are the same.
const SELF_SPEAKERS = new Set(["VOUS", "TU", "MOI", "YOU", "ME", "A", "STUDENT", "ÉLÈVE", "ELEVE"]);

function deriveSession() {
  const spoken = session.lines.filter((l) => !l.isNote);
  if (spoken.every((l) => l.lang === "fr")) session.mode = "A";
  else if (spoken.every((l) => l.lang === "en")) session.mode = "C";
  else session.mode = "B";

  // The cast, in the order they first speak.
  const seen = [];
  for (const l of spoken) {
    if (l.speaker && !seen.includes(l.speaker)) seen.push(l.speaker);
  }
  session.speakers = seen;

  // Keep any assignment the user already made on the roster; only seed it the
  // first time, or when editing introduced a speaker nobody has ruled on.
  if (!session.userSpeakers) session.userSpeakers = new Set();
  for (const name of [...session.userSpeakers]) {
    if (!seen.includes(name)) session.userSpeakers.delete(name);
  }
  if (seen.length && session.userSpeakers.size === 0) {
    const self = seen.filter((n) => SELF_SPEAKERS.has(n));
    // Recognised "you" wins. Otherwise leave it EMPTY rather than guessing —
    // renderResult() gates Begin on this and asks, since picking the wrong
    // half means practising the wrong half of the conversation.
    self.forEach((n) => session.userSpeakers.add(n));
  }

  const anyMarker = seen.length > 0 || session.lines.some((l) => l.speaker || l.hadDash);
  const firstLang = spoken[0]?.lang;
  const allSameLang = spoken.every((l) => l.lang === firstLang);
  session.solo = !anyMarker && allSameLang;

  assignRoles();
}

function assignRoles() {
  session.lines.forEach((line, i) => {
    // A stage direction is never spoken by anyone and never scored.
    if (line.isNote) {
      line.role = "note";
      return;
    }

    // Speaker tags answer "who says this" directly, so when the dialogue has a
    // cast they decide the roles outright. Mode only decides how a turn is
    // SCORED (via isTranslateTurn, which is language-driven) — the two were
    // conflated before, which is why a tagged dialogue got its turns assigned
    // by alternation or by the language of each line.
    if (session.speakers.length && line.speaker) {
      line.role = session.userSpeakers.has(line.speaker) ? "user" : "app";
      return;
    }

    if (session.mode === "A") {
      // A solo French passage has nothing marking it as two-party, so nothing
      // alternates — every line is the user's to read. Otherwise, alternating
      // turns; app takes lines 0,2,4… unless roles are swapped.
      line.role = session.solo ? "user" : i % 2 === (session.userStartsFirst ? 0 : 1) ? "user" : "app";
    } else if (session.mode === "C") {
      // Nothing for the app to read — every line is the user's to render
      // into French. A translation drill rather than a conversation.
      line.role = "user";
    } else {
      line.role = line.lang === "en" ? "user" : "app";
    }
  });
}

/** The speaker a newly added line should default to: whoever isn't speaking
 *  on the line above it. You add a line to a dialogue to write a reply. */
function nextSpeakerFor(index) {
  const cast = session?.speakers || [];
  if (cast.length < 2) return cast[0] || null;
  for (let i = index - 1; i >= 0; i--) {
    const prev = session.lines[i];
    if (prev && !prev.isNote && prev.speaker) {
      const at = cast.indexOf(prev.speaker);
      return cast[(at + 1) % cast.length];
    }
  }
  return cast[0];
}

// A turn where the user must produce French from an English prompt. The
// reference is a machine translation — one valid rendering among many — so
// these are scored leniently, labelled as a suggestion, and never revealed
// mid-attempt. True in Mode C always, and in Mode B for the English lines.
function isTranslateTurn(line) {
  return line.lang === "en";
}

function resetAttempts() {
  session.lines.forEach((line) => {
    line.attempts = [];
    line.repeats = 0;
    line.repeatBudget = 0;
    line.heardAny = false;
    line.cleared = false;
    line.struggled = false;
    line.skipped = false;
  });
  session.idx = 0;
  session.consecutiveSilentLines = 0;
}

function stopToSetup() {
  sessionSeq++;
  abortAudio();
  session = null;
  editingLine = null;
  renderAll();
}

function abortAudio() {
  if (activeRecognition) {
    try {
      activeRecognition.abort();
    } catch {}
    activeRecognition = null;
  }
  stopMeter();
  window.speechSynthesis.cancel();
}

// -----------------------------
// Ready-screen editing
//
// Only available before Begin Practice. An edit re-runs TRANSLATE for that
// line alone (cached, on-device, cheap) and re-derives mode/solo/roles —
// editing the last English line of a mixed dialogue into French can turn a
// Mode B session into a Mode A one, and a French passage that gains an
// English line stops being solo even though nothing gained a marker.
// -----------------------------

function beginEdit(index) {
  if (!session || session.state !== "ready") return;
  editingLine = index;
  renderAll();
}

async function commitEdit(index, rawText) {
  const line = session?.lines[index];
  if (!session || !line) return;
  editingLine = null;
  const text = rawText.trim();
  if (!text) {
    deleteLine(index);
    return;
  }
  if (text === line.text) {
    renderAll();
    return;
  }
  line.busy = true;
  renderAll();
  // classifyOneLine only reads .text and writes .lang/.reference/.gloss, so a
  // throwaway probe keeps a failed lookup from half-overwriting the real line.
  const probe = { text };
  const ok = await classifyOneLine(probe);
  // The line list may have changed shape (deleted, session torn down) while
  // the TRANSLATE round-trip was in flight.
  if (!session || session.lines[index] !== line) return;
  line.busy = false;
  if (!ok) {
    renderAll("Couldn't translate that line — left unchanged.");
    return;
  }
  line.text = text;
  line.lang = probe.lang;
  line.reference = probe.reference;
  line.gloss = probe.gloss;
  deriveSession();
  renderAll();
}

function deleteLine(index) {
  if (!session || session.state !== "ready" || session.lines.length <= 2) return;
  session.lines.splice(index, 1);
  editingLine = null;
  deriveSession();
  renderAll();
}

function addLine() {
  if (!session || session.state !== "ready") return;
  session.lines.push(makeLine("", { speaker: nextSpeakerFor(session.lines.length) }));
  editingLine = session.lines.length - 1;
  renderAll();
}

// -----------------------------
// Mic level meter
//
// SpeechRecognition gives no signal at all until it has decoded words, so a
// mis-selected input device looks exactly like a user who hasn't spoken yet.
// A second, parallel getUserMedia stream drives a live level graph purely so
// the user can see their voice arriving. It is decorative and best-effort:
// recognition is never blocked on it, and any failure here just hides the
// canvas. (Chrome lets the two captures coexist — Web Speech does its own.)
// -----------------------------

const METER_BARS = 48;
const METER_GAIN = 3.5; // speech RMS is small; scale it to fill the canvas
const SILENT_RMS = 0.012; // below this is room noise, not speech
const SILENT_LEVEL = SILENT_RMS * METER_GAIN; // the same cutoff, post-gain
// How long the mic must stay quiet before the "no sound reaching the
// microphone" hint appears. Deliberately longer than the gap a learner leaves
// while working out what to say: the hint is about a broken input device, and
// showing it over an ordinary pause tells the user their mic is wrong when it
// isn't. It still lands before FIRST_SPEECH_MS ends the turn as silence.
const SILENT_WARN_MS = 4500;
// Frames of above-cutoff audio that count as "this mic works". A couple of
// stray loud frames are a door or a keystroke; a handful in a row is a voice.
const SPEECH_FRAMES = 5;

let meter = null;
let meterSeq = 0; // bumped by stopMeter, so a slow getUserMedia can tell it's stale

async function startMeter() {
  const canvas = $("practiceWave");
  if (!canvas || meter) return;
  const seq = ++meterSeq;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    console.warn("[FLA practice] mic meter unavailable", err);
    return;
  }
  // The turn can end while getUserMedia is still resolving — don't leave a
  // hot mic behind if stopMeter() already ran.
  if (seq !== meterSeq) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const audio = new AudioContext();
  // Created after an await, so it's outside the click's gesture window and
  // Chrome may hand it back suspended — a suspended graph never runs, and the
  // meter would sit flat while the mic is working perfectly.
  audio.resume().catch(() => {});
  const analyser = audio.createAnalyser();
  analyser.fftSize = 1024;
  audio.createMediaStreamSource(stream).connect(analyser);

  meter = {
    stream,
    audio,
    analyser,
    buf: new Uint8Array(analyser.fftSize),
    levels: new Array(METER_BARS).fill(0),
    raf: 0,
    lastLoudAt: Date.now(),
    loudFrames: 0,
    heardSpeech: false, // sound arrived at some point in THIS turn
    canvas
  };
  canvas.hidden = false;
  sizeCanvas(canvas);
  meter.raf = requestAnimationFrame(drawMeter);
}

function stopMeter() {
  meterSeq++;
  const hint = $("practiceMicHint");
  if (hint) hint.hidden = true;
  if (!meter) return;
  cancelAnimationFrame(meter.raf);
  meter.stream.getTracks().forEach((t) => t.stop());
  meter.audio.close().catch(() => {});
  meter.canvas.hidden = true;
  meter = null;
}

function sizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const h = canvas.clientHeight || 44;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

function drawMeter() {
  if (!meter) return;
  const { analyser, buf, levels, canvas } = meter;
  analyser.getByteTimeDomainData(buf);

  // RMS of the frame, scaled — one bar per frame, scrolling right to left.
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / buf.length);
  levels.push(Math.min(1, rms * METER_GAIN));
  if (levels.length > METER_BARS) levels.shift();

  if (rms >= SILENT_RMS) {
    meter.lastLoudAt = Date.now();
    if (++meter.loudFrames >= SPEECH_FRAMES) meter.heardSpeech = true;
  } else {
    meter.loudFrames = 0;
  }

  // The hint only ever means "this mic isn't picking anything up", so it is
  // shown only while that's still the live question: once a voice has arrived
  // this turn the device is proven, and the quiet that follows is the user
  // having finished speaking (the turn ends on that silence anyway) — warning
  // then was the hint appearing immediately after every answer.
  const quietFor = Date.now() - meter.lastLoudAt;
  const hint = $("practiceMicHint");
  if (hint) {
    hint.hidden = meter.heardSpeech || quietFor < SILENT_WARN_MS;
    if (!hint.hidden) {
      hint.textContent =
        "No sound reaching the microphone — check the input device Chrome is using.";
    }
  }

  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const mid = h / 2;
  ctx.clearRect(0, 0, w, h);

  const slot = w / METER_BARS;
  const barW = Math.max(1, slot * 0.55);
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const barH = Math.max(2, level * (h - 4));
    // Fresher bars (right edge) read as "now", faded ones as history.
    const age = i / METER_BARS;
    ctx.fillStyle =
      level >= SILENT_LEVEL
        ? `rgba(74, 144, 226, ${0.35 + age * 0.65})`
        : `rgba(180, 180, 180, ${0.25 + age * 0.35})`;
    ctx.fillRect(i * slot + (slot - barW) / 2, mid - barH / 2, barW, barH);
  }

  meter.raf = requestAnimationFrame(drawMeter);
}

// -----------------------------
// Turn loop
//
// Fully automatic once Begin Practice is pressed: app lines are read, user
// lines run pre-roll → listen → resolve, and the loop advances itself. The
// only manual controls left are Skip / Pause / Stop.
// -----------------------------

// Puts the session in `state` for `ms`, then reports back whether the wait
// completed undisturbed. Powers every auto-advancing beat (pre-roll, the
// repeat/struggled reveal, the wordless pause after a clear) with one shared
// implementation: if the session is paused, replaced, or torn down mid-wait,
// this resolves false and the caller must stop rather than continue as if
// nothing happened. A pause always replays a beat from the top on resume —
// there is no attempt to resume a partial countdown, which would be more
// confusing than starting over.
async function timedState(seq, state, ms) {
  session.state = state;
  renderAll();
  await delay(ms);
  return sessionSeq === seq && !!session && session.state === state;
}

async function nextTurn() {
  const seq = sessionSeq;
  while (session && sessionSeq === seq) {
    if (session.idx >= session.lines.length) {
      session.state = "done";
      renderAll();
      return;
    }
    const line = session.lines[session.idx];

    // A stage direction — "(You return)" — is scene context, not speech.
    // Nobody reads it and nothing is scored against it; it stays visible in
    // the list and the loop steps over it.
    if (line.role === "note") {
      session.idx++;
      continue;
    }

    if (line.role === "app") {
      session.state = "app-speaking";
      renderAll();
      await speakAsync(line.text, line.lang);
      // A pause cancels the utterance, which resolves speakAsync — the state
      // check keeps a paused session from advancing/speaking underneath.
      if (sessionSeq !== seq || !session || session.state !== "app-speaking") return;
      await delay(350);
      if (sessionSeq !== seq || !session || session.state !== "app-speaking") return;
      session.idx++;
      continue;
    }

    if (!(await timedState(seq, "pre-roll", PRE_ROLL_MS))) return;
    if (sessionSeq !== seq || !session) return;

    const outcome = await runListenAttempt(seq, line);
    if (outcome === "paused") return; // pauseSession() already rendered

    if (outcome === "cleared") {
      if (!(await timedState(seq, "cleared-pause", CLEARED_PAUSE_MS))) return;
      session.idx++;
      continue;
    }
    if (outcome === "repeat") {
      if (!(await timedState(seq, "repeat", REPEAT_REVEAL_MS))) return;
      continue; // same idx — one more attempt
    }
    if (outcome === "struggled") {
      if (!(await timedState(seq, "struggled-pause", STRUGGLED_PAUSE_MS))) return;
      session.idx++;
      continue;
    }
  }
}

// Runs one listen for the current line and resolves it against ADVANCE_GATE.
// Returns "cleared" | "repeat" | "struggled" | "paused".
async function runListenAttempt(seq, line) {
  session.state = "listening";
  renderAll();
  startMeter(); // best-effort, deliberately not awaited — recognition starts now
  const res = await listenOnce({
    reference: line.reference,
    onProgress: (text) => renderLiveProgress(line, text)
  });
  stopMeter();
  if (sessionSeq !== seq || !session || session.state !== "listening") return "paused";

  // A hard recognition failure (not simple silence) means the session can't
  // hear anything at all — better to stop and say so than march on scoring
  // every remaining line at zero.
  if (res.error && res.error !== "no-speech" && res.error !== "aborted") {
    if (res.error === "not-allowed" || res.error === "service-not-allowed") {
      micPermission = "denied";
      micModalDismissed = false; // a real permission failure overrides "Not now"
    }
    pauseSession(`error:${res.error}`);
    return "paused";
  }

  const transcript = res.transcript || "";
  const heardSpeech = transcript.trim().length > 0;
  const score = heardSpeech ? pronunciationScore(line.reference, transcript) : 0;
  const diff = alignPronunciation(line.reference, transcript);
  line.attempts.push({ transcript, score, diff });
  if (heardSpeech) line.heardAny = true;

  if (score >= ADVANCE_GATE) {
    line.cleared = true;
    session.consecutiveSilentLines = 0;
    return "cleared";
  }

  // First failure sets how many more tries this line gets, from whether that
  // first attempt had any speech in it at all: silence gets one more go
  // (there's nothing to diagnose beyond "try again"), a real wrong answer
  // gets two (worth a genuine second and third crack at it).
  if (line.attempts.length === 1) line.repeatBudget = heardSpeech ? 2 : 1;

  if (line.repeats < line.repeatBudget) {
    line.repeats++;
    return "repeat";
  }

  line.struggled = true;
  if (line.heardAny) {
    session.consecutiveSilentLines = 0;
  } else {
    session.consecutiveSilentLines++;
    if (session.consecutiveSilentLines >= 2) {
      pauseSession("silence");
      return "paused";
    }
  }
  return "struggled";
}

function pauseSession(reason) {
  if (!session) return;
  abortAudio();
  if (session.state !== "done" && session.state !== "classifying" && session.state !== "ready") {
    session.state = "paused";
    session.pauseReason = reason;
  }
  renderAll();
}

function onResume() {
  if (!session || session.state !== "paused") return;
  session.pauseReason = null;
  session.consecutiveSilentLines = 0;
  const line = session.lines[session.idx];
  if (!line) {
    session.state = "done";
    renderAll();
    return;
  }
  // A line already resolved (cleared or struggled) before the pause landed —
  // e.g. paused during the brief pause/reveal that follows either — is done;
  // without this, resuming would re-run pre-roll/listen on a line that
  // already spent its repeat budget. nextTurn() replays every other beat
  // (pre-roll, a reveal) from the top for whatever comes next.
  const finished = line.cleared || line.struggled || line.skipped;
  if (finished && session.idx < session.lines.length) session.idx++;
  nextTurn();
}

// Works from any live state — app-speaking, pre-roll, listening, or a
// repeat/struggled reveal — since every one of those is scoped to the
// current line and jumping to session.idx + 1 is correct from any of them.
function onSkip() {
  if (!session) return;
  if (!["app-speaking", "pre-roll", "listening", "repeat", "struggled-pause"].includes(session.state)) return;
  abortAudio();
  const line = session.lines[session.idx];
  if (line?.role === "user" && !line.cleared) line.skipped = true;
  session.idx++;
  nextTurn();
}

function onListen(rate) {
  if (!session) return;
  const line = session.lines[session.idx];
  if (line?.reference) speakAsync(line.reference, "fr", rate);
}

// Slower than config.slowSpeech's 0.7 — this one is for picking a phrase
// apart syllable by syllable after getting it wrong.
const DRILL_SLOW_RATE = 0.5;

// -----------------------------
// Speech APIs
// -----------------------------

// `rate` overrides config.slowSpeech for the drill playback buttons, where
// the user is asking for a specific speed rather than their usual one.
async function speakAsync(text, lang, rate) {
  // Unlike the older speak() helpers, this honors config.slowSpeech.
  const { config = {} } = await chrome.storage.local.get("config");
  return new Promise((resolve) => {
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = lang === "en" ? "en-US" : "fr-FR";
    utter.rate = rate ?? (config.slowSpeech ? 0.7 : 0.9);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    utter.onend = finish;
    utter.onerror = finish;
    window.speechSynthesis.speak(utter);
  });
}

function listenOnce({ reference, onProgress }) {
  return new Promise((resolve) => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      resolve({ error: "unsupported" });
      return;
    }
    const rec = new SR();
    activeRecognition = rec;
    rec.lang = "fr-FR";
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    rec.continuous = true;

    let transcript = ""; // everything heard so far, finals + live interim
    let heardSpeech = false;
    let settled = false;
    let silenceTimer = null;
    let firstSpeechTimer = null;
    let hardTimer = null;

    const settle = (v) => {
      if (settled) return;
      settled = true;
      if (activeRecognition === rec) activeRecognition = null;
      clearTimeout(silenceTimer);
      clearTimeout(firstSpeechTimer);
      clearTimeout(hardTimer);
      resolve(v);
    };

    // stop() flushes what's pending and fires onend; abort() throws it away.
    // Ending a turn should always keep what the user already said.
    const endTurn = () => {
      try {
        rec.stop();
      } catch {
        settle(transcript ? { transcript } : { error: "aborted" });
      }
    };

    // Of the recognizer's alternatives for a settled segment, keep the one
    // closest to what the user was supposed to say — softens ASR noise
    // without inventing words the user never said.
    const bestAlternative = (result) => {
      let best = result[0].transcript;
      let bestScore = -1;
      for (let i = 0; i < result.length; i++) {
        const sc = pronunciationScore(reference, result[i].transcript);
        if (sc > bestScore) {
          bestScore = sc;
          best = result[i].transcript;
        }
      }
      return best;
    };

    rec.onresult = (e) => {
      // In continuous mode e.results accumulates every segment of the turn,
      // so the full transcript is rebuilt from scratch on each event.
      let out = "";
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        out += `${r.isFinal ? bestAlternative(r) : r[0].transcript} `;
      }
      transcript = out.trim();
      if (transcript) {
        heardSpeech = true;
        clearTimeout(firstSpeechTimer);
      }
      onProgress?.(transcript);
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(endTurn, SILENCE_END_MS);
    };

    rec.onerror = (e) => {
      // Chrome reports "no-speech" for the trailing silence that ends a turn,
      // and "aborted" for our own stop() — neither is a failure if the user
      // already said something. Let onend resolve with the transcript.
      if ((e.error === "no-speech" || e.error === "aborted") && transcript) return;
      settle({ error: e.error });
    };

    rec.onend = () => {
      settle(transcript ? { transcript } : { error: "no-speech" });
    };

    firstSpeechTimer = setTimeout(() => {
      if (!heardSpeech) endTurn();
    }, FIRST_SPEECH_MS);
    hardTimer = setTimeout(endTurn, MAX_LISTEN_MS);

    try {
      rec.start();
    } catch (err) {
      settle({ error: err.name || "start-failed" });
    }
  });
}

async function refreshMicPermission() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    micPermission = status.state;
    status.onchange = () => {
      // Fires when the user grants via permission/grant-mic.html in another
      // tab — un-gates the UI without needing a panel reload.
      micPermission = status.state;
      renderAll();
    };
  } catch {
    micPermission = "prompt"; // can't query — let recognition itself surface errors
  }
}

// -----------------------------
// Rendering
// -----------------------------

function renderAll(notice) {
  const setup = $("practiceSetup");
  const sess = $("practiceSession");
  if (!setup || !sess) return; // not on a page that hosts the practice UI

  setup.hidden = !!session;
  sess.hidden = !session;
  renderMicGate();

  if (!session) {
    $("practiceNotice").innerHTML = notice ? `<div class="error">${escapeHtml(notice)}</div>` : "";
    return;
  }
  $("practiceNotice").innerHTML = "";

  if (session.state === "ready") renderReadyLines();
  else renderLines();
  renderControls();
  renderResult(notice);
}

// The running/finished view — one line per row, current line highlighted,
// pre-roll's countdown wipe applied to whichever line is about to be heard.
function renderLines() {
  const container = $("practiceLines");
  const preRollNow = session.state === "pre-roll";
  container.innerHTML = session.lines
    .map((line, i) => {
      const finished = line.cleared || line.struggled || line.skipped;
      const isCurrent = i === session.idx && session.state !== "done";
      const cls = [
        "pline",
        isCurrent ? "current" : "",
        isCurrent && preRollNow ? "pre-roll" : "",
        finished ? "finished" : ""
      ]
        .filter(Boolean)
        .join(" ");
      // A stage direction has no voice, no language and no turn — it renders
      // as scene context and nothing else.
      if (line.role === "note") {
        return `
          <div class="pline pline--note" data-line="${i}">
            <span class="pline-text">${escapeHtml(line.text)}</span>
          </div>
        `;
      }
      const roleIcon = line.role === "user" ? "🎤" : "🔊";
      // The icon answers the only question that matters mid-turn — am I
      // speaking? — so it stays, and the name sits beside it as context.
      const who = line.speaker
        ? `<span class="pline-speaker">${escapeHtml(line.speaker)}</span>`
        : "";
      const status = finished ? `<span class="pline-check" aria-hidden="true">✓</span>` : "";
      const gloss =
        line.role === "app" && line.gloss ? `<div class="pline-gloss">${escapeHtml(line.gloss)}</div>` : "";
      const instruction =
        isCurrent && (session.state === "pre-roll" || session.state === "listening")
          ? `<div class="pline-instruction">${isTranslateTurn(line) ? "Say this in French" : "Read this aloud"}</div>`
          : "";
      return `
        <div class="${cls}" data-line="${i}">
          <span class="pline-role">${roleIcon}</span>
          ${who}
          <span class="pline-lang">${line.lang || "…"}</span>
          <span class="pline-text">${escapeHtml(line.text)}${status}${gloss}${instruction}</span>
        </div>
      `;
    })
    .join("");
  container.querySelector(".pline.current")?.scrollIntoView({ block: "nearest" });

  // The wipe needs to transition FROM empty, so its "run" class is added a
  // frame after the element exists rather than baked into the string above —
  // otherwise the browser's first paint is already the end state.
  if (preRollNow) {
    requestAnimationFrame(() => {
      container.querySelector(".pline.current.pre-roll")?.classList.add("pre-roll--run");
    });
  }
}

// The ready screen: every line editable before Begin Practice. Click text to
// edit it in place; × deletes (minimum two lines); a trailing control adds
// one. Re-translating a line disables Begin until it resolves.
function renderReadyLines() {
  const container = $("practiceLines");
  const rows = session.lines
    .map((line, i) => {
      if (editingLine === i) {
        // The speaker selector lives in the EDITOR, not the roster: the
        // roster sets who you ARE, this sets who says a given line. A line
        // added by hand defaults to the other speaker, because you add a line
        // to a dialogue in order to write a reply.
        const picker = session.speakers.length
          ? `<select class="pline-speaker-select" data-line="${i}">
               ${session.speakers
                 .map(
                   (n) =>
                     `<option value="${escapeHtml(n)}"${n === line.speaker ? " selected" : ""}>${escapeHtml(n)}</option>`
                 )
                 .join("")}
             </select>`
          : "";
        return `
          <div class="pline pline--editing" data-line="${i}">
            ${picker}
            <input class="pline-edit-input" type="text" value="${escapeHtml(line.text)}" data-line="${i}" />
          </div>
        `;
      }
      if (line.role === "note") {
        return `
          <div class="pline pline--edit pline--note" data-line="${i}">
            <span class="pline-text" data-action="edit-line" data-line="${i}">${escapeHtml(line.text)}</span>
            <button type="button" class="pline-del" data-action="delete-line" data-line="${i}" title="Delete this line">×</button>
          </div>
        `;
      }
      // Roles are already assigned by the time the ready screen shows — same
      // icon the running view uses, so the user can see who reads what
      // before committing to Begin. A freshly added blank line has no role
      // yet (nothing to classify until it's typed in), so it gets neither.
      const roleIcon = line.lang == null ? "" : line.role === "user" ? "🎤" : "🔊";
      const who = line.speaker ? `<span class="pline-speaker">${escapeHtml(line.speaker)}</span>` : "";
      return `
        <div class="pline pline--edit" data-line="${i}">
          <span class="pline-role">${roleIcon}</span>
          ${who}
          <span class="pline-lang">${line.lang || "…"}</span>
          <span class="pline-text" data-action="edit-line" data-line="${i}">${
            line.busy ? "…" : escapeHtml(line.text)
          }</span>
          <button
            type="button"
            class="pline-del"
            data-action="delete-line"
            data-line="${i}"
            title="Delete this line"
            ${session.lines.length <= 2 ? "disabled" : ""}
          >×</button>
        </div>
      `;
    })
    .join("");
  container.innerHTML = `${rows}<button type="button" class="pline-add" data-action="add-line">＋ line</button>`;
  if (editingLine != null) {
    const input = container.querySelector(".pline-edit-input");
    input?.focus();
    input?.select();
  }
}

// The grant flow is a gate on entering practice, not a button parked in the
// UI: a one-time setup step shouldn't occupy permanent space next to the
// controls the user actually uses every session.
function renderMicGate() {
  const modal = $("micModal");
  if (!modal) return;
  modal.hidden = micPermission === "granted" || micModalDismissed;
}

const ACTIVE_STATES = ["app-speaking", "pre-roll", "listening", "repeat", "struggled-pause", "cleared-pause"];

function renderControls() {
  const st = session.state;
  $("practicePause").hidden = !ACTIVE_STATES.includes(st);
  $("practiceSkip").hidden = !ACTIVE_STATES.includes(st);
  $("practiceStop").hidden = st === "ready";
  $("practiceStop").textContent = st === "done" ? "New text" : "■ Stop";
}

function renderResult(notice) {
  const out = $("practiceResult");
  const st = session.state;
  const line = session.lines[session.idx];
  const noticeHtml = notice ? `<div class="error">${escapeHtml(notice)}</div>` : "";

  if (st === "classifying") {
    out.innerHTML = `<div class="hint">Preparing — translating line ${session.classifyProgress}/${session.lines.length}…</div>`;
    return;
  }
  if (st === "ready") {
    const busy = session.lines.some((l) => l.busy);
    const hasCast = session.speakers.length > 0;
    // With a named cast, roles come from the roster and the alternation
    // swap is meaningless — you change who you are by tapping a speaker.
    const swapBtn =
      !hasCast && session.mode === "A" && !session.solo
        ? `<button type="button" data-action="swap" title="Swap roles">⇄</button>`
        : "";

    // Nobody recognisable as "you" — ask, rather than guessing and having the
    // user practise the wrong half of the conversation without noticing.
    const needsPick = hasCast && session.userSpeakers.size === 0;
    const roster = hasCast
      ? `<div class="proster${needsPick ? " proster--needs-pick" : ""}">
           ${session.speakers
             .map((n) => {
               const mine = session.userSpeakers.has(n);
               return `<button type="button" class="proster-chip${mine ? " is-user" : ""}"
                         data-action="toggle-speaker" data-speaker="${escapeHtml(n)}">
                         ${mine ? "🎤" : "🔊"} ${escapeHtml(n)}
                       </button>`;
             })
             .join("")}
         </div>
         <div class="hint">${
           needsPick
             ? "Tap a speaker to choose who you're practising as."
             : "Tap a speaker to change who you practise as."
         }</div>`
      : "";

    out.innerHTML = `
      ${noticeHtml}
      ${roster}
      <div class="toolbar">
        <button type="button" data-action="begin" ${busy || needsPick ? "disabled" : ""}>▶ Begin Practice</button>
        ${swapBtn}
      </div>
    `;
    return;
  }
  if (st === "app-speaking") {
    out.innerHTML = `${noticeHtml}<div class="hint">🔊 Reading…</div>`;
    return;
  }
  if (st === "pre-roll") {
    out.innerHTML = noticeHtml;
    return;
  }
  if (st === "listening") {
    // Words light up as they're recognised; the verdict waits for the end of
    // the turn. Rendered once here — renderLiveProgress() then patches these
    // two nodes in place rather than re-running renderResult on every syllable.
    out.innerHTML = `
      <div class="hint">🎙 Listening…</div>
      <div id="practiceLive" class="plive">${liveWordsHtml(line, "")}</div>
      <div id="practiceInterim" class="pinterim"></div>
    `;
    return;
  }
  if (st === "cleared-pause") {
    out.innerHTML = `<div class="pcleared">✓</div>`;
    return;
  }
  if (st === "repeat") {
    out.innerHTML = failedAttemptHtml(line, { withReplay: true });
    return;
  }
  if (st === "struggled-pause") {
    out.innerHTML = failedAttemptHtml(line, { withReplay: false, movingOn: true });
    return;
  }
  if (st === "paused") {
    out.innerHTML = `
      <div class="hint">${pauseReasonText(session.pauseReason)}</div>
      <div class="toolbar"><button type="button" data-action="resume">▶ Resume</button></div>
    `;
    return;
  }
  if (st === "done") {
    renderSummary(out);
  }
}

function pauseReasonText(reason) {
  if (reason === "silence") return "Paused — didn't hear anything. Check your microphone input device.";
  if (reason === "error:not-allowed" || reason === "error:service-not-allowed")
    return "Microphone access is blocked.";
  if (reason?.startsWith("error:")) return `Speech recognition error (${reason.slice(6)}) — try again.`;
  return "Session paused.";
}

// Shared by "repeat" (offers another attempt) and "struggled-pause" (budget
// spent, moving on regardless) — both reveal the model French and the last
// attempt's diff; only the framing and the presence of the listen buttons
// differ.
function failedAttemptHtml(line, { withReplay, movingOn }) {
  const last = line.attempts[line.attempts.length - 1];
  const diffHtml = last.diff.words
    .map((w) => `<span class="dw ${w.match ? "ok" : w.near ? "near" : "miss"}">${escapeHtml(w.word)}</span>`)
    .join(" ");
  const refLabel = isTranslateTurn(line) ? "Suggested translation" : "Expected";
  const said = last.transcript
    ? `<div class="hint">You said: ${escapeHtml(last.transcript)}</div>`
    : `<div class="hint">Didn't catch that.</div>`;
  const listenBtns = withReplay
    ? `<div class="toolbar">
         <button type="button" data-action="listen">🔊 Listen</button>
         <button type="button" data-action="listen-slow">🐢 Slowly</button>
       </div>`
    : "";
  return `
    <div class="pfail">${movingOn ? "Moving on." : `${Math.round(last.score * 100)}% — not quite.`}</div>
    ${movingOn ? "" : `<div class="pdiff">${diffHtml}</div>`}
    <div class="hint">${refLabel}: ${escapeHtml(line.reference)}</div>
    ${movingOn ? "" : said}
    ${listenBtns}
  `;
}

// Live word-by-word match, redrawn on every recognition update.
function liveWordsHtml(line, transcript) {
  if (!session) return "";
  // Lighting up the reference on a translate turn would hand the user the
  // French they're being asked to produce.
  if (isTranslateTurn(line)) return "";
  const { words } = alignPronunciation(line.reference, transcript);
  // Unmatched words stay neutral here, not red: mid-turn they're usually just
  // words the user hasn't reached yet. Red is for the verdict at the end.
  return words
    .map((w) => `<span class="lw ${w.match ? "ok" : "pending"}">${escapeHtml(w.word)}</span>`)
    .join(" ");
}

function renderLiveProgress(line, transcript) {
  const live = $("practiceLive");
  if (live) live.innerHTML = liveWordsHtml(line, transcript);
  const interim = $("practiceInterim");
  if (interim) interim.textContent = transcript;
}

function renderSummary(out) {
  const userLines = session.lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.role === "user");

  // The first attempt is what's reported everywhere — a later attempt, taken
  // after the French was revealed, measures whether the user could read what
  // they'd just been shown, not whether they recalled it.
  const overall = userLines.length
    ? Math.round(
        (userLines.reduce((sum, { line: l }) => sum + (l.attempts[0]?.score || 0), 0) / userLines.length) * 100
      )
    : 0;

  const missCounts = {};
  session.lines.forEach((l) => {
    l.attempts[0]?.diff.words.forEach((w) => {
      if (!w.match) missCounts[w.word] = (missCounts[w.word] || 0) + 1;
    });
  });
  const repeated = Object.entries(missCounts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]);

  const rows = userLines
    .map(({ line: l, i }) => {
      const first = l.attempts[0];
      const playBtn = `<button class="pline-play" data-action="play" data-line="${i}" title="Hear it in French">▶</button>`;
      const refRow = `<div class="prow-ref">${playBtn} ${escapeHtml(l.reference)}</div>`;

      if (!first) {
        // Skipped before any attempt was made — nothing to compare.
        return `<tr class="prow-skipped">
          <td>${escapeHtml(l.text)}${refRow}</td>
          <td>skipped</td>
        </tr>`;
      }
      const diffHtml = first.diff.words
        .map((w) => `<span class="dw ${w.match ? "ok" : w.near ? "near" : "miss"}">${escapeHtml(w.word)}</span>`)
        .join(" ");
      const tier = l.struggled ? "struggled" : first.score >= PASS_THRESHOLD[session.mode] ? "strong" : "ok";
      const tag = l.struggled ? ` <span class="prow-tag">struggled</span>` : "";
      return `<tr class="prow-${tier}">
        <td>
          ${escapeHtml(l.text)}
          ${refRow}
          <div class="prow-said">You said: ${escapeHtml(first.transcript || "—")}</div>
          <div class="pdiff">${diffHtml}</div>
        </td>
        <td>${Math.round(first.score * 100)}%${tag}</td>
      </tr>`;
    })
    .join("");

  const mistakesHtml = repeated.length
    ? `<h3>Repeated mistakes</h3><ul>${repeated
        .map(([w, n]) => `<li><b>${escapeHtml(w)}</b> — missed ${n}×</li>`)
        .join("")}</ul>`
    : `<div class="hint">No repeated mistakes — bravo!</div>`;

  out.innerHTML = `
    <h3>Session complete — ${overall}%</h3>
    <table class="psummary">${rows}</table>
    ${mistakesHtml}
    <div class="toolbar">
      <button type="button" data-action="again">Practice again</button>
      <button type="button" data-action="new">New text</button>
    </div>
  `;
}

// -----------------------------
// Wiring
// -----------------------------

function wireListeners() {
  if (listenersWired) return; // initPracticePanel() runs on every tab switch
  listenersWired = true;

  $("practiceStart").addEventListener("click", () => startSession($("practiceInput").value));
  $("micGrantBtn").addEventListener("click", () =>
    chrome.tabs.create({ url: chrome.runtime.getURL("permission/grant-mic.html") })
  );
  $("micModalDismiss").addEventListener("click", () => {
    micModalDismissed = true;
    renderMicGate();
  });
  $("practicePause").addEventListener("click", () => pauseSession("user"));
  $("practiceSkip").addEventListener("click", onSkip);
  $("practiceStop").addEventListener("click", stopToSetup);

  $("practiceInfo").addEventListener("click", () => {
    $("practiceInfoModal").hidden = false;
  });
  $("practiceInfoClose").addEventListener("click", () => {
    $("practiceInfoModal").hidden = true;
  });

  // Revealed model answers (mid-session and in the summary) carry their own ▶.
  $("practiceLines").addEventListener("click", (e) => {
    const del = e.target.closest('[data-action="delete-line"]');
    if (del) {
      deleteLine(Number(del.dataset.line));
      return;
    }
    const add = e.target.closest('[data-action="add-line"]');
    if (add) {
      addLine();
      return;
    }
    const edit = e.target.closest('[data-action="edit-line"]');
    if (edit) {
      beginEdit(Number(edit.dataset.line));
      return;
    }
    const play = e.target.closest('[data-action="play"]');
    if (play) playLineReference(play.dataset.line);
  });

  // Enter commits an edit; Escape cancels it. Delegated because the <input>
  // is re-created on every render.
  $("practiceLines").addEventListener("keydown", (e) => {
    const input = e.target.closest(".pline-edit-input");
    if (!input) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit(Number(input.dataset.line), input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      editingLine = null;
      renderAll();
    }
  });
  // blur doesn't bubble, so the container listens in the capture phase via
  // focusout instead.
  $("practiceLines").addEventListener("change", (e) => {
    const sel = e.target.closest?.(".pline-speaker-select");
    if (!sel || !session) return;
    const line = session.lines[Number(sel.dataset.line)];
    if (!line) return;
    line.speaker = sel.value;
    assignRoles();
  });

  $("practiceLines").addEventListener("focusout", (e) => {
    const input = e.target.closest?.(".pline-edit-input");
    if (!input) return;
    commitEdit(Number(input.dataset.line), input.value);
  });

  $("practiceResult").addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    const action = el?.dataset.action;
    if (!action || !session) return;
    if (action === "play") {
      playLineReference(el.dataset.line);
    } else if (action === "begin") {
      session.idx = 0;
      nextTurn();
    } else if (action === "toggle-speaker") {
      // Assignment is per SPEAKER, not per line: flipping one line would let
      // you build a dialogue where VOUS is you on line 2 and the app on
      // line 5, which is nonsense the UI shouldn't invite.
      const name = el.dataset.speaker;
      if (session.userSpeakers.has(name)) session.userSpeakers.delete(name);
      else session.userSpeakers.add(name);
      assignRoles();
      renderAll();
    } else if (action === "swap") {
      session.userStartsFirst = !session.userStartsFirst;
      assignRoles();
      renderAll();
    } else if (action === "resume") {
      onResume();
    } else if (action === "listen") {
      onListen();
    } else if (action === "listen-slow") {
      onListen(DRILL_SLOW_RATE);
    } else if (action === "again") {
      resetAttempts();
      session.state = "ready";
      renderAll();
    } else if (action === "new") {
      stopToSetup();
    }
  });
}

// -----------------------------
// Helpers
// -----------------------------

// Plays the French the user was meant to produce for a given line — the
// line's own text in Mode A, the reference translation on a translate turn.
function playLineReference(index) {
  const line = session?.lines[Number(index)];
  if (line?.reference) speakAsync(line.reference, "fr");
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
