/**
 * CrisisSync — script.js
 * Firebase v9 Modular SDK · ES Module
 *
 * Firestore collections (from BACKEND_DOCS.md):
 *   /incidents/{id}  → type, location, description, status, hotelId,
 *                       createdAt, photoUrl, triage{}, resolvedAt, staffId
 *   /staff/{uid}     → role, isOnDuty, fcmToken, hotelId
 *   /hotels/{id}     → config + /predictions sub-collection
 *
 * ─── EDIT BEFORE DEPLOYING ────────────────────────────────────────────────
 */
const BASE_URL = "https://CrisisSync.up.railway.app"; // ← your Railway URL

/* ══════════════════════════════════════════════════════════════════════════
   FIREBASE v9 MODULAR SDK — IMPORTS
══════════════════════════════════════════════════════════════════════════ */
import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";

import { getAuth, signInAnonymously }
  from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  addDoc,
  doc,
  getDoc,
  onSnapshot,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

/* ══════════════════════════════════════════════════════════════════════════
   FIREBASE CONFIG
══════════════════════════════════════════════════════════════════════════ */
const firebaseConfig = {
  apiKey:            "AIzaSyAD5cXsGGWzzi7yQnz1nfZcYmfrDZmv--4",
  authDomain:        "crisissync-gdg.firebaseapp.com",
  projectId:         "crisissync-gdg",
  storageBucket:     "crisissync-gdg.firebasestorage.app",
  messagingSenderId: "105702461886",
  appId:             "1:105702461886:web:3c9541193e0c93c2a6a9ef",
  measurementId:     "G-YB3SXBP4XN",
};

const fbApp = initializeApp(firebaseConfig);
const auth  = getAuth(fbApp);
const db    = getFirestore(fbApp);

/* ══════════════════════════════════════════════════════════════════════════
   SPA STATE
══════════════════════════════════════════════════════════════════════════ */
let selectedType      = "MEDICAL"; // active incident type chip
let triageUnsub       = null;      // onSnapshot cleanup for guest triage
let mapUnsub          = null;      // onSnapshot cleanup for staff map
let dashUnsub         = null;      // onSnapshot cleanup for dashboard
let currentIncidentId = null;      // id of incident open in scr-brief
let pinBuffer         = "";        // staff PIN digit buffer
let chartInstance     = null;      // Chart.js instance ref
let qrStarted         = false;     // guard against double QR init

/* ──────────────────────────────────────────────────────
   SIREN STATE — Web Audio API synthesised wail
   No MP3 needed; also falls back to <audio id="sos-siren">
─────────────────────────────────────────────────────── */
let sirenCtx     = null;
let sirenOsc     = null;
let sirenGain    = null;
let sirenLfo     = null;
let sirenLfoGain = null;
let sirenMuted   = false;
let sirenActive  = false;

/* ──────────────────────────────────────────────────────
   COUNTDOWN STATE — 5-minute clicking countdown on scr-wait
─────────────────────────────────────────────────────── */
let countdownTimer    = null; // setInterval handle
let countdownSeconds  = 300;  // 5:00

/* ══════════════════════════════════════════════════════════════════════════
   LOADER
══════════════════════════════════════════════════════════════════════════ */
window.addEventListener("load", () => {
  setTimeout(() => document.getElementById("loader").classList.add("out"), 800);
});

/* ══════════════════════════════════════════════════════════════════════════
   NAVIGATION — show/hide .screen divs
   BACK_MAP maps screenId → parent screenId (null = no back button)
══════════════════════════════════════════════════════════════════════════ */
const BACK_MAP = {
  "scr-qr":    "scr-role",
  "scr-sos":   "scr-role",
  "scr-wait":  null,         // no back from waiting — guest is locked in
  "scr-pin":   "scr-role",
  "scr-map":   "scr-role",
  "scr-brief": "scr-map",
  "scr-dash":  "scr-role",
};

