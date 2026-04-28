// ============================================================
//  CrisisSync — Complete Backend (FINAL VERSION)
//  Firebase Functions v2 + Gemini 1.5 Pro + Cloudinary + FCM
//  Node 20 Compatible
// ============================================================

"use strict";

// ─────────────────────────────────────────────────────────────
//  STEP 1: IMPORTS
//  These lines load all the tools your backend needs
// ─────────────────────────────────────────────────────────────

// Firebase Functions v2 — triggers for Firestore events
const {
  onDocumentCreated,
  onDocumentUpdated,
} = require("firebase-functions/v2/firestore");

// Firebase Functions v2 — callable HTTPS functions (staff app + admin dashboard)
const { onCall, HttpsError } = require("firebase-functions/v2/https");

// Firebase Functions v2 — scheduled (cron) jobs
const { onSchedule } = require("firebase-functions/v2/scheduler");

// Firebase Functions — secret key manager
const { defineSecret } = require("firebase-functions/params");

// Firebase Admin SDK — talks to Firestore, FCM, Auth
const admin = require("firebase-admin");

// Google Gemini AI
const { GoogleGenerativeAI } = require("@google/generative-ai");

// Cloudinary — photo/file storage
const cloudinary = require("cloudinary").v2;

// ─────────────────────────────────────────────────────────────
//  STEP 2: START FIREBASE
//  This one line connects your code to your Firebase project
// ─────────────────────────────────────────────────────────────

admin.initializeApp();

// ─────────────────────────────────────────────────────────────
//  STEP 3: SECRET KEY REFERENCES
//  These are NOT the actual keys — just name references
//  Firebase automatically injects the real values at runtime
//  You stored these using: firebase functions:secrets:set NAME
// ─────────────────────────────────────────────────────────────

const GEMINI_KEY            = defineSecret("GEMINI_KEY");
const CLOUDINARY_CLOUD_NAME = defineSecret("CLOUDINARY_CLOUD_NAME");
const CLOUDINARY_API_KEY    = defineSecret("CLOUDINARY_API_KEY");
const CLOUDINARY_API_SECRET = defineSecret("CLOUDINARY_API_SECRET");

// ═════════════════════════════════════════════════════════════
//
//  FUNCTION 1: triageIncident
//
//  WHAT IT DOES:
//  - Runs automatically the moment a guest submits an SOS
//  - If guest sent a photo → uploads it to Cloudinary
//  - Calls Gemini AI with the incident details
//  - Gemini decides: severity, which staff to alert, message
//  - Saves the triage result back to Firestore
//  - Sends push notifications to on-duty staff via FCM
//
//  TRIGGER: New document created in "incidents" collection
//
// ═════════════════════════════════════════════════════════════

exports.triageIncident = onDocumentCreated(
  {
    document       : "incidents/{incidentId}",
    region         : "asia-south1",   // Mumbai server — fastest for India
    timeoutSeconds : 120,             // give Gemini up to 2 minutes
    secrets        : [
      GEMINI_KEY,
      CLOUDINARY_CLOUD_NAME,
      CLOUDINARY_API_KEY,
      CLOUDINARY_API_SECRET,
    ],
  },

  async (event) => {

    // Get the newly created Firestore document
    const snap = event.data;
    if (!snap) {
      console.log("No data in event — skipping");
      return;
    }

    const incident   = snap.data();       // all the fields guest submitted
    const incidentId = event.params.incidentId;  // the document ID
    const db         = admin.firestore(); // database connection

    console.log("========================================");
    console.log("NEW INCIDENT:", incidentId);
    console.log("Type:", incident.type);
    console.log("Location:", incident.location);
    console.log("========================================");

    // ── A. SET UP CLOUDINARY ─────────────────────────────────
    // This MUST be inside the function (not outside)
    // because secrets are only available when function runs
    cloudinary.config({
      cloud_name : CLOUDINARY_CLOUD_NAME.value(),
      api_key    : CLOUDINARY_API_KEY.value(),
      api_secret : CLOUDINARY_API_SECRET.value(),
    });

    // ── B. UPLOAD PHOTO TO CLOUDINARY (if guest sent one) ────
    let photoUrl = null;

    if (incident.photoBase64) {
      console.log("Photo detected — uploading to Cloudinary...");

      try {
        const uploadResult = await cloudinary.uploader.upload(
          "data:image/jpeg;base64," + incident.photoBase64,
          {
            folder        : "crisissync/incidents",  // folder in Cloudinary
            public_id     : incidentId,              // filename = incident ID
            resource_type : "image",
            transformation: [
              { width: 1200, crop: "limit" },        // max width 1200px
              { quality: "auto" },                   // auto compress
            ],
          }
        );

        photoUrl = uploadResult.secure_url;
        console.log("Photo uploaded successfully:", photoUrl);

        // Save Cloudinary URL to Firestore
        // AND delete the heavy base64 data (can be 2-3 MB — wastes space)
        await snap.ref.update({
          photoUrl    : photoUrl,
          photoBase64 : admin.firestore.FieldValue.delete(),
        });

      } catch (uploadErr) {
        // If photo upload fails, we continue anyway
        // The SOS triage is more important than the photo
        console.error("Cloudinary failed (continuing without photo):", uploadErr.message);
      }

    } else {
      console.log("No photo in this incident — skipping Cloudinary");
    }

    // ── C. CALL GEMINI AI FOR TRIAGE ─────────────────────────
    console.log("Calling Gemini AI...");

    const genAI = new GoogleGenerativeAI(GEMINI_KEY.value());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    // This is what we send to Gemini
    // We tell it EXACTLY what format to reply in (JSON only)
    const triagePrompt = `
You are CrisisSync, an AI emergency coordinator for a hospitality venue.
Analyze the incident below and return a triage decision.

CRITICAL RULE: Reply with ONLY a raw JSON object.
No explanation. No markdown. No backticks. Just the JSON starting with { and ending with }.

INCIDENT DETAILS:
- Type: ${incident.type || "Unknown"}
- Location: ${incident.location || "Unknown"}  
- Description: ${incident.description || "No description provided"}
- Hotel ID: ${incident.hotelId || "Unknown"}
- Photo attached: ${photoUrl ? "Yes — " + photoUrl : "No"}
- Reported at: ${new Date().toISOString()}

RESPOND WITH THIS EXACT JSON STRUCTURE:
{
  "severity": "LOW" or "MEDIUM" or "CRITICAL",
  "category": "MEDICAL" or "FIRE" or "SECURITY" or "MAINTENANCE" or "OTHER",
  "dispatch_message": "A clear 2-sentence alert message for responding staff",
  "action_steps": ["Immediate action 1", "Immediate action 2", "Immediate action 3"],
  "notify_roles": ["Security"] or ["Medical"] or ["Security", "Medical", "Management"],
  "guest_message": "A calm reassuring message to display to the distressed guest",
  "escalate_to_112": true or false,
  "eta_minutes": estimated staff arrival time as a number
}`;

    try {
      // Send prompt to Gemini and get response
      const geminiResult = await model.generateContent(triagePrompt);
      const rawResponse  = geminiResult.response.text().trim();

      console.log("Gemini raw response (first 300 chars):");
      console.log(rawResponse.substring(0, 300));

      // Clean response in case Gemini accidentally added ```json ... ```
      const cleanedResponse = rawResponse
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      // Parse the JSON
      const triage = JSON.parse(cleanedResponse);

      console.log("Triage severity:", triage.severity);
      console.log("Notify roles:", triage.notify_roles);
      console.log("Escalate to 112:", triage.escalate_to_112);

      // ── D. SAVE TRIAGE RESULT TO FIRESTORE ───────────────────
      await snap.ref.update({
        triage            : triage,
        status            : "ACTIVE",
        photoUrl          : photoUrl || null,
        triageCompletedAt : admin.firestore.FieldValue.serverTimestamp(),
        triageError       : false,
      });

      console.log("Triage saved to Firestore successfully");

      // ── E. SEND FCM PUSH NOTIFICATIONS TO STAFF ──────────────
      await notifyStaff(
        triage.notify_roles,
        incident,
        triage,
        incidentId,
        db
      );

      console.log("triageIncident completed successfully for:", incidentId);

    } catch (geminiErr) {
      // Gemini failed — but we still mark incident ACTIVE
      // so staff can manually see it in the dashboard
      console.error("Gemini triage failed:", geminiErr.message);

      await snap.ref.update({
        status         : "ACTIVE",
        triageError    : true,
        triageErrorMsg : geminiErr.message,
        photoUrl       : photoUrl || null,
      });
    }
  }
);

