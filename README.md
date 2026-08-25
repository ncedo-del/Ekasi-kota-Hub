# eKasi Kota Hub — Firebase Edition

A kota & chips ordering app for a Soweto takeaway shop built with **Firebase** (Firestore, Firebase Auth, Cloud Functions, and Firebase Hosting). Customers browse the menu and place orders from their phone; the owner manages the menu, order queue, and shop status from the same page. Orders are validated, rate-limited, and priced entirely server-side in a Firebase Cloud Function.

## What's in this repo

| File / Directory | Purpose |
|---|---|
| `index.html` | The whole front end — customer ordering flow and owner dashboard, powered by Firebase Web SDK |
| `firebase.json` | Firebase configuration for Hosting, Cloud Functions, and Firestore |
| `firestore.rules` | Security rules for `owners`, `menu_items`, `orders`, and rate limits |
| `firestore.indexes.json` | Compound indexes for Firestore menu and order queries |
| `functions/` | Firebase Cloud Function (`placeOrder`) handling rate limiting, server-side pricing, and WhatsApp notifications |
| `backend-architecture.md` | Detailed explanation of the Firebase architecture and client integration |

## Setup Instructions

### 1. Firebase Project Setup
1. Log in to the Firebase CLI:
   ```bash
   npx -y firebase-tools@latest login
   ```
2. Create a new Firebase project or select an existing one:
   ```bash
   npx -y firebase-tools@latest projects:create ekasi-kota-hub
   npx -y firebase-tools@latest use ekasi-kota-hub
   ```
3. Enable **Email/Password** or **Email Link (Passwordless)** sign-in in the Firebase Auth console.

### 2. Configure `index.html`
Open `index.html` and replace the placeholder config values with your Firebase Project settings:
```javascript
var FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};
var OWNER_ID = 'YOUR_OWNER_FIREBASE_UID';
```

### 3. Deploy to Firebase
Deploy security rules, Firestore indexes, Cloud Functions, and Firebase Hosting with one command:
```bash
npx -y firebase-tools@latest deploy
```

Set your Fonnte WhatsApp token secret for the Cloud Function (optional):
```bash
npx -y firebase-tools@latest functions:secrets:set FONNTE_TOKEN
```

## Local Testing & Emulators

Run the Firebase local emulator suite to test Hosting, Firestore, and Cloud Functions on your machine:
```bash
npx -y firebase-tools@latest emulators:start
```
Open `http://localhost:5000` to view your app locally.