function go(screenId) {
  // Stop siren and countdown if navigating away from waiting screen
  if (screenId !== "scr-wait") {
    stopSiren();
    stopCountdown();
  }

  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(screenId).classList.add("active");

  const backBtn = document.getElementById("back-btn");
  if (BACK_MAP[screenId]) {
    backBtn.classList.add("vis");
    backBtn._target = BACK_MAP[screenId];
  } else {
    backBtn.classList.remove("vis");
  }

  // Per-screen side effects
  if (screenId === "scr-qr")   initQR();
  if (screenId === "scr-map")  initStaffMap();
  if (screenId === "scr-dash") initDashboard();
  if (screenId === "scr-pin")  resetPin();
}

window.go     = go;
window.goBack = () => { const b = document.getElementById("back-btn"); if (b._target) go(b._target); };

/* ══════════════════════════════════════════════════════════════════════════
   SIREN — Web Audio synthesised emergency wail + <audio> fallback
   Carrier oscillator (sawtooth 700 Hz) modulated by LFO (0.9 Hz ±280 Hz)
   = classic rising/falling siren sound, no MP3 required.
══════════════════════════════════════════════════════════════════════════ */
function startSiren() {
  if (sirenActive) return;
  sirenActive = true;
  sirenMuted  = false;

  try {
    // Web Audio path
    sirenCtx     = new (window.AudioContext || window.webkitAudioContext)();
    sirenGain    = sirenCtx.createGain();
    sirenGain.gain.setValueAtTime(0.35, sirenCtx.currentTime);
    sirenGain.connect(sirenCtx.destination);

    sirenOsc          = sirenCtx.createOscillator();
    sirenOsc.type     = "sawtooth";
    sirenOsc.frequency.setValueAtTime(700, sirenCtx.currentTime);

    sirenLfo          = sirenCtx.createOscillator();
    sirenLfo.type     = "sine";
    sirenLfo.frequency.setValueAtTime(0.9, sirenCtx.currentTime);

    sirenLfoGain      = sirenCtx.createGain();
    sirenLfoGain.gain.setValueAtTime(280, sirenCtx.currentTime);

    sirenLfo.connect(sirenLfoGain);
    sirenLfoGain.connect(sirenOsc.frequency);
    sirenOsc.connect(sirenGain);

    sirenLfo.start();
    sirenOsc.start();
  } catch (_) {
    // Web Audio unavailable — use <audio> fallback
    const el = document.getElementById("sos-siren");
    if (el) { el.currentTime = 0; el.play().catch(() => {}); }
  }

  updateSirenUI();
}

function stopSiren() {
  if (!sirenActive) return;
  try { sirenOsc?.stop(); sirenLfo?.stop(); sirenCtx?.close(); } catch (_) {}
  sirenActive = false;
  sirenCtx = sirenOsc = sirenGain = sirenLfo = sirenLfoGain = null;

  // Also stop <audio> fallback
  const el = document.getElementById("sos-siren");
  if (el) { el.pause(); el.currentTime = 0; }
}

window.toggleSiren = function () {
  if (!sirenActive) return;
  sirenMuted = !sirenMuted;
  if (sirenGain) {
    sirenGain.gain.setTargetAtTime(sirenMuted ? 0 : 0.35, sirenCtx.currentTime, 0.05);
  }
  // Also handle <audio> fallback mute
  const el = document.getElementById("sos-siren");
  if (el) el.muted = sirenMuted;
  updateSirenUI();
};

function updateSirenUI() {
  const bar = document.getElementById("siren-bar");
  const btn = document.getElementById("siren-mute-btn");
  const lbl = document.getElementById("siren-label");
  if (!bar) return;
  if (sirenMuted) {
    bar.classList.add("muted");
    if (btn) btn.textContent = "Unmute";
    if (lbl) lbl.textContent = "Siren muted";
  } else {
    bar.classList.remove("muted");
    if (btn) btn.textContent = "Mute";
    if (lbl) lbl.textContent = "Emergency siren active";
  }
}