// ═════════════════════════════════════════════════════════════
//
//  HELPER FUNCTION: notifyStaff
//
//  WHAT IT DOES:
//  - Takes the list of roles Gemini said to notify
//    e.g. ["Security", "Medical"]
//  - For each role, finds all staff who are on duty
//  - Collects their FCM tokens (phone notification addresses)
//  - Sends a high-priority push notification to each phone
//
//  This is NOT exported — it's only called by triageIncident
//
// ═════════════════════════════════════════════════════════════

async function notifyStaff(roles, incident, triage, incidentId, db) {

  const messaging = admin.messaging();

  // Loop through each role Gemini said to notify
  for (const role of roles) {
    console.log("Searching for on-duty staff with role:", role);

    // Query Firestore: find staff with this role who are on duty
    const staffSnapshot = await db
      .collection("staff")
      .where("role",     "==", role)
      .where("isOnDuty", "==", true)
      .get();

    if (staffSnapshot.empty) {
      console.log("No on-duty staff found for role:", role);
      continue; // skip to next role
    }

    // Collect all their FCM tokens
    // FCM token = a unique address for each phone/device
    const tokens = staffSnapshot.docs
      .map((doc) => doc.data().fcmToken)
      .filter((token) => token && token.length > 10); // remove empty/invalid tokens

    if (tokens.length === 0) {
      console.log("Staff found but no valid FCM tokens for role:", role);
      continue;
    }

    console.log("Sending push notification to", tokens.length, role, "staff...");

    // Send the push notification to all their phones at once
    try {
      const response = await messaging.sendEachForMulticast({
        tokens : tokens,

        notification: {
          title: "ALERT " + triage.severity + ": " + (incident.type || "Emergency"),
          body  : triage.dispatch_message,
        },

        android: {
          priority: "high",             // wakes phone even if on silent
          notification: {
            sound     : "default",
            channelId : "crisis_alerts",
            priority  : "max",
          },
        },

        // Extra data sent with notification (for the Flutter app to use)
        data: {
          incidentId : incidentId,
          severity   : triage.severity,
          location   : incident.location || "",
          type       : incident.type     || "",
          photoUrl   : incident.photoUrl || "",
        },
      });

      console.log("FCM sent successfully to", role);
      console.log("Success count:", response.successCount);
      console.log("Failure count:", response.failureCount);

    } catch (fcmErr) {
      console.error("FCM failed for role:", role, fcmErr.message);
    }
  }
}

// ═════════════════════════════════════════════════════════════
//
//  FUNCTION 2: generateResponderBrief
//
//  WHAT IT DOES:
//  - Runs when an admin taps "Escalate to Emergency Services"
//  - This flips incident.escalated from false to true
//  - Gemini generates a professional brief for 112/ambulance/fire
//  - Brief includes exact location, hazards, access routes etc.
//
//  TRIGGER: incident document updated + escalated = true
//
// ═════════════════════════════════════════════════════════════

