// ============================================================
//  CrisisSync — Express Backend Server
//  Runs on Railway.app (FREE — no card needed)
//  Firestore + Gemini AI + Cloudinary + FCM — all free
// ============================================================
"use strict";

const express    = require("express");
const admin      = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cloudinary = require("cloudinary").v2;
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── FIREBASE ADMIN ───────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db        = admin.firestore();
const messaging = admin.messaging();

// ── CLOUDINARY ───────────────────────────────────────────────
cloudinary.config({
  cloud_name : process.env.CLOUDINARY_CLOUD_NAME,
  api_key    : process.env.CLOUDINARY_API_KEY,
  api_secret : process.env.CLOUDINARY_API_SECRET,
});

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "CrisisSync backend is running!", time: new Date().toISOString() });
});

// ═════════════════════════════════════════════════════════════
//  ROUTE 1: POST /triage
//  Flutter calls this when guest submits SOS
//  Body: { incidentId, type, location, description, hotelId, photoBase64? }
// ═════════════════════════════════════════════════════════════
app.post("/triage", async (req, res) => {
  const { incidentId, type, location, description, hotelId, photoBase64 } = req.body;
  if (!incidentId) return res.status(400).json({ error: "incidentId is required" });

  console.log("=== TRIAGE ===", incidentId, type);
  res.json({ success: true, message: "Triage started", incidentId });

  // A. Upload photo
  let photoUrl = null;
  if (photoBase64) {
    try {
      const r = await cloudinary.uploader.upload("data:image/jpeg;base64," + photoBase64, {
        folder: "crisissync/incidents", public_id: incidentId, resource_type: "image",
        transformation: [{ width: 1200, crop: "limit" }, { quality: "auto" }],
      });
      photoUrl = r.secure_url;
      await db.collection("incidents").doc(incidentId).update({
        photoUrl, photoBase64: admin.firestore.FieldValue.delete(),
      });
      console.log("Photo uploaded:", photoUrl);
    } catch (e) { console.error("Cloudinary failed:", e.message); }
  }

  // B. Gemini triage
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const prompt = `You are CrisisSync AI emergency coordinator for a hotel.
Respond with ONLY raw JSON, no markdown, no backticks.
Incident: Type=${type||"Unknown"}, Location=${location||"Unknown"}, Description=${description||"None"}, Photo=${photoUrl?"Yes":"No"}
Return: {"severity":"LOW or MEDIUM or CRITICAL","category":"MEDICAL or FIRE or SECURITY or MAINTENANCE or OTHER","dispatch_message":"2-sentence staff alert","action_steps":["step1","step2","step3"],"notify_roles":["Security"],"guest_message":"calm message for guest","escalate_to_112":false,"eta_minutes":5}`;

    const geminiResult = await model.generateContent(prompt);
    const raw = geminiResult.response.text().trim().replace(/```json/gi,"").replace(/```/g,"").trim();
    const triage = JSON.parse(raw);
    console.log("Triage:", triage.severity, triage.notify_roles);

    // C. Save to Firestore
    await db.collection("incidents").doc(incidentId).update({
      triage, status: "ACTIVE", photoUrl: photoUrl||null,
      triageCompletedAt: admin.firestore.FieldValue.serverTimestamp(), triageError: false,
    });

    // D. FCM notifications
    await notifyStaff(triage.notify_roles, { type, location }, triage, incidentId);

  } catch (err) {
    console.error("Triage error:", err.message);
    await db.collection("incidents").doc(incidentId).update({
      status: "ACTIVE", triageError: true, triageErrorMsg: err.message,
    });
  }
});

