// ═══════════════════════════════════════════════════════════
//  CHAT INTERNO IPCI — Widget flotante
//  Se integra en coordinador, vendedor, trafiquer y admin con:
//  <script type="module" src="chat-widget.js"></script>
//
//  Canales:
//   · general            → todos los roles
//   · global_trafico     → trafiquers + superadmin
//   · consultora_{id}    → coordinador y vendedores de esa
//                          consultora + trafiquers + superadmin
//  Fase 1: texto en tiempo real, historial (últimos 50),
//  no-leídos en canales principales. Sin archivos ni DMs.
// ═══════════════════════════════════════════════════════════

import {
  auth, db, onAuthStateChanged, escapeHtml,
  doc, getDoc, getDocs, collection, query, orderBy, limit,
  onSnapshot, addDoc, setDoc, serverTimestamp
} from "./firebase-config.js";

let usuario = null;          // { uid, nombre, rol, consultoraId, consultoraIds }
let canales = [];            // [{ id, nombre, tipo }]
let canalAbierto = null;     // canal actualmente en pantalla
let vista = "lista";         // "lista" | "chat"
let abierto = false;
let unsubMsgs = null;
let metaUnsubs = [];
let noLeidos = new Map();    // canalId -> bool
let enviando = false;
let tituloOriginal = document.title;
let ultimaNotif = new Map(); // canalId -> ts del último aviso (para no repetir)
let audioCtx = null;

const ROL_LABEL = { superadmin: "Dirección", coordinador: "Coordinación", vendedor: "Ventas", trafiquer: "Tráfico" };
const ROL_COLOR = { superadmin: "#b7791f", coordinador: "#0b4ea2", vendedor: "#64748b", trafiquer: "#15803d" };

// ── Utilidades ──
const lastReadKey = id => `ipciChatRead_${usuario.uid}_${id}`;
const getLastRead = id => Number(localStorage.getItem(lastReadKey(id)) || 0);
const setLastRead = id => { try { localStorage.setItem(lastReadKey(id), String(Date.now())); } catch (_) {} };

function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  } catch (_) {}
}

function ding() {
  if (!audioCtx || audioCtx.state !== "running") return;
  try {
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, t);
    o.frequency.setValueAtTime(1174.66, t + 0.09);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.35);
  } catch (_) {}
}

