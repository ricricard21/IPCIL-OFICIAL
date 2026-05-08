// ═══════════════════════════════════════════════════════════
// IPCI v2.5 — Configuración Firebase compartida
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
  onSnapshot,
  Timestamp
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
  Timestamp,
  httpsCallable
};

// ═══════════════════════════════════════════════════════════
// PARCHE v2.5.1 — Wrapper robusto para llamar Cloud Functions
// (retry automático + fallback fetch + errores claros)
// ═══════════════════════════════════════════════════════════
//
// Problema observado: la Cloud Function "generarCertificado" devolvía
// FirebaseError: internal con errores aparentes de CORS. La causa real
// es server-side (la función crashea o hace timeout). El SDK reporta
// como CORS porque cuando la función falla con 5xx, no devuelve headers
// CORS, y el navegador lo reinterpreta.
//
// Este wrapper:
//   1. Reintenta UNA vez los errores transitorios (internal, unavailable, deadline-exceeded)
//   2. Hace fallback a fetch directo si el SDK falla por preflight CORS
//   3. Loggea info detallada en consola para diagnosticar
//   4. Devuelve mensajes de error específicos por código

const CALLABLE_BASE_URL = `https://us-central1-${firebaseConfig.projectId}.cloudfunctions.net`;
const CODIGOS_REINTENTABLES = new Set(["internal", "unavailable", "deadline-exceeded"]);

const MENSAJES_ERROR = {
  "internal":            "La función Cloud falló internamente. Revisa logs en Firebase Console > Functions > Logs.",
  "unavailable":         "Servicio no disponible. Reintenta en unos segundos.",
  "deadline-exceeded":   "Timeout: la generación tomó más de lo permitido. El PDF puede haberse creado igual; revisa antes de reintentar.",
  "permission-denied":   "Sin permisos para generar este certificado.",
  "unauthenticated":     "Sesión expirada. Cierra sesión y vuelve a entrar.",
  "not-found":           "Curso o alumno no encontrado en la base de datos.",
  "invalid-argument":    "Datos del alumno incompletos o mal formados (revisa nombre/email/cursoId).",
  "failed-precondition": "El alumno o curso está en un estado que no permite generar (¿ya fue generado?).",
  "resource-exhausted":  "Límite de cuota alcanzado (Resend/Workspace). Espera unos minutos."
};

function enriquecerError(err, contexto) {
  const code = err?.code || "unknown";
  const baseMsg = MENSAJES_ERROR[code] || err?.message || "Error desconocido";
  const ctxStr = contexto ? ` [${contexto}]` : "";
  const error = new Error(baseMsg + ctxStr);
  error.code = code;
  error.original = err;
  error.details = err?.details;
  return error;
}

/**
 * Llama una Cloud Function callable con retry, fallback y logging detallado.
 *
 * @param {string} nombreFn - Nombre de la función (ej: "generarCertificado")
 * @param {object} payload  - Datos a enviar
 * @param {object} opts     - { maxIntentos: 2, contexto: "alumno X" }
 * @returns {Promise<{data: any}>}
 */
export async function callCertFunction(nombreFn, payload, opts = {}) {
  const maxIntentos = opts.maxIntentos ?? 2;
  const contexto = opts.contexto || "";
  const fn = httpsCallable(functions, nombreFn);

  let ultimoError = null;

  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      const result = await fn(payload);
      if (intento > 1) {
        console.info(`[${nombreFn}] ✅ Éxito en intento ${intento}/${maxIntentos}`);
      }
      return result;
    } catch (err) {
      ultimoError = err;

      console.error(`[${nombreFn}] ❌ Intento ${intento}/${maxIntentos} falló`, {
        code: err?.code,
        message: err?.message,
        details: err?.details,
        contexto,
        payload,
        timestamp: new Date().toISOString()
      });

      const reintentable = CODIGOS_REINTENTABLES.has(err?.code);
      const ultimoIntento = intento === maxIntentos;

      if (!reintentable || ultimoIntento) break;

      // Backoff: 1.5s primer reintento, 3s segundo
      const espera = 1500 * intento;
      console.info(`[${nombreFn}] Reintentando en ${espera}ms...`);
      await new Promise(r => setTimeout(r, espera));
    }
  }

  // Si todos los intentos del SDK fallaron, probar fallback con fetch directo
  // (cubre el caso raro donde el preflight CORS del SDK falla pero fetch directo no)
  if (ultimoError?.code === "internal" || ultimoError?.message?.includes("CORS")) {
    try {
      console.info(`[${nombreFn}] Intentando fallback con fetch directo...`);
      const result = await callConFetchDirecto(nombreFn, payload);
      console.info(`[${nombreFn}] ✅ Éxito con fallback fetch directo`);
      return result;
    } catch (errFallback) {
      console.error(`[${nombreFn}] ❌ Fallback fetch directo también falló`, errFallback);
      // No reemplazamos el error original; el del SDK suele ser más informativo
    }
  }

  throw enriquecerError(ultimoError, contexto);
}