exports.generateResponderBrief = onDocumentUpdated(
  {
    document : "incidents/{incidentId}",
    region   : "asia-south1",
    secrets  : [GEMINI_KEY],
  },

  async (event) => {

    const before = event.data.before.data(); // document BEFORE the update
    const after  = event.data.after.data();  // document AFTER the update

    // Only run when escalated changes from false → true
    // If escalated didn't change, exit immediately
    if (before.escalated === after.escalated) return;
    if (!after.escalated) return;

    console.log("========================================");
    console.log("INCIDENT ESCALATED — generating responder brief");
    console.log("Incident ID:", event.params.incidentId);
    console.log("========================================");

    const genAI = new GoogleGenerativeAI(GEMINI_KEY.value());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    const briefPrompt = `
You are CrisisSync generating an emergency brief for first responders.
This will be read by ambulance crews, firefighters, and police.
It must be clear, precise, and professional.

CRITICAL RULE: Reply with ONLY raw JSON. No markdown. No extra text.

INCIDENT DATA:
${JSON.stringify(after, null, 2)}

RETURN THIS JSON:
{
  "incident_summary": "One clear paragraph describing the full emergency situation",
  "exact_location": "Precise location including building, floor, room, and landmarks",
  "access_route": "Best entry point and route for emergency vehicles",
  "number_affected": estimated number of people affected as integer,
  "medical_notes": "Relevant medical information, conditions, allergies if known",
  "hazards": "Any fire, chemical, structural, or electrical hazards",
  "recommended_units": "Which units to dispatch e.g. 1 ambulance, 2 police",
  "priority_level": "P1" or "P2" or "P3"
}`;

    try {
      const result = await model.generateContent(briefPrompt);
      const raw    = result.response.text().trim()
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      const brief = JSON.parse(raw);

      await event.data.after.ref.update({
        responderBrief            : brief,
        responderBriefGeneratedAt : admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("Responder brief saved successfully");

    } catch (err) {
      console.error("Responder brief generation failed:", err.message);
    }
  }
);

// ═════════════════════════════════════════════════════════════
//
//  FUNCTION 3: generatePostIncidentSummary
//
//  WHAT IT DOES:
//  - Runs when staff marks an incident as RESOLVED
//  - Gemini writes a full incident report
//  - Report is used by management and insurance
//  - Includes timeline, effectiveness assessment, recommendations
//
//  TRIGGER: incident.status changes to "RESOLVED"
//
// ═════════════════════════════════════════════════════════════

exports.generatePostIncidentSummary = onDocumentUpdated(
  {
    document : "incidents/{incidentId}",
    region   : "asia-south1",
    secrets  : [GEMINI_KEY],
  },

  async (event) => {

    const before = event.data.before.data();
    const after  = event.data.after.data();

    // Only run when status changes TO "RESOLVED"
    if (before.status === after.status) return;
    if (after.status !== "RESOLVED") return;

    console.log("========================================");
    console.log("INCIDENT RESOLVED — generating summary report");
    console.log("========================================");

    const genAI = new GoogleGenerativeAI(GEMINI_KEY.value());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    const summaryPrompt = `
You are CrisisSync generating a post-incident report for hotel management.
This report may be used for insurance claims, staff training, and legal records.

CRITICAL RULE: Reply with ONLY raw JSON. No markdown. No extra text.

INCIDENT DATA:
${JSON.stringify(after, null, 2)}

RETURN THIS JSON:
{
  "executive_summary": "2-3 sentences summarizing what happened and how it was resolved",
  "timeline": "Chronological timeline of events from first report to resolution",
  "response_effectiveness": "Objective assessment of how well the team handled the situation",
  "guest_impact": "Description of how hotel guests were affected",
  "recommendations": [
    "Specific recommendation 1 to prevent recurrence",
    "Specific recommendation 2 to improve response",
    "Specific recommendation 3 for staff training"
  ],
  "follow_up_required": true or false,
  "insurance_relevant": true or false,
  "severity_rating": integer from 1 (minor) to 5 (catastrophic)
}`;

    try {
      const result  = await model.generateContent(summaryPrompt);
      const raw     = result.response.text().trim()
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      const summary = JSON.parse(raw);

      await event.data.after.ref.update({
        postIncidentSummary : summary,
        summaryGeneratedAt  : admin.firestore.FieldValue.serverTimestamp(),
      });

      console.log("Post-incident summary saved successfully");

    } catch (err) {
      console.error("Post-incident summary failed:", err.message);
    }
  }
);

// ═════════════════════════════════════════════════════════════
//
//  FUNCTION 4: nightlyRiskPrediction
//
//  WHAT IT DOES:
//  - Runs automatically every night at midnight IST
//  - Reads all incidents from the last 90 days
//  - Sends them to Gemini for pattern analysis
//  - Gemini predicts future risks and hotspot areas
//  - Saves predictions to each hotel's subcollection
//
//  TRIGGER: Cloud Scheduler — cron "0 0 * * *" (midnight daily)
//
// ═════════════════════════════════════════════════════════════

exports.nightlyRiskPrediction = onSchedule(
  {
    schedule : "0 0 * * *",      // midnight every day
    timeZone : "Asia/Kolkata",   // IST timezone
    region   : "asia-south1",
    secrets  : [GEMINI_KEY],
  },

  async () => {

    console.log("========================================");
    console.log("NIGHTLY RISK PREDICTION — starting");
    console.log("Time:", new Date().toISOString());
    console.log("========================================");

    const db = admin.firestore();

    // Get all hotels in the system
    const hotelsSnap = await db.collection("hotels").get();

    if (hotelsSnap.empty) {
      console.log("No hotels in database — skipping risk prediction");
      return;
    }

    console.log("Hotels found:", hotelsSnap.size);

    // Get incidents from the last 90 days
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const incidentsSnap = await db
      .collection("incidents")
      .where("createdAt", ">=", ninetyDaysAgo)
      .get();

    if (incidentsSnap.empty) {
      console.log("No incidents in last 90 days — skipping");
      return;
    }

    const incidents = incidentsSnap.docs.map((doc) => doc.data());
    console.log("Incidents analyzed:", incidents.length);

    const genAI = new GoogleGenerativeAI(GEMINI_KEY.value());
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    const riskPrompt = `
You are CrisisSync analyzing 90 days of hotel incident data to predict future risks.
Use pattern recognition to identify trends and high-risk situations.

CRITICAL RULE: Reply with ONLY raw JSON. No markdown. No extra text.

HISTORICAL INCIDENT DATA (last 90 days, ${incidents.length} total incidents):
${JSON.stringify(incidents.slice(0, 40), null, 2)}

RETURN THIS JSON:
{
  "high_risk_areas": ["Specific area 1", "Specific area 2", "Specific area 3"],
  "high_risk_times": ["Friday evenings", "Early morning 2-4am", "Checkout rush"],
  "predicted_incident_types": ["MEDICAL", "SECURITY"],
  "risk_score": integer from 1 (very safe) to 100 (very dangerous),
  "recommendations": [
    "Specific actionable recommendation 1",
    "Specific actionable recommendation 2",
    "Specific actionable recommendation 3"
  ],
  "trend": "IMPROVING" or "STABLE" or "WORSENING",
  "analysis_summary": "2-3 sentence overview of patterns found"
}`;

    try {
      const result     = await model.generateContent(riskPrompt);
      const raw        = result.response.text().trim()
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

      const prediction = JSON.parse(raw);

      console.log("Risk score:", prediction.risk_score);
      console.log("Trend:", prediction.trend);

      // Save prediction to EVERY hotel's predictions subcollection
      const savePromises = hotelsSnap.docs.map((hotelDoc) =>
        hotelDoc.ref.collection("predictions").add({
          ...prediction,
          createdAt      : admin.firestore.FieldValue.serverTimestamp(),
          incidentsCount : incidents.length,
          periodDays     : 90,
        })
      );

      await Promise.all(savePromises);
      console.log("Risk prediction saved to all", hotelsSnap.size, "hotels");

    } catch (err) {
      console.error("Risk prediction failed:", err.message);
    }
  }
);


// ╔═══════════════════════════════════════════════════════════╗
// ║           STAFF APP BACKEND FUNCTIONS                     ║
// ║  registerStaff · toggleDuty · updateFcmToken ·           ║
// ║  acknowledgeIncident · uploadStaffPhoto ·                 ║
// ║  getMyIncidents                                           ║
// ╚═══════════════════════════════════════════════════════════╝

// ═════════════════════════════════════════════════════════════
//
//  STAFF FUNCTION 1: registerStaff
//
//  WHAT IT DOES:
//  - Called from Flutter staff app when a new staff member signs up
//  - Creates a Firebase Auth user with email + password
//  - Creates a Firestore document in "staff" collection
//  - Optionally uploads a profile photo to Cloudinary
//  - Sets custom claim { role } on the Auth token
//    so Firestore rules can check request.auth.token.role
//
//  Flutter calls:
//    FirebaseFunctions.instance.httpsCallable('registerStaff').call({
//      name, email, password, role, hotelId, phone, photoBase64
//    })
//
//  Roles: "Security" | "Medical" | "Maintenance" | "Management" | "Receptionist"
//
// ═════════════════════════════════════════════════════════════

exports.registerStaff = onCall(
  {
    region  : "asia-south1",
    secrets : [CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET],
  },

  async (request) => {
    const { name, email, password, role, hotelId, phone, photoBase64 } = request.data;

    // ── VALIDATE ─────────────────────────────────────────────
    if (!name || !email || !password || !role || !hotelId) {
      throw new HttpsError("invalid-argument", "name, email, password, role, hotelId are required");
    }

    const VALID_ROLES = ["Security", "Medical", "Maintenance", "Management", "Receptionist"];
    if (!VALID_ROLES.includes(role)) {
      throw new HttpsError("invalid-argument", `role must be one of: ${VALID_ROLES.join(", ")}`);
    }

    const db = admin.firestore();

    // ── CREATE FIREBASE AUTH USER ────────────────────────────
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({ email, password, displayName: name });
      console.log("Auth user created:", userRecord.uid);
    } catch (err) {
      throw new HttpsError("already-exists", "Email already in use or invalid: " + err.message);
    }

    const uid = userRecord.uid;

    // ── SET CUSTOM CLAIM (role) ──────────────────────────────
    // Flutter can read this from: FirebaseAuth.instance.currentUser.getIdTokenResult()
    await admin.auth().setCustomUserClaims(uid, { role, hotelId });

    // ── UPLOAD PROFILE PHOTO (optional) ─────────────────────
    let photoUrl = null;
    if (photoBase64) {
      cloudinary.config({
        cloud_name : CLOUDINARY_CLOUD_NAME.value(),
        api_key    : CLOUDINARY_API_KEY.value(),
        api_secret : CLOUDINARY_API_SECRET.value(),
      });

      try {
        const result = await cloudinary.uploader.upload(
          "data:image/jpeg;base64," + photoBase64,
          {
            folder        : "crisissync/staff",
            public_id     : uid,
            resource_type : "image",
            transformation: [
              { width: 400, height: 400, crop: "fill", gravity: "face" },
              { quality: "auto" },
            ],
          }
        );
        photoUrl = result.secure_url;
        console.log("Staff photo uploaded:", photoUrl);
      } catch (photoErr) {
        console.error("Staff photo upload failed (continuing):", photoErr.message);
      }
    }

    // ── CREATE FIRESTORE STAFF DOCUMENT ─────────────────────
    const staffData = {
      uid,
      name,
      email,
      role,
      hotelId,
      phone        : phone || null,
      photoUrl     : photoUrl || null,
      isOnDuty     : false,           // staff starts off-duty
      fcmToken     : null,            // set when they log in on device
      isActive     : true,            // admin can deactivate staff
      createdAt    : admin.firestore.FieldValue.serverTimestamp(),
      lastSeenAt   : null,
    };

    await db.collection("staff").doc(uid).set(staffData);
    console.log("Staff document created:", uid, role);

    return {
      success : true,
      uid,
      message : `Staff member ${name} registered as ${role}`,
    };
  }
);

// ═════════════════════════════════════════════════════════════
//
//  STAFF FUNCTION 2: toggleDuty
//
//  WHAT IT DOES:
//  - Staff taps "Go On Duty" / "Go Off Duty" in the app
//  - Updates isOnDuty in their Firestore document
//  - When going ON duty: records dutyStartedAt timestamp
//  - When going OFF duty: records dutyEndedAt timestamp
//  - notifyStaff() uses isOnDuty to decide who gets FCM alerts
//
//  Flutter calls:
//    FirebaseFunctions.instance.httpsCallable('toggleDuty').call({
//      isOnDuty: true   // or false
//    })
//
// ═════════════════════════════════════════════════════════════

exports.toggleDuty = onCall(
  { region: "asia-south1" },

  async (request) => {
    // Must be logged in
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in to toggle duty");
    }

    const uid      = request.auth.uid;
    const isOnDuty = request.data.isOnDuty;

    if (typeof isOnDuty !== "boolean") {
      throw new HttpsError("invalid-argument", "isOnDuty must be true or false");
    }

    const db  = admin.firestore();
    const ref = db.collection("staff").doc(uid);
    const doc = await ref.get();

    if (!doc.exists) {
      throw new HttpsError("not-found", "Staff document not found");
    }

    if (!doc.data().isActive) {
      throw new HttpsError("permission-denied", "Your account has been deactivated");
    }

    const updateData = {
      isOnDuty,
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isOnDuty) {
      updateData.dutyStartedAt = admin.firestore.FieldValue.serverTimestamp();
      updateData.dutyEndedAt   = null;
    } else {
      updateData.dutyEndedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await ref.update(updateData);
    console.log(`Staff ${uid} duty status → ${isOnDuty}`);

    return {
      success  : true,
      isOnDuty,
      message  : isOnDuty ? "You are now on duty" : "You are now off duty",
    };
  }
);

// ═════════════════════════════════════════════════════════════
//
//  STAFF FUNCTION 3: updateFcmToken
//
//  WHAT IT DOES:
//  - Called on every app launch from the Flutter staff app
//  - Saves the device's latest FCM push token to Firestore
//  - notifyStaff() reads these tokens to send push alerts
//  - Old token is replaced (tokens rotate after time)
//
//  Flutter calls:
//    String token = await FirebaseMessaging.instance.getToken();
//    FirebaseFunctions.instance.httpsCallable('updateFcmToken').call({
//      fcmToken: token
//    })
//
// ═════════════════════════════════════════════════════════════

exports.updateFcmToken = onCall(
  { region: "asia-south1" },

  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { fcmToken } = request.data;
    if (!fcmToken || typeof fcmToken !== "string" || fcmToken.length < 10) {
      throw new HttpsError("invalid-argument", "Valid fcmToken is required");
    }

    const db = admin.firestore();
    await db.collection("staff").doc(request.auth.uid).update({
      fcmToken,
      lastSeenAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log("FCM token updated for staff:", request.auth.uid);
    return { success: true };
  }
);

// ═════════════════════════════════════════════════════════════
//
//  STAFF FUNCTION 4: acknowledgeIncident
//
//  WHAT IT DOES:
//  - Staff taps "I'm Responding" in the app after getting an alert
//  - Saves their acknowledgment to the incident document
//  - Records: who acknowledged, their role, timestamp
//  - Admin dashboard shows these acknowledgments live
//  - If this is the FIRST acknowledgment, sends FCM to admin/manager
//
//  Flutter calls:
//    FirebaseFunctions.instance.httpsCallable('acknowledgeIncident').call({
//      incidentId: "abc123"
//    })
//
// ═════════════════════════════════════════════════════════════

exports.acknowledgeIncident = onCall(
  { region: "asia-south1" },

  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { incidentId } = request.data;
    if (!incidentId) {
      throw new HttpsError("invalid-argument", "incidentId is required");
    }

    const db          = admin.firestore();
    const uid         = request.auth.uid;

    // Get staff info
    const staffDoc = await db.collection("staff").doc(uid).get();
    if (!staffDoc.exists) {
      throw new HttpsError("not-found", "Staff profile not found");
    }
    const staff = staffDoc.data();

    // Get incident
    const incidentRef = db.collection("incidents").doc(incidentId);
    const incidentDoc = await incidentRef.get();
    if (!incidentDoc.exists) {
      throw new HttpsError("not-found", "Incident not found");
    }
    const incident = incidentDoc.data();

    if (incident.status === "RESOLVED") {
      throw new HttpsError("failed-precondition", "This incident is already resolved");
    }

    // Build acknowledgment record
    const ack = {
      uid,
      name      : staff.name,
      role      : staff.role,
      photoUrl  : staff.photoUrl || null,
      ackedAt   : admin.firestore.FieldValue.serverTimestamp(),
    };

    // Add to acknowledgments array, avoid duplicates
    const existing = incident.acknowledgments || [];
    const alreadyAcked = existing.some((a) => a.uid === uid);
    if (alreadyAcked) {
      return { success: true, message: "Already acknowledged" };
    }

    const isFirstAck = existing.length === 0;

    await incidentRef.update({
      acknowledgments           : admin.firestore.FieldValue.arrayUnion(ack),
      firstAcknowledgedAt       : isFirstAck
        ? admin.firestore.FieldValue.serverTimestamp()
        : incident.firstAcknowledgedAt,
      firstResponderName        : isFirstAck ? staff.name  : incident.firstResponderName,
      firstResponderRole        : isFirstAck ? staff.role  : incident.firstResponderRole,
    });

    console.log(`Incident ${incidentId} acknowledged by ${staff.name} (${staff.role})`);

    // Notify managers/admins that someone is responding
    if (isFirstAck) {
      const mgmtSnap = await db.collection("staff")
        .where("role", "in", ["Management", "Receptionist"])
        .where("isOnDuty", "==", true)
        .get();

      const tokens = mgmtSnap.docs
        .map((d) => d.data().fcmToken)
        .filter((t) => t && t.length > 10);

      if (tokens.length > 0) {
        try {
          await admin.messaging().sendEachForMulticast({
            tokens,
            notification: {
              title : "✅ Responder Dispatched",
              body  : `${staff.name} (${staff.role}) is responding to the ${incident.type || "incident"} at ${incident.location || "unknown location"}`,
            },
            data: { incidentId, responderId: uid },
            android: { priority: "high" },
          });
        } catch (fcmErr) {
          console.error("FCM to management failed:", fcmErr.message);
        }
      }
    }

    return {
      success : true,
      message : "You are marked as responding",
    };
  }
);

// ═════════════════════════════════════════════════════════════
//
//  STAFF FUNCTION 5: uploadStaffPhoto
//
//  WHAT IT DOES:
//  - Staff updates their profile photo from the app
//  - Uploads base64 image to Cloudinary
//  - Updates photoUrl in their Firestore document
//  - Old photo is overwritten (same public_id = uid)
//
//  Flutter calls:
//    FirebaseFunctions.instance.httpsCallable('uploadStaffPhoto').call({
//      photoBase64: "<base64 string>"
//    })
//
// ═════════════════════════════════════════════════════════════

exports.uploadStaffPhoto = onCall(
  {
    region  : "asia-south1",
    secrets : [CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET],
  },

  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const { photoBase64 } = request.data;
    if (!photoBase64) {
      throw new HttpsError("invalid-argument", "photoBase64 is required");
    }

    cloudinary.config({
      cloud_name : CLOUDINARY_CLOUD_NAME.value(),
      api_key    : CLOUDINARY_API_KEY.value(),
      api_secret : CLOUDINARY_API_SECRET.value(),
    });

    const uid = request.auth.uid;

    try {
      const result = await cloudinary.uploader.upload(
        "data:image/jpeg;base64," + photoBase64,
        {
          folder        : "crisissync/staff",
          public_id     : uid,               // overwrites old photo
          overwrite     : true,
          resource_type : "image",
          transformation: [
            { width: 400, height: 400, crop: "fill", gravity: "face" },
            { quality: "auto" },
          ],
        }
      );

      const photoUrl = result.secure_url;

      await admin.firestore().collection("staff").doc(uid).update({ photoUrl });
      console.log("Staff photo updated:", uid, photoUrl);

      return { success: true, photoUrl };

    } catch (err) {
      throw new HttpsError("internal", "Photo upload failed: " + err.message);
    }
  }
);

