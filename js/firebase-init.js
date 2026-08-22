// Shared Firebase initialization — imported by every page that needs
// auth or the database. Keeping this in one place means the config only
// lives in one file.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBZQTkwRZNZL-HmNBx_i33QoSpSjIMin_8",
  authDomain: "darwesh-group.firebaseapp.com",
  projectId: "darwesh-group",
  storageBucket: "darwesh-group.firebasestorage.app",
  messagingSenderId: "353477435585",
  appId: "1:353477435585:web:1c86f48a2e4302cd953440",
  measurementId: "G-QVJBWKFC97"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// The only company on this platform so far. Every signup is stamped
// with this until there's a real "which company" flow for multi-tenant
// use — see the note at the top of firestore.rules.
export const DEFAULT_COMPANY_ID = 'darwesh-group';
