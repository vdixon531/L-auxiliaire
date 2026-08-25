// lib/practice-panel.js
//
// Conversation-practice session for the side panel's Practice tab. The whole
// live session state machine lives here in the panel — SpeechRecognition and
// speechSynthesis are window-context UI APIs the service worker can't run —
// but translations still route through TRANSLATE messages so the service
// worker keeps owning external calls and the translation cache. Session state
// is deliberately ephemeral (module memory, nothing persisted).
//
// Caller contract (sidepanel.html must provide these IDs): practiceSetup,
// practiceInput, practiceStart, practiceNotice, practiceSession,
// practiceLines, practiceWave, practiceMicHint, micBtn, practiceDone,
// practiceListen, practiceRetry, practiceSkip, practiceStop, practiceResult,
// micModal, micGrantBtn, micModalDismiss.
//
// Two modes, inferred from the selected/pasted dialogue:
//   A — every line French: the app reads its lines aloud, the user reads
//       theirs into the mic; speech is checked against the line's own text.
//   B — mixed French/English: the app reads the French lines; each English
//       line becomes a translate-turn the user must speak in French, checked
//       (leniently — the machine translation is only ONE valid rendering)
//       against a reference translation.
//   C — every line English: Mode B with no French lines left for the app to
//       read, so every line is a translate-turn. A translation drill rather
//       than a conversation, and scored on B's lenient bar for the same reason.

import { pronunciationScore, alignPronunciation } from "./fuzzy-match.js";

const $ = (id) => document.getElementById(id);

// Scores come from fuzzy-match's pronunciation scorer, which already forgives
// spelling that French pronounces identically — so these gate on "did they
// say the right words", not "did they hit the exact letters". Mode A is
// verbatim reading, so a whole wrong word should fail; Mode B compares
// against a single machine reference among many valid translations, so
// failing correct answers would be worse for learning than passing loose ones.
// Mode C is Mode B's translate-turn all the way down, so it shares B's bar.
const PASS_THRESHOLD = { A: 0.78, B: 0.55, C: 0.55 };

// Recognition runs continuous (see listenOnce) — a turn ends when the user
// stops talking, not when Chrome finalizes its first result, which for a
// multi-word line used to score the whole line on its opening word.
const SILENCE_END_MS = 1800;
const FIRST_SPEECH_MS = 9000;
const MAX_LISTEN_MS = 30000;

let listenersWired = false;
let session = null; // null = setup screen
let sessionSeq = 0; // bumped on stop/reset so in-flight async turns abandon themselves
let activeRecognition = null;
let endTurnEarly = null; // set while listening, so the Done button can close the turn
let micPermission = "prompt"; // last known navigator.permissions state
let micModalDismissed = false; // "Not now" — don't nag again this panel lifetime

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
  abortAudio();
  if (session.state !== "ready" && session.state !== "done" && session.state !== "classifying") {
    session.state = "paused";
  }
  renderAll();
}

// -----------------------------
// Session setup
// -----------------------------

function stripSpeakerTag(s) {
  // Leading dialogue dashes/bullets, then "Marie:"-style speaker tags.
  return s.replace(/^\s*[-–—•]\s*/, "").replace(/^[A-Za-zÀ-ÿ]{1,12}\s*:\s*/, "");
}

function parseLines(text) {
  let lines = String(text || "")
    .split(/\n+/)
    .map(stripSpeakerTag)
    .map((s) => s.trim())
    .filter(Boolean);
  if (lines.length <= 1) {
    // Single block — fall back to sentence splitting.
    lines = String(text || "")
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?…])\s+/)
      .map(stripSpeakerTag)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return lines;
}