// ═════════════════════════════════════════════════════════════
//
//  STAFF FUNCTION 6: getMyIncidents
//
//  WHAT IT DOES:
//  - Returns incidents relevant to this staff member's role
//  - Filters by: hotelId + role matches notify_roles in triage
//  - Returns last 20 incidents (ACTIVE first, then RESOLVED)
//  - Staff app shows this as their incident history list
//
//  Flutter calls:
//    FirebaseFunctions.instance.httpsCallable('getMyIncidents').call()
//
// ═════════════════════════════════════════════════════════════

exports.getMyIncidents = onCall(
  { region: "asia-south1" },

  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const db       = admin.firestore();
    const uid      = request.auth.uid;
    const staffDoc = await db.collection("staff").doc(uid).get();

    if (!staffDoc.exists) {
      throw new HttpsError("not-found", "Staff profile not found");
    }

    const { role, hotelId } = staffDoc.data();

    // Fetch ACTIVE incidents for this hotel first
    const activeSnap = await db.collection("incidents")
      .where("hotelId", "==", hotelId)
      .where("status", "==", "ACTIVE")
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();

    // Fetch recent RESOLVED incidents
    const resolvedSnap = await db.collection("incidents")
      .where("hotelId", "==", hotelId)
      .where("status", "==", "RESOLVED")
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();

    const toPlain = (doc) => {
      const d = doc.data();
      return {
        id              : doc.id,
        type            : d.type            || "Unknown",
        location        : d.location        || "Unknown",
        description     : d.description     || "",
        status          : d.status          || "ACTIVE",
        severity        : d.triage?.severity || null,
        photoUrl        : d.photoUrl         || null,
        acknowledgments : d.acknowledgments  || [],
        createdAt       : d.createdAt?.toDate().toISOString() || null,
        resolvedAt      : d.resolvedAt?.toDate().toISOString() || null,
        myAck           : (d.acknowledgments || []).some((a) => a.uid === uid),
      };
    };

    const active   = activeSnap.docs.map(toPlain);
    const resolved = resolvedSnap.docs.map(toPlain);

    return {
      success  : true,
      role,
      hotelId,
      incidents: [...active, ...resolved],
    };
  }
);