function horaMsg(ts) {
  const d = ts?.toDate ? ts.toDate() : null;
  if (!d) return "";
  const hoy = new Date().toDateString() === d.toDateString();
  return hoy
    ? d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString("es-MX", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// ═══════════════ Estilos ═══════════════
function inyectarCSS() {
  const css = `
  .icw-burbuja {
    position: fixed; right: 22px; bottom: 22px; z-index: 900;
    width: 56px; height: 56px; border-radius: 50%; border: none; cursor: pointer;
    background: var(--primary, #0b4ea2); color: #fff;
    display: flex; align-items: center; justify-content: center;
    box-shadow: 0 10px 26px rgba(11, 78, 162, 0.38);
    transition: transform 0.16s ease, box-shadow 0.16s ease;
  }
  .icw-burbuja:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 14px 30px rgba(11, 78, 162, 0.45); }
  .icw-burbuja svg { width: 25px; height: 25px; }
  .icw-badge {
    position: absolute; top: -3px; right: -3px; min-width: 19px; height: 19px;
    background: #dc2626; color: #fff; border-radius: 999px; font-size: 11px;
    font-weight: 800; display: flex; align-items: center; justify-content: center;
    padding: 0 5px; border: 2px solid #fff; font-family: 'Montserrat', sans-serif;
  }

  .icw-panel {
    position: fixed; right: 22px; bottom: 90px; z-index: 899;
    width: 372px; max-width: calc(100vw - 28px); height: 540px; max-height: calc(100vh - 120px);
    background: var(--surface, #fff); border: 1px solid var(--line, #e2e8f0);
    border-radius: 18px; box-shadow: 0 24px 60px rgba(15, 40, 80, 0.22);
    display: none; flex-direction: column; overflow: hidden;
    font-family: 'Montserrat', sans-serif;
  }
  .icw-panel.open { display: flex; animation: icwIn 0.18s ease; }
  @keyframes icwIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

  .icw-head {
    display: flex; align-items: center; gap: 10px; padding: 14px 16px;
    background: var(--primary, #0b4ea2); color: #fff; flex-shrink: 0;
  }
  .icw-head-t { font-size: 14px; font-weight: 800; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .icw-head-s { font-size: 10.5px; font-weight: 600; opacity: 0.85; }
  .icw-iconbtn {
    border: none; background: rgba(255,255,255,0.14); color: #fff; cursor: pointer;
    width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center;
    justify-content: center; flex-shrink: 0; transition: background 0.15s;
  }
  .icw-iconbtn:hover { background: rgba(255,255,255,0.26); }
  .icw-iconbtn svg { width: 15px; height: 15px; }
  .icw-head-main { flex: 1; min-width: 0; }

  .icw-body { flex: 1; overflow-y: auto; background: var(--bg, #f4f7fb); }

  /* Lista de canales */
  .icw-canal {
    display: flex; align-items: center; gap: 11px; width: 100%;
    padding: 13px 16px; border: none; background: var(--surface, #fff);
    border-bottom: 1px solid var(--line-soft, #eef2f7); cursor: pointer;
    text-align: left; font-family: inherit; transition: background 0.12s;
  }
  .icw-canal:hover { background: var(--primary-soft, #eaf1fa); }
  .icw-canal-ico {
    width: 36px; height: 36px; border-radius: 11px; flex-shrink: 0;
    background: var(--primary-soft, #eaf1fa); color: var(--primary, #0b4ea2);
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 800;
  }
  .icw-canal-ico.g { background: #fdf3df; color: #b7791f; }
  .icw-canal-ico.t { background: #e5f5ec; color: #15803d; }
  .icw-canal-main { flex: 1; min-width: 0; }
  .icw-canal-n { font-size: 13px; font-weight: 700; color: var(--text, #16324f); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .icw-canal-sub { font-size: 11px; color: var(--muted, #64748b); margin-top: 1px; }
  .icw-dot { width: 9px; height: 9px; border-radius: 50%; background: #dc2626; flex-shrink: 0; }
  .icw-seccion { font-size: 10px; font-weight: 800; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted, #64748b); padding: 12px 16px 6px; }

  /* Mensajes */
  .icw-msgs { padding: 14px 14px 6px; display: flex; flex-direction: column; gap: 10px; }
  .icw-msg { max-width: 82%; }
  .icw-msg.mio { align-self: flex-end; }
  .icw-msg-autor { display: flex; align-items: baseline; gap: 7px; margin: 0 4px 3px; }
  .icw-msg-nombre { font-size: 11px; font-weight: 800; }
  .icw-msg-rol { font-size: 9px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.75; }
  .icw-msg-burb {
    background: var(--surface, #fff); border: 1px solid var(--line, #e2e8f0);
    border-radius: 13px; border-top-left-radius: 5px; padding: 9px 13px;
    font-size: 12.5px; color: var(--text, #16324f); line-height: 1.5; word-wrap: break-word; white-space: pre-wrap;
  }
  .icw-msg.mio .icw-msg-burb {
    background: var(--primary, #0b4ea2); border-color: var(--primary, #0b4ea2); color: #fff;
    border-radius: 13px; border-top-right-radius: 5px;
  }
  .icw-msg-hora { font-size: 9.5px; color: var(--muted-light, #94a3b8); margin: 3px 5px 0; }
  .icw-msg.mio .icw-msg-hora { text-align: right; }
  .icw-vacio { text-align: center; color: var(--muted, #64748b); font-size: 12px; padding: 40px 20px; line-height: 1.6; }

  /* Input */
  .icw-foot { display: flex; gap: 9px; padding: 11px 13px; background: var(--surface, #fff); border-top: 1px solid var(--line, #e2e8f0); flex-shrink: 0; }
  .icw-input {
    flex: 1; resize: none; border: 1px solid var(--line, #e2e8f0); border-radius: 12px;
    padding: 9px 13px; font-family: inherit; font-size: 12.5px; color: var(--text, #16324f);
    outline: none; max-height: 90px; line-height: 1.45; background: var(--bg, #f4f7fb);
  }
  .icw-input:focus { border-color: var(--primary, #0b4ea2); background: var(--surface, #fff); }
  .icw-send {
    width: 40px; height: 40px; border-radius: 12px; border: none; cursor: pointer;
    background: var(--primary, #0b4ea2); color: #fff; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center; transition: all 0.14s;
    align-self: flex-end;
  }
  .icw-send:hover { filter: brightness(1.1); }
  .icw-send:disabled { opacity: 0.5; cursor: wait; }
  .icw-send svg { width: 17px; height: 17px; }

  @media (max-width: 520px) {
    .icw-panel { right: 8px; left: 8px; bottom: 84px; width: auto; height: 76vh; }
    .icw-burbuja { right: 16px; bottom: 16px; }
  }`;
  const st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);
}

// ═══════════════ DOM ═══════════════
function construirDOM() {
  const wrap = document.createElement("div");
  wrap.innerHTML = `
    <button class="icw-burbuja" id="icw-burbuja" title="Chat interno IPCI" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>
      <span class="icw-badge" id="icw-badge" style="display:none">0</span>
    </button>
    <div class="icw-panel" id="icw-panel">
      <div class="icw-head" id="icw-head"></div>
      <div class="icw-body" id="icw-body"></div>
      <div class="icw-foot" id="icw-foot" style="display:none">
        <textarea class="icw-input" id="icw-input" rows="1" placeholder="Escribe un mensaje..."></textarea>
        <button class="icw-send" id="icw-send" type="button" title="Enviar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  document.addEventListener("pointerdown", unlockAudio, { once: true });
  document.getElementById("icw-burbuja").addEventListener("click", togglePanel);
  document.getElementById("icw-send").addEventListener("click", enviarMsg);
  const input = document.getElementById("icw-input");
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); enviarMsg(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 90) + "px";
  });
}

function togglePanel() {
  unlockAudio();
  abierto = !abierto;
  document.getElementById("icw-panel").classList.toggle("open", abierto);
  if (abierto) {
    if (vista === "chat" && canalAbierto) abrirCanal(canalAbierto);
    else renderLista();
  } else {
    detenerMsgs();
  }
}

// ═══════════════ Vista: lista de canales ═══════════════
function renderLista() {
  vista = "lista";
  detenerMsgs();
  document.getElementById("icw-foot").style.display = "none";
  document.getElementById("icw-head").innerHTML = `
    <div class="icw-head-main">
      <div class="icw-head-t">Chat interno IPCI</div>
      <div class="icw-head-s">${escapeHtml(usuario.nombre)} · ${ROL_LABEL[usuario.rol] || usuario.rol}</div>
    </div>
    <button class="icw-iconbtn" id="icw-cerrar" title="Cerrar" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  document.getElementById("icw-cerrar").addEventListener("click", togglePanel);

  const ini = n => n.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const fijos = canales.filter(c => c.tipo !== "consultora");
  const cons = canales.filter(c => c.tipo === "consultora");

  const item = c => `
    <button class="icw-canal" data-canal="${c.id}" type="button">
      <div class="icw-canal-ico ${c.tipo === "general" ? "g" : c.tipo === "trafico" ? "t" : ""}">${c.tipo === "general" ? "G" : c.tipo === "trafico" ? "T" : escapeHtml(ini(c.nombre))}</div>
      <div class="icw-canal-main">
        <div class="icw-canal-n">${escapeHtml(c.nombre)}</div>
        <div class="icw-canal-sub">${c.tipo === "general" ? "Todo el equipo IPCI" : c.tipo === "trafico" ? "Trafiquers y dirección" : "Coordinación · Ventas · Tráfico"}</div>
      </div>
      ${noLeidos.get(c.id) ? '<span class="icw-dot"></span>' : ""}
    </button>`;

  document.getElementById("icw-body").innerHTML =
    fijos.map(item).join("") +
    (cons.length ? `<div class="icw-seccion">Consultoras</div>` + cons.map(item).join("") : "");

  document.querySelectorAll("[data-canal]").forEach(b =>
    b.addEventListener("click", () => {
      const c = canales.find(x => x.id === b.dataset.canal);
      if (c) abrirCanal(c);
    })
  );
}

// ═══════════════ Vista: conversación ═══════════════
function abrirCanal(canal) {
  vista = "chat";
  canalAbierto = canal;
  noLeidos.set(canal.id, false);
  setLastRead(canal.id);
  actualizarBadge();

  document.getElementById("icw-foot").style.display = "flex";
  document.getElementById("icw-head").innerHTML = `
    <button class="icw-iconbtn" id="icw-back" title="Canales" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
    <div class="icw-head-main">
      <div class="icw-head-t">${escapeHtml(canal.nombre)}</div>
      <div class="icw-head-s">${canal.tipo === "general" ? "Todo el equipo" : canal.tipo === "trafico" ? "Trafiquers y dirección" : "Canal de la consultora"}</div>
    </div>
    <button class="icw-iconbtn" id="icw-cerrar" title="Cerrar" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
  document.getElementById("icw-back").addEventListener("click", renderLista);
  document.getElementById("icw-cerrar").addEventListener("click", togglePanel);

  document.getElementById("icw-body").innerHTML = `<div class="icw-vacio">Cargando mensajes...</div>`;

  detenerMsgs();
  const q = query(collection(db, "chats", canal.id, "mensajes"), orderBy("creadoEn", "desc"), limit(50));
  unsubMsgs = onSnapshot(q, snap => {
    const msgs = snap.docs.map(d => d.data()).reverse();
    renderMsgs(msgs);
    if (abierto && vista === "chat" && canalAbierto?.id === canal.id) setLastRead(canal.id);
  }, err => {
    console.warn("chat:", err);
    document.getElementById("icw-body").innerHTML = `<div class="icw-vacio">No se pudieron cargar los mensajes.<br>Verifica tu conexión o avisa al administrador.</div>`;
  });
}

function renderMsgs(msgs) {
  const body = document.getElementById("icw-body");
  if (!msgs.length) {
    body.innerHTML = `<div class="icw-vacio">Aún no hay mensajes en este canal.<br>Escribe el primero.</div>`;
    return;
  }
  body.innerHTML = `<div class="icw-msgs">${msgs.map(m => {
    const mio = m.autorUid === usuario.uid;
    const color = ROL_COLOR[m.autorRol] || "#64748b";
    return `<div class="icw-msg${mio ? " mio" : ""}">
      ${mio ? "" : `<div class="icw-msg-autor">
        <span class="icw-msg-nombre" style="color:${color}">${escapeHtml(m.autorNombre || "Usuario")}</span>
        <span class="icw-msg-rol" style="color:${color}">${ROL_LABEL[m.autorRol] || ""}</span>
      </div>`}
      <div class="icw-msg-burb">${escapeHtml(m.texto || "")}</div>
      <div class="icw-msg-hora">${horaMsg(m.creadoEn)}</div>
    </div>`;
  }).join("")}</div>`;
  body.scrollTop = body.scrollHeight;
}

function detenerMsgs() {
  if (unsubMsgs) { unsubMsgs(); unsubMsgs = null; }
}

// ═══════════════ Enviar ═══════════════
async function enviarMsg() {
  if (enviando || !canalAbierto) return;
  const input = document.getElementById("icw-input");
  const texto = input.value.trim();
  if (!texto) return;
  enviando = true;
  document.getElementById("icw-send").disabled = true;
  try {
    await addDoc(collection(db, "chats", canalAbierto.id, "mensajes"), {
      texto: texto.slice(0, 1000),
      autorUid: usuario.uid,
      autorNombre: usuario.nombre,
      autorRol: usuario.rol,
      creadoEn: serverTimestamp(),
    });
    setDoc(doc(db, "chats", canalAbierto.id), {
      nombre: canalAbierto.nombre,
      tipo: canalAbierto.tipo,
      ...(canalAbierto.consultoraId ? { consultoraId: canalAbierto.consultoraId } : {}),
      ultimoMsg: texto.slice(0, 80),
      ultimoMsgPor: usuario.uid,
      ultimoMsgPorNombre: usuario.nombre,
      ultimoMsgEn: serverTimestamp(),
    }, { merge: true }).catch(() => {});
    input.value = "";
    input.style.height = "auto";
    setLastRead(canalAbierto.id);
  } catch (e) {
    console.error("enviar:", e);
    alert("No se pudo enviar el mensaje. Intenta de nuevo.");
  } finally {
    enviando = false;
    document.getElementById("icw-send").disabled = false;
    input.focus();
  }
}

// ═══════════════ No leídos (canales principales) ═══════════════
function escucharMetas() {
  metaUnsubs.forEach(u => u());
  metaUnsubs = [];
  // Solo los canales "propios": general + trafico (si aplica) + su consultora (si aplica).
  const principales = canales.filter(c =>
    c.tipo === "general" || c.tipo === "trafico" ||
    (c.tipo === "consultora" && usuario.consultoraId && c.consultoraId === usuario.consultoraId)
  );
  principales.forEach(c => {
    const u = onSnapshot(doc(db, "chats", c.id), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      const ts = d.ultimoMsgEn?.toMillis ? d.ultimoMsgEn.toMillis() : 0;
      const esNuevo = ts > getLastRead(c.id) && d.ultimoMsgPor !== usuario.uid;
      const abiertoAqui = abierto && vista === "chat" && canalAbierto?.id === c.id;
      noLeidos.set(c.id, esNuevo && !abiertoAqui);
      if (esNuevo && !abiertoAqui && ultimaNotif.get(c.id) !== ts) {
        ultimaNotif.set(c.id, ts);
        ding();
      }
      if (abiertoAqui) setLastRead(c.id);
      actualizarBadge();
      if (abierto && vista === "lista") renderLista();
    }, () => {});
    metaUnsubs.push(u);
  });
}

function actualizarBadge() {
  const n = [...noLeidos.values()].filter(Boolean).length;
  const b = document.getElementById("icw-badge");
  if (b) {
    b.style.display = n ? "flex" : "none";
    b.textContent = n;
  }
  document.title = n ? `(•) ${tituloOriginal}` : tituloOriginal;
}

// ═══════════════ Canales según el rol ═══════════════
async function construirCanales() {
  const lista = [{ id: "general", nombre: "General IPCI", tipo: "general" }];

  if (usuario.rol === "superadmin" || usuario.rol === "trafiquer") {
    lista.push({ id: "global_trafico", nombre: "Tráfico y Dirección", tipo: "trafico" });

    // Consultoras visibles
    const ids = usuario.consultoraIds;
    const todas = usuario.rol === "superadmin" || !Array.isArray(ids) || !ids.length || ids.includes("*");
    if (todas) {
      const snap = await getDocs(collection(db, "consultoras"));
      snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(c => c.activo !== false)
        .sort((a, b) => (a.nombre || "").localeCompare(b.nombre || ""))
        .forEach(c => lista.push({ id: "consultora_" + c.id, nombre: c.nombre || c.id, tipo: "consultora", consultoraId: c.id }));
    } else {
      for (const id of ids) {
        try {
          const snap = await getDoc(doc(db, "consultoras", id));
          if (snap.exists()) lista.push({ id: "consultora_" + id, nombre: snap.data().nombre || id, tipo: "consultora", consultoraId: id });
        } catch (_) {}
      }
    }
  } else if (usuario.consultoraId) {
    // Coordinador y vendedor: el canal de SU consultora
    let nombre = "Mi consultora";
    try {
      const snap = await getDoc(doc(db, "consultoras", usuario.consultoraId));
      if (snap.exists()) nombre = snap.data().nombre || nombre;
    } catch (_) {}
    lista.push({ id: "consultora_" + usuario.consultoraId, nombre, tipo: "consultora", consultoraId: usuario.consultoraId });
  }

  canales = lista;
}

// ═══════════════ Init ═══════════════
onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    const snap = await getDoc(doc(db, "usuarios", user.uid));
    if (!snap.exists()) return;
    const data = snap.data();
    if (data.activo === false) return;
    if (!["superadmin", "coordinador", "vendedor", "trafiquer"].includes(data.rol)) return;

    usuario = {
      uid: user.uid,
      nombre: data.nombre || data.email || "Usuario",
      rol: data.rol,
      consultoraId: data.consultoraId || null,
      consultoraIds: data.consultoraIds || null,
    };

    inyectarCSS();
    construirDOM();
    await construirCanales();
    escucharMetas();
  } catch (e) {
    console.warn("chat-widget:", e);
  }
});