async function startSession(text) {
  const parsed = parseLines(text);
  if (parsed.length < 2) {
    session = null;
    renderAll("Paste a dialogue with at least two lines (one line per speaker).");
    return;
  }

  sessionSeq++;
  const seq = sessionSeq;
  abortAudio();
  session = {
    mode: null,
    userStartsFirst: false,
    idx: 0,
    state: "classifying",
    classifyProgress: 0,
    lines: parsed.map((t) => ({
      text: t,
      lang: null,
      reference: null, // what the USER must say on their turns
      gloss: null,     // the other-language text, for display
      role: null,
      attempts: [],
      bestScore: 0,
      passed: false,
      skipped: false
    }))
  };
  renderAll();

  // One TRANSLATE per line, sequential: the response's sourceLang classifies
  // the line (fr vs en) AND supplies the Mode B reference / display gloss in
  // the same call. The 7d translation cache makes repeat sessions instant.
  for (let i = 0; i < session.lines.length; i++) {
    if (sessionSeq !== seq || !session) return;
    const line = session.lines[i];
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({ type: "TRANSLATE", text: line.text });
    } catch (err) {
      console.error("[FLA practice] classify failed", err);
      resp = null;
    }
    if (sessionSeq !== seq || !session) return;
    if (!resp || resp.error || !resp.translation) {
      session = null;
      renderAll("Couldn't prepare the session (translation failed) — try again in a moment.");
      return;
    }
    line.lang = resp.sourceLang;
    if (line.lang === "en") {
      line.reference = resp.translation; // the French the user should produce
      line.gloss = line.text;
    } else {
      line.reference = line.text; // verbatim reading
      line.gloss = resp.translation;
    }
    session.classifyProgress = i + 1;
    renderAll();
  }

  if (session.lines.every((l) => l.lang === "fr")) session.mode = "A";
  else if (session.lines.every((l) => l.lang === "en")) session.mode = "C";
  else session.mode = "B";
  assignRoles();
  session.state = "ready";
  renderAll();
}

function assignRoles() {
  session.lines.forEach((line, i) => {
    if (session.mode === "A") {
      // Alternating turns; app takes lines 0,2,4… unless roles are swapped.
      line.role = i % 2 === (session.userStartsFirst ? 0 : 1) ? "user" : "app";
    } else if (session.mode === "C") {
      // Nothing for the app to read — every line is the user's to render
      // into French. A translation drill rather than a conversation.
      line.role = "user";
    } else {
      line.role = line.lang === "en" ? "user" : "app";
    }
  });
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
    line.bestScore = 0;
    line.passed = false;
    line.skipped = false;
  });
  session.idx = 0;
}

function stopToSetup() {
  sessionSeq++;
  abortAudio();
  session = null;
  renderAll();
}

function abortAudio() {
  if (activeRecognition) {
    try { activeRecognition.abort(); } catch {}
    activeRecognition = null;
  }
  endTurnEarly = null;
  stopMeter();
  window.speechSynthesis.cancel();
}

// -----------------------------
// Mic level meter
// -----------------------------
//
// SpeechRecognition gives no signal at all until it has decoded words, so a
// mis-selected input device looks exactly like a user who hasn't spoken yet.
// A second, parallel getUserMedia stream drives a live level graph purely so
// the user can see their voice arriving. It is decorative and best-effort:
// recognition is never blocked on it, and any failure here just hides the
// canvas. (Chrome lets the two captures coexist — Web Speech does its own.)

const METER_BARS = 48;
const METER_GAIN = 3.5; // speech RMS is small; scale it to fill the canvas
const SILENT_RMS = 0.012; // below this is room noise, not speech
const SILENT_LEVEL = SILENT_RMS * METER_GAIN; // the same cutoff, post-gain
const SILENT_WARN_MS = 2500;

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

  if (rms >= SILENT_RMS) meter.lastLoudAt = Date.now();
  const quietFor = Date.now() - meter.lastLoudAt;
  const hint = $("practiceMicHint");
  if (hint) {
    hint.hidden = quietFor < SILENT_WARN_MS;
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
    ctx.fillStyle = level >= SILENT_LEVEL
      ? `rgba(74, 144, 226, ${0.35 + age * 0.65})`
      : `rgba(180, 180, 180, ${0.25 + age * 0.35})`;
    ctx.fillRect(i * slot + (slot - barW) / 2, mid - barH / 2, barW, barH);
  }

  meter.raf = requestAnimationFrame(drawMeter);
}

// -----------------------------
// Turn loop
// -----------------------------

async function nextTurn() {
  const seq = sessionSeq;
  while (session && sessionSeq === seq) {
    if (session.idx >= session.lines.length) {
      session.state = "done";
      renderAll();
      return;
    }
    const line = session.lines[session.idx];
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
    } else {
      session.state = "listening-armed";
      renderAll();
      return; // wait for the mic button
    }
  }
}