// ╔═══════════════════════════════════════════════════════════╗
// ║           ADMIN DASHBOARD BACKEND FUNCTIONS               ║
// ║  getDashboardStats · listStaff · setStaffActive ·        ║
// ║  listIncidents · updateHotelConfig · exportIncidents ·   ║
// ║  broadcastAlert                                           ║
// ╚═══════════════════════════════════════════════════════════╝

// ── HELPER: Verify caller is Management/admin role ──────────
async function requireAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in");
  }
  const db  = admin.firestore();
  const doc = await db.collection("staff").doc(request.auth.uid).get();
  if (!doc.exists || doc.data().role !== "Management") {
    throw new HttpsError("permission-denied", "Only Management role can perform this action");
  }
  return doc.data(); // return caller's staff data
}

// ═════════════════════════════════════════════════════════════
//
//  ADMIN FUNCTION 1: getDashboardStats
//
//  WHAT IT DOES:
//  - Returns a single object with all key metrics for the dashboard
//  - Active incident count, resolved today, staff on duty count
//  - Most recent prediction risk score + trend
//  - Last 5 incidents for the "recent" feed
//
//  Dashboard calls this on load and refreshes every 30 seconds.
//
// ═════════════════════════════════════════════════════════════

exports.getDashboardStats = onCall(
  { region: "asia-south1" },

  async (request) => {
    const caller  = await requireAdmin(request);
    const db      = admin.firestore();
    const hotelId = caller.hotelId;

    // Run all queries in parallel for speed
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [
      activeSnap,
      resolvedTodaySnap,
      staffSnap,
      onDutySnap,
      predSnap,
      recentSnap,
    ] = await Promise.all([
      db.collection("incidents").where("hotelId", "==", hotelId).where("status", "==", "ACTIVE").get(),
      db.collection("incidents").where("hotelId", "==", hotelId).where("status", "==", "RESOLVED").where("resolvedAt", ">=", startOfDay).get(),
      db.collection("staff").where("hotelId", "==", hotelId).where("isActive", "==", true).get(),
      db.collection("staff").where("hotelId", "==", hotelId).where("isOnDuty", "==", true).get(),
      db.collection("hotels").doc(hotelId).collection("predictions").orderBy("createdAt", "desc").limit(1).get(),
      db.collection("incidents").where("hotelId", "==", hotelId).orderBy("createdAt", "desc").limit(5).get(),
    ]);

    const prediction = predSnap.empty ? null : predSnap.docs[0].data();

    // Severity breakdown of active incidents
    const severityCount = { LOW: 0, MEDIUM: 0, CRITICAL: 0 };
    activeSnap.docs.forEach((d) => {
      const sev = d.data().triage?.severity;
      if (sev && severityCount[sev] !== undefined) severityCount[sev]++;
    });

    const recentIncidents = recentSnap.docs.map((d) => {
      const data = d.data();
      return {
        id       : d.id,
        type     : data.type     || "Unknown",
        location : data.location || "Unknown",
        status   : data.status   || "ACTIVE",
        severity : data.triage?.severity || null,
        createdAt: data.createdAt?.toDate().toISOString() || null,
      };
    });

    return {
      success         : true,
      hotelId,
      activeIncidents : activeSnap.size,
      resolvedToday   : resolvedTodaySnap.size,
      totalStaff      : staffSnap.size,
      staffOnDuty     : onDutySnap.size,
      severityBreakdown : severityCount,
      riskScore       : prediction?.risk_score  || null,
      riskTrend       : prediction?.trend       || null,
      riskSummary     : prediction?.analysis_summary || null,
      recentIncidents,
    };
  }
);