// ═════════════════════════════════════════════════════════════
//  ROUTE 2: POST /escalate
//  Body: { incidentId }
// ═════════════════════════════════════════════════════════════
app.post("/escalate", async (req, res) => {
  const { incidentId } = req.body;
  if (!incidentId) return res.status(400).json({ error: "incidentId required" });

  const doc = await db.collection("incidents").doc(incidentId).get();
  if (!doc.exists) return res.status(404).json({ error: "Incident not found" });

  res.json({ success: true, message: "Generating responder brief..." });

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const prompt = `Generate emergency brief for first responders. ONLY raw JSON.
Incident: ${JSON.stringify(doc.data())}
Return: {"incident_summary":"paragraph","exact_location":"floor,room,landmarks","access_route":"best entry","number_affected":1,"medical_notes":"info","hazards":"any hazards","recommended_units":"ambulance/police","priority_level":"P1"}`;

    const result = await model.generateContent(prompt);
    const brief  = JSON.parse(result.response.text().trim().replace(/```json/gi,"").replace(/```/g,"").trim());

    await db.collection("incidents").doc(incidentId).update({
      escalated: true, responderBrief: brief,
      responderBriefGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("Responder brief saved:", incidentId);
  } catch (err) { console.error("Escalation failed:", err.message); }
});

// ═════════════════════════════════════════════════════════════
//  ROUTE 3: POST /resolve
//  Body: { incidentId }
// ═════════════════════════════════════════════════════════════
app.post("/resolve", async (req, res) => {
  const { incidentId } = req.body;
  if (!incidentId) return res.status(400).json({ error: "incidentId required" });

  const doc = await db.collection("incidents").doc(incidentId).get();
  if (!doc.exists) return res.status(404).json({ error: "Incident not found" });

  await db.collection("incidents").doc(incidentId).update({
    status: "RESOLVED", resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  res.json({ success: true, message: "Resolved! Generating summary..." });

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const prompt = `Generate post-incident report for hotel management. ONLY raw JSON.
Incident: ${JSON.stringify(doc.data())}
Return: {"executive_summary":"2-3 sentences","timeline":"chronological","response_effectiveness":"assessment","guest_impact":"impact","recommendations":["rec1","rec2","rec3"],"follow_up_required":false,"insurance_relevant":false,"severity_rating":3}`;

    const result  = await model.generateContent(prompt);
    const summary = JSON.parse(result.response.text().trim().replace(/```json/gi,"").replace(/```/g,"").trim());

    await db.collection("incidents").doc(incidentId).update({
      postIncidentSummary: summary, summaryGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log("Summary saved:", incidentId);
  } catch (err) { console.error("Summary failed:", err.message); }
});

// ═════════════════════════════════════════════════════════════
//  ROUTE 4: GET /predict/:hotelId
// ═════════════════════════════════════════════════════════════
app.get("/predict/:hotelId", async (req, res) => {
  const { hotelId } = req.params;
  const since = new Date(); since.setDate(since.getDate() - 90);
  const incSnap = await db.collection("incidents").where("createdAt", ">=", since).get();
  if (incSnap.empty) return res.json({ message: "No incidents in last 90 days" });

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
    const incidents = incSnap.docs.map(d => d.data());
    const prompt = `Analyze hotel incidents for risk prediction. ONLY raw JSON.
Data: ${JSON.stringify(incidents.slice(0,40))}
Return: {"high_risk_areas":["area1"],"high_risk_times":["Friday nights"],"predicted_incident_types":["MEDICAL"],"risk_score":50,"recommendations":["rec1","rec2"],"trend":"STABLE","analysis_summary":"summary"}`;

    const result     = await model.generateContent(prompt);
    const prediction = JSON.parse(result.response.text().trim().replace(/```json/gi,"").replace(/```/g,"").trim());

    await db.collection("hotels").doc(hotelId).collection("predictions").add({
      ...prediction, createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true, prediction });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── HELPER: notifyStaff ──────────────────────────────────────
async function notifyStaff(roles, incident, triage, incidentId) {
  for (const role of roles) {
    const snap = await db.collection("staff").where("role","==",role).where("isOnDuty","==",true).get();
    if (snap.empty) continue;
    const tokens = snap.docs.map(d => d.data().fcmToken).filter(t => t && t.length > 10);
    if (!tokens.length) continue;
    try {
      await messaging.sendEachForMulticast({
        tokens,
        notification: { title: "ALERT "+triage.severity+": "+(incident.type||"Emergency"), body: triage.dispatch_message },
        android: { priority: "high", notification: { sound: "default", channelId: "crisis_alerts" } },
        data: { incidentId, severity: triage.severity, location: incident.location||"", type: incident.type||"" },
      });
      console.log("FCM sent to", role);
    } catch (e) { console.error("FCM failed:", role, e.message); }
  }
}

// ── START SERVER ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("CrisisSync running on port", PORT));