// ═══════════════════════════════════════════════════════════
// IPCI v2 — Configuración Firebase compartida
// ═══════════════════════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  addDoc,
  serverTimestamp,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getFunctions,
  httpsCallable
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

const firebaseConfig = {
  apiKey: "AIzaSyDTh-wdt-yG-3lRCH0icV8v8ipmSP_09Mg",
  authDomain: "ipci-certificados.firebaseapp.com",
  projectId: "ipci-certificados",
  storageBucket: "ipci-certificados.firebasestorage.app",
  messagingSenderId: "421751322374",
  appId: "1:421751322374:web:fc2d2d0d14a237248ed087"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, "us-central1");

// Re-exportar funciones de Firebase para uso en los paneles
export {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  addDoc,
  serverTimestamp,
  onSnapshot,
  httpsCallable
};

// ═══════════════════════════════════════════════════════════
// HELPERS COMUNES
// ═══════════════════════════════════════════════════════════

/**
 * Verifica el rol del usuario logueado.
 * Si no está logueado, redirige a login.
 * Si su rol no coincide con el rol esperado, redirige al panel correcto.
 */
export async function requireRole(rolEsperado) {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (!user) {
        window.location.href = "index.html";
        return;
      }

      try {
        const userDoc = await getDoc(doc(db, "usuarios", user.uid));

        if (!userDoc.exists() || !userDoc.data().activo) {
          alert("Tu cuenta no existe o está desactivada.");
          await signOut(auth);
          window.location.href = "index.html";
          return;
        }

        const userData = userDoc.data();

        if (userData.rol !== rolEsperado) {
          // Redirigir al panel correcto según su rol
          const redirects = {
            superadmin: "admin.html",
            coordinador: "coordinador.html",
            vendedor: "vendedor.html"
          };
          window.location.href = redirects[userData.rol] || "index.html";
          return;
        }

        resolve({ uid: user.uid, ...userData });
      } catch (error) {
        console.error("Error verificando rol:", error);
        window.location.href = "index.html";
      }
    });
  });
}

/**
 * Cierra sesión y redirige al login.
 */
export async function cerrarSesion() {
  await signOut(auth);
  window.location.href = "index.html";
}

/**
 * Formatea una fecha de Firestore a string legible.
 */
export function formatFecha(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleDateString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

/**
 * Muestra un toast/notificación temporal.
 */
export function toast(mensaje, tipo = "info") {
  const colors = {
    success: { bg: "#dcfce7", border: "#16a34a", text: "#166534" },
    error: { bg: "#fee2e2", border: "#dc2626", text: "#991b1b" },
    info: { bg: "#dbeafe", border: "#0b4ea2", text: "#1e3a8a" },
    warning: { bg: "#fef9c3", border: "#facc15", text: "#854d0e" }
  };
  const c = colors[tipo] || colors.info;

  const div = document.createElement("div");
  div.style.cssText = `
    position: fixed; top: 24px; right: 24px;
    background: ${c.bg}; border: 1px solid ${c.border}; color: ${c.text};
    padding: 14px 20px; border-radius: 10px; font-weight: 600;
    box-shadow: 0 8px 24px rgba(0,0,0,0.1); z-index: 9999;
    font-family: 'Montserrat', sans-serif; font-size: 14px;
    max-width: 360px; animation: toastIn 0.3s ease;
  `;
  div.textContent = mensaje;
  document.body.appendChild(div);

  setTimeout(() => {
    div.style.animation = "toastOut 0.3s ease forwards";
    setTimeout(() => div.remove(), 300);
  }, 3500);
}