// ═════════════════════════════════════════════════════════════
//
//  ADMIN FUNCTION 2: listStaff
//
//  WHAT IT DOES:
//  - Returns all staff for the admin's hotel
//  - Optional filter: role, isOnDuty, isActive
//  - Dashboard uses this to show the "Staff Management" table
//
//  Dashboard calls:
//    httpsCallable('listStaff')({ role: "Security", onDutyOnly: false })
//
// ═════════════════════════════════════════════════════════════

exports.listStaff = onCall(
  { region: "asia-south1" },

  async (request) => {
    const caller  = await requireAdmin(request);
    const db      = admin.firestore();
    const { role, onDutyOnly, activeOnly = true } = request.data || {};

    let query = db.collection("staff").where("hotelId", "==", caller.hotelId);

    if (activeOnly)  query = query.where("isActive",  "==", true);
    if (onDutyOnly)  query = query.where("isOnDuty",  "==", true);
    if (role)        query = query.where("role",       "==", role);

    const snap = await query.orderBy("name").get();

    const staff = snap.docs.map((d) => {
      const s = d.data();
      return {
        uid        : d.id,
        name       : s.name,
        email      : s.email,
        role       : s.role,
        phone      : s.phone       || null,
        photoUrl   : s.photoUrl    || null,
        isOnDuty   : s.isOnDuty    || false,
        isActive   : s.isActive    || true,
        lastSeenAt : s.lastSeenAt?.toDate().toISOString() || null,
        dutyStartedAt : s.dutyStartedAt?.toDate().toISOString() || null,
      };
    });

    return { success: true, staff, total: staff.length };
  }
);