async function onMicClick() {
  if (!session) return;
  if (session.state !== "listening-armed" && session.state !== "feedback-fail") return;
  const seq = sessionSeq;
  const idxAtStart = session.idx;
  const line = session.lines[session.idx];

  session.state = "listening";
  renderAll();
  startMeter(); // best-effort, deliberately not awaited — recognition starts now
  const res = await listenOnce({
    reference: line.reference,
    onProgress: (text) => renderLiveProgress(line, text)
  });
  stopMeter();
  // Skip and pause both abort the recognition, which settles this promise —
  // if either moved the turn on (or paused it), this continuation is stale.
  if (sessionSeq !== seq || !session) return;
  if (session.idx !== idxAtStart || session.state !== "listening") return;

  if (res.error) {
    handleListenError(res.error);
    return;
  }

  const score = pronunciationScore(line.reference, res.transcript);
  const diff = alignPronunciation(line.reference, res.transcript);
  line.attempts.push({ transcript: res.transcript, score, diff });
  line.bestScore = Math.max(line.bestScore, score);

  if (score >= PASS_THRESHOLD[session.mode]) {
    line.passed = true;
    session.state = "feedback-pass";
    renderAll();
    await delay(1100);
    if (sessionSeq !== seq || !session || session.state !== "feedback-pass") return;
    session.idx++;
    nextTurn();
  } else {
    session.state = "feedback-fail";
    renderAll();
  }
}

function handleListenError(error) {
  if (!session) return;
  session.state = "listening-armed";
  if (error === "not-allowed" || error === "service-not-allowed") {
    micPermission = "denied";
    micModalDismissed = false; // a real permission failure overrides "Not now"
    renderAll("Microphone access is blocked.");
  } else if (error === "unsupported") {
    renderAll("Speech recognition isn't available in this browser (Chrome only).");
  } else if (error === "no-speech" || error === "aborted") {
    renderAll("Didn't catch anything — check your microphone input device, then press 🎤 Speak again.");
  } else {
    renderAll(`Speech recognition error (${error}) — try again.`);
  }
}

function onSkip() {
  if (!session) return;
  if (session.state !== "listening-armed" && session.state !== "feedback-fail" && session.state !== "listening") return;
  abortAudio();
  const line = session.lines[session.idx];
  if (!line.passed) line.skipped = true;
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

function onResume() {
  if (!session || session.state !== "paused") return;
  const line = session.lines[session.idx];
  if (!line) {
    session.state = "done";
    renderAll();
  } else if (line.passed) {
    // Paused during the pass-feedback flash — this line is done, move on.
    session.idx++;
    nextTurn();
  } else if (line.role === "user") {
    session.state = "listening-armed";
    renderAll();
  } else {
    nextTurn();
  }
}

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
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve();
      }
    };
    // Chrome's onend is unreliable (notoriously so after cancel()) — a
    // fallback timer keeps the turn loop from freezing on a stalled utterance.
    const timer = setTimeout(finish, Math.max(4000, text.length * 120));
    utter.onend = finish;
    utter.onerror = finish;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  });
}

// Listens for one user turn and resolves with everything they said.
//
// `continuous` is the important bit. With it off, Chrome ends the session at
// its first final result — which for a spoken sentence is often just the
// opening word or two, so the line got scored (and failed) before the user
// had finished saying it. Continuous keeps the session open across as many
// result segments as the user produces; we decide when the turn is over,
// from silence, from the Done button, or from a hard cap.
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
      if (endTurnEarly === endTurn) endTurnEarly = null;
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
    endTurnEarly = endTurn;

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

  renderLines();
  renderControls();
  renderResult(notice);
}