function sirenConfirmed() {
  // Called when staff confirms — turn bar green, stop
  stopSiren();
  const bar = document.getElementById("siren-bar");
  const lbl = document.getElementById("siren-label");
  const btn = document.getElementById("siren-mute-btn");
  if (bar) {
    bar.style.borderColor = "rgba(29,158,117,0.35)";
    bar.style.background  = "rgba(29,158,117,0.06)";
    bar.style.animation   = "none";
    bar.classList.add("muted");
  }
  if (lbl) { lbl.textContent = "Staff confirmed — siren stopped"; lbl.style.color = "var(--teal)"; }
  if (btn) btn.style.display = "none";
}

/* ══════════════════════════════════════════════════════════════════════════
   COUNTDOWN — 5-minute clicking timer on scr-wait
   Ticks every second, plays click.mp3, displays MM:SS in #eta-num
══════════════════════════════════════════════════════════════════════════ */
function startCountdown() {
  countdownSeconds = 300; // reset to 5:00
  renderCountdown();
  stopCountdown(); // clear any existing interval

  countdownTimer = setInterval(() => {
    countdownSeconds = Math.max(0, countdownSeconds - 1);
    renderCountdown();

    // Play click sound every second
    const click = document.getElementById("sos-click");
    if (click) {
      click.currentTime = 0;
      click.play().catch(() => {}); // autoplay may be blocked; fail silently
    }

    if (countdownSeconds === 0) stopCountdown();
  }, 1000);
}

function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}

function renderCountdown() {
  const m = Math.floor(countdownSeconds / 60);
  const s = countdownSeconds % 60;
  const display = `${m}:${String(s).padStart(2, "0")}`;
  const el = document.getElementById("eta-num");
  if (el) el.textContent = display;
  const unit = document.getElementById("eta-unit");
  if (unit) unit.textContent = countdownSeconds > 0 ? "remaining" : "— Staff arriving now";
}

/* ══════════════════════════════════════════════════════════════════════════
   GUEST — TYPE CHIP SELECTION
══════════════════════════════════════════════════════════════════════════ */
window.pickType = function (btn) {
  document.querySelectorAll(".chip").forEach(c => c.classList.remove("sel"));
  btn.classList.add("sel");
  selectedType = btn.dataset.type;
};