// ═════════════════════════════════════════════════════════════
//
//  ADMIN FUNCTION 3: setStaffActive
//
//  WHAT IT DOES:
//  - Admin activates or deactivates a staff account
//  - Deactivated staff: can still log in but toggleDuty blocks them
//  - Also disables/enables the Firebase Auth account
//  - Dashboard: toggle switch next to each staff member
//
//  Dashboard calls:
//    httpsCallable('setStaffActive')({ targetUid: "xxx", isActive: false })
//
// ═════════════════════════════════════════════════════════════

exports.setStaffActive = onCall(
  { region: "asia-south1" },

  async (request) => {
    const caller              = await requireAdmin(request);
    const { targetUid, isActive } = request.data;

    if (!targetUid || typeof isActive !== "boolean") {
      throw new HttpsError("invalid-argument", "targetUid and isActive (bool) are required");
    }

    const db      = admin.firestore();
    const target  = await db.collection("staff").doc(targetUid).get();
    if (!target.exists || target.data().hotelId !== caller.hotelId) {
      throw new HttpsError("not-found", "Staff member not found in your hotel");
    }

    // Update Firestore
    await db.collection("staff").doc(targetUid).update({
      isActive,
      isOnDuty: isActive ? target.data().isOnDuty : false, // force off-duty if deactivated
    });

    // Disable/enable Firebase Auth account
    await admin.auth().updateUser(targetUid, { disabled: !isActive });

    console.log(`Staff ${targetUid} isActive → ${isActive} by admin ${caller.uid}`);
    return {
      success : true,
      message : `Staff member ${isActive ? "activated" : "deactivated"} successfully`,
    };
  }
);

// ═════════════════════════════════════════════════════════════
//
//  ADMIN FUNCTION 4: listIncidents
//
//  WHAT IT DOES:
//  - Returns paginated incident list for the admin dashboard
//  - Filters: status, severity, type, dateFrom, dateTo
//  - Returns full incident data including triage, acknowledgments,
//    post-incident summary, responder brief
//
//  Dashboard calls:
//    httpsCallable('listIncidents')({
//      status: "ACTIVE",         // or "RESOLVED" or null for all
//      severity: "CRITICAL",     // or null
//      limit: 20,
//      startAfter: "lastDocId"   // for pagination
//    })
//
// ═════════════════════════════════════════════════════════════

exports.listIncidents = onCall(
  { region: "asia-south1" },

  async (request) => {
    const caller = await requireAdmin(request);
    const db     = admin.firestore();
    const {
      status,
      severity,
      limitCount = 20,
      startAfterDate,
    } = request.data || {};

    let query = db.collection("incidents")
      .where("hotelId", "==", caller.hotelId)
      .orderBy("createdAt", "desc")
      .limit(Math.min(limitCount, 50)); // max 50 per page

    if (status)   query = query.where("status", "==", status);
    if (startAfterDate) {
      query = query.startAfter(new Date(startAfterDate));
    }

    const snap = await query.get();

    let incidents = snap.docs.map((d) => {
      const data = d.data();
      return {
        id                  : d.id,
        type                : data.type          || "Unknown",
        location            : data.location      || "Unknown",
        description         : data.description   || "",
        status              : data.status         || "ACTIVE",
        severity            : data.triage?.severity || null,
        category            : data.triage?.category || null,
        photoUrl            : data.photoUrl       || null,
        triage              : data.triage         || null,
        escalated           : data.escalated      || false,
        responderBrief      : data.responderBrief || null,
        postIncidentSummary : data.postIncidentSummary || null,
        acknowledgments     : data.acknowledgments || [],
        firstResponderName  : data.firstResponderName || null,
        firstResponderRole  : data.firstResponderRole || null,
        createdAt           : data.createdAt?.toDate().toISOString()           || null,
        resolvedAt          : data.resolvedAt?.toDate().toISOString()          || null,
        triageCompletedAt   : data.triageCompletedAt?.toDate().toISOString()   || null,
        firstAcknowledgedAt : data.firstAcknowledgedAt?.toDate().toISOString() || null,
      };
    });

    // Client-side severity filter (Firestore can't filter on nested field triage.severity easily)
    if (severity) {
      incidents = incidents.filter((i) => i.severity === severity);
    }

    return {
      success   : true,
      incidents,
      count     : incidents.length,
      hasMore   : snap.size === Math.min(limitCount, 50),
    };
  }
);

// ═════════════════════════════════════════════════════════════
//
//  ADMIN FUNCTION 5: updateHotelConfig
//
//  WHAT IT DOES:
//  - Admin updates hotel settings from the dashboard
//  - Settings: hotel name, address, floors, emergency contacts,
//              auto-escalation threshold, notification preferences
//
//  Dashboard calls:
//    httpsCallable('updateHotelConfig')({
//      name: "Grand Hyatt Mumbai",
//      address: "...",
//      totalFloors: 34,
//      emergencyContacts: [{ name: "...", phone: "..." }],
//      autoEscalateMinutes: 10
//    })
//
// ═════════════════════════════════════════════════════════════