function renderLines() {
  const container = $("practiceLines");
  container.innerHTML = session.lines
    .map((line, i) => {
      const cls = [
        "pline",
        i === session.idx && session.state !== "ready" && session.state !== "done" ? "current" : "",
        line.passed ? "done" : "",
        line.skipped ? "failed" : ""
      ]
        .filter(Boolean)
        .join(" ");
      const roleIcon = line.role === "user" ? "🎤" : "🔊";
      const status = line.passed
        ? ` <span class="pline-score">✓ ${Math.round(line.bestScore * 100)}%</span>`
        : line.skipped
          ? ` <span class="pline-score">skipped</span>`
          : "";
      const gloss =
        line.role === "app" && line.gloss
          ? `<div class="pline-gloss">${escapeHtml(line.gloss)}</div>`
          : "";
      // A translate turn's French stays hidden until the user has had their
      // go at it — then it's revealed, with playback, as the model answer to
      // imitate. This is the only place Mode C ever shows the French.
      const revealed =
        isTranslateTurn(line) && (line.passed || line.skipped)
          ? `<div class="pline-reveal">
               <button class="pline-play" data-action="play" data-line="${i}" title="Hear it in French">▶</button>
               <span>${escapeHtml(line.reference)}</span>
             </div>`
          : "";
      return `
        <div class="${cls}" data-line="${i}">
          <span class="pline-role">${roleIcon}</span>
          <span class="pline-lang">${line.lang || "…"}</span>
          <span class="pline-text">${escapeHtml(line.text)}${status}${gloss}${revealed}</span>
        </div>
      `;
    })
    .join("");
  container.querySelector(".pline.current")?.scrollIntoView({ block: "nearest" });
}

// The grant flow is a gate on entering practice, not a button parked in the
// UI: a one-time setup step shouldn't occupy permanent space next to the
// controls the user actually uses every session.
function renderMicGate() {
  const modal = $("micModal");
  if (!modal) return;
  modal.hidden = micPermission === "granted" || micModalDismissed;
}

function renderControls() {
  const st = session.state;
  const mic = $("micBtn");
  mic.hidden = !(st === "listening-armed" || st === "listening");
  mic.disabled = st !== "listening-armed";
  mic.textContent = st === "listening" ? "🎤 Listening…" : "🎤 Speak";
  $("practiceDone").hidden = st !== "listening";
  // Hearing the model pronunciation is the point of the exercise, so both
  // speeds sit right next to the retry button after a miss.
  $("practiceListen").hidden = !(st === "listening-armed" || st === "feedback-fail");
  $("practiceListenSlow").hidden = st !== "feedback-fail";
  $("practiceRetry").hidden = st !== "feedback-fail";
  $("practiceSkip").hidden = !(st === "listening-armed" || st === "listening" || st === "feedback-fail");
  $("practiceStop").textContent = st === "done" ? "New text" : "■ Stop";
}

