// ============================================================
// FIREBASE.JS - Firebase Configuration and Initialization
// This file sets up the connection to your Firebase project.
// Include this file BEFORE app.js in every HTML page.
// ============================================================

// Your Firebase project settings
const firebaseConfig = {
  apiKey: "AIzaSyBCmmZfuz_FUR5uk47RhPubEp81CKTepuA",
  authDomain: "sage-energy-system.firebaseapp.com",
  projectId: "sage-energy-system",
  messagingSenderId: "723800589122",
  appId: "1:723800589122:web:5941579425ede01c293edb"
};

// Start Firebase (only initialize once to avoid errors)
if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}

// Create a reference to Firestore database
// 'db' is used across the whole app to read/write data
const db = firebase.firestore();