exports.updateHotelConfig = onCall(
  { region: "asia-south1" },

  async (request) => {
    const caller  = await requireAdmin(request);
    const db      = admin.firestore();
    const hotelId = caller.hotelId;

    const allowed = [
      "name", "address", "totalFloors", "emergencyContacts",
      "autoEscalateMinutes", "notifyManagementOnCritical",
      "logoUrl", "checkInTime", "checkOutTime", "totalRooms",
    ];

    // Only copy allowed fields to prevent injection
    const update = {};
    for (const key of allowed) {
      if (request.data[key] !== undefined) {
        update[key] = request.data[key];
      }
    }

    if (Object.keys(update).length === 0) {
      throw new HttpsError("invalid-argument", "No valid fields to update");
    }

    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    update.updatedBy = caller.uid;

    await db.collection("hotels").doc(hotelId).set(update, { merge: true });
    console.log("Hotel config updated:", hotelId, Object.keys(update));

    return { success: true, message: "Hotel configuration updated" };
  }
);

// ═════════════════════════════════════════════════════════════
//
//  ADMIN FUNCTION 6: exportIncidents
//
//  WHAT IT DOES:
//  - Exports all incidents for a date range as a JSON array
//  - Dashboard triggers this for CSV/report download
//  - Returns full data including triage, summary, timeline
//  - Meant to be called once, not paginated
//
//  Dashboard calls:
//    httpsCallable('exportIncidents')({
//      dateFrom: "2025-01-01",
//      dateTo:   "2025-01-31"
//    })
//
// ═════════════════════════════════════════════════════════════

exports.exportIncidents = onCall(
  { region: "asia-south1" },

  async (request) => {
    const caller  = await requireAdmin(request);
    const db      = admin.firestore();
    const { dateFrom, dateTo } = request.data || {};

    if (!dateFrom || !dateTo) {
      throw new HttpsError("invalid-argument", "dateFrom and dateTo are required (YYYY-MM-DD)");
    }

    const from = new Date(dateFrom + "T00:00:00.000Z");
    const to   = new Date(dateTo   + "T23:59:59.999Z");

    if (isNaN(from) || isNaN(to)) {
      throw new HttpsError("invalid-argument", "Invalid date format. Use YYYY-MM-DD");
    }

    const snap = await db.collection("incidents")
      .where("hotelId",   "==", caller.hotelId)
      .where("createdAt", ">=", from)
      .where("createdAt", "<=", to)
      .orderBy("createdAt", "desc")
      .limit(500) // safety cap
      .get();

    const incidents = snap.docs.map((d) => {
      const data = d.data();
      return {
        id                  : d.id,
        type                : data.type          || "",
        location            : data.location      || "",
        description         : data.description   || "",
        status              : data.status         || "",
        severity            : data.triage?.severity || "",
        category            : data.triage?.category || "",
        escalated           : data.escalated      || false,
        responderCount      : (data.acknowledgments || []).length,
        firstResponderName  : data.firstResponderName || "",
        insuranceRelevant   : data.postIncidentSummary?.insurance_relevant || false,
        severityRating      : data.postIncidentSummary?.severity_rating || null,
        createdAt           : data.createdAt?.toDate().toISOString()           || "",
        resolvedAt          : data.resolvedAt?.toDate().toISOString()          || "",
        firstAcknowledgedAt : data.firstAcknowledgedAt?.toDate().toISOString() || "",
      };
    });

    return {
      success   : true,
      dateFrom,
      dateTo,
      hotelId   : caller.hotelId,
      count     : incidents.length,
      incidents,
    };
  }
);

// ═════════════════════════════════════════════════════════════
//
//  ADMIN FUNCTION 7: broadcastAlert
//
//  WHAT IT DOES:
//  - Admin sends a custom FCM push notification to all on-duty staff
//  - Or to staff with a specific role
//  - Used for: drills, weather warnings, shift changes, etc.
//  - Saves the broadcast to Firestore for audit trail
//
//  Dashboard calls:
//    httpsCallable('broadcastAlert')({
//      title: "Fire Drill",
//      body: "Report to lobby immediately",
//      targetRole: "Security"  // or null for ALL on-duty staff
//    })
//
// ═════════════════════════════════════════════════════════════

exports.broadcastAlert = onCall(
  { region: "asia-south1" },

  async (request) => {
    const caller  = await requireAdmin(request);
    const db      = admin.firestore();
    const { title, body, targetRole } = request.data;

    if (!title || !body) {
      throw new HttpsError("invalid-argument", "title and body are required");
    }

    // Find on-duty staff to notify
    let query = db.collection("staff")
      .where("hotelId",  "==", caller.hotelId)
      .where("isOnDuty", "==", true)
      .where("isActive", "==", true);

    if (targetRole) {
      query = query.where("role", "==", targetRole);
    }

    const snap   = await query.get();
    const tokens = snap.docs.map((d) => d.data().fcmToken).filter((t) => t && t.length > 10);

    let sentCount = 0;

    if (tokens.length > 0) {
      // FCM max batch = 500 tokens
      const chunks = [];
      for (let i = 0; i < tokens.length; i += 500) {
        chunks.push(tokens.slice(i, i + 500));
      }

      for (const chunk of chunks) {
        try {
          const result = await admin.messaging().sendEachForMulticast({
            tokens: chunk,
            notification: { title, body },
            android: { priority: "high", notification: { sound: "default" } },
            data: { broadcastType: "ADMIN_BROADCAST", sentBy: caller.name },
          });
          sentCount += result.successCount;
        } catch (fcmErr) {
          console.error("Broadcast FCM chunk failed:", fcmErr.message);
        }
      }
    }

    // Audit trail in Firestore
    await db.collection("hotels").doc(caller.hotelId).collection("broadcasts").add({
      title,
      body,
      targetRole  : targetRole || "ALL",
      sentBy      : caller.name,
      sentByUid   : caller.uid,
      recipientCount : snap.size,
      sentCount,
      createdAt   : admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`Broadcast sent by ${caller.name}: "${title}" → ${sentCount}/${snap.size} staff`);

    return {
      success        : true,
      recipientCount : snap.size,
      sentCount,
      message        : `Alert sent to ${sentCount} staff member(s)`,
    };
  }
);