function renderResult(notice) {
  const out = $("practiceResult");
  const st = session.state;
  const line = session.lines[session.idx];
  const noticeHtml = notice ? `<div class="error">${escapeHtml(notice)}</div>` : "";

  if (st === "classifying") {
    out.innerHTML = `<div class="hint">Preparing session — translating line ${session.classifyProgress}/${session.lines.length}…</div>`;
    return;
  }
  if (st === "ready") {
    const modeDesc = {
      A: "All-French dialogue: the app reads its lines aloud, you read yours.",
      B: "Mixed dialogue: the app reads the French lines; say each English line in French.",
      C: "All-English dialogue: say every line in French. Nothing is read to you — each line is yours to translate aloud."
    }[session.mode];
    const swapBtn =
      session.mode === "A"
        ? `<button data-action="swap">⇄ Swap roles</button>`
        : "";
    out.innerHTML = `
      <div class="hint">${escapeHtml(modeDesc)} Check the fr/en tags above look right before starting.</div>
      <div class="toolbar">
        <button data-action="begin">▶ Start conversation</button>
        ${swapBtn}
      </div>
    `;
    return;
  }
  if (st === "app-speaking") {
    out.innerHTML = `${noticeHtml}<div class="hint">🔊 Reading…</div>`;
    return;
  }
  if (st === "listening-armed") {
    const prompt =
      line.lang === "en"
        ? "Your turn — say the highlighted line <b>in French</b>, then press 🎤 Speak."
        : "Your turn — read the highlighted line aloud, then press 🎤 Speak.";
    out.innerHTML = `${noticeHtml}<div class="hint">${prompt}</div>`;
    return;
  }
  if (st === "listening") {
    // Words light up as they're recognised; the verdict waits for the end of
    // the turn. Rendered once here — renderLiveProgress() then patches these
    // two nodes in place rather than re-running renderResult on every syllable.
    out.innerHTML = `
      <div class="hint">Listening — say the whole line, then pause (or press ✓ Done).</div>
      <div id="practiceLive" class="plive">${liveWordsHtml(line, "")}</div>
      <div id="practiceInterim" class="pinterim"></div>
    `;
    return;
  }
  if (st === "feedback-pass") {
    const last = line.attempts[line.attempts.length - 1];
    out.innerHTML = `<div class="ppass">✓ ${Math.round(last.score * 100)}% — nice!</div>`;
    return;
  }
  if (st === "feedback-fail") {
    const last = line.attempts[line.attempts.length - 1];
    const diffHtml = last.diff.words
      .map((w) => {
        const cls = w.match ? "ok" : w.near ? "near" : "miss";
        return `<span class="dw ${cls}">${escapeHtml(w.word)}</span>`;
      })
      .join(" ");
    const extras = last.diff.extras.length
      ? `<div class="hint">Extra words heard: ${escapeHtml(last.diff.extras.join(", "))}</div>`
      : "";
    const refLabel = isTranslateTurn(line) ? "Suggested translation" : "Expected";
    const nearNote = last.diff.words.some((w) => !w.match && w.near)
      ? `<div class="hint">Amber words came out close — worth another go at the sounds.</div>`
      : "";
    out.innerHTML = `
      <div class="pfail">${Math.round(last.score * 100)}% — not quite.</div>
      <div class="pdiff">${diffHtml}</div>
      ${nearNote}
      <div class="hint">${refLabel}: ${escapeHtml(line.reference)}</div>
      <div class="hint">You said: ${escapeHtml(last.transcript)}</div>
      ${extras}
    `;
    return;
  }
  if (st === "paused") {
    out.innerHTML = `
      <div class="hint">Session paused.</div>
      <div class="toolbar"><button data-action="resume">▶ Resume</button></div>
    `;
    return;
  }
  if (st === "done") {
    renderSummary(out);
  }
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
  // Indices are carried along so each row's ▶ can address the original line.
  const userLines = session.lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.role === "user");
  const overall = userLines.length
    ? Math.round(
        (userLines.reduce((sum, { line: l }) => sum + (l.skipped && !l.passed ? 0 : l.bestScore), 0) /
          userLines.length) *
          100
      )
    : 0;

  // Repeated mistakes: every reference word marked unmatched, aggregated
  // across all attempts of all lines, surfaced at 2+ misses.
  const missCounts = {};
  session.lines.forEach((l) =>
    l.attempts.forEach((a) =>
      a.diff.words.forEach((w) => {
        if (!w.match) missCounts[w.word] = (missCounts[w.word] || 0) + 1;
      })
    )
  );
  const repeated = Object.entries(missCounts)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]);

  const rows = userLines
    .map(({ line: l, i }) => {
      const label = l.passed
        ? `${Math.round(l.bestScore * 100)}%`
        : l.skipped
          ? "skipped"
          : `${Math.round(l.bestScore * 100)}%`;
      // Every line replayable after the session — the summary is where the
      // user sees what they got wrong, so it's where they'll want to drill.
      return `<tr>
        <td>
          <button class="pline-play" data-action="play" data-line="${i}" title="Hear it in French">▶</button>
          ${escapeHtml(l.text)}
        </td>
        <td>${label}</td>
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
      <button data-action="again">Practice again</button>
      <button data-action="new">New text</button>
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
  $("practiceDone").addEventListener("click", () => endTurnEarly?.());
  $("micBtn").addEventListener("click", onMicClick);
  $("practiceRetry").addEventListener("click", onMicClick);
  $("practiceListen").addEventListener("click", () => onListen());
  $("practiceListenSlow").addEventListener("click", () => onListen(DRILL_SLOW_RATE));
  $("practiceSkip").addEventListener("click", onSkip);
  $("practiceStop").addEventListener("click", stopToSetup);

  // Revealed model answers carry their own ▶ (renderLines).
  $("practiceLines").addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="play"]');
    if (btn) playLineReference(btn.dataset.line);
  });

  // Dynamic buttons (begin/swap/resume/again/new/play) render into #practiceResult.
  $("practiceResult").addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    const action = el?.dataset.action;
    if (!action || !session) return;
    if (action === "play") {
      playLineReference(el.dataset.line);
    } else if (action === "begin") {
      session.idx = 0;
      nextTurn();
    } else if (action === "swap") {
      session.userStartsFirst = !session.userStartsFirst;
      assignRoles();
      renderAll();
    } else if (action === "resume") {
      onResume();
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