/* ══════════════════════════════════════════════════════════════════════════
   GUEST — PHOTO PREVIEW (local)
══════════════════════════════════════════════════════════════════════════ */
window.previewImg = function (input) {
  if (input.files && input.files[0]) {
    const reader = new FileReader();
    reader.onload = e => {
      const img = document.getElementById("image-preview");
      img.src = e.target.result;
      img.style.display = "block";
      document.getElementById("upload-placeholder").style.display = "none";
    };
    reader.readAsDataURL(input.files[0]);
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   GUEST — QR SCANNER
══════════════════════════════════════════════════════════════════════════ */
function initQR() {
  if (qrStarted) return;
  qrStarted = true;
  const scanner = new Html5Qrcode("reader");
  Html5Qrcode.getCameras()
    .then(devices => {
      if (!devices || !devices.length) return;
      scanner.start(
        devices[0].id,
        { fps: 10, qrbox: 220 },
        decoded => {
          scanner.stop().catch(() => {});
          document.getElementById("loc").value = decoded;
          go("scr-sos");
        }
      );
    })
    .catch(e => console.warn("QR scanner:", e));
}

/* ══════════════════════════════════════════════════════════════════════════
   GUEST — SEND SOS
   Firestore field contract (matches BACKEND_DOCS.md + server.js):
     type, location, description, status:"PENDING",
     hotelId:"hotel-demo", createdAt: serverTimestamp()
   POST /triage body: { incidentId, type, location, description, hotelId }
══════════════════════════════════════════════════════════════════════════ */
window.handleSOS = async function () {
  const location = document.getElementById("loc").value.trim() || "Location not specified";
  const btn      = document.getElementById("sos-btn");

  btn.disabled = true;
  btn.querySelector(".sos-label").textContent = "···";
  btn.querySelector(".sos-sub").textContent   = "Connecting";

  try {
    // 1. Anonymous auth — required by Firestore security rules
    await signInAnonymously(auth);

    // 2. Create incident document with exact field names
    const docRef = await addDoc(collection(db, "incidents"), {
      type:        selectedType,   // "MEDICAL" | "FIRE" | "SECURITY" | "MAINTENANCE"
      location:    location,
      description: "",
      status:      "PENDING",      // backend changes → "ACTIVE" after Gemini triage
      hotelId:     "hotel-demo",   // must match /hotels/{hotelId}
      createdAt:   serverTimestamp(),
    });

    const incidentId = docRef.id;
    console.log("[SOS] Incident created:", incidentId);

    // 3. Call Railway backend /triage (fire-and-forget; backend responds 200 then runs async)
    fetch(`${BASE_URL}/triage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        incidentId,
        type:        selectedType,
        location,
        description: "",
        hotelId:     "hotel-demo",
      }),
    })
    .then(r => r.json())
    .then(j => console.log("[SOS] /triage response:", j))
    .catch(e => console.warn("[SOS] /triage POST failed (Firestore doc still exists):", e.message));

    // 4. Switch to waiting screen + start siren + start countdown
    go("scr-wait");
    startSiren();
    startCountdown();

    // 5. Listen for backend triage result on this doc
    listenForTriage(incidentId);

  } catch (err) {
    console.error("[SOS] failed:", err);
    btn.disabled = false;
    btn.querySelector(".sos-label").textContent = "SOS";
    btn.querySelector(".sos-sub").textContent   = "Tap to alert";
    const msg = err.code === "permission-denied"
      ? "Firebase permission denied. Enable anonymous auth in your Firebase console."
      : `Could not send SOS: ${err.message}`;
    alert(msg);
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   GUEST — TRIAGE onSnapshot LISTENER
   Waits for backend to write:
     incident.triage {}
     incident.status = "ACTIVE"
     incident.triageError = true (on failure)
══════════════════════════════════════════════════════════════════════════ */
function listenForTriage(incidentId) {
  if (triageUnsub) triageUnsub();

  triageUnsub = onSnapshot(doc(db, "incidents", incidentId), snap => {
    if (!snap.exists()) return;
    const data = snap.data();

    // Error path — Gemini call failed but staff still notified
    if (data.triageError) {
      stopCountdown();
      document.getElementById("spin-wrap").style.display = "none";
      document.getElementById("err-card").style.display  = "block";
      sirenConfirmed();
      triageUnsub && triageUnsub();
      return;
    }

    // Wait until backend writes the triage object
    if (!data.triage) return;

    // Triage received — render and stop waiting state
    renderTriage(data.triage);
    triageUnsub && triageUnsub();

  }, err => {
    console.error("[triage listener]", err);
    document.getElementById("spin-wrap").style.display = "none";
    document.getElementById("err-card").style.display  = "block";
    stopCountdown();
  });

  // 8-second UI fallback if backend is cold-starting
  setTimeout(() => {
    const sw = document.getElementById("spin-wrap");
    if (sw && sw.style.display !== "none") {
      renderTriage({
        severity:      "ACTIVE",
        guest_message: "Staff are reviewing your request. Help is on the way.",
        eta_minutes:   5,
        action_steps:  [
          "Remain calm and stay where you are",
          "Do not leave without staff escort",
          "Call 112 directly if situation worsens",
        ],
        escalate_to_112: false,
      });
    }
  }, 8000);
}

function renderTriage(t) {
  // Stop countdown — replace with ETA from AI
  stopCountdown();
  sirenConfirmed();

  document.getElementById("guest-msg").textContent = t.guest_message || "Our team is responding.";
  document.getElementById("wait-sub").textContent  = t.guest_message || "Our team is responding.";

  const tag = document.getElementById("sev-tag");
  tag.textContent = t.severity || "ACTIVE";
  tag.className   = `sev-tag sev-${t.severity || "ACTIVE"}`;

  // Show ETA from AI (overrides countdown)
  const etaEl  = document.getElementById("eta-num");
  const unitEl = document.getElementById("eta-unit");
  if (etaEl)  etaEl.textContent  = t.eta_minutes ?? "—";
  if (unitEl) unitEl.textContent = "min";

  // Action steps list
  const list = document.getElementById("action-list");
  list.innerHTML = "";
  (t.action_steps || []).forEach((step, i) => {
    list.insertAdjacentHTML("beforeend",
      `<li class="action-item"><span class="action-num">${i + 1}</span><span>${step}</span></li>`);
  });

  if (t.escalate_to_112) document.getElementById("callout-112").style.display = "flex";

  document.getElementById("spin-wrap").style.display   = "none";
  document.getElementById("triage-card").style.display = "flex";
}

/* ══════════════════════════════════════════════════════════════════════════
   STAFF — PIN PAD
   Correct code: 1234 (set STAFF_PIN below)
══════════════════════════════════════════════════════════════════════════ */
const STAFF_PIN = "1234";

function resetPin() {
  pinBuffer = "";
  updatePinDots();
  document.getElementById("pin-err").textContent = "";
}

window.pinKey = function (digit) {
  if (pinBuffer.length >= 4) return;
  pinBuffer += digit;
  updatePinDots();
  if (pinBuffer.length === 4) setTimeout(checkPin, 120);
};

window.pinDel = function () {
  pinBuffer = pinBuffer.slice(0, -1);
  updatePinDots();
};

function updatePinDots() {
  for (let i = 0; i < 4; i++) {
    const d = document.getElementById("pd" + i);
    d.classList.toggle("filled", i < pinBuffer.length);
    d.classList.remove("err");
  }
}

function checkPin() {
  if (pinBuffer === STAFF_PIN) {
    go("scr-map");
  } else {
    for (let i = 0; i < 4; i++) document.getElementById("pd" + i).classList.add("err");
    document.getElementById("pin-err").textContent = "⛔ Access Denied";
    setTimeout(() => { pinBuffer = ""; updatePinDots(); document.getElementById("pin-err").textContent = ""; }, 900);
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   STAFF — TACTICAL MAP
   onSnapshot on /incidents ordered by createdAt desc, limit 30
   Filters PENDING → red .map-dot, ACTIVE → amber .map-dot
══════════════════════════════════════════════════════════════════════════ */

// Room label → approximate % position on the SVG floor plan
const MAP_POSITIONS = {
  "101": { x: 9,  y: 17 }, "102": { x: 24, y: 17 }, "103": { x: 40, y: 17 },
  "104": { x: 57, y: 17 }, "105": { x: 73, y: 17 }, "106": { x: 91, y: 17 },
  "201": { x: 9,  y: 50 }, "202": { x: 24, y: 50 }, "203": { x: 40, y: 50 },
  "204": { x: 57, y: 50 }, "205": { x: 73, y: 50 }, "206": { x: 91, y: 50 },
  "LOBBY":      { x: 18, y: 83 },
  "RESTAURANT": { x: 50, y: 83 },
  "POOL":       { x: 83, y: 83 },
  "DEFAULT":    { x: 50, y: 50 },
};

function roomToMapPos(location) {
  const loc  = (location || "").toUpperCase();
  const keys = Object.keys(MAP_POSITIONS).filter(k => k !== "DEFAULT");
  for (const k of keys) {
    if (loc.includes(k)) return MAP_POSITIONS[k];
  }
  return MAP_POSITIONS.DEFAULT;
}

function initStaffMap() {
  if (mapUnsub) return; // already listening

  const q = query(
    collection(db, "incidents"),
    orderBy("createdAt", "desc"),
    limit(30)
  );

  mapUnsub = onSnapshot(q, snap => {
    const incidents = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderMapDots(incidents);
    renderIncidentList(incidents, "incident-list", true);

    const active = incidents.filter(i => i.status === "PENDING" || i.status === "ACTIVE").length;
    document.getElementById("live-count").textContent = `${active} active`;
  });
}

function renderMapDots(incidents) {
  const wrap = document.getElementById("map-wrap");
  wrap.querySelectorAll(".map-dot").forEach(d => d.remove());

  incidents
    .filter(i => i.status === "PENDING" || i.status === "ACTIVE")
    .forEach(inc => {
      const pos = roomToMapPos(inc.location);
      const dot = document.createElement("div");
      dot.className = "map-dot" + (inc.status === "ACTIVE" ? " active-dot" : "");
      dot.style.left  = pos.x + "%";
      dot.style.top   = pos.y + "%";
      dot.title       = `${inc.type} — ${inc.location}`;
      dot.onclick     = () => openBrief(inc.id);
      wrap.appendChild(dot);
    });
}

/* ══════════════════════════════════════════════════════════════════════════
   SHARED — INCIDENT LIST RENDERER
   Used by both scr-map (staffMode=true) and scr-dash (staffMode=false)
══════════════════════════════════════════════════════════════════════════ */
function renderIncidentList(incidents, containerId, staffMode = false) {
  const el = document.getElementById(containerId);
  if (!incidents.length) {
    el.innerHTML = `<div class="empty-state">No incidents found</div>`;
    return;
  }

  el.innerHTML = incidents.slice(0, 10).map(inc => {
    const sc   = { PENDING: "pending", ACTIVE: "active", RESPONDING: "responding", RESOLVED: "resolved" };
    const cls  = sc[inc.status] || "";
    const pill = `<span class="status-pill s-${(inc.status || "").toLowerCase()}">${inc.status || "—"}</span>`;
    const time = inc.createdAt?.toDate ? timeAgo(inc.createdAt.toDate()) : "";
    const detailBtn = staffMode && inc.status !== "RESOLVED"
      ? `<button class="btn-detail" onclick="openBrief('${inc.id}')">See Details →</button>`
      : "";
    const sevChip = inc.triage?.severity
      ? `<div style="font-size:12px;color:var(--muted2);">Severity: <span class="sev-tag sev-${inc.triage.severity}" style="font-size:10px;">${inc.triage.severity}</span></div>`
      : "";

    return `
      <div class="inc-card ${cls}">
        <div class="inc-top">
          <div>
            <div class="inc-type">${inc.type || "Unknown"}</div>
            <div class="inc-loc">📍 ${inc.location || "Unknown location"}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;">
            ${pill}
            <span class="inc-time">${time}</span>
          </div>
        </div>
        ${sevChip}
        ${detailBtn ? `<div class="inc-actions">${detailBtn}</div>` : ""}
      </div>`;
  }).join("");
}

function timeAgo(date) {
  const s = Math.floor((Date.now() - date) / 1000);
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/* ══════════════════════════════════════════════════════════════════════════
   STAFF — OPEN ACTION BRIEF  (#scr-brief)

   Photo priority (from BACKEND_DOCS.md spec):
     1. data.photoUrl (Firebase Storage URL set by Guest App after upload)
     2. Emoji fallback by incident type

   ACCEPT RESPONSE updates:
     status      → "RESPONDING"
     staffId     → auth uid (or placeholder)
     respondedAt → serverTimestamp()
══════════════════════════════════════════════════════════════════════════ */
window.openBrief = async function (incidentId) {
  currentIncidentId = incidentId;

  // Fetch the single incident document directly
  let inc;
  try {
    const snap = await getDoc(doc(db, "incidents", incidentId));
    if (!snap.exists()) { alert("Incident not found."); return; }
    inc = { id: snap.id, ...snap.data() };
  } catch (err) {
    alert("Failed to load incident: " + err.message);
    return;
  }

  // ── PHOTO: prefer Firebase Storage URL, fall back to emoji ──────────
  const photoFallback = document.getElementById("brief-photo-fallback");
  const photoImage    = document.getElementById("brief-photo-image");
  const TYPE_ICON     = { MEDICAL: "🏥", FIRE: "🔥", SECURITY: "🚨", MAINTENANCE: "⚠️" };

  if (inc.photoUrl && inc.photoUrl.startsWith("http")) {
    // Real photo from Firebase Storage
    photoFallback.style.display = "none";
    photoImage.style.display    = "block";
    photoImage.src              = inc.photoUrl;
    photoImage.onerror          = () => {
      // If image fails to load, show emoji fallback
      photoImage.style.display    = "none";
      photoFallback.style.display = "";
      photoFallback.textContent   = TYPE_ICON[inc.type] || "📍";
    };
  } else {
    photoImage.style.display    = "none";
    photoFallback.style.display = "";
    photoFallback.textContent   = TYPE_ICON[inc.type] || "📍";
  }

  // ── TEXT FIELDS ──────────────────────────────────────────────────────
  document.getElementById("brief-type").textContent     = inc.type     || "—";
  document.getElementById("brief-loc").textContent      = inc.location || "—";
  document.getElementById("brief-status").textContent   = inc.status   || "—";
  document.getElementById("brief-severity").textContent = inc.triage?.severity || "Pending AI";

  const dispatchWrap = document.getElementById("triage-brief");
  if (inc.triage?.dispatch_message) {
    dispatchWrap.style.display = "block";
    document.getElementById("brief-dispatch").textContent = inc.triage.dispatch_message;
  } else {
    dispatchWrap.style.display = "none";
  }

  // ── ACCEPT BUTTON STATE ──────────────────────────────────────────────
  const acceptBtn   = document.getElementById("accept-btn");
  const isResponded = inc.status === "RESPONDING" || inc.status === "RESOLVED";
  acceptBtn.disabled    = isResponded;
  acceptBtn.textContent = isResponded ? "✅  RESPONDING" : "✅ \u00A0 ACCEPT RESPONSE";

  go("scr-brief");
};

/* ══════════════════════════════════════════════════════════════════════════
   STAFF — ACCEPT RESPONSE
   Updates Firestore: status → "RESPONDING", staffId, respondedAt
══════════════════════════════════════════════════════════════════════════ */
window.acceptIncident = async function () {
  if (!currentIncidentId) return;
  const btn = document.getElementById("accept-btn");
  btn.disabled    = true;
  btn.textContent = "Updating…";

  try {
    await updateDoc(doc(db, "incidents", currentIncidentId), {
      status:      "RESPONDING",
      staffId:     auth.currentUser?.uid || ("staff-web-" + Date.now()),
      respondedAt: serverTimestamp(),
    });

    btn.textContent = "✅  RESPONDING";
    setTimeout(() => go("scr-map"), 1200);

  } catch (err) {
    btn.disabled    = false;
    btn.textContent = "✅ \u00A0 ACCEPT RESPONSE";
    alert("Update failed: " + err.message);
  }
};

/* ══════════════════════════════════════════════════════════════════════════
   DASHBOARD — Real-time Firestore listeners for three metrics

   1. Total Successful Interventions (#odo-num)
      → onSnapshot WHERE status == "RESOLVED"

   2. Active Incidents (#stat-active)
      → onSnapshot WHERE status == "PENDING"

   3. Resolved Today (#stat-today)
      → onSnapshot WHERE status == "RESOLVED" AND resolvedAt >= today 00:00

   Chart.js doughnut is drawn once (not real-time).
══════════════════════════════════════════════════════════════════════════ */
let dashResolvedUnsub = null;
let dashActiveUnsub   = null;
let dashTodayUnsub    = null;
let dashListUnsub     = null;

function initDashboard() {
  if (dashUnsub) return; // mark as started (reuse dashUnsub as guard)
  dashUnsub = true;

  // ── 1. Total resolved (odometer) ──────────────────────────────────────
  const qResolved = query(
    collection(db, "incidents"),
    where("status", "==", "RESOLVED")
  );
  dashResolvedUnsub = onSnapshot(qResolved, snap => {
    animateOdometer(snap.size);
    document.getElementById("odo-sub").textContent = `${snap.size} total resolved interventions`;
  });

  // ── 2. Active (PENDING) incidents ─────────────────────────────────────
  const qActive = query(
    collection(db, "incidents"),
    where("status", "==", "PENDING")
  );
  dashActiveUnsub = onSnapshot(qActive, snap => {
    document.getElementById("stat-active").textContent   = snap.size;
    document.getElementById("stat-active-d").textContent = snap.size > 0 ? "⚠ Needs attention" : "✓ All clear";
    document.getElementById("dash-live-count").textContent = snap.size + " live";
  });

  // ── 3. Resolved today — filter by resolvedAt >= today 00:00 ──────────
  const now       = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const todayTs    = Timestamp.fromDate(todayStart);

  const qToday = query(
    collection(db, "incidents"),
    where("status", "==", "RESOLVED"),
    where("resolvedAt", ">=", todayTs)
  );
  dashTodayUnsub = onSnapshot(qToday, snap => {
    document.getElementById("stat-today").textContent   = snap.size;
    document.getElementById("stat-today-d").textContent = snap.size > 0 ? `↑ ${snap.size} resolved today` : "";
  });

  // ── 4. Recent incidents list (last 20 for display) ────────────────────
  const qList = query(
    collection(db, "incidents"),
    orderBy("createdAt", "desc"),
    limit(20)
  );
  dashListUnsub = onSnapshot(qList, snap => {
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderIncidentList(all, "dash-incident-list", false);
  });

  // ── 5. Draw Chart.js doughnut once ───────────────────────────────────
  drawPieChart();
}

/* ─────────────────────────────────────────────────
   ODOMETER — smooth count animation
─────────────────────────────────────────────────── */
let odoTarget  = 0;
let odoTimer   = null;

function animateOdometer(target) {
  if (odoTarget === target) return;
  odoTarget = target;
  if (odoTimer) clearInterval(odoTimer);

  const el      = document.getElementById("odo-num");
  let   current = parseInt(el.textContent) || 0;
  const diff    = target - current;
  if (diff === 0) return;

  const step     = diff > 0 ? 1 : -1;
  const interval = Math.max(20, Math.floor(600 / Math.abs(diff)));

  odoTimer = setInterval(() => {
    current += step;
    el.textContent = current;
    if (current === target) { clearInterval(odoTimer); odoTimer = null; }
  }, interval);
}

/* ─────────────────────────────────────────────────
   PIE CHART — Chart.js doughnut
   Medical 70% | Fire 15% | Security 15%
─────────────────────────────────────────────────── */
function drawPieChart() {
  const canvas = document.getElementById("pie-chart");
  if (!canvas) return;
  if (chartInstance) chartInstance.destroy();

  chartInstance = new Chart(canvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels:   ["Medical", "Fire / Smoke", "Security"],
      datasets: [{
        data:            [70, 15, 15],
        backgroundColor: ["#E24B4A", "#EF9F27", "#5B8DEF"],
        borderColor:     "#111116",
        borderWidth:     3,
        hoverOffset:     6,
      }],
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      cutout:              "68%",
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks:       { label: ctx => ` ${ctx.label}: ${ctx.parsed}%` },
          backgroundColor: "#18181F",
          borderColor:     "#2D2D38",
          borderWidth:     1,
          titleColor:      "#EDEAE3",
          bodyColor:       "#9A9890",
        },
      },
      animation: { animateRotate: true, duration: 900 },
    },
  });
}
