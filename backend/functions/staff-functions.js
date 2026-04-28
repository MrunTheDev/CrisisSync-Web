// ============================================================
//  CrisisSync — Staff App Backend Functions
//  Firebase Functions v2
//  Handles: Staff Registration, Auth, Duty Management,
//           Incident Acknowledgment, Profile + Photo Upload
// ============================================================

"use strict";

const { onCall, HttpsError }    = require("firebase-functions/v2/https");
const { onDocumentUpdated }     = require("firebase-functions/v2/firestore");
const { defineSecret }          = require("firebase-functions/params");
const admin                     = require("firebase-admin");
const cloudinary                = require("cloudinary").v2;

// ── SECRETS ──────────────────────────────────────────────────
const CLOUDINARY_CLOUD_NAME = defineSecret("CLOUDINARY_CLOUD_NAME");
const CLOUDINARY_API_KEY    = defineSecret("CLOUDINARY_API_KEY");
const CLOUDINARY_API_SECRET = defineSecret("CLOUDINARY_API_SECRET");

// ─────────────────────────────────────────────────────────────
//  HELPER: Get authenticated staff doc from Firestore
// ─────────────────────────────────────────────────────────────
async function getStaffDoc(uid) {
  const db  = admin.firestore();
  const ref = db.collection("staff").doc(uid);
  const doc = await ref.get();
  return { ref, doc };
}

// ═════════════════════════════════════════════════════════════
//
//  FUNCTION 1: registerStaff
//
//  Called when a new staff member signs up via Flutter app.
//  Creates a Firebase Auth user and a Firestore staff document.
//
//  Called from Flutter with:
//  {
//    email, password, name, role, hotelId,
//    phone (optional), photoBase64 (optional)
//  }
//
// ═════════════════════════════════════════════════════════════

exports.registerStaff = onCall(
  {
    region  : "asia-south1",
    secrets : [CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_