async function callConFetchDirecto(nombreFn, payload) {
  const user = auth.currentUser;
  if (!user) {
    const e = new Error("Sin sesión activa");
    e.code = "unauthenticated";
    throw e;
  }

  const idToken = await user.getIdToken();
  const url = `${CALLABLE_BASE_URL}/${nombreFn}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + idToken
    },
    body: JSON.stringify({ data: payload })
  });

  let json = null;
  try { json = await res.json(); } catch (_) { /* ignora */ }

  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    const e = new Error(msg);
    e.code = json?.error?.status || "internal";
    throw e;
  }

  if (json?.error) {
    const e = new Error(json.error.message);
    e.code = json.error.status || "internal";
    throw e;
  }

  return { data: json?.result };
}

// ═══════════════════════════════════════════════════════════
// HELPERS COMUNES
// ═══════════════════════════════════════════════════════════

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

export async function cerrarSesion() {
  await signOut(auth);
  window.location.href = "index.html";
}

export function formatFecha(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleDateString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

export function formatFechaHora(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleString("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatMoney(num) {
  const n = Number(num) || 0;
  return "$" + n.toLocaleString("es-MX", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Calcula el porcentaje de comisión que aplica a una venta.
 * Prioridad:
 *   1. usuario.comisionOverride (override por vendedor)
 *   2. curso.comisionOverride (override por curso)
 *   3. consultora.comisionDefault (default por consultora)
 *   4. 0 si no hay nada configurado
 */
export function calcularComisionPct(usuario, curso, consultora) {
  if (typeof usuario?.comisionOverride === "number") return usuario.comisionOverride;
  if (typeof curso?.comisionOverride === "number") return curso.comisionOverride;
  if (typeof consultora?.comisionDefault === "number") return consultora.comisionDefault;
  return 0;
}

export function calcularComisionMonto(precio, pct) {
  const p = Number(precio) || 0;
  const c = Number(pct) || 0;
  return Math.round(p * c / 100 * 100) / 100;
}

export function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function iniciales(nombre) {
  if (!nombre) return "?";
  const partes = String(nombre).trim().split(/\s+/);
  if (partes.length === 1) return partes[0][0].toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function ensureToastContainer() {
  let c = document.getElementById("toast-container");
  if (!c) {
    c = document.createElement("div");
    c.id = "toast-container";
    c.className = "toast-container";
    document.body.appendChild(c);
  }
  return c;
}

export function toast(mensaje, tipo = "info", duracion = 3500) {
  const container = ensureToastContainer();
  const div = document.createElement("div");
  div.className = `toast toast-${tipo}`;

  const iconos = {
    success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  div.innerHTML = `${iconos[tipo] || iconos.info}<span>${escapeHtml(mensaje)}</span>`;
  container.appendChild(div);

  setTimeout(() => {
    div.style.animation = "slideInRight var(--t-slow) reverse forwards";
    setTimeout(() => div.remove(), 300);
  }, duracion);
}

export function confirmar({ titulo = "Confirmar", mensaje = "¿Continuar?", btnOk = "Sí, continuar", btnCancel = "Cancelar", peligroso = false } = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    backdrop.innerHTML = `
      <div class="modal" style="max-width:420px">
        <div class="modal-header">
          <div>
            <div class="modal-title">${escapeHtml(titulo)}</div>
          </div>
          <button class="modal-close" type="button" aria-label="Cerrar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="modal-body">
          <p style="color:var(--text-soft);font-size:14px;line-height:1.55">${escapeHtml(mensaje)}</p>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-cancel>${escapeHtml(btnCancel)}</button>
          <button type="button" class="btn ${peligroso ? "btn-danger" : "btn-primary"}" data-ok>${escapeHtml(btnOk)}</button>
        </div>
      </div>`;

    document.body.appendChild(backdrop);

    const cleanup = (val) => {
      backdrop.remove();
      resolve(val);
    };

    backdrop.querySelector("[data-ok]").addEventListener("click", () => cleanup(true));
    backdrop.querySelector("[data-cancel]").addEventListener("click", () => cleanup(false));
    backdrop.querySelector(".modal-close").addEventListener("click", () => cleanup(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cleanup(false);
    });
  });
}

/**
 * Helper para sidebar móvil: agrega backdrop y maneja toggle.
 */
export function setupSidebar() {
  const sidebar = document.getElementById("sidebar");
  const hamburger = document.getElementById("hamburger");
  if (!sidebar || !hamburger) return;

  let backdrop = document.querySelector(".sidebar-backdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "sidebar-backdrop";
    document.body.appendChild(backdrop);
  }

  function open() {
    sidebar.classList.add("open");
    backdrop.classList.add("show");
  }
  function close() {
    sidebar.classList.remove("open");
    backdrop.classList.remove("show");
  }
  function toggle() {
    if (sidebar.classList.contains("open")) close(); else open();
  }

  hamburger.addEventListener("click", toggle);
  backdrop.addEventListener("click", close);
  return { open, close, toggle };
}
