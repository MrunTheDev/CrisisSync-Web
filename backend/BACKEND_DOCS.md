# CrisisSync — Staff App & Admin Dashboard Backend

All functions are in `functions/index.js` and deploy to Firebase Functions v2 (region: `asia-south1`).

---

## Firestore Data Model

```
/incidents/{incidentId}          ← SOS submissions (guests + staff update)
/staff/{uid}                     ← One doc per staff member
/hotels/{hotelId}                ← Hotel config
/hotels/{hotelId}/predictions/   ← Nightly AI risk predictions
/hotels/{hotelId}/broadcasts/    ← Admin broadcast audit log
```

### Staff document fields
| Field | Type | Description |
|---|---|---|
| uid | string | Firebase Auth UID |
| name | string | Full name |
| email | string | Login email |
| role | string | Security / Medical / Maintenance / Management / Receptionist |
| hotelId | string | Which hotel they belong to |
| phone | string? | Optional phone number |
| photoUrl | string? | Cloudinary profile photo URL |
| isOnDuty | bool | Whether they're currently on shift |
| isActive | bool | Admin can deactivate without deleting |
| fcmToken | string? | Latest device push token |
| createdAt | timestamp | |
| lastSeenAt | timestamp | Updated on every app action |
| dutyStartedAt | timestamp? | When they last went on duty |
| dutyEndedAt | timestamp? | When they last went off duty |

---

## Staff App Functions

These are `onCall` functions — Flutter calls them with `FirebaseFunctions.instance.httpsCallable('functionName').call({ ... })`.

### `registerStaff`
Creates a Firebase Auth account + Firestore staff document + sets custom claims.

**Input:**
```json
{
  "name": "Ravi Kumar",
  "email": "ravi@hotel.com",
  "password": "secret123",
  "role": "Security",
  "hotelId": "grand-hyatt-mumbai",
  "phone": "+919876543210",
  "photoBase64": "<optional base64 jpg>"
}
```
**Output:** `{ success, uid, message }`

---

### `toggleDuty`
Staff goes on/off duty. Controls who receives FCM incident alerts.

**Input:** `{ "isOnDuty": true }`
**Output:** `{ success, isOnDuty, message }`

---

### `updateFcmToken`
Call on every app launch. Keeps push notifications working as tokens rotate.

**Input:** `{ "fcmToken": "eXAiOi..." }`
**Output:** `{ success }`

---

### `acknowledgeIncident`
Staff taps "I'm Responding". Records them as a responder on the incident.
Also sends FCM to on-duty Management that a responder is en route.

**Input:** `{ "incidentId": "abc123" }`
**Output:** `{ success, message }`

---

### `uploadStaffPhoto`
Updates profile photo. Overwrites old photo in Cloudinary.

**Input:** `{ "photoBase64": "<base64 jpg>" }`
**Output:** `{ success, photoUrl }`

---

### `getMyIncidents`
Returns incidents relevant to this staff member's hotel.
Active incidents first, then recent resolved ones.

**Input:** `{}` (uses caller's auth token)
**Output:**
```json
{
  "success": true,
  "role": "Security",
  "hotelId": "grand-hyatt-mumbai",
  "incidents": [
    {
      "id": "abc123",
      "type": "MEDICAL",
      "location": "Room 304",
      "status": "ACTIVE",
      "severity": "CRITICAL",
      "myAck": false,
      "acknowledgments": [],
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  ]
}
```

---

## Admin Dashboard Functions

All require the caller's Firestore `staff` document to have `role == "Management"`.

### `getDashboardStats`
Single call returns all metrics for the dashboard home screen.

**Input:** `{}`
**Output:**
```json
{
  "activeIncidents": 3,
  "resolvedToday": 7,
  "totalStaff": 24,
  "staffOnDuty": 8,
  "severityBreakdown": { "LOW": 1, "MEDIUM": 1, "CRITICAL": 1 },
  "riskScore": 42,
  "riskTrend": "STABLE",
  "riskSummary": "Pattern analysis shows...",
  "recentIncidents": [...]
}
```

---

### `listStaff`
Returns staff list with optional filters.

**Input:** `{ "role": "Security", "onDutyOnly": true, "activeOnly": true }`
**Output:** `{ success, staff: [...], total }`

---

### `setStaffActive`
Activate or deactivate a staff account. Also disables Firebase Auth login.

**Input:** `{ "targetUid": "xyz", "isActive": false }`
**Output:** `{ success, message }`

---

### `listIncidents`
Paginated incident list with filters.

**Input:**
```json
{
  "status": "ACTIVE",
  "severity": "CRITICAL",
  "limitCount": 20,
  "startAfterDate": "2025-01-15T10:30:00.000Z"
}
```
**Output:** `{ success, incidents: [...], count, hasMore }`

---

### `updateHotelConfig`
Update hotel settings.

**Input:**
```json
{
  "name": "Grand Hyatt Mumbai",
  "address": "Kalina, Santacruz East",
  "totalFloors": 34,
  "totalRooms": 547,
  "emergencyContacts": [{ "name": "Local Fire", "phone": "101" }],
  "autoEscalateMinutes": 10,
  "notifyManagementOnCritical": true
}
```
**Output:** `{ success, message }`

---

### `exportIncidents`
Returns up to 500 incidents for a date range (for CSV/report download).

**Input:** `{ "dateFrom": "2025-01-01", "dateTo": "2025-01-31" }`
**Output:** `{ success, count, incidents: [...] }` — flat objects, easy to convert to CSV

---

### `broadcastAlert`
Send custom FCM push to all on-duty staff (or a specific role).

**Input:**
```json
{
  "title": "Fire Drill",
  "body": "Please report to the lobby immediately",
  "targetRole": "Security"
}
```
**Output:** `{ success, recipientCount, sentCount, message }`

---

## Setup — Secrets to set

Run these before deploying:

```bash
firebase functions:secrets:set GEMINI_KEY
firebase functions:secrets:set CLOUDINARY_CLOUD_NAME
firebase functions:secrets:set CLOUDINARY_API_KEY
firebase functions:secrets:set CLOUDINARY_API_SECRET
```

## Deploy

```bash
cd functions
npm install
firebase deploy --only functions,firestore:rules
```
