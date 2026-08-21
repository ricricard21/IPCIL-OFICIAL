/**
 * ═══════════════════════════════════════════════════════════
 * IPCI v5.0 — Backend de generación de certificados
 * ═══════════════════════════════════════════════════════════
 * Endpoints:
 *   onCall  generarCertificado          → vendedor genera cert
 *   onCall  reenviarHistorico           → coordinador/admin reenvía
 *   onSchedule procesarProgramados      → cron diario 08:00 MX
 *   onCall  crearUsuariosMasivo         → admin crea usuarios masivos
 * ═══════════════════════════════════════════════════════════
 */

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const { Resend } = require("resend");
const { PDFDocument: PDFLibDocument, rgb } = require("pdf-lib");

admin.initializeApp();
const db = admin.firestore();
const storage = admin.storage();

const RESEND_API_KEY = defineSecret("RESEND_API_KEY");
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
const WATI_API_TOKEN = defineSecret("WATI_API_TOKEN");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

setGlobalOptions({
  region: "us-central1",
  maxInstances: 10,
  memory: "512MiB",
  timeoutSeconds: 60,
});

// ═══════════════════════════════════════════════════════════
// CONSTANTES
// ═══════════════════════════════════════════════════════════
const VALIDATION_URL = "https://ipcil.org/validar.html";
const FROM_EMAIL = "IPCI Certificados <certificados@ipcil.org>";
const REPLY_TO = "ipcilinstituto@ipcil.org";
const CLOUD_RUN_URL = "https://ipci-pdf-generator-421751322374.us-central1.run.app";

// ═══════════════════════════════════════════════════════════
// HELPER: Genera PDF usando Cloud Run (plantilla PPTX → PDF)
// ═══════════════════════════════════════════════════════════
async function generarPDFConPlantilla({ plantilla, datos, qrBuffer }) {
  const { GoogleAuth } = require("google-auth-library");
  const auth = new GoogleAuth();
  const client = await auth.getIdTokenClient(CLOUD_RUN_URL);
  const idToken = await client.idTokenProvider.fetchIdToken(CLOUD_RUN_URL);

  const qrBase64 = qrBuffer ? qrBuffer.toString("base64") : null;
  const body = JSON.stringify({ plantilla, datos, qrBase64 });

  const response = await fetch(`${CLOUD_RUN_URL}/generar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`,
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cloud Run HTTP ${response.status}: ${errText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// ═══════════════════════════════════════════════════════════
// QR overlay v4.9 (90px esquina inferior izquierda)
// ═══════════════════════════════════════════════════════════
async function agregarQRalPDF(pdfBuffer, qrBuffer) {
  try {
    const pdfDoc = await PDFLibDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    if (pages.length === 0) return pdfBuffer;
    const page = pages[0];
    const qrImage = await pdfDoc.embedPng(qrBuffer);

    const QR_SIZE = 90;
    const X = 30;
    const Y = 30;

    page.drawImage(qrImage, { x: X, y: Y, width: QR_SIZE, height: QR_SIZE });

    const newPdfBytes = await pdfDoc.save();
    return Buffer.from(newPdfBytes);
  } catch (err) {
    console.error("[QR] Error:", err.message);
    return pdfBuffer;
  }
}

// ═══════════════════════════════════════════════════════════
// HELPER: Enviar email con captura de errores y reintentos
// Resend SDK v4 devuelve { data, error } y NO lanza excepción
// cuando rechaza (rate limit, etc). Sin este wrapper, los emails
// fallidos se marcarían como "enviados" silenciosamente.
// ═══════════════════════════════════════════════════════════
async function enviarEmailSeguro(resend, payload, { maxIntentos = 3, contexto = "" } = {}) {
  let ultimoError = null;
  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      const resp = await resend.emails.send(payload);
      // Resend v4 devuelve {data, error}. Si hay error, NO lanza, hay que checarlo.
      if (resp && resp.error) {
        const errMsg = resp.error.message || resp.error.name || JSON.stringify(resp.error);
        const esRateLimit = /rate.?limit|too.?many|429/i.test(errMsg);
        console.warn(`[EMAIL ${contexto}] Intento ${intento}/${maxIntentos} → ${errMsg}`);
        ultimoError = new Error(`Resend: ${errMsg}`);
        if (esRateLimit && intento < maxIntentos) {
          // Backoff exponencial: 3s, 8s, 15s
          const espera = intento === 1 ? 3000 : intento === 2 ? 8000 : 15000;
          await new Promise(r => setTimeout(r, espera));
          continue;
        }
        throw ultimoError;
      }
      // Éxito real (data.id presente)
      if (intento > 1) {
        console.log(`[EMAIL ${contexto}] ✅ Enviado en intento ${intento}`);
      }
      return resp.data;
    } catch (e) {
      ultimoError = e;
      const msg = String(e.message || "");
      const esRateLimit = /rate.?limit|too.?many|429/i.test(msg);
      console.warn(`[EMAIL ${contexto}] Intento ${intento}/${maxIntentos} excepción: ${msg}`);
      if (esRateLimit && intento < maxIntentos) {
        const espera = intento === 1 ? 3000 : intento === 2 ? 8000 : 15000;
        await new Promise(r => setTimeout(r, espera));
        continue;
      }
      if (intento >= maxIntentos) throw ultimoError;
    }
  }
  throw ultimoError || new Error("enviarEmailSeguro: agotados los intentos");
}

// ═══════════════════════════════════════════════════════════
// HELPERS DE COMISIÓN — pesos fijos por venta (no porcentaje)
// ═══════════════════════════════════════════════════════════
function calcularComisionFija(usuario, curso, consultora) {
  // Prioridad: vendedor → curso → consultora
  if (typeof usuario?.comisionFija === "number") return usuario.comisionFija;
  if (typeof curso?.comisionFija === "number") return curso.comisionFija;
  if (typeof consultora?.comisionFija === "number") return consultora.comisionFija;
  // Compatibilidad legacy: si solo hay comisionDefault, usarlo como pesos fijos
  if (typeof usuario?.comisionOverride === "number") return usuario.comisionOverride;
  if (typeof curso?.comisionOverride === "number") return curso.comisionOverride;
  if (typeof consultora?.comisionDefault === "number") return consultora.comisionDefault;
  return 0;
}

// ═══════════════════════════════════════════════════════════
// FUNCIÓN PRINCIPAL: generarCertificadoCompleto
// ═══════════════════════════════════════════════════════════
async function generarCertificadoCompleto({
  alumnoId, alumno, consultora, curso, userId,
  vendedor = null, folioForzado = null,
  adminGenerado = false, empresaContratante = "",
  horasCurso = null,
}) {
  const codigoConsultora = consultora.codigo
    || (consultora.nombre || "IPCI").substring(0, 4).toUpperCase().replace(/[^A-Z]/g, "")
    || "IPCI";
  const textoDescriptivo = consultora.textoDescriptivo || "impartido por";
  const firmaTexto = consultora.firmaTexto || consultora.nombre || "Coordinación";

  // Fecha siempre la de hoy (la duración la define horasCurso si viene)
  const fechaCertificado = new Date();

  // Duración que aparece en el PDF: si admin la sobreescribió, usa esa; si no, la del curso
  const duracionFinal = (horasCurso && String(horasCurso).trim()) || curso.duracion || "40 horas";

  let folio;
  if (folioForzado) {
    folio = folioForzado;
  } else {
    const year = new Date().getFullYear();
    await db.runTransaction(async (transaction) => {
      const consRef = db.collection("consultoras").doc(alumno.consultoraId);
      const consDoc = await transaction.get(consRef);
      if (!consDoc.exists) throw new Error(`Consultora ${alumno.consultoraId} no existe`);
      const contador = (consDoc.data().contadorFolio || 0) + 1;
      folio = `IPCI-${codigoConsultora}-${year}-${String(contador).padStart(4, "0")}`;
      transaction.update(consRef, { contadorFolio: contador });
    });
  }

  // QR
  const qrUrl = `${VALIDATION_URL}?folio=${encodeURIComponent(folio)}`;
  const qrDataUrl = await QRCode.toDataURL(qrUrl, {
    errorCorrectionLevel: "M", margin: 1, width: 200,
  });
  const qrBuffer = Buffer.from(qrDataUrl.split(",")[1], "base64");

  // PDF
  let pdfBuffer;
  if (consultora.plantilla) {
    const fechaFormateada = fechaCertificado.toLocaleDateString("es-MX", {
      day: "numeric", month: "long", year: "numeric",
      timeZone: "America/Mexico_City",
    });
    pdfBuffer = await generarPDFConPlantilla({
      plantilla: consultora.plantilla,
      datos: {
        NOMBRE_ALUMNO: (alumno.nombre || "Alumno").toUpperCase(),
        NOMBRE_CURSO: (curso.nombre || "Curso").toUpperCase(),
        FOLIO: folio,
        FECHA: fechaFormateada,
        MODALIDAD: curso.modalidad || "En línea",
        DURACION: duracionFinal,
        FIRMANTE: curso.ponente || consultora.firmaTexto || consultora.nombre || "",
        CARGO: curso.cargo || "Coordinación General",
        QR_IMAGE: "",
      },
      qrBuffer,
    });
    pdfBuffer = await agregarQRalPDF(pdfBuffer, qrBuffer);
  } else {
    pdfBuffer = await generarPDF({
      nombreAlumno: alumno.nombre || "Alumno",
      nombreCurso: curso.nombre || "Curso",
      nombreConsultora: consultora.nombre || "IPCI",
      textoDescriptivo, firmaTexto, folio, qrBuffer,
      duracion: duracionFinal,
      modalidad: curso.modalidad || "",
      ponente: curso.ponente || "",
    });
  }

  // Subir a Storage
  const bucket = storage.bucket();
  const filename = `certificados/${alumno.consultoraId}/${folio}.pdf`;
  const file = bucket.file(filename);
  // FIX: URL con download token de Firebase Storage (permanente). Antes se usaba
  // getSignedUrl firmado por la cuenta de servicio; al rotar esas llaves los
  // certificados viejos daban "SignatureDoesNotMatch". El token NO rota.
  const downloadToken = crypto.randomUUID();
  await file.save(pdfBuffer, {
    metadata: {
      contentType: "application/pdf",
      metadata: { firebaseStorageDownloadTokens: downloadToken },
    },
    resumable: false,
  });
  const pdfUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(filename)}?alt=media&token=${downloadToken}`;

  // Comisión snapshot — pesos fijos por venta (no porcentaje)
  let comisionFija = Number(calcularComisionFija(vendedor, curso, consultora)) || 0;
  if (!Number.isFinite(comisionFija)) comisionFija = 0;

  // Crear certificado en Firestore
  const certRef = db.collection("certificados").doc();
  const certData = {
    folio, alumnoId,
    nombreAlumno: alumno.nombre || "",
    emailAlumno: alumno.email || "",
    cursoId: curso.id || alumno.cursoId || "",
    nombreCurso: curso.nombre || "",
    modalidad: curso.modalidad || "",
    duracion: duracionFinal,
    consultoraId: alumno.consultoraId || "",
    nombreConsultora: consultora.nombre || "",
    pdfUrl,
    qrUrl: `${VALIDATION_URL}?folio=${encodeURIComponent(folio)}`,
    fecha: fechaCertificado.toLocaleDateString("es-MX", {
      day: "2-digit", month: "long", year: "numeric",
      timeZone: "America/Mexico_City",
    }),
    creadoEn: admin.firestore.FieldValue.serverTimestamp(),
    generadoPor: userId,
    precio: Number(curso.precio) || 0,
    comisionFija: comisionFija,         // pesos fijos por venta
    comisionVendedor: comisionFija,     // monto que cobra el vendedor (= comisionFija)
    comisionPct: null,                  // ya no se usa, pero mantenemos campo para compatibilidad
    generadoPorAdmin: adminGenerado === true,
    empresaContratante: empresaContratante || "",
  };
  await certRef.set(certData);

  // Email
  const resend = new Resend(RESEND_API_KEY.value());
  const firmaNombre = vendedor?.nombre || "Equipo IPCI";
  const firmaConsultora = consultora.nombre || "IPCI";
  const html = generarHtmlEmail({
    nombre: alumno.nombre || "",
    curso: curso.nombre || "",
    folio,
    consultora: firmaConsultora,
    pdfUrl,
    qrUrl: certData.qrUrl,
    firmaNombre,
  });
  await enviarEmailSeguro(resend, {
    from: FROM_EMAIL,
    to: alumno.email,
    reply_to: REPLY_TO,
    subject: `Certificado de participacion: ${curso.nombre || "curso"}`,
    html,
    attachments: [{
      filename: `Certificado-${folio}.pdf`,
      content: pdfBuffer.toString("base64"),
    }],
  }, { contexto: `cert-${folio}` });

  // Marcar alumno
  try {
    await db.collection("alumnos").doc(alumnoId).update({
      estado: "email_enviado",
      certificadoId: certRef.id,
      fechaEnvio: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error("[CERT] Error actualizando alumno:", err.message);
  }

  return { folio, pdfUrl, certificadoId: certRef.id };
}

// ═══════════════════════════════════════════════════════════
// PDF Generator (PDFKit fallback)
// ═══════════════════════════════════════════════════════════
async function generarPDF({
  nombreAlumno, nombreCurso, nombreConsultora, textoDescriptivo,
  firmaTexto, folio, qrBuffer, duracion, modalidad, ponente,
}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "LETTER", layout: "landscape",
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    const buffers = [];
    doc.on("data", buffers.push.bind(buffers));
    doc.on("end", () => resolve(Buffer.concat(buffers)));
    doc.on("error", reject);

    const PAGE_W = doc.page.width;
    const PAGE_H = doc.page.height;

    doc.lineWidth(3).strokeColor("#0b4ea2")
      .rect(20, 20, PAGE_W - 40, PAGE_H - 40).stroke();
    doc.lineWidth(1).strokeColor("#C8982E")
      .rect(28, 28, PAGE_W - 56, PAGE_H - 56).stroke();

    doc.fillColor("#0b4ea2").font("Helvetica-Bold").fontSize(28)
      .text("IPCI", 0, 60, { align: "center" });
    doc.fontSize(10).fillColor("#5f7186").font("Helvetica")
      .text("INSTITUTO PROFESIONAL DE CERTIFICACIÓN INDUSTRIAL", 0, 95, {
        align: "center", characterSpacing: 2,
      });

    doc.moveTo(PAGE_W / 2 - 60, 118).lineTo(PAGE_W / 2 + 60, 118)
      .strokeColor("#C8982E").lineWidth(2).stroke();

    doc.font("Helvetica").fontSize(13).fillColor("#34465c")
      .text("Otorga el presente", 0, 140, { align: "center" });
    doc.font("Helvetica-Bold").fontSize(34).fillColor("#0b4ea2")
      .text("CERTIFICADO", 0, 160, { align: "center" });

    doc.font("Helvetica").fontSize(12).fillColor("#5f7186")
      .text("a", 0, 215, { align: "center" });
    doc.font("Helvetica-Bold").fontSize(26).fillColor("#0f1d2e")
      .text((nombreAlumno || "").toUpperCase(), 50, 235, {
        align: "center", width: PAGE_W - 100,
      });

    doc.font("Helvetica").fontSize(12).fillColor("#5f7186")
      .text(`por completar satisfactoriamente el curso ${textoDescriptivo || ""}:`, 0, 280, {
        align: "center",
      });
    doc.font("Helvetica-Bold").fontSize(18).fillColor("#0b4ea2")
      .text(nombreCurso || "", 50, 305, { align: "center", width: PAGE_W - 100 });

    if (duracion || modalidad || ponente) {
      doc.font("Helvetica").fontSize(10).fillColor("#5f7186");
      const detalles = [];
      if (duracion) detalles.push(`Duración: ${duracion}`);
      if (modalidad) detalles.push(`Modalidad: ${modalidad}`);
      if (ponente) detalles.push(`Ponente: ${ponente}`);
      doc.text(detalles.join("  ·  "), 0, 348, { align: "center" });
    }

    const FOOTER_Y = PAGE_H - 130;
    doc.moveTo(80, FOOTER_Y).lineTo(280, FOOTER_Y)
      .strokeColor("#0b4ea2").lineWidth(1).stroke();
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f1d2e")
      .text(firmaTexto || nombreConsultora, 80, FOOTER_Y + 6, {
        width: 200, align: "center",
      });
    doc.font("Helvetica").fontSize(8).fillColor("#5f7186")
      .text("Coordinación general", 80, FOOTER_Y + 22, {
        width: 200, align: "center",
      });

    const QR_SIZE = 90;
    const QR_X = PAGE_W - 130;
    const QR_Y = FOOTER_Y - 20;
    doc.image(qrBuffer, QR_X, QR_Y, { width: QR_SIZE });

    doc.font("Helvetica").fontSize(8).fillColor("#5f7186")
      .text("FOLIO", QR_X - 130, QR_Y + 10, { width: 120, align: "right" });
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#0b4ea2")
      .text(folio, QR_X - 130, QR_Y + 22, { width: 120, align: "right" });
    doc.font("Helvetica").fontSize(7).fillColor("#5f7186")
      .text("Verifica este certificado", QR_X - 130, QR_Y + 50, {
        width: 120, align: "right",
      });
    doc.text("escaneando el código QR", QR_X - 130, QR_Y + 60, {
      width: 120, align: "right",
    });
    doc.text("o en ipcil.org/validar.html", QR_X - 130, QR_Y + 70, {
      width: 120, align: "right",
    });

    doc.end();
  });
}

// ═══════════════════════════════════════════════════════════
// HTML del email
// ═══════════════════════════════════════════════════════════
function generarHtmlEmail({ nombre, curso, folio, consultora, pdfUrl, qrUrl, firmaNombre }) {
  // HTML transaccional simple — sin gradientes, botones grandes, ni colores fuertes.
  // Gmail clasifica como Promotions cuando ve marketing visual; este formato simple va al Primary tab.
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Certificado IPCI ${escapeHtml(folio)}</title></head>
<body style="margin:0;padding:20px;font-family:Arial,Helvetica,sans-serif;color:#222;font-size:14px;line-height:1.6;background:#ffffff;">
<p>Hola ${escapeHtml(nombre)},</p>

<p>Tu certificado de participación está adjunto a este correo en formato PDF. También puedes descargarlo desde el siguiente enlace:</p>

<p><a href="${escapeHtml(pdfUrl)}" style="color:#0b4ea2;">Descargar certificado (PDF)</a></p>

<p>Datos del certificado:</p>
<p style="margin-left:16px;">
Curso: ${escapeHtml(curso)}<br>
Folio: ${escapeHtml(folio)}<br>
Emitido por: ${escapeHtml(consultora)}
</p>

<p>Para verificar la autenticidad de tu certificado, escanea el código QR del PDF o ingresa tu folio en <a href="${escapeHtml(qrUrl)}" style="color:#0b4ea2;">ipcil.org/validar</a>.</p>

<p>Si tienes alguna duda, responde a este correo y con gusto te atendemos.</p>

<p>Saludos,<br>
${escapeHtml(firmaNombre)}<br>
${escapeHtml(consultora)}</p>

<p style="color:#888;font-size:12px;margin-top:24px;">IPCI — Instituto Profesional de Certificación Industrial Latinoamericano · ipcil.org</p>
</body></html>`;
}

function escapeHtml(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ═══════════════════════════════════════════════════════════
// 1) generarCertificado
// ═══════════════════════════════════════════════════════════
exports.generarCertificado = onCall(
  { secrets: [RESEND_API_KEY], invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }
    const { alumnoId, programarEn = null } = request.data;
    if (!alumnoId) {
      throw new HttpsError("invalid-argument", "Falta el ID del alumno.");
    }

    const userId = request.auth.uid;
    const userDoc = await db.collection("usuarios").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (!["vendedor", "coordinador", "superadmin"].includes(userData.rol)) {
      throw new HttpsError("permission-denied", "Sin permisos.");
    }

    if (programarEn && Number(programarEn) > Date.now() + 60 * 1000) {
      await db.collection("alumnos").doc(alumnoId).update({
        estado: "programado",
        fechaProgramada: admin.firestore.Timestamp.fromMillis(Number(programarEn)),
        programadoPor: userId,
        programadoEn: admin.firestore.FieldValue.serverTimestamp(),
      });
      return {
        ok: true,
        programado: true,
        fechaProgramada: Number(programarEn),
        mensaje: "Certificado programado correctamente.",
      };
    }

    const alumnoDoc = await db.collection("alumnos").doc(alumnoId).get();
    if (!alumnoDoc.exists) throw new HttpsError("not-found", "Alumno no encontrado.");
    const alumno = alumnoDoc.data();

    if (alumno.estado === "email_enviado") {
      throw new HttpsError("already-exists", "Ya se generó el certificado.");
    }
    if (!alumno.email || !alumno.cursoId) {
      throw new HttpsError("failed-precondition", "Falta email o curso.");
    }

    const [consultoraDoc, cursoDoc] = await Promise.all([
      db.collection("consultoras").doc(alumno.consultoraId).get(),
      db.collection("cursos").doc(alumno.cursoId).get(),
    ]);
    if (!consultoraDoc.exists) throw new HttpsError("not-found", "Consultora no encontrada.");
    if (!cursoDoc.exists) throw new HttpsError("not-found", "Curso no encontrado.");

    const consultora = { id: consultoraDoc.id, ...consultoraDoc.data() };
    const curso = { id: cursoDoc.id, ...cursoDoc.data() };

    const result = await generarCertificadoCompleto({
      alumnoId, alumno, consultora, curso, userId,
      vendedor: { uid: userId, ...userData },
    });

    // ─── DETECTAR SI ESTE ALUMNO HIZO LLEGAR AL MÍNIMO → AVISAR PONENTE AUTOMÁTICO ───
    try {
      await detectarYAvisarPonente({ cursoId: curso.id, consultoraId: consultora.id });
    } catch (e) {
      console.warn("[AVISO-PONENTE] Error en detección automática:", e.message);
    }

    return { ok: true, programado: false, ...result };
  }
);

// ═══════════════════════════════════════════════════════════
// Detecta si después de inscribir un alumno se alcanzó el mínimo
// del curso, y avisa al ponente AUTOMÁTICAMENTE (una sola vez por apertura)
// ═══════════════════════════════════════════════════════════
async function detectarYAvisarPonente({ cursoId, consultoraId }) {
  if (!cursoId || !consultoraId) return;

  // Cargar curso
  const cursoDoc = await db.collection("cursos").doc(cursoId).get();
  if (!cursoDoc.exists) return;
  const curso = cursoDoc.data();

  const minimo = curso.minimoAlumnos || 8;
  if (!curso.emailPonente || !curso.emailPonente.includes("@")) return;

  // Contar alumnos del curso de esta consultora
  const alumnosSnap = await db.collection("alumnos")
    .where("cursoId", "==", cursoId)
    .where("consultoraId", "==", consultoraId)
    .get();
  const inscritos = alumnosSnap.size;

  // ¿No llegó al mínimo todavía? Salir
  if (inscritos < minimo) return;

  // Buscar la apertura "pendiente" más cercana del curso (próxima a iniciar)
  const aperturasSnap = await db.collection("aperturas")
    .where("cursoId", "==", cursoId)
    .where("consultoraId", "==", consultoraId)
    .where("estado", "in", ["pendiente", "activo"])
    .get();

  if (aperturasSnap.empty) {
    console.log(`[AVISO-PONENTE] Curso ${cursoId} llegó al mínimo pero no hay apertura programada`);
    return;
  }

  // Tomar la apertura con primera sesión más próxima (futura)
  const ahora = new Date();
  let aperturaElegida = null;
  let aperturaIdElegida = null;
  let primeraMin = null;

  aperturasSnap.docs.forEach(d => {
    const ap = d.data();
    if (!Array.isArray(ap.sesiones) || ap.sesiones.length === 0) return;
    const fs = ap.sesiones.map(s => s.fecha?.toDate?.() || new Date(s.fecha));
    const min = new Date(Math.min(...fs.map(f => f.getTime())));
    if (min < ahora) return; // ya inició, no avisar de esta
    if (!primeraMin || min < primeraMin) {
      primeraMin = min;
      aperturaElegida = ap;
      aperturaIdElegida = d.id;
    }
  });

  if (!aperturaElegida) {
    console.log(`[AVISO-PONENTE] No hay apertura futura para ${cursoId}`);
    return;
  }

  // ¿Ya se avisó al ponente para esta apertura? No avisar de nuevo
  if (aperturaElegida.ponenteAvisado === true) {
    console.log(`[AVISO-PONENTE] Ya se había avisado al ponente para apertura ${aperturaIdElegida}`);
    return;
  }

  // Cargar consultora para nombre
  const consultoraDoc = await db.collection("consultoras").doc(consultoraId).get();
  const consultora = consultoraDoc.exists ? consultoraDoc.data() : {};

  // Preparar email
  const sesionesEmail = aperturaElegida.sesiones.map(s => {
    const f = s.fecha?.toDate?.() || new Date(s.fecha);
    return { fecha: f.toISOString(), horaInicio: s.horaInicio, horaFin: s.horaFin };
  });

  const fechaFormateada = primeraMin.toLocaleDateString("es-MX", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    timeZone: "America/Mexico_City",
  }) + " · " + (aperturaElegida.sesiones[0].horaInicio || primeraMin.toLocaleTimeString("es-MX", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Mexico_City",
  }));

  const html = generarHtmlAvisoPonente({
    ponente: aperturaElegida.ponente || curso.ponente || "Ponente",
    curso: aperturaElegida.cursoNombre || curso.nombre || "Curso",
    modalidad: aperturaElegida.modalidad || curso.modalidad || "En línea",
    duracion: aperturaElegida.duracion || curso.duracion || "",
    inscritos,
    fechaInicio: fechaFormateada,
    sesiones: sesionesEmail,
    patronSemanal: aperturaElegida.patronSemanal || [],
    semanas: aperturaElegida.semanas || 0,
    consultora: consultora.nombre || aperturaElegida.consultoraNombre || "IPCI",
    coordinadorNombre: "Coordinación",
    coordinadorEmail: "",
    whatsappLink: curso.whatsappLink || "",
    whatsappHora1: curso.whatsappHora1 || "08:00",
    whatsappHora2: curso.whatsappHora2 || "17:00",
  });

  const resend = new Resend(RESEND_API_KEY.value());
  await resend.emails.send({
    from: FROM_EMAIL,
    to: curso.emailPonente,
    reply_to: REPLY_TO,
    subject: `📢 ¡Tu grupo se llenó! · ${curso.nombre}`,
    html,
  });

  // Marcar como avisado para no duplicar
  await db.collection("aperturas").doc(aperturaIdElegida).update({
    ponenteAvisado: true,
    ponenteAvisadoEn: admin.firestore.FieldValue.serverTimestamp(),
    alumnosAlAvisar: inscritos,
  });

  console.log(`[AVISO-PONENTE] ✓ Email enviado al ponente ${curso.emailPonente} de "${curso.nombre}" (${inscritos}/${minimo})`);
}

// ═══════════════════════════════════════════════════════════
// 2) reenviarHistorico
// ═══════════════════════════════════════════════════════════
exports.reenviarHistorico = onCall(
  { secrets: [RESEND_API_KEY], invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }
    const { alumnoId } = request.data;
    if (!alumnoId) {
      throw new HttpsError("invalid-argument", "Falta el ID del alumno.");
    }

    const userId = request.auth.uid;
    const userDoc = await db.collection("usuarios").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (!["coordinador", "superadmin"].includes(userData.rol)) {
      throw new HttpsError("permission-denied", "Solo coordinadores y admins pueden reenviar históricos.");
    }

    const alumnoDoc = await db.collection("alumnos").doc(alumnoId).get();
    if (!alumnoDoc.exists) throw new HttpsError("not-found", "Alumno no encontrado.");
    const alumno = alumnoDoc.data();

    if (userData.rol === "coordinador" && alumno.consultoraId !== userData.consultoraId) {
      throw new HttpsError("permission-denied", "No puedes reenviar de otra consultora.");
    }

    if (!alumno.email) throw new HttpsError("failed-precondition", "El alumno no tiene email.");
    if (!alumno.cursoId) throw new HttpsError("failed-precondition", "El alumno no tiene curso asignado.");

    const folioOriginal = alumno.historico?.folioOriginal || null;

    const [consultoraDoc, cursoDoc] = await Promise.all([
      db.collection("consultoras").doc(alumno.consultoraId).get(),
      db.collection("cursos").doc(alumno.cursoId).get(),
    ]);
    if (!consultoraDoc.exists) throw new HttpsError("not-found", "Consultora no encontrada.");
    if (!cursoDoc.exists) throw new HttpsError("not-found", "Curso no encontrado.");

    const consultora = { id: consultoraDoc.id, ...consultoraDoc.data() };
    const curso = { id: cursoDoc.id, ...cursoDoc.data() };

    const result = await generarCertificadoCompleto({
      alumnoId, alumno, consultora, curso, userId,
      vendedor: { uid: userId, ...userData },
      folioForzado: folioOriginal,
    });

    return { ok: true, ...result };
  }
);

// ═══════════════════════════════════════════════════════════
// 3) procesarProgramados — CRON DIARIO
// ═══════════════════════════════════════════════════════════
exports.procesarProgramados = onSchedule(
  {
    schedule: "0 8 * * *",
    timeZone: "America/Mexico_City",
    secrets: [RESEND_API_KEY],
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async (event) => {
    const ahora = admin.firestore.Timestamp.now();
    const snap = await db.collection("alumnos")
      .where("estado", "==", "programado")
      .where("fechaProgramada", "<=", ahora)
      .get();

    let exitos = 0, errores = 0;
    for (const docu of snap.docs) {
      const alumnoId = docu.id;
      const alumno = docu.data();
      try {
        if (!alumno.email || !alumno.cursoId) continue;
        const [consultoraDoc, cursoDoc, vendedorDoc] = await Promise.all([
          db.collection("consultoras").doc(alumno.consultoraId).get(),
          db.collection("cursos").doc(alumno.cursoId).get(),
          alumno.programadoPor
            ? db.collection("usuarios").doc(alumno.programadoPor).get()
            : Promise.resolve(null),
        ]);
        if (!consultoraDoc.exists || !cursoDoc.exists) continue;
        const consultora = { id: consultoraDoc.id, ...consultoraDoc.data() };
        const curso = { id: cursoDoc.id, ...cursoDoc.data() };
        const vendedor = vendedorDoc?.exists ? { uid: vendedorDoc.id, ...vendedorDoc.data() } : null;

        await generarCertificadoCompleto({
          alumnoId, alumno, consultora, curso,
          userId: alumno.programadoPor || alumno.registradoPor,
          vendedor,
        });
        exitos++;

        // Detectar si este alumno hizo llegar al mínimo → avisar ponente
        try {
          await detectarYAvisarPonente({ cursoId: curso.id, consultoraId: consultora.id });
        } catch (e) {
          console.warn("[CRON] Error en aviso ponente:", e.message);
        }
      } catch (err) {
        errores++;
        console.error(`[CRON] Error ${alumnoId}:`, err.message);
      }
    }
    console.log(`[CRON] ${exitos} enviados, ${errores} errores.`);
    return null;
  }
);

// ═══════════════════════════════════════════════════════════
// 3.5) recordatoriosPonentes — CRON DIARIO 8AM
// Envía email a ponentes cuyo curso inicia HOY (solo si está activo)
// ═══════════════════════════════════════════════════════════
exports.recordatoriosPonentes = onSchedule(
  {
    schedule: "0 8 * * *",
    timeZone: "America/Mexico_City",
    secrets: [RESEND_API_KEY, WATI_API_TOKEN],
    memory: "256MiB",
    timeoutSeconds: 300,
  },
  async (event) => {
    // Calcular rango "hoy" en zona MX
    const ahora = new Date();
    const hoyStrMX = ahora.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }); // YYYY-MM-DD
    const inicioHoy = new Date(hoyStrMX + "T00:00:00-06:00");
    const finHoy = new Date(hoyStrMX + "T23:59:59-06:00");

    console.log(`[RECORDATORIO] Buscando aperturas activas con primera sesión hoy ${hoyStrMX}`);

    // Solo aperturas activas (verde) que no han sido recordadas hoy
    // Incluye "pendiente": a las 8am la apertura del día aún no pasa a "activo"
    // (autoAbrirGrupos la activa hasta que INICIA la primera sesión, ej. 7pm)
    const snap = await db.collection("aperturas")
      .where("estado", "in", ["activo", "pendiente"])
      .get();

    let enviados = 0, omitidos = 0, errores = 0;
    const resend = new Resend(RESEND_API_KEY.value());

    for (const docu of snap.docs) {
      const ap = docu.data();
      const aperturaId = docu.id;
      try {
        const sesiones = ap.sesiones || [];
        if (sesiones.length === 0) { omitidos++; continue; }

        // Primera sesión cronológica
        const fs = sesiones.map(s => s.fecha?.toDate?.() || new Date(s.fecha)).sort((a, b) => a - b);
        const primera = fs[0];

        // Verificar que primera sesión es HOY
        if (primera < inicioHoy || primera > finHoy) { omitidos++; continue; }

        // Ya se envió recordatorio?
        if (ap.recordatorioEnviado) { omitidos++; continue; }

        // Verificar email del ponente
        if (!ap.emailPonente || !ap.emailPonente.includes("@")) { omitidos++; continue; }

        // Cargar curso y consultora
        const [cursoDoc, consultoraDoc] = await Promise.all([
          db.collection("cursos").doc(ap.cursoId).get(),
          db.collection("consultoras").doc(ap.consultoraId).get(),
        ]);
        const curso = cursoDoc.exists ? cursoDoc.data() : { nombre: ap.cursoNombre || "Curso" };
        const consultora = consultoraDoc.exists ? consultoraDoc.data() : { nombre: "IPCI" };

        // Mandar recordatorio
        const horaInicio = sesiones[0].horaInicio || primera.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Mexico_City" });
        const html = generarHtmlRecordatorio({
          ponente: ap.ponente || "Ponente",
          curso: ap.cursoNombre || curso.nombre,
          modalidad: ap.modalidad || curso.modalidad || "En línea",
          duracion: ap.duracion || curso.duracion || "",
          horaInicio,
          consultora: consultora.nombre || "IPCI",
        });

        await resend.emails.send({
          from: FROM_EMAIL,
          to: ap.emailPonente,
          reply_to: REPLY_TO,
          subject: `🔔 Recordatorio · Hoy inicia tu curso: ${ap.cursoNombre}`,
          html,
        });

        // Marcar como recordado
        await db.collection("aperturas").doc(aperturaId).update({
          recordatorioEnviado: true,
          recordatorioEnviadoEn: admin.firestore.FieldValue.serverTimestamp(),
        });

        enviados++;
        console.log(`[RECORDATORIO] ✓ ${ap.cursoNombre} → ${ap.emailPonente}`);

        // ── WhatsApp de recordatorio al ponente (PILOTO por consultora) ──
        try {
          const RECORDATORIO_WA_CONSULTORAS = [
            "oDXSSwQDt7f2kOJfmkkC", // Dermalysse (piloto)
          ];
          const telPon = normalizarTelefonoWA(curso.telefonoPonente);
          if (RECORDATORIO_WA_CONSULTORAS.includes(ap.consultoraId) && telPon) {
            const watiCfg = await getWatiConfig(ap.consultoraId);
            const respWA = await fetch(
              `${watiCfg.baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${telPon}`,
              {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${watiCfg.token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  ...(watiCfg.channelNumber ? { channel_number: watiCfg.channelNumber } : {}),
                  template_name: "recordatorio_ponente_v1",
                  broadcast_name: `ipci_recordatorio_ponente_${ap.cursoId}_${Date.now()}`,
                  parameters: [
                    { name: "1", value: (ap.ponente || curso.ponente || "Ponente").trim() },
                    { name: "2", value: formatearFechaConDia(hoyStrMX) },
                    { name: "3", value: ap.cursoNombre || curso.nombre || "su curso" },
                    { name: "4", value: horaInicio },
                    { name: "5", value: resolverLinkGrupo(curso, hoyStrMX) || "Su coordinador se lo compartirá en breve" },
                  ],
                }),
              }
            );
            const waData = await respWA.json().catch(() => ({}));
            const waOk = respWA.ok && (waData.result === true || waData.ok === true || waData.result === "success");
            if (waOk) {
              console.log(`[RECORDATORIO] ✓ WhatsApp al ponente ${telPon}`);
            } else {
              console.error(`[RECORDATORIO] ✗ WhatsApp al ponente falló:`, JSON.stringify(waData).slice(0, 200));
            }
          }
        } catch (eWA) {
          console.error(`[RECORDATORIO] ✗ Error WhatsApp ponente:`, eWA.message);
        }
      } catch (err) {
        errores++;
        console.error(`[RECORDATORIO] Error apertura ${aperturaId}:`, err.message);
      }
    }
    console.log(`[RECORDATORIO] ${enviados} enviados, ${omitidos} omitidos, ${errores} errores.`);
    return null;
  }
);

// ═══════════════════════════════════════════════════════════
// 3.6) autoAbrirGrupos — CRON CADA MINUTO
// Pasa aperturas pendientes 🟡 → activas 🟢 cuando ya inició la primera sesión + 1 min
// Manda email automático al ponente al abrirse
// ═══════════════════════════════════════════════════════════
exports.autoAbrirGrupos = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "America/Mexico_City",
    secrets: [RESEND_API_KEY],
    memory: "256MiB",
    timeoutSeconds: 120,
  },
  async (event) => {
    const ahora = new Date();
    const snap = await db.collection("aperturas").where("estado", "==", "pendiente").get();

    let abiertos = 0, omitidos = 0, errores = 0;
    const resend = new Resend(RESEND_API_KEY.value());

    for (const docu of snap.docs) {
      const ap = docu.data();
      const aperturaId = docu.id;
      try {
        const sesiones = ap.sesiones || [];
        if (sesiones.length === 0) { omitidos++; continue; }

        // Primera sesión cronológica
        const fs = sesiones.map(s => s.fecha?.toDate?.() || new Date(s.fecha)).sort((a, b) => a - b);
        const primera = fs[0];
        const aperturaTime = new Date(primera.getTime() + 60 * 1000); // +1 min después del inicio

        // ¿Ya pasó la hora de auto-apertura?
        if (ahora < aperturaTime) { omitidos++; continue; }

        // Marcar como activa
        await db.collection("aperturas").doc(aperturaId).update({
          estado: "activo",
          activadaEn: admin.firestore.FieldValue.serverTimestamp(),
          autoAbierto: true,
        });

        // Reiniciar contador del curso (próxima apertura)
        if (ap.cursoId) {
          await db.collection("cursos").doc(ap.cursoId).update({
            ultimaApertura: admin.firestore.FieldValue.serverTimestamp(),
            ultimaAperturaPor: "AUTO_SISTEMA",
          });
        }

        // Mandar email al ponente si tiene email
        if (ap.emailPonente && ap.emailPonente.includes("@")) {
          try {
            const [consultoraDoc, cursoDoc] = await Promise.all([
              db.collection("consultoras").doc(ap.consultoraId).get(),
              db.collection("cursos").doc(ap.cursoId).get(),
            ]);
            const consultora = consultoraDoc.exists ? consultoraDoc.data() : {};
            const curso = cursoDoc.exists ? cursoDoc.data() : {};

            const fechaFormateada = primera.toLocaleDateString("es-MX", {
              weekday: "long", day: "numeric", month: "long", year: "numeric",
              timeZone: "America/Mexico_City",
            }) + " · " + primera.toLocaleTimeString("es-MX", {
              hour: "2-digit", minute: "2-digit", hour12: true,
              timeZone: "America/Mexico_City",
            });

            const sesionesEmail = sesiones.map(s => {
              const f = s.fecha?.toDate?.() || new Date(s.fecha);
              return {
                fecha: f.toISOString(),
                horaInicio: s.horaInicio,
                horaFin: s.horaFin,
              };
            });

            // Contar inscritos
            const alumnosSnap = await db.collection("alumnos")
              .where("cursoId", "==", ap.cursoId || "")
              .get();
            const inscritos = alumnosSnap.size;

            const html = generarHtmlAvisoPonente({
              ponente: ap.ponente || "Ponente",
              curso: ap.cursoNombre || "Curso",
              modalidad: ap.modalidad || "En línea",
              duracion: ap.duracion || "",
              inscritos,
              fechaInicio: fechaFormateada,
              sesiones: sesionesEmail,
              patronSemanal: ap.patronSemanal || [],
              semanas: ap.semanas || 0,
              consultora: consultora.nombre || ap.consultoraNombre || "IPCI",
              coordinadorNombre: "Coordinación",
              coordinadorEmail: "",
              whatsappLink: curso.whatsappLink || "",
              whatsappHora1: curso.whatsappHora1 || "08:00",
              whatsappHora2: curso.whatsappHora2 || "17:00",
            });

            await resend.emails.send({
              from: FROM_EMAIL,
              to: ap.emailPonente,
              reply_to: REPLY_TO,
              subject: `📢 Tu grupo se abrió: ${ap.cursoNombre}`,
              html,
            });
          } catch (errEmail) {
            console.error(`[AUTO-ABRIR] Email falló ${aperturaId}:`, errEmail.message);
          }
        }

        abiertos++;
        console.log(`[AUTO-ABRIR] ✓ ${ap.cursoNombre} (${aperturaId})`);
      } catch (err) {
        errores++;
        console.error(`[AUTO-ABRIR] Error apertura ${aperturaId}:`, err.message);
      }
    }
    if (abiertos > 0) {
      console.log(`[AUTO-ABRIR] ${abiertos} aperturas activadas, ${omitidos} omitidas, ${errores} errores.`);
    }
    return null;
  }
);

// ═══════════════════════════════════════════════════════════
// 3.7) enviarLinksWhatsApp — CRON CADA MINUTO
// El día de inicio del curso, en las horas configuradas (default 8am y 5pm),
// envía email con el link del grupo de WhatsApp a TODOS los alumnos + ponente
// ═══════════════════════════════════════════════════════════
exports.enviarLinksWhatsApp = onSchedule(
  {
    schedule: "* * * * *",
    timeZone: "America/Mexico_City",
    secrets: [RESEND_API_KEY],
    memory: "256MiB",
    timeoutSeconds: 540,
  },
  async (event) => {
    // Hora actual en MX
    const ahora = new Date();
    const horaMX = ahora.toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", hour12: false,
      timeZone: "America/Mexico_City",
    }); // "HH:MM"

    // Solo aperturas activas (verde) o iniciadas (morado) cuya primera sesión es hoy
    const hoyStr = ahora.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
    const inicioHoy = new Date(hoyStr + "T00:00:00-06:00");
    const finHoy = new Date(hoyStr + "T23:59:59-06:00");

    const snap = await db.collection("aperturas")
      .where("estado", "in", ["activo", "pendiente"])
      .get();

    let enviados = 0, omitidos = 0, errores = 0;
    const resend = new Resend(RESEND_API_KEY.value());

    for (const docu of snap.docs) {
      const ap = docu.data();
      const aperturaId = docu.id;
      try {
        const sesiones = ap.sesiones || [];
        if (sesiones.length === 0) { omitidos++; continue; }

        // Primera sesión cronológica
        const fs = sesiones.map(s => s.fecha?.toDate?.() || new Date(s.fecha)).sort((a, b) => a - b);
        const primera = fs[0];
        if (primera < inicioHoy || primera > finHoy) { omitidos++; continue; }

        // Cargar curso para obtener whatsappLink y horas
        const cursoDoc = await db.collection("cursos").doc(ap.cursoId).get();
        if (!cursoDoc.exists) { omitidos++; continue; }
        const curso = cursoDoc.data();

        // Link de ESTA apertura (por fecha de hoy) con respaldo al global del curso
        const whatsappLink = resolverLinkGrupo(curso, hoyStr);
        if (!whatsappLink) { omitidos++; continue; }

        const hora1 = curso.whatsappHora1 || "08:00";

        // Envío ÚNICO matutino (8:00 AM) con margen de ±2 min para tolerar atraso de Cloud Scheduler
        let horaActiva = null;
        if (dentroDeVentana(horaMX, hora1, 2)) horaActiva = "manana";
        if (!horaActiva) { omitidos++; continue; }

        // Verificar que no se haya enviado ya esta hora hoy
        const enviosWa = ap.enviosWhatsApp || {};
        const claveDia = `${hoyStr}_${horaActiva}`;
        if (enviosWa[claveDia]) { omitidos++; continue; }

        // Cargar consultora
        const consultoraDoc = await db.collection("consultoras").doc(ap.consultoraId).get();
        const consultora = consultoraDoc.exists ? consultoraDoc.data() : {};

        // Cargar alumnos del curso (de esta consultora)
        const alumnosSnap = await db.collection("alumnos")
          .where("cursoId", "==", ap.cursoId)
          .where("consultoraId", "==", ap.consultoraId)
          .get();

        const emails = new Set();
        alumnosSnap.docs.forEach(d => {
          const a = d.data();
          if (a.email && a.email.includes("@")) emails.add(a.email.trim().toLowerCase());
        });
        // NOTA: NO se agrega al ponente — el ponente recibió el link cuando se abrió el grupo (al llegar al mínimo).
        // Estos envíos de 8am/5pm son solo para alumnos.

        if (emails.size === 0) {
          await db.collection("aperturas").doc(aperturaId).update({
            [`enviosWhatsApp.${claveDia}`]: { enviadoEn: admin.firestore.FieldValue.serverTimestamp(), totales: 0, omitido: "sin_alumnos" },
          });
          omitidos++;
          continue;
        }

        const horaSesion = sesiones[0].horaInicio || primera.toLocaleTimeString("es-MX", {
          hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Mexico_City",
        });

        const html = generarHtmlWhatsAppLink({
          curso: ap.cursoNombre || curso.nombre || "Curso",
          ponente: ap.ponente || curso.ponente || "Ponente",
          horaSesion,
          modalidad: ap.modalidad || curso.modalidad || "En línea",
          whatsappLink,
          consultora: consultora.nombre || ap.consultoraNombre || "IPCI",
          esTarde: false,
        });

        // Mandar a cada alumno
        let enviadosCount = 0, fallosCount = 0;
        for (const email of emails) {
          try {
            await resend.emails.send({
              from: FROM_EMAIL,
              to: email,
              reply_to: REPLY_TO,
              subject: `🎉 ¡Felicidades! Tu grupo se abrió: ${ap.cursoNombre}`,
              html,
            });
            enviadosCount++;
          } catch (errSend) {
            fallosCount++;
            console.error(`[WA-LINK] Error enviando a ${email}:`, errSend.message);
          }
        }

        // Marcar como enviado
        await db.collection("aperturas").doc(aperturaId).update({
          [`enviosWhatsApp.${claveDia}`]: {
            enviadoEn: admin.firestore.FieldValue.serverTimestamp(),
            totales: emails.size,
            exitos: enviadosCount,
            fallos: fallosCount,
          },
        });

        enviados++;
        console.log(`[WA-LINK] ✓ ${ap.cursoNombre} (${horaActiva}): ${enviadosCount} enviados, ${fallosCount} fallos`);
      } catch (err) {
        errores++;
        console.error(`[WA-LINK] Error apertura ${aperturaId}:`, err.message);
      }
    }
    if (enviados > 0) {
      console.log(`[WA-LINK] ${enviados} aperturas procesadas, ${omitidos} omitidas, ${errores} errores.`);
    }
    return null;
  }
);

function generarHtmlWhatsAppLink({ curso, ponente, horaSesion, modalidad, whatsappLink, consultora, esTarde }) {
  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>¡Tu grupo se abrió!</title></head>
<body style="margin:0;padding:0;background:#f5f8fc;font-family:Arial,Helvetica,sans-serif;color:#0f1d2e;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8fc;padding:30px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 14px rgba(15,29,46,.08);">
        <tr><td style="background:linear-gradient(135deg,#25D366 0%,#128C7E 100%);padding:36px 28px;text-align:center;">
          <div style="font-size:48px;margin-bottom:6px">🎉</div>
          <div style="color:#ffffff;font-size:30px;font-weight:800;letter-spacing:.02em;line-height:1.2">¡Felicidades!</div>
          <div style="color:#ffffff;font-size:18px;font-weight:600;margin-top:8px;line-height:1.3">Tu grupo se ha abierto</div>
          <div style="color:#d1fae5;font-size:13px;margin-top:10px;">${escapeHtml(consultora)}</div>
        </td></tr>
        <tr><td style="padding:32px 32px 14px 32px;">
          <p style="font-size:16px;line-height:1.55;margin:0 0 18px 0;text-align:center">
            <strong>Hoy comienza tu curso.</strong><br>
            Únete al grupo de WhatsApp donde recibirás <strong>todas las clases</strong>, materiales y avisos del curso.
          </p>

          <table width="100%" cellpadding="0" cellspacing="0" style="background:#dcfce7;border:2px solid #16a34a;border-radius:10px;padding:18px 20px;margin:14px 0;">
            <tr><td>
              <div style="color:#15803d;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700">CURSO</div>
              <div style="color:#0f172a;font-size:17px;font-weight:800;margin-top:4px;">${escapeHtml(curso)}</div>
              <div style="margin-top:14px;display:flex;gap:18px;flex-wrap:wrap">
                <div>
                  <div style="color:#15803d;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700">PONENTE</div>
                  <div style="color:#0f172a;font-size:14px;font-weight:600;margin-top:2px">${escapeHtml(ponente)}</div>
                </div>
                <div>
                  <div style="color:#15803d;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700">HORARIO</div>
                  <div style="color:#0f172a;font-size:14px;font-weight:600;margin-top:2px">${escapeHtml(horaSesion)}</div>
                </div>
                <div>
                  <div style="color:#15803d;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700">MODALIDAD</div>
                  <div style="color:#0f172a;font-size:14px;font-weight:600;margin-top:2px">${escapeHtml(modalidad)}</div>
                </div>
              </div>
            </td></tr>
          </table>

          <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:12px 16px;margin:18px 0;text-align:center">
            <div style="font-size:13px;color:#78350f;font-weight:600;line-height:1.4">
              📲 Las clases se imparten por <strong>el grupo de WhatsApp</strong>
            </div>
          </div>

          <div style="text-align:center;margin:28px 0 16px 0">
            <a href="${escapeHtml(whatsappLink)}" target="_blank" style="display:inline-block;background:#25D366;color:#ffffff;padding:18px 44px;border-radius:12px;font-size:18px;font-weight:800;text-decoration:none;box-shadow:0 6px 18px rgba(37,211,102,.4);text-transform:none">
              💬 Unirme al grupo ahora
            </a>
          </div>

          <p style="font-size:12px;color:#64748b;line-height:1.5;text-align:center;margin:18px 0 0 0;border-top:1px solid #f1f5f9;padding-top:14px">
            Si el botón no funciona, copia y pega este link en tu navegador:<br>
            <a href="${escapeHtml(whatsappLink)}" style="color:#0b4ea2;word-break:break-all;font-size:11.5px">${escapeHtml(whatsappLink)}</a>
          </p>
        </td></tr>
        <tr><td style="background:#f5f8fc;padding:18px 28px;text-align:center;border-top:1px solid #eef2f7;">
          <div style="color:#5f7186;font-size:11px;line-height:1.5;">
            IPCI · Instituto Profesional de Certificación Industrial Latinoamericano<br>
            <a href="https://ipcil.org" style="color:#0b4ea2;text-decoration:none;font-weight:600;">ipcil.org</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════
// Correo de AVISO para exalumnos (Membresía, Software, Canales, Catálogo).
// Un solo generador; cada tipo trae su color, título, mensaje y botón.
// ═══════════════════════════════════════════════════════════
function generarHtmlAviso({ tipo, link, descuento, curso, ponente, consultora }) {
  const CFG = {
    membresia: {
      c1: "#8b5cf6", c2: "#6d28d9", c3: "#4c1d95", soft: "#f5f3ff", accent: "#7c3aed",
      emoji: "\u2b50", badge: "MEMBRES\u00cdA VIP",
      titulo: "Bienvenido al c\u00edrculo exclusivo",
      subtitulo: "Una invitaci\u00f3n reservada para ti",
      cuerpo: "Nos dio mucho gusto acompa\u00f1arte en tu formaci\u00f3n. Por la confianza que depositaste en nosotros, queremos abrirte las puertas de nuestra <strong>membres\u00eda exclusiva</strong>: beneficios, recursos premium y ventajas pensadas para que sigas creciendo sin l\u00edmites.",
      cta: "Quiero mi membres\u00eda",
      perks: ["Contenido premium exclusivo", "Recursos y plantillas descargables", "Acceso prioritario a novedades"],
    },
    software: {
      c1: "#3b82f6", c2: "#1d4ed8", c3: "#1e3a8a", soft: "#eff6ff", accent: "#2563eb",
      emoji: "\ud83d\ude80", badge: "HERRAMIENTA EXCLUSIVA",
      titulo: "Lleva tu trabajo al siguiente nivel",
      subtitulo: "Tecnolog\u00eda pensada para ti",
      cuerpo: "Ya diste el paso de capacitarte con nosotros. Ahora queremos potenciar tus resultados con una <strong>herramienta profesional</strong> dise\u00f1ada para aplicar lo aprendido y resolver los retos de tu d\u00eda a d\u00eda de forma m\u00e1s r\u00e1pida y sencilla.",
      cta: "Descubrir el software",
      perks: ["Ahorra horas de trabajo manual", "F\u00e1cil de usar desde el primer d\u00eda", "Pensado para tu \u00e1rea profesional"],
    },
    canales: {
      c1: "#06b6d4", c2: "#0891b2", c3: "#0e7490", soft: "#ecfeff", accent: "#0891b2",
      emoji: "\ud83c\udf81", badge: "COMUNIDAD VIP",
      titulo: "\u00danete a la comunidad exclusiva",
      subtitulo: "Solo para nuestros exalumnos",
      cuerpo: "Gracias por confiar en nosotros para tu formaci\u00f3n. Queremos seguir apoy\u00e1ndote: entra a nuestro <strong>canal VIP de exalumnos</strong> y forma parte de una comunidad que sigue creciendo contigo.",
      cta: "Unirme al canal VIP",
      perks: ["Webinars y masterclass gratuitos", "Descuentos exclusivos para miembros", "Eventos y lanzamientos preferenciales"],
    },
    catalogo: {
      c1: "#f97316", c2: "#ea580c", c3: "#c2410c", soft: "#fff7ed", accent: "#ea580c",
      emoji: "\ud83c\udf93", badge: "OFERTA ESPECIAL",
      titulo: "Un descuento pensado para ti",
      subtitulo: "Sigue creciendo con nosotros",
      cuerpo: "Nos encant\u00f3 que confiaras en nosotros en tu curso anterior. Como agradecimiento, te reservamos un <strong>descuento exclusivo</strong> para tu pr\u00f3ximo curso. Escr\u00edbenos por WhatsApp y aparta tu lugar antes de que se agote.",
      cta: "\ud83d\udcac Reclamar mi descuento",
      perks: null,
    },
  };
  const c = CFG[tipo] || CFG.membresia;

  // Palomita de verificación en HTML puro (círculo de color + check) — no depende
  // de imágenes externas, así que siempre se ve en cualquier cliente de correo.
  const check = (bg, size) => `<span style="display:inline-block;width:${size}px;height:${size}px;line-height:${size}px;text-align:center;background:${bg};color:#ffffff;border-radius:50%;font-size:${Math.round(size*0.6)}px;font-weight:900;vertical-align:middle;box-shadow:0 1px 3px rgba(0,0,0,.15)">\u2713</span>`;
  const checkList = `<span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;background:#16a34a;color:#fff;border-radius:50%;font-size:12px;font-weight:900;margin-right:10px">\u2713</span>`;

  const bloqueDescuento = (tipo === "catalogo" && descuento)
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 24px 0;">
         <tr><td align="center" style="background:linear-gradient(135deg,#fff7ed 0%,#ffedd5 100%);border:2px dashed ${c.c1};border-radius:18px;padding:26px 20px;">
           <div style="color:${c.accent};font-size:12px;text-transform:uppercase;letter-spacing:.2em;font-weight:800">Tu descuento exclusivo</div>
           <div style="color:${c.c3};font-size:66px;font-weight:900;line-height:1;margin:8px 0;text-shadow:0 3px 10px rgba(234,88,12,.25)">${escapeHtml(String(descuento))}%</div>
           <div style="display:inline-block;background:${c.c2};color:#fff;font-size:13px;font-weight:700;padding:8px 18px;border-radius:999px;margin-top:4px">${curso ? `en ${escapeHtml(curso)}` : "en tu pr\u00f3ximo curso"}</div>
         </td></tr>
       </table>`
    : "";

  const bloqueCurso = (curso && tipo !== "catalogo")
    ? `<div style="text-align:center;margin:0 0 16px 0">
         <span style="display:inline-block;background:${c.soft};color:${c.accent};font-size:12px;font-weight:700;padding:7px 15px;border-radius:999px">Por tu curso: ${escapeHtml(curso)}</span>
       </div>`
    : "";

  // Lista de beneficios (para todos menos catálogo, que ya tiene el bloque de descuento)
  const bloquePerks = (c.perks && c.perks.length)
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 24px 0;background:${c.soft};border-radius:16px;">
         <tr><td style="padding:22px 24px">
           <div style="font-size:12px;font-weight:800;color:${c.accent};text-transform:uppercase;letter-spacing:.12em;margin-bottom:14px;text-align:center">Lo que incluye</div>
           ${c.perks.map(p => `<div style="font-size:14.5px;color:#334155;font-weight:600;margin:11px 0;line-height:1.4">${checkList}${escapeHtml(p)}</div>`).join("")}
         </td></tr>
       </table>`
    : "";

  // Para catálogo: ponente destacado + lista ampliada de beneficios
  const bloqueQR = (tipo === "catalogo")
    ? `${ponente ? `
       <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px 0;">
         <tr><td align="center" style="background:linear-gradient(135deg,#fff7ed 0%,#ffe4c4 100%);border-radius:16px;padding:24px 20px;">
           <div style="width:66px;height:66px;line-height:66px;margin:0 auto 10px auto;background:#ea580c;border-radius:50%;font-size:33px;box-shadow:0 8px 20px rgba(234,88,12,.4)">\ud83c\udf93</div>
           <div style="color:#9a3412;font-size:11px;text-transform:uppercase;letter-spacing:.18em;font-weight:800">Impartido por</div>
           <div style="color:#7c2d12;font-size:20px;font-weight:900;margin-top:6px;line-height:1.25">${escapeHtml(ponente)}</div>
           <div style="display:inline-block;margin-top:8px;background:#ea580c;color:#fff;font-size:12px;font-weight:700;padding:5px 14px;border-radius:999px">Ponente experto certificado</div>
         </td></tr>
       </table>` : ""}
       <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px 0;background:#f8fafc;border-radius:16px;border:1px solid #eef2f7;">
         <tr><td style="padding:22px 24px">
           <div style="font-size:12px;font-weight:800;color:#475569;text-transform:uppercase;letter-spacing:.12em;margin-bottom:14px;text-align:center">Todo esto incluye tu curso</div>
           ${[
             "Certificado <strong>verificable con c\u00f3digo QR</strong>",
             "Material y recursos <strong>descargables</strong>",
             "Acceso a las <strong>grabaciones</strong> de las sesiones",
             "<strong>Asesor\u00eda</strong> y acompa\u00f1amiento del ponente",
             "Modalidad <strong>flexible</strong>, desde donde est\u00e9s",
             "Aval y respaldo de <strong>IPCI</strong>",
           ].map(b => `<div style="font-size:14.5px;color:#334155;font-weight:600;margin:11px 0;line-height:1.4">${checkList}${b}</div>`).join("")}
         </td></tr>
       </table>`
    : "";

  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(c.titulo)}</title></head>
<body style="margin:0;padding:0;background:#eef1f6;font-family:'Segoe UI',Arial,Helvetica,sans-serif;color:#0f1d2e;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;padding:32px 14px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:24px;overflow:hidden;box-shadow:0 12px 40px rgba(15,29,46,.14);">

        <!-- HEADER -->
        <tr><td style="background:linear-gradient(150deg,${c.c1} 0%,${c.c2} 55%,${c.c3} 100%);padding:14px 28px 42px 28px;text-align:center;">
          <div style="padding-top:24px">
            <span style="display:inline-block;background:rgba(255,255,255,.22);color:#ffffff;font-size:11.5px;font-weight:800;letter-spacing:.18em;text-transform:uppercase;padding:8px 18px;border-radius:999px;border:1px solid rgba(255,255,255,.35)">${escapeHtml(c.badge)}</span>
          </div>
          <div style="margin:22px auto 16px auto;width:96px;height:96px;line-height:96px;background:rgba(255,255,255,.16);border-radius:50%;font-size:48px;border:2px solid rgba(255,255,255,.30)">${c.emoji}</div>
          <div style="color:#ffffff;font-size:31px;font-weight:900;letter-spacing:-.01em;line-height:1.15;padding:0 6px">${escapeHtml(c.titulo)}</div>
          <div style="color:#ffffff;font-size:16px;font-weight:600;margin-top:10px;opacity:.95">${escapeHtml(c.subtitulo)}</div>
          <!-- Consultora con palomita de verificación -->
          <div style="margin-top:16px">
            <span style="display:inline-block;background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.28);border-radius:999px;padding:7px 16px 7px 12px;color:#ffffff;font-size:13px;font-weight:700">
              ${check('#1d9bf0', 16)} <span style="vertical-align:middle;margin-left:5px">${escapeHtml(consultora)} \u00b7 Verificado</span>
            </span>
          </div>
        </td></tr>

        <!-- CUERPO -->
        <tr><td style="padding:34px 36px 10px 36px;">
          ${bloqueCurso}
          <p style="font-size:16px;line-height:1.65;margin:8px 0 22px 0;text-align:center;color:#3f4a5a">
            ${c.cuerpo}
          </p>
          ${bloqueDescuento}
          ${bloqueQR}
          ${bloquePerks}
          <!-- BOTÓN CTA -->
          <div style="text-align:center;margin:22px 0 12px 0">
            <a href="${escapeHtml(link)}" target="_blank" style="display:inline-block;background:linear-gradient(135deg,${c.c1} 0%,${c.c2} 100%);color:#ffffff;padding:19px 48px;border-radius:14px;font-size:18px;font-weight:800;text-decoration:none;box-shadow:0 10px 28px ${c.accent}66;letter-spacing:.01em">
              ${escapeHtml(c.cta)}
            </a>
          </div>
          <!-- Sello de confianza -->
          <div style="text-align:center;margin:20px 0 6px 0">
            <span style="display:inline-block;color:#16a34a;font-size:12.5px;font-weight:700;background:#f0fdf4;border:1px solid #bbf7d0;padding:7px 15px;border-radius:999px">
              ${check('#16a34a', 15)} <span style="vertical-align:middle;margin-left:4px">Comunicaci\u00f3n oficial de IPCI</span>
            </span>
          </div>
          <p style="font-size:11.5px;color:#8a97a8;line-height:1.5;text-align:center;margin:16px 0 0 0;border-top:1px solid #eef2f7;padding-top:16px">
            \u00bfEl bot\u00f3n no funciona? Copia y pega este enlace:<br>
            <a href="${escapeHtml(link)}" style="color:${c.accent};word-break:break-all;font-size:11px">${escapeHtml(link)}</a>
          </p>
        </td></tr>

        <!-- FOOTER -->
        <tr><td style="background:#f8fafc;padding:24px 28px;text-align:center;border-top:1px solid #eef2f7;">
          <div style="margin-bottom:8px">${check('#1d9bf0', 26)}</div>
          <div style="color:#64748b;font-size:11px;line-height:1.6;">
            <strong style="color:#475569">IPCI</strong> \u00b7 Instituto Profesional de Certificaci\u00f3n Industrial Latinoamericano<br>
            Certificados verificables por QR \u00b7 <a href="https://ipcil.org" style="color:${c.accent};text-decoration:none;font-weight:700;">ipcil.org</a>
          </div>
        </td></tr>

      </table>
      <div style="max-width:600px;margin:16px auto 0 auto;color:#64748b;font-size:10.5px;text-align:center;line-height:1.5">
        Recibiste este correo porque eres exalumno de una consultora aliada de IPCI.
      </div>
    </td></tr>
  </table>
</body></html>`;
}

function generarHtmlRecordatorio({ ponente, curso, modalidad, duracion, horaInicio, consultora }) {
  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Recordatorio</title></head>
<body style="margin:0;padding:0;background:#f5f8fc;font-family:Arial,Helvetica,sans-serif;color:#0f1d2e;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8fc;padding:30px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 14px rgba(15,29,46,.08);">
        <tr><td style="background:linear-gradient(135deg,#9333ea 0%,#7e22ce 100%);padding:32px 28px;text-align:center;">
          <div style="color:#ffffff;font-size:28px;font-weight:800;letter-spacing:.04em;">🔔 ¡Hoy inicia tu curso!</div>
          <div style="color:#f3e8ff;font-size:13px;margin-top:6px;">Recordatorio · ${escapeHtml(consultora)}</div>
        </td></tr>
        <tr><td style="padding:32px 32px 28px 32px;">
          <p style="font-size:15px;line-height:1.55;margin:0 0 14px 0;">Hola <strong>${escapeHtml(ponente)}</strong>,</p>
          <p style="font-size:15px;line-height:1.55;margin:0 0 18px 0;">Te recordamos que <strong>HOY inicias el curso</strong>:</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3e8ff;border:2px solid #9333ea;border-radius:10px;padding:18px 20px;margin:14px 0;">
            <tr><td>
              <div style="color:#7e22ce;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;">CURSO</div>
              <div style="color:#581c87;font-size:17px;font-weight:800;margin-top:4px;">${escapeHtml(curso)}</div>
              <div style="margin-top:14px;display:flex;gap:18px;flex-wrap:wrap">
                <div>
                  <div style="color:#7e22ce;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700">HORARIO</div>
                  <div style="color:#0f1d2e;font-size:16px;font-weight:700;margin-top:2px">${escapeHtml(horaInicio)}</div>
                </div>
                <div>
                  <div style="color:#7e22ce;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700">MODALIDAD</div>
                  <div style="color:#0f1d2e;font-size:14px;font-weight:600;margin-top:2px">${escapeHtml(modalidad)}</div>
                </div>
                ${duracion ? `<div>
                  <div style="color:#7e22ce;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700">DURACIÓN</div>
                  <div style="color:#0f1d2e;font-size:14px;font-weight:600;margin-top:2px">${escapeHtml(duracion)}</div>
                </div>` : ""}
              </div>
            </td></tr>
          </table>
          <p style="font-size:14px;line-height:1.55;color:#334155;margin:18px 0;">¡Mucho éxito en tu sesión de hoy! 🎓</p>
        </td></tr>
        <tr><td style="background:#f5f8fc;padding:18px 28px;text-align:center;border-top:1px solid #eef2f7;">
          <div style="color:#5f7186;font-size:11px;line-height:1.5;">
            IPCI · Instituto Profesional de Certificación Industrial Latinoamericano<br>
            <a href="https://ipcil.org" style="color:#0b4ea2;text-decoration:none;font-weight:600;">ipcil.org</a>
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════
// 4) crearUsuariosMasivo — solo super admin
// ═══════════════════════════════════════════════════════════
function generarPasswordFuerte() {
  const mayusculas = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const minusculas = "abcdefghijkmnpqrstuvwxyz";
  const numeros = "23456789";
  const simbolos = "!@#$%&*+=?";

  let password = "";
  password += mayusculas[Math.floor(Math.random() * mayusculas.length)];
  password += minusculas[Math.floor(Math.random() * minusculas.length)];
  password += numeros[Math.floor(Math.random() * numeros.length)];
  password += simbolos[Math.floor(Math.random() * simbolos.length)];

  const todos = mayusculas + minusculas + numeros + simbolos;
  for (let i = 4; i < 16; i++) {
    password += todos[Math.floor(Math.random() * todos.length)];
  }

  return password.split("").sort(() => Math.random() - 0.5).join("");
}

// ═══════════════════════════════════════════════════════════
// 4.5) limpiarDatos — solo superadmin
// Borra certificados, alumnos y aperturas (mantiene cursos, consultoras, usuarios)
// ═══════════════════════════════════════════════════════════
exports.limpiarDatos = onCall(
  { invoker: "public", cors: true, timeoutSeconds: 540 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    const userDoc = await db.collection("usuarios").doc(request.auth.uid).get();
    if (!userDoc.exists) throw new HttpsError("permission-denied", "Usuario no registrado.");
    if (userDoc.data().rol !== "superadmin") {
      throw new HttpsError("permission-denied", "Solo super admin puede limpiar datos.");
    }

    const { confirmacion, consultoraId } = request.data || {};
    if (confirmacion !== "BORRAR_TODO") {
      throw new HttpsError("invalid-argument", "Confirmación inválida.");
    }
    if (!consultoraId) {
      throw new HttpsError("invalid-argument", "Falta consultoraId — limpieza por consultora obligatoria.");
    }

    // Verificar consultora existe
    const consultoraDoc = await db.collection("consultoras").doc(consultoraId).get();
    if (!consultoraDoc.exists) {
      throw new HttpsError("not-found", "Consultora no encontrada.");
    }
    const consultoraNombre = consultoraDoc.data().nombre || consultoraId;

    const colecciones = ["certificados", "alumnos", "aperturas"];
    let total = 0;
    const detalle = {};

    for (const col of colecciones) {
      let count = 0;
      while (true) {
        const snap = await db.collection(col)
          .where("consultoraId", "==", consultoraId)
          .limit(500)
          .get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        count += snap.size;
        if (snap.size < 500) break;
      }
      detalle[col] = count;
      total += count;
    }

    // Resetear contadores en cursos de ESTA consultora
    const cursosSnap = await db.collection("cursos")
      .where("consultoraId", "==", consultoraId)
      .get();
    let cursosReseteados = 0;
    for (const cd of cursosSnap.docs) {
      const data = cd.data();
      if (data.ultimaApertura) {
        await cd.ref.update({
          ultimaApertura: admin.firestore.FieldValue.delete(),
          ultimaAperturaPor: admin.firestore.FieldValue.delete(),
        });
        cursosReseteados++;
      }
    }

    // Resetear contador de folios de la consultora
    if (consultoraDoc.data().contadorFolio) {
      await consultoraDoc.ref.update({ contadorFolio: 0 });
    }

    console.log(`[LIMPIAR] Consultora ${consultoraNombre}: ${JSON.stringify(detalle)} · cursos reseteados: ${cursosReseteados}`);
    return { ok: true, total, detalle, cursosReseteados, consultoraNombre };
  }
);

// ═══════════════════════════════════════════════════════════
// 4.6) generarCertificadoAdmin — solo superadmin
// Genera certificado para empresa externa con folio especial IPCI-{CODIGO}-ADMIN-AAAA-NNNN
// ═══════════════════════════════════════════════════════════
exports.generarCertificadoAdmin = onCall(
  { invoker: "public", cors: true, secrets: [RESEND_API_KEY], timeoutSeconds: 540, memory: "1GiB" },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    const userDoc = await db.collection("usuarios").doc(request.auth.uid).get();
    if (!userDoc.exists) throw new HttpsError("permission-denied", "Usuario no registrado.");
    const userData = userDoc.data();
    if (userData.rol !== "superadmin") {
      throw new HttpsError("permission-denied", "Solo super admin puede usar este endpoint.");
    }

    const { consultoraId, cursoId, alumno, empresaContratante = "", horasCurso = null } = request.data || {};
    if (!consultoraId || !cursoId || !alumno?.nombre || !alumno?.email) {
      throw new HttpsError("invalid-argument", "Faltan campos obligatorios.");
    }

    const [consultoraDoc, cursoDoc] = await Promise.all([
      db.collection("consultoras").doc(consultoraId).get(),
      db.collection("cursos").doc(cursoId).get(),
    ]);
    if (!consultoraDoc.exists) throw new HttpsError("not-found", "Consultora no encontrada.");
    if (!cursoDoc.exists) throw new HttpsError("not-found", "Curso no encontrado.");

    const consultora = { id: consultoraDoc.id, ...consultoraDoc.data() };
    const curso = { id: cursoDoc.id, ...cursoDoc.data() };

    // Crear documento de alumno temporal (para el flujo estándar)
    const alumnoRef = await db.collection("alumnos").add({
      nombre: alumno.nombre,
      email: alumno.email,
      telefono: alumno.telefono || "",
      consultoraId,
      cursoId,
      registradoPor: "ADMIN_DIRECTO",
      generadoPorAdmin: true,
      empresaContratante: empresaContratante || "",
      adminUid: request.auth.uid,
      adminEmail: userData.email || "",
      horasCurso: horasCurso || "",
      estado: "pendiente",
      creadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Generar folio especial: IPCI-{CODIGO}-ADMIN-{YEAR}-{NNNN}
    const codigo = consultora.codigo || consultora.id.substring(0, 4).toUpperCase();
    const year = new Date().getFullYear();

    // Contador específico de admin
    const counterRef = db.collection("contadores").doc(`admin_${consultoraId}_${year}`);
    const folio = await db.runTransaction(async (tx) => {
      const counterDoc = await tx.get(counterRef);
      const next = (counterDoc.exists ? counterDoc.data().valor : 0) + 1;
      tx.set(counterRef, { valor: next }, { merge: true });
      const numStr = String(next).padStart(4, "0");
      return `IPCI-${codigo}-ADMIN-${year}-${numStr}`;
    });

    // Generar certificado usando flujo estándar pero con folio admin
    try {
      await generarCertificadoCompleto({
        alumnoId: alumnoRef.id,
        alumno: { id: alumnoRef.id, nombre: alumno.nombre, email: alumno.email, telefono: alumno.telefono || "", consultoraId, cursoId },
        consultora,
        curso,
        userId: request.auth.uid,
        vendedor: { uid: request.auth.uid, nombre: userData.nombre || "Admin IPCI" },
        folioForzado: folio,
        adminGenerado: true,
        empresaContratante,
        horasCurso,
      });

      return { ok: true, folio, alumnoId: alumnoRef.id };
    } catch (err) {
      console.error("[ADMIN-CERT] Error completo:", err);
      console.error("[ADMIN-CERT] Stack:", err.stack);
      // Limpiar alumno temporal si falló
      try { await alumnoRef.delete(); } catch (_) {}
      // Pasar mensaje real al cliente
      const msgReal = err.message || String(err);
      throw new HttpsError("internal", `Generación falló: ${msgReal}`, { stack: err.stack });
    }
  }
);

exports.crearUsuariosMasivo = onCall(
  { invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const userId = request.auth.uid;
    const userDoc = await db.collection("usuarios").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (userData.rol !== "superadmin") {
      throw new HttpsError("permission-denied", "Solo super admin puede crear usuarios masivamente.");
    }

    const { usuarios } = request.data;
    if (!Array.isArray(usuarios) || usuarios.length === 0) {
      throw new HttpsError("invalid-argument", "Falta el array de usuarios.");
    }
    if (usuarios.length > 100) {
      throw new HttpsError("invalid-argument", "Máximo 100 usuarios por llamada.");
    }

    const consultorasSnap = await db.collection("consultoras").get();
    const consultorasMap = new Map();
    consultorasSnap.forEach(doc => {
      const data = doc.data();
      const nombre = (data.nombre || "").trim().toLowerCase();
      const codigo = (data.codigo || "").trim().toLowerCase();
      consultorasMap.set(nombre, { id: doc.id, ...data });
      if (codigo) consultorasMap.set(codigo, { id: doc.id, ...data });
    });

    const resultados = [];

    for (const u of usuarios) {
      const email = (u.email || "").trim().toLowerCase();
      const nombre = (u.nombre || "").trim();
      const rol = (u.rol || "").trim().toLowerCase();
      const consultoraInput = (u.consultora || "").trim();

      if (!email || !nombre || !rol || !consultoraInput) {
        resultados.push({ email, status: "error", error: "Faltan campos" });
        continue;
      }
      if (!["coordinador", "vendedor"].includes(rol)) {
        resultados.push({ email, status: "error", error: `Rol inválido: ${rol}` });
        continue;
      }

      const consultora = consultorasMap.get(consultoraInput.toLowerCase());
      if (!consultora) {
        resultados.push({ email, status: "error", error: `Consultora no encontrada: "${consultoraInput}"` });
        continue;
      }

      try {
        const password = generarPasswordFuerte();

        const userRecord = await admin.auth().createUser({
          email, password, displayName: nombre, emailVerified: true,
        });

        await db.collection("usuarios").doc(userRecord.uid).set({
          email, nombre, rol,
          consultoraId: consultora.id,
          consultoraNombre: consultora.nombre,
          activo: true,
          creadoEn: admin.firestore.FieldValue.serverTimestamp(),
          creadoPor: userId,
        });

        resultados.push({
          email, nombre, rol,
          consultora: consultora.nombre,
          password,
          uid: userRecord.uid,
          status: "ok",
        });
      } catch (err) {
        let mensaje = err.message || "Error desconocido";
        if (err.code === "auth/email-already-exists") {
          mensaje = "Email ya registrado";
        } else if (err.code === "auth/invalid-email") {
          mensaje = "Email inválido";
        }
        resultados.push({ email, status: "error", error: mensaje });
      }
    }

    const exitos = resultados.filter(r => r.status === "ok").length;
    const errores = resultados.filter(r => r.status === "error").length;

    return {
      ok: true,
      total: resultados.length,
      exitos,
      errores,
      resultados,
    };
  }
);

// ═══════════════════════════════════════════════════════════
// 5) notificarApertura — manda email al ponente
// Cuando el coordinador abre un grupo, se envía un aviso por correo
// al ponente con detalles del curso para que se vaya preparando.
// ═══════════════════════════════════════════════════════════
exports.notificarApertura = onCall(
  { secrets: [RESEND_API_KEY, WATI_API_TOKEN], invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const userId = request.auth.uid;
    const userDoc = await db.collection("usuarios").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (!["coordinador", "superadmin"].includes(userData.rol)) {
      throw new HttpsError("permission-denied", "Solo coordinadores y admins pueden notificar al ponente.");
    }

    const { cursoId, inscritos = 0, fechaInicio = null, sesiones = [], patronSemanal = [], semanas = 0 } = request.data || {};
    if (!cursoId) {
      throw new HttpsError("invalid-argument", "Falta el cursoId.");
    }

    // Cargar curso
    const cursoDoc = await db.collection("cursos").doc(cursoId).get();
    if (!cursoDoc.exists) {
      throw new HttpsError("not-found", "Curso no encontrado.");
    }
    const curso = cursoDoc.data();

    // Coordinador solo puede notificar de su consultora
    if (userData.rol === "coordinador" && curso.consultoraId !== userData.consultoraId) {
      throw new HttpsError("permission-denied", "No puedes notificar curso de otra consultora.");
    }

    if (!curso.emailPonente) {
      throw new HttpsError("failed-precondition", "El curso no tiene email del ponente.");
    }

    // Cargar consultora para nombre/firma
    const consultoraDoc = await db.collection("consultoras").doc(curso.consultoraId).get();
    const consultora = consultoraDoc.exists ? consultoraDoc.data() : {};

    // Mandar email
    try {
      const resend = new Resend(RESEND_API_KEY.value());

      // Formatear fecha de inicio en español si viene (zona horaria de México)
      let fechaFormateada = "";
      if (fechaInicio) {
        try {
          const d = new Date(fechaInicio);
          fechaFormateada = d.toLocaleDateString("es-MX", {
            weekday: "long", day: "numeric", month: "long", year: "numeric",
            timeZone: "America/Mexico_City",
          }) + " · " + d.toLocaleTimeString("es-MX", {
            hour: "2-digit", minute: "2-digit", hour12: true,
            timeZone: "America/Mexico_City",
          });
        } catch (e) {
          console.warn("Error formateando fecha:", e);
        }
      }

      const html = generarHtmlAvisoPonente({
        ponente: curso.ponente || "Ponente",
        curso: curso.nombre || "Curso",
        modalidad: curso.modalidad || "En línea",
        duracion: curso.duracion || "",
        inscritos,
        fechaInicio: fechaFormateada,
        sesiones,
        patronSemanal,
        semanas,
        consultora: consultora.nombre || "IPCI",
        coordinadorNombre: userData.nombre || "Coordinación",
        coordinadorEmail: userData.email || "",
        whatsappLink: curso.whatsappLink || "",
        whatsappHora1: curso.whatsappHora1 || "08:00",
        whatsappHora2: curso.whatsappHora2 || "17:00",
      });

      // Log diagnóstico — para saber si el dato llega del curso
      console.log(`[NOTIFICAR-APERTURA] Curso ${cursoId} → whatsappLink="${curso.whatsappLink || "(vacío)"}" hora1=${curso.whatsappHora1 || "default"} hora2=${curso.whatsappHora2 || "default"}`);

      const result = await resend.emails.send({
        from: FROM_EMAIL,
        to: curso.emailPonente,
        reply_to: userData.email || REPLY_TO,
        subject: `📢 Se abrió el grupo · ${curso.nombre}`,
        html,
      });

      console.log(`[NOTIFICAR-APERTURA] ✓ Email enviado a ${curso.emailPonente}`);

      // ── WhatsApp al ponente (PILOTO por consultora) ──
      // Solo consultoras habilitadas reciben también el aviso por WhatsApp.
      // Para activar en todas: reemplazar la lista por null y quitar el check.
      const PONENTE_WA_CONSULTORAS = [
        "oDXSSwQDt7f2kOJfmkkC", // Dermalysse (piloto)
      ];
      let waPonente = { enviado: false, motivo: "no habilitado" };
      try {
        const telPonente = normalizarTelefonoWA(curso.telefonoPonente);
        if (!PONENTE_WA_CONSULTORAS.includes(curso.consultoraId)) {
          waPonente.motivo = "consultora no está en el piloto";
        } else if (!telPonente) {
          waPonente.motivo = `teléfono del ponente inválido o vacío: "${curso.telefonoPonente || ""}"`;
        } else {
          const watiCfg = await getWatiConfig(curso.consultoraId);
          const respWA = await fetch(
            `${watiCfg.baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${telPonente}`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${watiCfg.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                ...(watiCfg.channelNumber ? { channel_number: watiCfg.channelNumber } : {}),
                template_name: "apertura_ponente_v2",
                broadcast_name: `ipci_apertura_ponente_${cursoId}_${Date.now()}`,
                parameters: [
                  { name: "1", value: (curso.ponente || "Ponente").trim() },
                  { name: "2", value: curso.nombre || "su curso" },
                  { name: "3", value: fechaFormateada || "por confirmar" },
                  { name: "4", value: resolverLinkGrupo(curso, fechaInicio ? new Date(fechaInicio).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }) : null) || "Su coordinador se lo compartirá en breve" },
                ],
              }),
            }
          );
          const waData = await respWA.json().catch(() => ({}));
          const waOk = respWA.ok && (waData.result === true || waData.ok === true || waData.result === "success");
          if (waOk) {
            waPonente = { enviado: true };
            console.log(`[NOTIFICAR-APERTURA] ✓ WhatsApp enviado al ponente ${telPonente}`);
          } else {
            waPonente.motivo = waData.info || waData.message || `HTTP ${respWA.status}`;
            console.error(`[NOTIFICAR-APERTURA] ✗ WhatsApp al ponente falló:`, JSON.stringify(waData).slice(0, 300));
          }
        }
      } catch (errWA) {
        waPonente.motivo = errWA.message;
        console.error("[NOTIFICAR-APERTURA] ✗ Error de red en WhatsApp al ponente:", errWA.message);
      }

      return { ok: true, emailId: result?.data?.id || null, waPonente };
    } catch (err) {
      console.error("[NOTIFICAR-APERTURA] Error:", err);
      throw new HttpsError("internal", `Error enviando email: ${err.message}`);
    }
  }
);

// ═══════════════════════════════════════════════════════════
// HTML del aviso al ponente
// ═══════════════════════════════════════════════════════════
function generarHtmlAvisoPonente({ ponente, curso, modalidad, duracion, inscritos, fechaInicio, sesiones, patronSemanal, semanas, consultora, coordinadorNombre, coordinadorEmail, whatsappLink = "", whatsappHora1 = "08:00", whatsappHora2 = "17:00" }) {
  // Generar tabla de sesiones HTML
  const DIAS_NOMBRES = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
  let tablaSesionesHtml = "";
  if (Array.isArray(sesiones) && sesiones.length > 0) {
    const filas = sesiones.map((s, idx) => {
      const f = s.fecha ? new Date(s.fecha) : null;
      if (!f) return "";
      const fStr = f.toLocaleDateString("es-MX", {
        weekday: "long", day: "numeric", month: "long",
        timeZone: "America/Mexico_City",
      });
      const horarioStr = `${s.horaInicio || ""}${s.horaFin ? " – " + s.horaFin : ""}`;
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#475569">${idx + 1}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#0f172a;text-transform:capitalize">${escapeHtml(fStr)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#0f172a;font-weight:600">${escapeHtml(horarioStr)}</td>
      </tr>`;
    }).join("");
    tablaSesionesHtml = `
      <h3 style="font-size:15px;color:#0f172a;margin:18px 0 8px 0">📋 Cronograma de sesiones (${sesiones.length} sesiones)</h3>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin:0 0 18px 0;background:#fff">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em">#</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Día</th>
            <th style="padding:10px 12px;text-align:left;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.06em">Horario</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>`;
  }

  // Resumen del patrón semanal
  let patronHtml = "";
  if (Array.isArray(patronSemanal) && patronSemanal.length > 0) {
    const items = patronSemanal.map(p => {
      const dia = DIAS_NOMBRES[p.dia] || "";
      const horario = `${p.horaInicio || ""}${p.horaFin ? " – " + p.horaFin : ""}`;
      return `<li style="margin:4px 0">${escapeHtml(dia)} · <strong>${escapeHtml(horario)}</strong></li>`;
    }).join("");
    patronHtml = `
      <div style="background:#fef3c7;border-left:4px solid #f59e0b;border-radius:8px;padding:14px 18px;margin:14px 0">
        <div style="color:#92400e;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;">⏰ Días y horarios habituales${semanas ? ` · ${semanas} semanas` : ""}</div>
        <ul style="margin:8px 0 0 18px;padding:0;font-size:14px;color:#78350f">${items}</ul>
      </div>`;
  }

  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Apertura de grupo</title></head>
<body style="margin:0;padding:0;background:#f5f8fc;font-family:Arial,Helvetica,sans-serif;color:#0f1d2e;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f8fc;padding:30px 16px;">
    <tr><td align="center">
      <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 14px rgba(15,29,46,.08);">
        <tr><td style="background:linear-gradient(135deg,#16a34a 0%,#15803d 100%);padding:32px 28px;text-align:center;">
          <div style="color:#ffffff;font-size:28px;font-weight:800;letter-spacing:.04em;">📢 ¡Grupo abierto!</div>
          <div style="color:#dcfce7;font-size:13px;margin-top:6px;">Apertura confirmada · ${escapeHtml(consultora)}</div>
        </td></tr>

        <tr><td style="padding:32px 32px 8px 32px;">
          <p style="font-size:15px;line-height:1.55;margin:0 0 14px 0;">
            Hola <strong>${escapeHtml(ponente)}</strong>,
          </p>
          <p style="font-size:15px;line-height:1.55;margin:0 0 18px 0;">
            Te avisamos que se ha <strong>abierto un grupo</strong> de tu curso. A continuación encontrarás todas las sesiones programadas.
          </p>

          ${fechaInicio ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(135deg,#dbeafe,#bfdbfe);border:2px solid #3b82f6;border-radius:10px;padding:18px 20px;margin:14px 0;">
            <tr><td style="text-align:center">
              <div style="color:#1e40af;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;">📅 Inicio del curso</div>
              <div style="color:#1e40af;font-size:18px;font-weight:800;margin-top:6px;text-transform:capitalize">${escapeHtml(fechaInicio)}</div>
            </td></tr>
          </table>
          ` : ""}

          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:18px 20px;margin:14px 0 18px 0;">
            <tr><td>
              <div style="color:#166534;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;">Curso</div>
              <div style="color:#15803d;font-size:17px;font-weight:800;margin-top:4px;">${escapeHtml(curso)}</div>

              <table width="100%" style="margin-top:14px"><tr>
                <td style="padding-right:10px">
                  <div style="color:#166534;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;">Modalidad</div>
                  <div style="color:#0f1d2e;font-size:14px;font-weight:600;margin-top:4px;">${escapeHtml(modalidad)}</div>
                </td>
                ${duracion ? `<td style="padding-right:10px">
                  <div style="color:#166534;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;">Duración</div>
                  <div style="color:#0f1d2e;font-size:14px;font-weight:600;margin-top:4px;">${escapeHtml(duracion)}</div>
                </td>` : ""}
                <td>
                  <div style="color:#166534;font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:700;">Alumnos</div>
                  <div style="color:#15803d;font-size:18px;font-weight:800;margin-top:4px;">${inscritos}</div>
                </td>
              </tr></table>
            </td></tr>
          </table>

          ${patronHtml}
          ${tablaSesionesHtml}

          ${whatsappLink ? `
          <div style="background:linear-gradient(135deg,#dcfce7,#bbf7d0);border:2px solid #16a34a;border-radius:12px;padding:18px 20px;margin:20px 0">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <span style="font-size:22px">💬</span>
              <strong style="color:#15803d;font-size:15px">Grupo de WhatsApp del curso</strong>
            </div>
            <p style="font-size:13.5px;color:#166534;margin:6px 0 14px 0;line-height:1.5">
              Por aquí se compartirán los avisos y materiales del curso. Únete desde ya:
            </p>
            <div style="text-align:center;margin:14px 0">
              <a href="${escapeHtml(whatsappLink)}" target="_blank" style="display:inline-block;background:#25D366;color:#ffffff;padding:13px 32px;border-radius:10px;font-size:15px;font-weight:800;text-decoration:none;box-shadow:0 4px 12px rgba(37,211,102,.3)">
                💬 Unirme al grupo de WhatsApp
              </a>
            </div>
            <p style="font-size:12px;color:#15803d;margin:14px 0 0 0;line-height:1.4;text-align:center;border-top:1px solid #86efac;padding-top:12px">
              📨 <strong>El día del inicio del curso</strong>, este link se enviará automáticamente a todos los alumnos a las <strong>${escapeHtml(whatsappHora1)}</strong> y <strong>${escapeHtml(whatsappHora2)}</strong> (México).
            </p>
          </div>
          ` : ""}

          <p style="font-size:14px;line-height:1.55;color:#334155;margin:18px 0;">
            <strong>📌 Próximos pasos:</strong><br>
            1. Revisa el cronograma y confirma tu disponibilidad<br>
            2. Prepara los materiales y plataforma<br>
            3. Coordina con quien te envió este correo
          </p>

          <p style="font-size:13px;line-height:1.55;color:#5f7186;margin:18px 0 4px 0;">Coordinación a cargo:</p>
          <p style="font-size:14px;line-height:1.4;color:#0f1d2e;font-weight:700;margin:0;">${escapeHtml(coordinadorNombre)}</p>
          ${coordinadorEmail ? `<p style="font-size:13px;line-height:1.4;color:#0b4ea2;margin:2px 0 0 0;"><a href="mailto:${escapeHtml(coordinadorEmail)}" style="color:#0b4ea2;text-decoration:none">${escapeHtml(coordinadorEmail)}</a></p>` : ""}
          <p style="font-size:12px;line-height:1.4;color:#5f7186;margin:6px 0 18px 0;">${escapeHtml(consultora)}</p>
        </td></tr>

        <tr><td style="background:#f5f8fc;padding:18px 28px;text-align:center;border-top:1px solid #eef2f7;">
          <div style="color:#5f7186;font-size:11px;line-height:1.5;">
            IPCI · Instituto Profesional de Certificación Industrial Latinoamericano<br>
            <a href="https://ipcil.org" style="color:#0b4ea2;text-decoration:none;font-weight:600;">ipcil.org</a>
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ═══════════════════════════════════════════════════════════
// HELPER: comparar hora actual vs hora objetivo con margen ±N minutos
// (resuelve atraso de Cloud Scheduler para enviarLinksWhatsApp)
// ═══════════════════════════════════════════════════════════
function dentroDeVentana(horaActualHHMM, horaObjetivoHHMM, margenMin = 2) {
  const toMins = (s) => {
    const m = String(s || "").match(/^(\d{1,2}):(\d{2})/);
    if (!m) return -1;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  };
  const a = toMins(horaActualHHMM);
  const b = toMins(horaObjetivoHHMM);
  if (a < 0 || b < 0) return false;
  return Math.abs(a - b) <= margenMin;
}

// ═══════════════════════════════════════════════════════════
// onCall: enviarLinkWhatsAppAhora — disparo manual desde coordinador
// Envía el link de WhatsApp a TODOS los alumnos de un curso al instante,
// sin esperar al cron ni requerir que la apertura tenga sesiones.
// ═══════════════════════════════════════════════════════════
exports.enviarLinkWhatsAppAhora = onCall(
  { secrets: [RESEND_API_KEY], invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const userId = request.auth.uid;
    const userDoc = await db.collection("usuarios").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (!["coordinador", "vendedor", "superadmin"].includes(userData.rol)) {
      throw new HttpsError("permission-denied", "No tienes permiso para enviar el link.");
    }

    const { cursoId, whatsappLink: _wl, aperturaKey, tipoAviso = "whatsapp", descuento, cursoCatalogo, ponenteCatalogo } = request.data || {};
    if (!cursoId) {
      throw new HttpsError("invalid-argument", "Falta el cursoId.");
    }

    const cursoDoc = await db.collection("cursos").doc(cursoId).get();
    if (!cursoDoc.exists) {
      throw new HttpsError("not-found", "Curso no encontrado.");
    }
    const curso = cursoDoc.data();

    if (["coordinador", "vendedor"].includes(userData.rol) && curso.consultoraId !== userData.consultoraId) {
      throw new HttpsError("permission-denied", "No puedes enviar link de un curso de otra consultora.");
    }

    // El vendedor manda un link "de un solo uso" en los params (los grupos de
    // WhatsApp cambian seguido). Si no viene, se usa el que el curso tenga
    // guardado — así el coordinador sigue funcionando igual que antes.
    const linkParam = (request.data?.whatsappLink || "").trim();
    const whatsappLink = linkParam || (curso.whatsappLink || "").trim();
    if (!whatsappLink) {
      throw new HttpsError("failed-precondition", "Falta el enlace a enviar.");
    }

    // Cargar alumnos del curso de esta consultora
    const alumnosSnap = await db.collection("alumnos")
      .where("cursoId", "==", cursoId)
      .where("consultoraId", "==", curso.consultoraId)
      .get();

    const emails = new Set();
    alumnosSnap.docs.forEach(d => {
      const a = d.data();
      // Si el vendedor mandó la apertura, solo cuenta alumnos de ESA fecha de
      // apertura (no de todas las aperturas del curso). El coordinador no manda
      // aperturaKey, así que para él sigue tomando todos (retrocompatible).
      if (aperturaKey) {
        const aKey = a.aperturaKey || "sin-asignar";
        if (aKey !== aperturaKey) return;
      }
      if (a.email && a.email.includes("@")) emails.add(a.email.trim().toLowerCase());
    });

    if (emails.size === 0) {
      throw new HttpsError("failed-precondition", "Este curso no tiene alumnos con email registrado.");
    }

    // Cargar consultora para el nombre
    const consultoraDoc = await db.collection("consultoras").doc(curso.consultoraId).get();
    const consultora = consultoraDoc.exists ? consultoraDoc.data() : {};

    // Determinar hora del curso (si hay fechaInicioGrupo, usarla; si no, "Por confirmar")
    let horaSesion = "Por confirmar";
    if (curso.fechaInicioGrupo) {
      try {
        const f = curso.fechaInicioGrupo.toDate?.() || new Date(curso.fechaInicioGrupo);
        horaSesion = f.toLocaleTimeString("es-MX", {
          hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "America/Mexico_City",
        });
      } catch (e) {
        console.warn("[WA-MANUAL] Error formateando hora:", e.message);
      }
    }

    // Elegir plantilla y asunto según el tipo de aviso.
    // "whatsapp" (grupo del curso) usa la plantilla original; el resto usa la genérica.
    let html, subject;
    const nombreCons = consultora.nombre || "IPCI";
    if (tipoAviso === "whatsapp") {
      html = generarHtmlWhatsAppLink({
        curso: curso.nombre || "Curso",
        ponente: curso.ponente || "Ponente",
        horaSesion,
        modalidad: curso.modalidad || "En línea",
        whatsappLink,
        consultora: nombreCons,
        esTarde: false,
      });
      subject = `🎉 ¡Tu grupo se abrió! · ${curso.nombre}`;
    } else {
      // Para catálogo: el vendedor pega SU número de WhatsApp (10 dígitos).
      // Construimos un link wa.me con un mensaje automático que incluye la
      // consultora y el descuento, para que el exalumno le escriba directo.
      let linkFinal = whatsappLink;
      if (tipoAviso === "catalogo") {
        const soloDigitos = String(whatsappLink).replace(/\D/g, "");
        const numeroCompleto = soloDigitos.startsWith("52") ? soloDigitos : "52" + soloDigitos;
        const enCurso = cursoCatalogo ? ` en el curso ${cursoCatalogo}` : "";
        const msg = `Soy exalumno de ${nombreCons}, me interesa el descuento del ${descuento || ""}%${enCurso}`;
        linkFinal = `https://wa.me/${numeroCompleto}?text=${encodeURIComponent(msg)}`;
      }
      html = generarHtmlAviso({
        tipo: tipoAviso,
        link: linkFinal,
        descuento,
        curso: tipoAviso === "catalogo" ? (cursoCatalogo || "") : "",
        ponente: tipoAviso === "catalogo" ? (ponenteCatalogo || "") : "",
        consultora: nombreCons,
      });
      const asuntos = {
        membresia: `Una invitación especial para ti · ${nombreCons}`,
        software: `Una herramienta pensada para ti · ${nombreCons}`,
        canales: `Únete a nuestra comunidad VIP de exalumnos · ${nombreCons}`,
        catalogo: `Tienes ${descuento || ""}% de descuento en tu próximo curso`,
      };
      subject = asuntos[tipoAviso] || `Un mensaje de ${nombreCons}`;
    }

    const resend = new Resend(RESEND_API_KEY.value());
    let enviadosCount = 0, fallosCount = 0;
    const fallosDetalle = [];

    // MODIFICADO: el remitente muestra el nombre de la consultora (no "IPCI Certificados"),
    // manteniendo el email verificado en Resend. Se limpian caracteres que rompen el header.
    const emailRemitente = (FROM_EMAIL.match(/<(.+)>/) || [])[1] || "certificados@ipcil.org";
    const nombreRemitente = String(nombreCons).replace(/["<>\r\n]/g, "").trim() || "IPCI";
    const fromAviso = `${nombreRemitente} <${emailRemitente}>`;

    for (const email of emails) {
      try {
        await resend.emails.send({
          from: fromAviso,
          to: email,
          reply_to: userData.email || REPLY_TO,
          subject,
          html,
        });
        enviadosCount++;
      } catch (errSend) {
        fallosCount++;
        fallosDetalle.push({ email, error: errSend.message });
        console.error(`[WA-MANUAL] Error enviando a ${email}:`, errSend.message);
      }
    }

    console.log(`[WA-MANUAL] Curso ${cursoId} por ${userData.email}: ${enviadosCount}/${emails.size} enviados (${fallosCount} fallos)`);

    return {
      ok: true,
      totales: emails.size,
      exitos: enviadosCount,
      fallos: fallosCount,
      fallosDetalle: fallosDetalle.slice(0, 5),
    };
  }
);

// ═══════════════════════════════════════════════════════════════════
//  stripeWebhookIPCI — Webhook de Stripe (activa / suspende consultoras)
//  Mueve consultoras.estadoSuscripcion según los eventos de pago.
//  Corre con Admin SDK → escribe IGNORANDO las reglas de Firestore.
//  La seguridad la da la verificación de firma (no la red).
// ═══════════════════════════════════════════════════════════════════
exports.stripeWebhookIPCI = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const Stripe = require("stripe");
    const stripe = new Stripe(STRIPE_SECRET_KEY.value());

    // 1) Verificar firma con el rawBody (Firebase v2 lo expone)
    let event;
    try {
      const sig = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (err) {
      console.error("[STRIPE] Firma inválida:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Helper: actualiza el estado de una consultora por su ID
    async function setEstado(consultoraId, estado, extra = {}) {
      if (!consultoraId) {
        console.warn("[STRIPE] Evento sin consultoraId, ignorado:", event.type);
        return;
      }
      await db.collection("consultoras").doc(consultoraId).set(
        {
          estadoSuscripcion: estado,
          suscripcionActualizada: admin.firestore.FieldValue.serverTimestamp(),
          ...extra,
        },
        { merge: true }
      );
      console.log(`[STRIPE] Consultora ${consultoraId} → ${estado} (${event.type})`);
    }

    // Helper: encuentra la consultora por su stripeCustomerId
    async function consultoraPorCustomer(customerId) {
      if (!customerId) return null;
      const snap = await db
        .collection("consultoras")
        .where("stripeCustomerId", "==", customerId)
        .limit(1)
        .get();
      return snap.empty ? null : snap.docs[0].id;
    }

    // 2) Procesar el evento
    try {
      switch (event.type) {
        // Pago inicial completado → ACTIVA + guardamos IDs de Stripe
        case "checkout.session.completed": {
          const s = event.data.object;
          await setEstado(s.client_reference_id, "activa", {
            stripeCustomerId: s.customer || null,
            stripeSubscriptionId: s.subscription || null,
          });
          break;
        }

        // Renovación cobrada con éxito → ACTIVA
        case "invoice.paid": {
          const inv = event.data.object;
          const id = await consultoraPorCustomer(inv.customer);
          await setEstado(id, "activa");
          break;
        }

        // Falló el cobro de la renovación → SUSPENDIDA
        case "invoice.payment_failed": {
          const inv = event.data.object;
          const id = await consultoraPorCustomer(inv.customer);
          await setEstado(id, "suspendida");
          break;
        }

        // Suscripción cancelada → SUSPENDIDA
        case "customer.subscription.deleted": {
          const sub = event.data.object;
          const id = await consultoraPorCustomer(sub.customer);
          await setEstado(id, "suspendida");
          break;
        }

        default:
          // Otros eventos no nos interesan; respondemos 200 igual.
          break;
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      console.error("[STRIPE] Error procesando evento:", err);
      return res.status(500).send("Error interno");
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
//  crearCheckoutIPCI — Autoservicio público (página suscripcion.html)
//  El prospecto llena empresa/email/teléfono/plan → creamos su consultora
//  en estado "pendiente" y lo mandamos a pagar a Stripe con SU tarjeta.
//  Al pagar, el webhook (stripeWebhookIPCI) la pasa a "activa".
//  NOTA: la consultora queda "pendiente" hasta el pago; el alta real
//  (plantilla co-branded, código, usuarios) la hace el equipo después.
// ═══════════════════════════════════════════════════════════════════
exports.crearCheckoutIPCI = onRequest(
  { secrets: [STRIPE_SECRET_KEY], cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Método no permitido." });
    }

    try {
      const { empresa, email, telefono, plan } = req.body || {};

      // Validación básica
      if (!empresa || !email || !plan) {
        return res
          .status(400)
          .json({ error: "Faltan datos: empresa, email y plan son obligatorios." });
      }

      // Mapeo de planes → Price IDs de Stripe (IPCI Certificación)
      const PRICES = {
        mensual: "price_1TiqdtA7If2CqXs9omKD1cgF",
        anual: "price_1Tiqf4A7If2CqXs9TMw2oIEi",
      };
      const priceId = PRICES[plan];
      if (!priceId) {
        return res.status(400).json({ error: "Plan inválido." });
      }

      const emailLimpio = String(email).trim().toLowerCase();
      const nombreLimpio = String(empresa).trim();

      // 1) Crear la consultora en estado "pendiente"
      const ref = await db.collection("consultoras").add({
        nombre: nombreLimpio,
        emailContacto: emailLimpio,
        telefono: telefono ? String(telefono).trim() : "",
        codigo: "", // lo asigna el admin al dar de alta formalmente
        contadorFolio: 0,
        estadoSuscripcion: "pendiente",
        planSolicitado: plan,
        origen: "autoservicio-web",
        fechaRegistro: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 2) Crear la sesión de pago de Stripe
      const Stripe = require("stripe");
      const stripe = new Stripe(STRIPE_SECRET_KEY.value());

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: ref.id, // ← el webhook activa ESTA consultora
        customer_email: emailLimpio,
        allow_promotion_codes: true,
        success_url: "https://ipcil.org/gracias.html",
        cancel_url: "https://ipcil.org/suscripcion.html",
        metadata: { consultoraId: ref.id, empresa: nombreLimpio, plan },
        subscription_data: {
          metadata: { consultoraId: ref.id, empresa: nombreLimpio },
        },
      });

      return res.status(200).json({ url: session.url });
    } catch (err) {
      console.error("[CHECKOUT] Error:", err);
      return res
        .status(500)
        .json({ error: "No se pudo iniciar el pago. Inténtalo de nuevo." });
    }
  }
);

// ═══════════════════════════════════════════════════════════
// MÓDULO: Recordatorios por WhatsApp vía WATI — v1.0
// ═══════════════════════════════════════════════════════════
// INSTRUCCIONES DE INSTALACIÓN:
//
// 1. Pega TODO este bloque AL FINAL de:
//    C:\Users\user\ipci-backend\functions\index.js
//
// 2. Agrega esta línea junto a los otros defineSecret (arriba
//    del archivo, donde está RESEND_API_KEY):
//
//    const WATI_API_TOKEN = defineSecret("WATI_API_TOKEN");
//
// 3. Deploy:
//    cd C:\Users\user\ipci-backend
//    firebase deploy --only functions:enviarRecordatorioWhatsApp
//
// 4. Verificar IAM público en Cloud Run (bug recurrente):
//    https://console.cloud.google.com/run/detail/us-central1/enviarrecordatoriowhatsapp/security?project=ipci-certificados
//    → allUsers con rol "Cloud Run Invoker"
// ═══════════════════════════════════════════════════════════

const WATI_BASE_URL = "https://live-mt-server.wati.io/1085621";
const WATI_TEMPLATE_NAME = "recordatorio_curso_v4"; // nombre exacto de la plantilla aprobada en WATI

/**
 * Config WATI multi-consultora.
 * Lee watiConfigs/{consultoraId} de Firestore (baseUrl + token).
 * Si la consultora no tiene config propia, usa el WATI global (secreto).
 * La colección watiConfigs debe estar BLOQUEADA en las reglas de Firestore
 * (allow read, write: if false) — solo el Admin SDK del backend la lee.
 */
async function getWatiConfig(consultoraId) {
  try {
    if (consultoraId) {
      const cfgDoc = await db.collection("watiConfigs").doc(consultoraId).get();
      if (cfgDoc.exists) {
        const cfg = cfgDoc.data();
        if (cfg.baseUrl && cfg.token) {
          console.log(`[WATI-CONFIG] Usando WATI propio de consultora ${consultoraId}${cfg.channelNumber ? ` (canal ${cfg.channelNumber})` : ""}`);
          return {
            baseUrl: String(cfg.baseUrl).replace(/\/+$/, ""),
            token: cfg.token,
            // Canal específico para cuentas WATI con más de un número de WhatsApp
            channelNumber: cfg.channelNumber ? String(cfg.channelNumber).replace(/\D/g, "") : null,
            // Override opcional: nombre de plantilla de recordatorio propio de la consultora.
            // Si su cuenta WATI tiene la plantilla aprobada con OTRO nombre, se pone aquí.
            templateRecordatorio: cfg.templateRecordatorio ? String(cfg.templateRecordatorio).trim() : null,
            templateMembresia: cfg.templateMembresia ? String(cfg.templateMembresia).trim() : null,
            templateInvitacion: cfg.templateInvitacion ? String(cfg.templateInvitacion).trim() : null,
          };
        }
      }
    }
  } catch (e) {
    console.warn("[WATI-CONFIG] Error leyendo config, uso global:", e.message);
  }
  console.log(`[WATI-CONFIG] Consultora ${consultoraId || "(sin id)"} SIN config propia → usando WATI GLOBAL ${WATI_BASE_URL}`);
  return { baseUrl: WATI_BASE_URL, token: WATI_API_TOKEN.value(), channelNumber: null, templateRecordatorio: null, templateMembresia: null, templateInvitacion: null };
}

const WATI_BROADCAST_PREFIX = "ipci_recordatorio"; // prefijo para identificar los envíos en WATI

/**
 * Normaliza un teléfono mexicano al formato que espera WATI: 521XXXXXXXXXX
 * - Quita espacios, guiones, paréntesis, signos +
 * - 10 dígitos → antepone 52 (México)
 * - 12 dígitos que empiezan con 52 → lo deja igual
 * - Devuelve null si no se puede normalizar
 */
function normalizarTelefonoWA(telRaw) {
  if (!telRaw) return null;
  let tel = String(telRaw).replace(/[\s\-().+]/g, "");
  if (!/^\d+$/.test(tel)) return null;
  if (tel.length === 10) return "52" + tel;
  if (tel.length === 12 && tel.startsWith("52")) return tel;
  if (tel.length === 13 && tel.startsWith("521")) return "52" + tel.slice(3); // 521XXXXXXXXXX viejo formato → 52XXXXXXXXXX
  return null;
}

/**
 * Formatea "YYYY-MM-DD" a "martes 11 de agosto de 2026" (es-MX).
 * Si no es fecha válida, devuelve el valor tal cual.
 */
function formatearFechaConDia(yyyymmdd) {
  const m = String(yyyymmdd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return yyyymmdd;
  try {
    const d = new Date(`${yyyymmdd}T12:00:00-06:00`);
    return d.toLocaleDateString("es-MX", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      timeZone: "America/Mexico_City",
    });
  } catch (e) { return yyyymmdd; }
}

/**
 * Resuelve el link del grupo de WhatsApp para una fecha de apertura específica.
 * Prioridad: curso.whatsappLinks[fechaKey] (link por apertura) → curso.whatsappLink (respaldo).
 */
function resolverLinkGrupo(curso, fechaKey) {
  const mapa = curso?.whatsappLinks || {};
  if (fechaKey && mapa[fechaKey] && String(mapa[fechaKey]).trim()) {
    return String(mapa[fechaKey]).trim();
  }
  return (curso?.whatsappLink || "").trim();
}

/**
 * Convierte hora 24h "HH:MM" a formato 12h con AM/PM (ej. "19:00" → "7:00 PM").
 * Si el valor no es una hora válida (ej. "por confirmar"), lo devuelve igual.
 */
function formatearHora12(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return hhmm;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const suf = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${suf}`;
}

/**
 * onCall: enviarRecordatorioWhatsApp
 * Envía la plantilla de recordatorio a los alumnos indicados de un curso.
 * Llamado desde el panel del vendedor/coordinador.
 *
 * data: {
 *   cursoId: string,
 *   alumnoIds: string[]   // ids de los alumnos a notificar (los seleccionados en el panel)
 * }
 */
exports.enviarRecordatorioWhatsApp = onCall(
  { secrets: [WATI_API_TOKEN], invoker: "public", cors: true, timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    // ── Validar rol ──
    const userId = request.auth.uid;
    const userDoc = await db.collection("usuarios").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (!["vendedor", "coordinador", "superadmin"].includes(userData.rol)) {
      throw new HttpsError("permission-denied", "No tienes permiso para enviar recordatorios.");
    }

    // ── Validar datos ──
    const { cursoId, alumnoIds, aperturaKey } = request.data || {};
    if (!cursoId || !Array.isArray(alumnoIds) || alumnoIds.length === 0) {
      throw new HttpsError("invalid-argument", "Faltan cursoId o alumnoIds.");
    }
    if (alumnoIds.length > 100) {
      throw new HttpsError("invalid-argument", "Máximo 100 alumnos por envío.");
    }
    const aperturaKeyValida = /^\d{4}-\d{2}-\d{2}$/.test(aperturaKey || "") ? aperturaKey : null;

    // ── Cargar curso ──
    const cursoDoc = await db.collection("cursos").doc(cursoId).get();
    if (!cursoDoc.exists) {
      throw new HttpsError("not-found", "Curso no encontrado.");
    }
    const curso = cursoDoc.data();

    // Seguridad multi-consultora: vendedor/coordinador solo de su consultora
    if (userData.rol !== "superadmin" && curso.consultoraId !== userData.consultoraId) {
      throw new HttpsError("permission-denied", "No puedes enviar recordatorios de cursos de otra consultora.");
    }

    // Link del grupo: prioridad al que manda el vendedor desde el modal;
    // si no viene, usar el configurado en el curso
    const linkDelModal = (request.data.whatsappLink || "").trim();
    const whatsappLink = linkDelModal || resolverLinkGrupo(curso, aperturaKeyValida);
    if (!whatsappLink) {
      throw new HttpsError("failed-precondition", "Falta el link del grupo de WhatsApp. Pégalo en el modal antes de enviar.");
    }
    if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+/.test(whatsappLink)) {
      throw new HttpsError("invalid-argument", "El link del grupo no es válido. Debe ser tipo https://chat.whatsapp.com/XXXX");
    }
    // Guardar el link: por apertura (mapa por fecha) + respaldo global
    if (linkDelModal) {
      try {
        const updates = { whatsappLink: linkDelModal };
        if (aperturaKeyValida) {
          updates[`whatsappLinks.${aperturaKeyValida}`] = linkDelModal;
        }
        await db.collection("cursos").doc(cursoId).update(updates);
      } catch (e) {
        console.warn("[WA-RECORDATORIO] No se pudo guardar el link en el curso:", e.message);
      }
    }

    // Hora de la primera sesión (para el {{3}} de la plantilla)
    let horaSesion = curso.whatsappHora1 || "por confirmar";
    // Buscar la apertura activa más reciente con sesiones para una hora más precisa
    try {
      const apSnap = await db.collection("aperturas")
        .where("cursoId", "==", cursoId)
        .where("estado", "in", ["activo", "pendiente"])
        .limit(5)
        .get();
      for (const apDoc of apSnap.docs) {
        const sesiones = apDoc.data().sesiones || [];
        if (sesiones.length > 0 && sesiones[0].horaInicio) {
          horaSesion = sesiones[0].horaInicio;
          break;
        }
      }
    } catch (e) {
      console.warn("[WA-RECORDATORIO] No se pudo leer sesiones:", e.message);
    }

    // ── Cargar alumnos ──
    const alumnosDocs = await Promise.all(
      alumnoIds.map(id => db.collection("alumnos").doc(id).get())
    );

    const watiCfg = await getWatiConfig(curso.consultoraId);
    // Plantilla efectiva: override de la consultora (watiConfigs/{id}.templateRecordatorio) o la global
    const templateRecordatorio = watiCfg.templateRecordatorio || WATI_TEMPLATE_NAME;
    console.log(`[WA-RECORDATORIO] Enviando via ${watiCfg.baseUrl}${watiCfg.channelNumber ? " canal " + watiCfg.channelNumber : ""} · plantilla ${templateRecordatorio} · consultora ${curso.consultoraId}`);
    const resultados = { exitos: 0, fallos: 0, sinTelefono: 0, detalle: [] };

    for (const aDoc of alumnosDocs) {
      if (!aDoc.exists) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, ok: false, motivo: "Alumno no existe" });
        continue;
      }
      const alumno = aDoc.data();

      // Seguridad: el alumno debe ser del mismo curso y consultora
      if (alumno.cursoId !== cursoId || (userData.rol !== "superadmin" && alumno.consultoraId !== userData.consultoraId)) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, ok: false, motivo: "No pertenece al curso/consultora" });
        continue;
      }

      const telWA = normalizarTelefonoWA(alumno.telefono);
      if (!telWA) {
        resultados.sinTelefono++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, ok: false, motivo: `Teléfono inválido: "${alumno.telefono || "(vacío)"}"` });
        continue;
      }

      // Primer nombre para el saludo (más natural que el nombre completo)
      const primerNombre = (alumno.nombre || "").trim().split(/\s+/)[0] || "Hola";

      try {
        const resp = await fetch(
          `${watiCfg.baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${telWA}`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${watiCfg.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...(watiCfg.channelNumber ? { channel_number: watiCfg.channelNumber } : {}),
              template_name: templateRecordatorio,
              broadcast_name: `${WATI_BROADCAST_PREFIX}_${cursoId}_${Date.now()}`,
              parameters: [
                { name: "1", value: primerNombre },
                { name: "2", value: curso.nombre || "tu curso" },
                { name: "3", value: formatearHora12(horaSesion) },
                { name: "4", value: whatsappLink },
              ],
            }),
          }
        );

        const respData = await resp.json().catch(() => ({}));

        // WATI responde ok:true / result:true cuando acepta el mensaje
        const aceptado = resp.ok && (respData.result === true || respData.ok === true || respData.result === "success");

        if (aceptado) {
          resultados.exitos++;
          resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: true });
        } else {
          resultados.fallos++;
          const motivo = respData.info || respData.message || respData.error || `HTTP ${resp.status}`;
          resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: false, motivo });
          console.error(`[WA-RECORDATORIO] Fallo con ${telWA}:`, JSON.stringify(respData).slice(0, 300));
        }
      } catch (errSend) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: false, motivo: errSend.message });
        console.error(`[WA-RECORDATORIO] Error de red con ${telWA}:`, errSend.message);
      }

      // Pausa suave entre mensajes para no saturar la API de WATI
      await new Promise(r => setTimeout(r, 350));
    }

    // Registrar el envío en la apertura/curso para trazabilidad
    try {
      await db.collection("cursos").doc(cursoId).update({
        ultimoRecordatorioWA: admin.firestore.FieldValue.serverTimestamp(),
        ultimoRecordatorioWAPor: userData.email || userId,
      });
    } catch (e) {
      console.warn("[WA-RECORDATORIO] No se pudo registrar trazabilidad:", e.message);
    }

    console.log(`[WA-RECORDATORIO] Curso ${cursoId} por ${userData.email}: ${resultados.exitos} ok, ${resultados.fallos} fallos, ${resultados.sinTelefono} sin teléfono`);

    return {
      ok: true,
      totales: alumnoIds.length,
      exitos: resultados.exitos,
      fallos: resultados.fallos,
      sinTelefono: resultados.sinTelefono,
      detalle: resultados.detalle,
    };
  }
);
// ═══════════════════════════════════════════════════════════
// FIN Módulo WhatsApp WATI
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// onCall: enviarOfertaMembresia — oferta de membresía VIP por WhatsApp
// Enviado por el vendedor a alumnos que ya concluyeron su curso.
// Plantilla WATI: oferta_membresia_v1 (Marketing)
// ═══════════════════════════════════════════════════════════
const WATI_TEMPLATE_MEMBRESIA = "oferta_membresia_v1";

exports.enviarOfertaMembresia = onCall(
  { secrets: [WATI_API_TOKEN], invoker: "public", cors: true, timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const userId = request.auth.uid;
    const userDoc = await db.collection("usuarios").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (!["vendedor", "coordinador", "superadmin"].includes(userData.rol)) {
      throw new HttpsError("permission-denied", "No tienes permiso para enviar ofertas.");
    }

    const { cursoId, alumnoIds, membresiaNombre, membresiaLink } = request.data || {};
    if (!cursoId || !Array.isArray(alumnoIds) || alumnoIds.length === 0) {
      throw new HttpsError("invalid-argument", "Faltan cursoId o alumnoIds.");
    }
    if (alumnoIds.length > 100) {
      throw new HttpsError("invalid-argument", "Máximo 100 alumnos por envío.");
    }

    const nombreMem = (membresiaNombre || "").trim();
    const linkMem = (membresiaLink || "").trim();
    if (!nombreMem) {
      throw new HttpsError("invalid-argument", "Falta el nombre de la membresía.");
    }
    if (!/^https?:\/\/.+\..+/.test(linkMem)) {
      throw new HttpsError("invalid-argument", "El link de la membresía no es válido. Debe empezar con https://");
    }

    const cursoDoc = await db.collection("cursos").doc(cursoId).get();
    if (!cursoDoc.exists) {
      throw new HttpsError("not-found", "Curso no encontrado.");
    }
    const curso = cursoDoc.data();

    if (userData.rol !== "superadmin" && curso.consultoraId !== userData.consultoraId) {
      throw new HttpsError("permission-denied", "No puedes enviar ofertas de cursos de otra consultora.");
    }

    // Guardar membresía en la consultora para precargar la próxima vez
    try {
      await db.collection("consultoras").doc(curso.consultoraId).update({
        membresiaNombre: nombreMem,
        membresiaLink: linkMem,
      });
    } catch (e) {
      console.warn("[WA-MEMBRESIA] No se pudo guardar membresía en consultora:", e.message);
    }

    const alumnosDocs = await Promise.all(
      alumnoIds.map(id => db.collection("alumnos").doc(id).get())
    );

    const watiCfg = await getWatiConfig(curso.consultoraId);
    // Plantilla efectiva: override de la consultora (watiConfigs/{id}.templateMembresia) o la global
    const templateMembresia = watiCfg.templateMembresia || WATI_TEMPLATE_MEMBRESIA;
    const resultados = { exitos: 0, fallos: 0, sinTelefono: 0, detalle: [] };

    for (const aDoc of alumnosDocs) {
      if (!aDoc.exists) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, ok: false, motivo: "Alumno no existe" });
        continue;
      }
      const alumno = aDoc.data();

      if (alumno.cursoId !== cursoId || (userData.rol !== "superadmin" && alumno.consultoraId !== userData.consultoraId)) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, ok: false, motivo: "No pertenece al curso/consultora" });
        continue;
      }

      const telWA = normalizarTelefonoWA(alumno.telefono);
      if (!telWA) {
        resultados.sinTelefono++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, ok: false, motivo: `Teléfono inválido: "${alumno.telefono || "(vacío)"}"` });
        continue;
      }

      const primerNombre = (alumno.nombre || "").trim().split(/\s+/)[0] || "Hola";

      try {
        const resp = await fetch(
          `${watiCfg.baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${telWA}`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${watiCfg.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...(watiCfg.channelNumber ? { channel_number: watiCfg.channelNumber } : {}),
              template_name: templateMembresia,
              broadcast_name: `ipci_membresia_${cursoId}_${Date.now()}`,
              parameters: [
                { name: "1", value: primerNombre },
                { name: "2", value: curso.nombre || "su curso" },
                { name: "3", value: nombreMem },
                { name: "4", value: linkMem },
              ],
            }),
          }
        );

        const respData = await resp.json().catch(() => ({}));
        const aceptado = resp.ok && (respData.result === true || respData.ok === true || respData.result === "success");

        if (aceptado) {
          resultados.exitos++;
          resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: true });
        } else {
          resultados.fallos++;
          const motivo = respData.info || respData.message || respData.error || `HTTP ${resp.status}`;
          resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: false, motivo });
          console.error(`[WA-MEMBRESIA] Fallo con ${telWA}:`, JSON.stringify(respData).slice(0, 300));
        }
      } catch (errSend) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: false, motivo: errSend.message });
        console.error(`[WA-MEMBRESIA] Error de red con ${telWA}:`, errSend.message);
      }

      await new Promise(r => setTimeout(r, 350));
    }

    console.log(`[WA-MEMBRESIA] Curso ${cursoId} por ${userData.email}: ${resultados.exitos} ok, ${resultados.fallos} fallos, ${resultados.sinTelefono} sin teléfono`);

    return {
      ok: true,
      totales: alumnoIds.length,
      exitos: resultados.exitos,
      fallos: resultados.fallos,
      sinTelefono: resultados.sinTelefono,
      detalle: resultados.detalle,
    };
  }
);
// ═══════════════════════════════════════════════════════════
// FIN Oferta de membresía
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// onCall: enviarInvitacionCurso — invita a un curso con descuento
// Plantilla WATI: invitacion_curso_v1 (Marketing)
// Variables: {{1}} nombre, {{2}} curso tomado, {{3}} curso nuevo, {{4}} descuento
// ═══════════════════════════════════════════════════════════
const WATI_TEMPLATE_INVITACION = "invitacion_curso_v1";

exports.enviarInvitacionCurso = onCall(
  { secrets: [WATI_API_TOKEN], invoker: "public", cors: true, timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const userId = request.auth.uid;
    const userDoc = await db.collection("usuarios").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (!["vendedor", "coordinador", "superadmin"].includes(userData.rol)) {
      throw new HttpsError("permission-denied", "No tienes permiso para enviar invitaciones.");
    }

    const { cursoId, alumnoIds, cursoPromoId, descuento } = request.data || {};
    if (!cursoId || !Array.isArray(alumnoIds) || alumnoIds.length === 0 || !cursoPromoId) {
      throw new HttpsError("invalid-argument", "Faltan cursoId, alumnoIds o cursoPromoId.");
    }
    if (alumnoIds.length > 100) {
      throw new HttpsError("invalid-argument", "Máximo 100 alumnos por envío.");
    }
    const descNum = parseInt(descuento, 10);
    if (isNaN(descNum) || descNum < 1 || descNum > 1000) {
      throw new HttpsError("invalid-argument", "El descuento debe ser un monto en pesos entre 1 y 1000.");
    }

    const [cursoDoc, cursoPromoDoc] = await Promise.all([
      db.collection("cursos").doc(cursoId).get(),
      db.collection("cursos").doc(cursoPromoId).get(),
    ]);
    if (!cursoDoc.exists) throw new HttpsError("not-found", "Curso original no encontrado.");
    if (!cursoPromoDoc.exists) throw new HttpsError("not-found", "Curso a promocionar no encontrado.");

    const curso = cursoDoc.data();
    const cursoPromo = cursoPromoDoc.data();

    if (userData.rol !== "superadmin") {
      if (curso.consultoraId !== userData.consultoraId || cursoPromo.consultoraId !== userData.consultoraId) {
        throw new HttpsError("permission-denied", "Los cursos deben ser de tu consultora.");
      }
    }

    const alumnosDocs = await Promise.all(
      alumnoIds.map(id => db.collection("alumnos").doc(id).get())
    );

    const watiCfg = await getWatiConfig(curso.consultoraId);
    // Plantilla efectiva: override de la consultora (watiConfigs/{id}.templateInvitacion) o la global
    const templateInvitacion = watiCfg.templateInvitacion || WATI_TEMPLATE_INVITACION;
    const resultados = { exitos: 0, fallos: 0, sinTelefono: 0, detalle: [] };

    for (const aDoc of alumnosDocs) {
      if (!aDoc.exists) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, ok: false, motivo: "Alumno no existe" });
        continue;
      }
      const alumno = aDoc.data();

      if (alumno.cursoId !== cursoId || (userData.rol !== "superadmin" && alumno.consultoraId !== userData.consultoraId)) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, ok: false, motivo: "No pertenece al curso/consultora" });
        continue;
      }

      const telWA = normalizarTelefonoWA(alumno.telefono);
      if (!telWA) {
        resultados.sinTelefono++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, ok: false, motivo: `Teléfono inválido: "${alumno.telefono || "(vacío)"}"` });
        continue;
      }

      const primerNombre = (alumno.nombre || "").trim().split(/\s+/)[0] || "Hola";

      try {
        const resp = await fetch(
          `${watiCfg.baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${telWA}`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${watiCfg.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...(watiCfg.channelNumber ? { channel_number: watiCfg.channelNumber } : {}),
              template_name: templateInvitacion,
              broadcast_name: `ipci_invitacion_${cursoPromoId}_${Date.now()}`,
              parameters: [
                { name: "1", value: primerNombre },
                { name: "2", value: curso.nombre || "su curso anterior" },
                { name: "3", value: cursoPromo.nombre || "nuestro nuevo curso" },
                { name: "4", value: `$${descNum} pesos` },
              ],
            }),
          }
        );

        const respData = await resp.json().catch(() => ({}));
        const aceptado = resp.ok && (respData.result === true || respData.ok === true || respData.result === "success");

        if (aceptado) {
          resultados.exitos++;
          resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: true });
        } else {
          resultados.fallos++;
          const motivo = respData.info || respData.message || respData.error || `HTTP ${resp.status}`;
          resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: false, motivo });
          console.error(`[WA-INVITACION] Fallo con ${telWA}:`, JSON.stringify(respData).slice(0, 300));
        }
      } catch (errSend) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: false, motivo: errSend.message });
        console.error(`[WA-INVITACION] Error de red con ${telWA}:`, errSend.message);
      }

      await new Promise(r => setTimeout(r, 350));
    }

    console.log(`[WA-INVITACION] Promo de ${cursoPromoId} ($${descNum} MXN) por ${userData.email}: ${resultados.exitos} ok, ${resultados.fallos} fallos, ${resultados.sinTelefono} sin teléfono`);

    return {
      ok: true,
      totales: alumnoIds.length,
      exitos: resultados.exitos,
      fallos: resultados.fallos,
      sinTelefono: resultados.sinTelefono,
      detalle: resultados.detalle,
    };
  }
);

// ═══════════════════════════════════════════════════════════
// onCall: enviarOfertaSoftware — oferta de software/SaaS
// Plantilla WATI: oferta_software_v1 (Marketing)
// Variables: {{1}} nombre, {{2}} software, {{3}} descripción, {{4}} link
// ═══════════════════════════════════════════════════════════
const WATI_TEMPLATE_SOFTWARE = "oferta_software_v1";

exports.enviarOfertaSoftware = onCall(
  { secrets: [WATI_API_TOKEN], invoker: "public", cors: true, timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const userId = request.auth.uid;
    const userDoc = await db.collection("usuarios").doc(userId).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (!["vendedor", "coordinador", "superadmin"].includes(userData.rol)) {
      throw new HttpsError("permission-denied", "No tienes permiso para enviar ofertas.");
    }

    const { cursoId, alumnoIds, softwareNombre, softwareDesc, softwareLink } = request.data || {};
    if (!cursoId || !Array.isArray(alumnoIds) || alumnoIds.length === 0) {
      throw new HttpsError("invalid-argument", "Faltan cursoId o alumnoIds.");
    }
    if (alumnoIds.length > 100) {
      throw new HttpsError("invalid-argument", "Máximo 100 alumnos por envío.");
    }

    const nombreSoft = (softwareNombre || "").trim();
    const descSoft = (softwareDesc || "").trim();
    const linkSoft = (softwareLink || "").trim();
    if (!nombreSoft) throw new HttpsError("invalid-argument", "Falta el nombre del software.");
    if (!descSoft) throw new HttpsError("invalid-argument", "Falta la descripción del software.");
    if (!/^https?:\/\/.+\..+/.test(linkSoft)) {
      throw new HttpsError("invalid-argument", "El link del software no es válido. Debe empezar con https://");
    }

    const cursoDoc = await db.collection("cursos").doc(cursoId).get();
    if (!cursoDoc.exists) throw new HttpsError("not-found", "Curso no encontrado.");
    const curso = cursoDoc.data();

    if (userData.rol !== "superadmin" && curso.consultoraId !== userData.consultoraId) {
      throw new HttpsError("permission-denied", "No puedes enviar ofertas de cursos de otra consultora.");
    }

    // Guardar el software en la consultora para precargar la próxima vez
    try {
      await db.collection("consultoras").doc(curso.consultoraId).update({
        softwareNombre: nombreSoft,
        softwareDesc: descSoft,
        softwareLink: linkSoft,
      });
    } catch (e) {
      console.warn("[WA-SOFTWARE] No se pudo guardar software en consultora:", e.message);
    }

    const alumnosDocs = await Promise.all(
      alumnoIds.map(id => db.collection("alumnos").doc(id).get())
    );

    const watiCfg = await getWatiConfig(curso.consultoraId);
    const resultados = { exitos: 0, fallos: 0, sinTelefono: 0, detalle: [] };

    for (const aDoc of alumnosDocs) {
      if (!aDoc.exists) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, ok: false, motivo: "Alumno no existe" });
        continue;
      }
      const alumno = aDoc.data();

      if (alumno.cursoId !== cursoId || (userData.rol !== "superadmin" && alumno.consultoraId !== userData.consultoraId)) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, ok: false, motivo: "No pertenece al curso/consultora" });
        continue;
      }

      const telWA = normalizarTelefonoWA(alumno.telefono);
      if (!telWA) {
        resultados.sinTelefono++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, ok: false, motivo: `Teléfono inválido: "${alumno.telefono || "(vacío)"}"` });
        continue;
      }

      const primerNombre = (alumno.nombre || "").trim().split(/\s+/)[0] || "Hola";

      try {
        const resp = await fetch(
          `${watiCfg.baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${telWA}`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${watiCfg.token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ...(watiCfg.channelNumber ? { channel_number: watiCfg.channelNumber } : {}),
              template_name: WATI_TEMPLATE_SOFTWARE,
              broadcast_name: `ipci_software_${cursoId}_${Date.now()}`,
              parameters: [
                { name: "1", value: primerNombre },
                { name: "2", value: nombreSoft },
                { name: "3", value: descSoft },
                { name: "4", value: linkSoft },
              ],
            }),
          }
        );

        const respData = await resp.json().catch(() => ({}));
        const aceptado = resp.ok && (respData.result === true || respData.ok === true || respData.result === "success");

        if (aceptado) {
          resultados.exitos++;
          resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: true });
        } else {
          resultados.fallos++;
          const motivo = respData.info || respData.message || respData.error || `HTTP ${resp.status}`;
          resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: false, motivo });
          console.error(`[WA-SOFTWARE] Fallo con ${telWA}:`, JSON.stringify(respData).slice(0, 300));
        }
      } catch (errSend) {
        resultados.fallos++;
        resultados.detalle.push({ id: aDoc.id, nombre: alumno.nombre, tel: telWA, ok: false, motivo: errSend.message });
        console.error(`[WA-SOFTWARE] Error de red con ${telWA}:`, errSend.message);
      }

      await new Promise(r => setTimeout(r, 350));
    }

    console.log(`[WA-SOFTWARE] ${nombreSoft} por ${userData.email}: ${resultados.exitos} ok, ${resultados.fallos} fallos, ${resultados.sinTelefono} sin teléfono`);

    return {
      ok: true,
      totales: alumnoIds.length,
      exitos: resultados.exitos,
      fallos: resultados.fallos,
      sinTelefono: resultados.sinTelefono,
      detalle: resultados.detalle,
    };
  }
);
// ═══════════════════════════════════════════════════════════
// FIN Invitación a curso + Oferta de software
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// TRIGGER: vigilarMinimoAlumnos — detector server-side del mínimo
// Se dispara con cada alta/edición/borrado de alumno. Si el curso
// cruza su mínimo de inscritos, notifica al ponente por email y
// por WhatsApp (piloto) SIN depender de que ningún panel esté abierto.
// Anti-duplicado: marca minimoNotificado en el curso y se re-arma
// cuando el conteo vuelve a caer por debajo del mínimo.
// ═══════════════════════════════════════════════════════════
exports.vigilarMinimoAlumnos = onDocumentWritten(
  {
    document: "alumnos/{alumnoId}",
    secrets: [RESEND_API_KEY, WATI_API_TOKEN],
  },
  async (event) => {
    // Datos del alumno después del cambio (o antes, si fue borrado)
    const despues = event.data?.after?.exists ? event.data.after.data() : null;
    const antes = event.data?.before?.exists ? event.data.before.data() : null;
    const alumno = despues || antes;
    if (!alumno || !alumno.cursoId) return;

    // La migración histórica no debe disparar notificaciones
    if (alumno.registradoPor === "MIGRACION_HISTORICA") return;

    const cursoId = alumno.cursoId;

    try {
      const cursoDoc = await db.collection("cursos").doc(cursoId).get();
      if (!cursoDoc.exists) return;
      const curso = cursoDoc.data();
      if (curso.activo === false) return;

      const minimo = curso.minimoAlumnos || 8;

      // Conteo de inscritos pendientes (misma lógica que el panel del coordinador):
      // sin certificado emitido Y apertura sin asignar o de hoy en adelante
      const hoyMX = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
      const alumnosSnap = await db.collection("alumnos")
        .where("cursoId", "==", cursoId)
        .get();
      const inscritos = alumnosSnap.docs.filter(d => {
        const a = d.data();
        if (a.estado === "email_enviado") return false;
        const ak = a.aperturaKey || "sin-asignar";
        return ak === "sin-asignar" || ak >= hoyMX;
      }).length;

      const yaNotificado = curso.minimoNotificado === true;

      // ── Re-armar el detector cuando el ciclo se vació ──
      if (inscritos < minimo) {
        if (yaNotificado) {
          await db.collection("cursos").doc(cursoId).update({ minimoNotificado: false });
          console.log(`[VIGILAR-MINIMO] Curso ${cursoId} bajó de mínimo (${inscritos}/${minimo}) → detector re-armado`);
        }
        return;
      }

      // ── Cruzó el mínimo y aún no se ha notificado este ciclo ──
      if (yaNotificado) return; // fast-path: ya avisado

      // Claim ATÓMICO con transacción: si varios alumnos entran a la vez y
      // disparan ejecuciones paralelas, solo UNA gana el derecho a notificar.
      const cursoRef = db.collection("cursos").doc(cursoId);
      const ganoElClaim = await db.runTransaction(async (tx) => {
        const snap = await tx.get(cursoRef);
        if (!snap.exists) return false;
        if (snap.data().minimoNotificado === true) return false; // otra ejecución ya ganó
        tx.update(cursoRef, {
          minimoNotificado: true,
          minimoNotificadoEn: admin.firestore.FieldValue.serverTimestamp(),
        });
        return true;
      });
      if (!ganoElClaim) {
        console.log(`[VIGILAR-MINIMO] Curso ${cursoId}: otra ejecución concurrente ya notificó, se omite duplicado`);
        return;
      }

      console.log(`[VIGILAR-MINIMO] 🎉 Curso ${cursoId} "${curso.nombre}" alcanzó ${inscritos}/${minimo}. Notificando al ponente...`);

      // ── 1) Email al ponente ──
      let emailOk = false;
      if (curso.emailPonente && curso.emailPonente.includes("@")) {
        try {
          const resend = new Resend(RESEND_API_KEY.value());
          const consultoraDoc = await db.collection("consultoras").doc(curso.consultoraId).get();
          const consultora = consultoraDoc.exists ? consultoraDoc.data() : {};

          const html = generarHtmlAvisoPonente({
            ponente: curso.ponente || "Ponente",
            curso: curso.nombre || "Curso",
            modalidad: curso.modalidad || "En línea",
            duracion: curso.duracion || "",
            inscritos,
            fechaInicio: (() => {
              const aksMail = alumnosSnap.docs.map(d => d.data())
                .filter(a => a.estado !== "email_enviado" && a.aperturaKey && a.aperturaKey >= hoyMX)
                .map(a => a.aperturaKey).sort();
              if (aksMail.length === 0) return "Por confirmar — su coordinador programará la fecha en breve";
              let t = formatearFechaConDia(aksMail[0]);
              if (curso.horaInicioCurso) t += ` a las ${formatearHora12(curso.horaInicioCurso)}`;
              return t;
            })(),
            sesiones: [],
            patronSemanal: [],
            semanas: 0,
            consultora: consultora.nombre || "IPCI",
            coordinadorNombre: "Coordinación",
            coordinadorEmail: REPLY_TO,
            whatsappLink: curso.whatsappLink || "",
            whatsappHora1: curso.whatsappHora1 || "08:00",
            whatsappHora2: curso.whatsappHora2 || "17:00",
          });

          await resend.emails.send({
            from: FROM_EMAIL,
            to: curso.emailPonente,
            reply_to: REPLY_TO,
            subject: `🎉 ¡Su grupo se completó! · ${curso.nombre}`,
            html,
          });
          emailOk = true;
          console.log(`[VIGILAR-MINIMO] ✓ Email al ponente ${curso.emailPonente}`);
        } catch (eMail) {
          console.error(`[VIGILAR-MINIMO] ✗ Email al ponente falló:`, eMail.message);
        }
      } else {
        console.log(`[VIGILAR-MINIMO] Curso sin emailPonente, se omite email`);
      }

      // ── 2) WhatsApp al ponente (PILOTO por consultora) ──
      const PONENTE_WA_CONSULTORAS = [
        "oDXSSwQDt7f2kOJfmkkC", // Dermalysse (piloto)
      ];
      const telPonente = normalizarTelefonoWA(curso.telefonoPonente);
      if (PONENTE_WA_CONSULTORAS.includes(curso.consultoraId) && telPonente) {
        try {
          const watiCfg = await getWatiConfig(curso.consultoraId);
          // Fecha de inicio programada: la apertura futura más próxima de los alumnos pendientes
          let fechaInicioTxt = "por confirmar";
          const aks = alumnosSnap.docs
            .map(d => d.data())
            .filter(a => a.estado !== "email_enviado" && a.aperturaKey && a.aperturaKey >= hoyMX)
            .map(a => a.aperturaKey)
            .sort();
          if (aks.length > 0) fechaInicioTxt = formatearFechaConDia(aks[0]);
          // Agregar la hora de inicio si el coordinador la configuró en el curso
          if (curso.horaInicioCurso && fechaInicioTxt !== "por confirmar") {
            fechaInicioTxt += ` a las ${formatearHora12(curso.horaInicioCurso)}`;
          }

          const respWA = await fetch(
            `${watiCfg.baseUrl}/api/v1/sendTemplateMessage?whatsappNumber=${telPonente}`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${watiCfg.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                ...(watiCfg.channelNumber ? { channel_number: watiCfg.channelNumber } : {}),
                template_name: "apertura_ponente_v2",
                broadcast_name: `ipci_minimo_ponente_${cursoId}_${Date.now()}`,
                parameters: [
                  { name: "1", value: (curso.ponente || "Ponente").trim() },
                  { name: "2", value: curso.nombre || "su curso" },
                  { name: "3", value: fechaInicioTxt },
                  { name: "4", value: resolverLinkGrupo(curso, aks[0] || null) || "Su coordinador se lo compartirá en breve" },
                ],
              }),
            }
          );
          const waData = await respWA.json().catch(() => ({}));
          const waOk = respWA.ok && (waData.result === true || waData.ok === true || waData.result === "success");
          if (waOk) {
            console.log(`[VIGILAR-MINIMO] ✓ WhatsApp al ponente ${telPonente}`);
          } else {
            console.error(`[VIGILAR-MINIMO] ✗ WhatsApp al ponente falló:`, JSON.stringify(waData).slice(0, 300));
          }
        } catch (eWA) {
          console.error(`[VIGILAR-MINIMO] ✗ Error de red WhatsApp ponente:`, eWA.message);
        }
      } else {
        console.log(`[VIGILAR-MINIMO] WhatsApp omitido (piloto=${PONENTE_WA_CONSULTORAS.includes(curso.consultoraId)}, tel=${telPonente || "inválido"})`);
      }
    } catch (err) {
      console.error(`[VIGILAR-MINIMO] Error general:`, err.message);
    }
  }
);
// ═══════════════════════════════════════════════════════════
// FIN vigilarMinimoAlumnos
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// onCall: guardarLinkApertura — guarda el link del grupo por fecha
// Lo llama el vendedor al pegar el link en el modal (sin enviar nada).
// Así el aviso al ponente (al completar mínimo) ya tiene el link correcto.
// ═══════════════════════════════════════════════════════════
exports.guardarLinkApertura = onCall(
  { invoker: "public", cors: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }
    const userDoc = await db.collection("usuarios").doc(request.auth.uid).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (!["vendedor", "coordinador", "superadmin"].includes(userData.rol)) {
      throw new HttpsError("permission-denied", "Sin permiso.");
    }

    const { cursoId, aperturaKey, whatsappLink } = request.data || {};
    const link = (whatsappLink || "").trim();
    if (!cursoId || !link) {
      throw new HttpsError("invalid-argument", "Faltan cursoId o whatsappLink.");
    }
    if (!/^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]+/.test(link)) {
      throw new HttpsError("invalid-argument", "Link inválido. Debe ser tipo https://chat.whatsapp.com/XXXX");
    }

    const cursoDoc = await db.collection("cursos").doc(cursoId).get();
    if (!cursoDoc.exists) throw new HttpsError("not-found", "Curso no encontrado.");
    const curso = cursoDoc.data();
    if (userData.rol !== "superadmin" && curso.consultoraId !== userData.consultoraId) {
      throw new HttpsError("permission-denied", "El curso no es de tu consultora.");
    }

    const updates = { whatsappLink: link };
    if (/^\d{4}-\d{2}-\d{2}$/.test(aperturaKey || "")) {
      updates[`whatsappLinks.${aperturaKey}`] = link;
    }
    await db.collection("cursos").doc(cursoId).update(updates);
    console.log(`[LINK-APERTURA] Curso ${cursoId} · ${aperturaKey || "(global)"} → guardado por ${userData.email}`);
    return { ok: true };
  }
);
// ═══════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════
// analizarCursosIA — Diagnóstico de cursos con IA (coordinador/admin)
// ───────────────────────────────────────────────────────────
// Corre SOLO cuando el usuario presiona "Actualizar análisis".
// Lee cursos + alumnos de la consultora, arma métricas (SIN dinero
// recaudado ni comisiones) y le pide a Claude un diagnóstico +
// recomendaciones. Guarda el resultado en analisisIA/{consultoraId}.
// El coordinador NUNCA ve ingresos: solo decisiones. El precio SÍ se
// usa para recomendar subir/bajar.
// ═══════════════════════════════════════════════════════════
// Modelos Sonnet a intentar en orden: se usa el PRIMERO que tu cuenta acepte.
// Si ya sabes cuál funciona, deja solo ese en la lista.
const IA_MODELOS = [
  "claude-sonnet-4-5",
  "claude-sonnet-5",
  "claude-3-7-sonnet-latest",
  "claude-3-5-sonnet-latest",
];

exports.analizarCursosIA = onCall(
  { secrets: [ANTHROPIC_API_KEY], invoker: "public", cors: true, timeoutSeconds: 300 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Debes iniciar sesión.");
    }

    const userDoc = await db.collection("usuarios").doc(request.auth.uid).get();
    if (!userDoc.exists) {
      throw new HttpsError("permission-denied", "Usuario no registrado.");
    }
    const userData = userDoc.data();
    if (!["coordinador", "superadmin"].includes(userData.rol)) {
      throw new HttpsError("permission-denied", "Solo coordinadores y admins pueden generar el análisis.");
    }

    // Consultora a analizar: el coordinador siempre la suya; el superadmin puede pasar una.
    let consultoraId = userData.consultoraId || null;
    if (userData.rol === "superadmin" && request.data && request.data.consultoraId) {
      consultoraId = request.data.consultoraId;
    }
    if (!consultoraId) {
      throw new HttpsError("invalid-argument", "No se pudo determinar la consultora a analizar.");
    }

    // ── Candado: 1 análisis por semana por consultora (superadmin sin límite) ──
    // Si aún no pasa la semana, se regresa el ÚLTIMO análisis guardado (no se borra nada).
    if (userData.rol === "coordinador") {
      const cachePrevio = await db.collection("analisisIA").doc(consultoraId).get();
      if (cachePrevio.exists) {
        const prev = cachePrevio.data();
        const prevMs = prev._ts && prev._ts.toMillis
          ? prev._ts.toMillis()
          : (prev.generadoEn ? new Date(prev.generadoEn).getTime() : 0);
        const SEMANA_MS = 7 * 864e5;
        if (prevMs && Date.now() - prevMs < SEMANA_MS) {
          const disponible = new Date(prevMs + SEMANA_MS).toLocaleDateString("es-MX", {
            weekday: "long", day: "numeric", month: "long", timeZone: "America/Mexico_City",
          });
          const { _ts, generadoPor, ...limpio } = prev;
          console.log(`[IA] Consultora ${consultoraId}: análisis semanal ya usado, devolviendo cache`);
          return { ...limpio, desdeCache: true, bloqueadoHasta: disponible };
        }
      }
    }

    // ── Datos de la consultora ──
    const [cursosSnap, alumnosSnap] = await Promise.all([
      db.collection("cursos").where("consultoraId", "==", consultoraId).get(),
      db.collection("alumnos").where("consultoraId", "==", consultoraId).get(),
    ]);
    const cursos = cursosSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const alumnos = alumnosSnap.docs.map((d) => d.data());

    if (cursos.length === 0) {
      const vacio = {
        generadoEn: new Date().toISOString(),
        resumen: "Aún no hay cursos registrados en esta consultora para analizar.",
        pronosticos: [],
        oportunidades: [],
        pendienteAdmin: null,
      };
      await db.collection("analisisIA").doc(consultoraId).set({
        ...vacio,
        _ts: admin.firestore.FieldValue.serverTimestamp(),
        generadoPor: userData.email || request.auth.uid,
      });
      return vacio;
    }

    // ── Métricas por curso (SIN dinero recaudado / comisiones) ──
    const hoyMX = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
    const now = Date.now();
    const d30 = now - 30 * 864e5;
    const d90 = now - 90 * 864e5;

    const porCurso = new Map();
    alumnos.forEach((a) => {
      const arr = porCurso.get(a.cursoId) || [];
      arr.push(a);
      porCurso.set(a.cursoId, arr);
    });

    const MADURO_DIAS = 45; // un alumno con 45+ días ya debería tener certificado
    const corteMaduroMs = now - MADURO_DIAS * 864e5;

    const cursosResumen = cursos.map((c) => {
      const al = porCurso.get(c.id) || [];
      const total = al.length;
      const certificados = al.filter((a) => a.estado === "email_enviado").length;
      const insc30 = al.filter((a) => (a.creadoEn && a.creadoEn.toMillis ? a.creadoEn.toMillis() : 0) >= d30).length;
      const insc90 = al.filter((a) => (a.creadoEn && a.creadoEn.toMillis ? a.creadoEn.toMillis() : 0) >= d90).length;
      const inscritosActivos = al.filter((a) => {
        if (a.estado === "email_enviado") return false;
        const ak = a.aperturaKey || "sin-asignar";
        return ak === "sin-asignar" || ak >= hoyMX;
      }).length;
      const aperturas = new Set(al.map((a) => a.aperturaKey).filter((ak) => ak && ak !== "sin-asignar")).size;

      // Conversión MADURA: solo alumnos con 45+ días (los recientes aún no deben certificado)
      const maduros = al.filter((a) => {
        const t = a.creadoEn && a.creadoEn.toMillis ? a.creadoEn.toMillis() : 0;
        return t > 0 && t <= corteMaduroMs;
      });
      const madurosCert = maduros.filter((a) => a.estado === "email_enviado").length;
      const conversionMaduraPct = maduros.length > 0 ? Math.round((madurosCert / maduros.length) * 100) : null;
      // Certificados atrasados = maduros que siguen sin certificado (pendiente ADMINISTRATIVO)
      const certificadosAtrasados = maduros.length - madurosCert;

      return {
        curso: c.nombre,
        activo: c.activo !== false,
        precio: Number(c.precio) || 0,
        minimoAlumnos: c.minimoAlumnos || 8,
        frecuenciaDiasApertura: c.frecuenciaDiasApertura || 15,
        totalInscritosHistorico: total,
        certificadosEmitidos: certificados,
        inscritosUltimos30d: insc30,
        inscritosUltimos90d: insc90,
        inscritosActivosHaciaApertura: inscritosActivos,
        gruposAperturadosAprox: aperturas,
        alumnosMaduros45d: maduros.length,
        conversionMaduraPct,
        certificadosAtrasados,
        ponente: c.ponente || null,
      };
    });

    // ── Prompt ──
    const SYSTEM_PROMPT = [
      "Eres el ESTRATEGA DE LANZAMIENTOS de una consultora que vende cursos de certificación profesional en México.",
      "Tu lector es el COORDINADOR. Los cursos se relanzan en ciclos de ~15 días. Sé directo, concluyente, español mexicano.",
      "",
      "TU TRABAJO (mirando HACIA ADELANTE, no hacia atrás):",
      "1) PRONÓSTICO: para los cursos activos con más movimiento (máximo 8), predice si van a jalar en el PRÓXIMO relanzamiento.",
      "   - Veredicto exacto: 'Va a jalar' | 'Riesgo' | 'Mejor pausarlo'.",
      "   - El 'porque' combina: cifras internas (inscritos 30/90d, tendencia, grupos) + una señal REAL de mercado/temporada que investigues en internet (demanda del tema, estacionalidad, fechas clave del sector).",
      "2) OPORTUNIDADES: entre 8 y 12 temas NUEVOS que el mercado está pidiendo o que vienen por temporada — cursos que la consultora NO tiene, o DIPLOMADOS que puede armar empaquetando cursos que ya tiene.",
      "   - Cubre variedad: tendencias tecnológicas del sector, lo que viene por temporada en los próximos 2-3 meses, nichos con demanda y poca oferta, y 2-4 diplomados armados con cursos existentes.",
      "   - Cada una: titulo atractivo y vendible, tipo ('Curso' o 'Diplomado'), cuando lanzarla (ej. 'ya, para el ciclo del [fecha]' o 'octubre, por [temporada]'), y porque con la señal de mercado. Si es Diplomado, di qué cursos existentes lo alimentan.",
      "",
      "USA LA BÚSQUEDA WEB (hasta 5 búsquedas) para tendencias actuales, estacionalidad y demanda del sector en México/Latinoamérica. Infiere el sector por los nombres de los cursos. Piensa en temporadas: ciclos escolares, cosechas, normativas nuevas, congresos, fechas del sector.",
      "",
      "REGLAS ESTRICTAS:",
      "- NUNCA menciones ingresos, ganancias, dinero recaudado ni comisiones. El precio sí puedes usarlo.",
      "- NO repitas diagnóstico de 'cuál funciona y cuál no' — el coordinador ya lo ve en su dashboard. Todo debe ser hacia adelante.",
      "- NO hables de certificados ni de su envío (el sistema lo maneja aparte).",
      "- conversionMaduraPct es dato secundario de calidad (solo alumnos 45+ días). certificadosAtrasados ignóralo.",
      "- Cada afirmación con cifras internas exactas y/o señal de mercado concreta. Cero relleno y cero contradicciones.",
      "",
      "Responde ÚNICAMENTE este JSON, sin markdown ni texto fuera:",
      '{',
      '  "resumen": "2-3 frases del panorama para el próximo ciclo",',
      '  "pronosticos": [ { "curso": "nombre exacto", "veredicto": "Va a jalar | Riesgo | Mejor pausarlo", "porque": "cifras internas + señal de mercado/temporada" } ],',
      '  "oportunidades": [ { "titulo": "nombre vendible", "tipo": "Curso | Diplomado", "cuando": "cuándo lanzarla y por qué ese momento", "porque": "tendencia/temporada/demanda que lo respalda (y qué cursos existentes lo alimentan si es Diplomado)" } ]',
      '}',
      "",
      "LÍMITES: pronosticos máx 8 · oportunidades entre 8 y 12 (todas con su porque y su cuando; no relleno). Usa EXACTAMENTE los nombres de curso que se te dan.",
    ].join("\n");

    const hoyTxt = new Date().toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric", timeZone: "America/Mexico_City" });
    const proxCiclo = new Date(Date.now() + 15 * 864e5).toLocaleDateString("es-MX", { day: "numeric", month: "long", timeZone: "America/Mexico_City" });
    const userContent =
      `Hoy es ${hoyTxt}. Los cursos se relanzan en ciclos de ~15 días: el próximo ciclo arranca alrededor del ${proxCiclo}. ` +
      "Infiere el sector de la consultora por los nombres de los cursos. " +
      "Métricas internas (sin datos de dinero recaudado):\n\n" +
      JSON.stringify(cursosResumen, null, 2) +
      "\n\nInvestiga en internet la demanda, tendencias y temporadas ACTUALES del sector, y devuelve el JSON pedido.";

    // ── Llamada a Claude (modelos en orden; intenta con búsqueda web y cae a sin-tools) ──
    const llamarClaude = (modelo, conTools) => {
      const body = {
        model: modelo,
        max_tokens: 4500,
        temperature: 0.4,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      };
      if (conTools) {
        body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }];
      }
      return fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });
    };

    let text = "";
    let modeloUsado = "";
    let ultimoError = "";
    for (const modelo of IA_MODELOS) {
      try {
        let resp = await llamarClaude(modelo, true);
        let errTxt = "";
        if (!resp.ok) {
          errTxt = await resp.text();
          // Si el problema es la herramienta de búsqueda, reintenta el mismo modelo sin tools
          if (resp.status === 400 && /tool|web_search/i.test(errTxt)) {
            console.warn(`[IA] ${modelo}: web_search no disponible, reintentando sin herramientas`);
            resp = await llamarClaude(modelo, false);
            errTxt = resp.ok ? "" : await resp.text();
          }
        }

        if (resp.ok) {
          const data = await resp.json();
          text = (data.content || [])
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
            .trim();
          modeloUsado = modelo;
          break;
        }

        ultimoError = `(${resp.status}) ${errTxt.slice(0, 300)}`;
        console.error(`[IA] Modelo ${modelo} → ${ultimoError}`);

        if (resp.status === 401 || resp.status === 403) {
          throw new HttpsError(
            "failed-precondition",
            `Anthropic rechazó la API key (${resp.status}). Revisa el secret ANTHROPIC_API_KEY.`
          );
        }
        const esProblemaDeModelo = resp.status === 404 || /model/i.test(errTxt);
        if (!esProblemaDeModelo) {
          throw new HttpsError("internal", `Anthropic respondió: ${ultimoError}`);
        }
      } catch (err) {
        if (err instanceof HttpsError) throw err;
        ultimoError = String(err && err.message ? err.message : err);
        console.error(`[IA] Error de red con modelo ${modelo}:`, err);
      }
    }

    if (!text) {
      throw new HttpsError(
        "internal",
        `No se pudo generar el análisis. Detalle: ${ultimoError || "sin respuesta de la IA"}`
      );
    }

    // ── Parseo defensivo del JSON ──
    let parsed;
    try {
      let clean = text.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```$/, "").trim();
      parsed = JSON.parse(clean);
    } catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch (_) { parsed = null; }
      }
      if (!parsed) {
        console.error("[IA] JSON inválido:", text.slice(0, 500));
        throw new HttpsError("internal", "La IA no devolvió un JSON válido. Intenta de nuevo.");
      }
    }

    const arrOf = (x) => (Array.isArray(x) ? x : []);
    const resultado = {
      generadoEn: new Date().toISOString(),
      resumen: typeof parsed.resumen === "string" ? parsed.resumen : "",
      pronosticos: arrOf(parsed.pronosticos)
        .filter((r) => r && r.curso)
        .slice(0, 10)
        .map((r) => ({
          curso: String(r.curso || ""),
          veredicto: String(r.veredicto || ""),
          porque: String(r.porque || ""),
        })),
      oportunidades: arrOf(parsed.oportunidades)
        .filter((r) => r && (r.titulo || r.curso))
        .slice(0, 14)
        .map((r) => ({
          titulo: String(r.titulo || r.curso || ""),
          tipo: String(r.tipo || "Curso"),
          cuando: String(r.cuando || ""),
          porque: String(r.porque || ""),
        })),
      pendienteAdmin: null,
    };

    // Pendiente administrativo: certificados atrasados (datos reales, NO de la IA)
    const atrasadosTotal = cursosResumen.reduce((s, c) => s + (c.certificadosAtrasados || 0), 0);
    if (atrasadosTotal > 0) {
      const topAtrasados = cursosResumen
        .filter((c) => c.certificadosAtrasados > 0)
        .sort((a, b) => b.certificadosAtrasados - a.certificadosAtrasados)
        .slice(0, 3)
        .map((c) => `${c.curso} (${c.certificadosAtrasados})`)
        .join(", ");
      resultado.pendienteAdmin = `${atrasadosTotal} alumno${atrasadosTotal === 1 ? "" : "s"} con más de 45 días siguen sin certificado. Donde más urge: ${topAtrasados}. Es pendiente administrativo, no falla de los cursos.`;
    }

    // ── Guardar en cache (analisisIA/{consultoraId}) y devolver ──
    await db.collection("analisisIA").doc(consultoraId).set({
      ...resultado,
      _ts: admin.firestore.FieldValue.serverTimestamp(),
      _modelo: modeloUsado,
      generadoPor: userData.email || request.auth.uid,
    });

    console.log(`[IA] Análisis generado para consultora ${consultoraId} por ${userData.email || request.auth.uid} · ${cursos.length} cursos · modelo ${modeloUsado}`);
    return resultado;
  }
);
// ═══════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════
// 🆕 FASE D — AVISOS DE VENCIMIENTO (recertificación anual)
// Cron diario: detecta certificados que vencen en ~30 días y
// avisa al alumno por email para ofrecerle la renovación.
//
// ⚠ MODO PRUEBA: con true SOLO escribe en los logs lo que
//   enviaría (a quién, qué curso, cuándo vence) SIN mandar
//   nada ni marcar nada. Revisa los logs 1-2 días, aprueba
//   el texto, cámbialo a false y redeploya para activar.
// ═══════════════════════════════════════════════════════════
const AVISOS_VENCIMIENTO_MODO_PRUEBA = true;

function htmlAvisoVencimiento({ nombre, curso, folio, consultora, fechaVence }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f7fb;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:28px 16px">
    <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden">
      <div style="background:#0b4ea2;color:#ffffff;padding:22px 26px">
        <div style="font-size:18px;font-weight:800">IPCI · Tu certificación está por vencer</div>
        <div style="font-size:12px;opacity:.85;margin-top:4px">Instituto Profesional de Certificación Industrial Latinoamericano</div>
      </div>
      <div style="padding:26px;color:#16324f;font-size:14px;line-height:1.7">
        <p style="margin:0 0 14px">Hola <b>${nombre}</b>,</p>
        <p style="margin:0 0 14px">Tu certificación <b>"${curso}"</b>, emitida por <b>${consultora}</b> bajo el aval del Instituto IPCI, <b>vence el ${fechaVence}</b>.</p>
        <div style="background:#faf6ea;border:1px solid #e8dcb8;border-radius:10px;padding:14px 18px;margin:0 0 16px;font-size:13px;color:#7a6120">
          Folio institucional: <b>${folio}</b><br>
          Al vencer, tu credencial pasará a estado "vencida" en el Padrón Público IPCI.
        </div>
        <p style="margin:0 0 14px"><b>Renueva tu certificación</b> y mantén tu credencial vigente ante empleadores y colegas: responde este correo o contacta directamente a ${consultora} para conocer las opciones de recertificación disponibles.</p>
        <p style="margin:0 0 6px;font-size:12.5px;color:#64748b">Consulta tu certificado en cualquier momento:</p>
        <p style="margin:0"><a href="https://ipcil.org/panel/validar.html?folio=${encodeURIComponent(folio)}" style="color:#0b4ea2;font-weight:700">Verificar mi certificado</a> · <a href="https://ipcil.org/padron.html?folio=${encodeURIComponent(folio)}" style="color:#0b4ea2;font-weight:700">Ver mi expediente en el Padrón</a></p>
      </div>
      <div style="border-top:1px solid #eef2f7;padding:16px 26px;font-size:11px;color:#94a3b8">
        IPCI · Certificación privada profesional verificable · ipcil.org
      </div>
    </div>
  </div></body></html>`;
}

exports.avisosVencimiento = onSchedule(
  {
    schedule: "30 9 * * *",
    timeZone: "America/Mexico_City",
    secrets: [RESEND_API_KEY],
    memory: "256MiB",
    timeoutSeconds: 300,
  },
  async () => {
    const D = 864e5;
    const ahora = Date.now();
    // Ventana: emitidos hace 330-336 días → vencen en 29-35 días.
    // (7 días de colchón por si algún día no corre el cron; el flag evita duplicados)
    const desde = admin.firestore.Timestamp.fromMillis(ahora - 336 * D);
    const hasta = admin.firestore.Timestamp.fromMillis(ahora - 330 * D);

    const snap = await db.collection("certificados")
      .where("creadoEn", ">=", desde)
      .where("creadoEn", "<=", hasta)
      .get();

    const pendientes = snap.docs.filter((d) => !d.data().avisoVencimientoEnviado);
    console.log(`[AVISOS] Ventana 330-336 días: ${snap.size} certificados, ${pendientes.length} sin aviso.${AVISOS_VENCIMIENTO_MODO_PRUEBA ? " (MODO PRUEBA: no se envía nada)" : ""}`);

    if (!pendientes.length) return;
    const resend = AVISOS_VENCIMIENTO_MODO_PRUEBA ? null : new Resend(RESEND_API_KEY.value());
    let enviados = 0, sinEmail = 0, errores = 0;

    for (const docu of pendientes) {
      const cert = docu.data();
      try {
        // Email del alumno: cruce por certificadoId
        const alSnap = await db.collection("alumnos")
          .where("certificadoId", "==", docu.id).limit(1).get();
        const alumno = alSnap.empty ? null : alSnap.docs[0].data();
        const email = alumno?.email;
        if (!email) { sinEmail++; console.log(`[AVISOS] Sin email: ${cert.folio || docu.id}`); continue; }

        const venc = (cert.creadoEn?.toMillis?.() || 0) + 365 * D;
        const fechaVence = new Date(venc).toLocaleDateString("es-MX", {
          day: "numeric", month: "long", year: "numeric", timeZone: "America/Mexico_City",
        });

        if (AVISOS_VENCIMIENTO_MODO_PRUEBA) {
          console.log(`[AVISOS][PRUEBA] Enviaría a ${email} · ${cert.nombreAlumno || "?"} · "${cert.nombreCurso || "?"}" · folio ${cert.folio || "?"} · vence ${fechaVence}`);
          continue; // en prueba NO se marca ni se envía
        }

        await enviarEmailSeguro(resend, {
          from: FROM_EMAIL,
          to: email,
          reply_to: REPLY_TO,
          subject: `Tu certificación IPCI vence el ${fechaVence} — renuévala a tiempo`,
          html: htmlAvisoVencimiento({
            nombre: cert.nombreAlumno || alumno.nombre || "Profesional",
            curso: cert.nombreCurso || "tu curso",
            folio: cert.folio || "",
            consultora: cert.nombreConsultora || "tu consultora",
            fechaVence,
          }),
        }, { contexto: `aviso-venc-${cert.folio || docu.id}` });

        await docu.ref.update({
          avisoVencimientoEnviado: admin.firestore.FieldValue.serverTimestamp(),
          avisoVencimientoDias: 30,
        });
        enviados++;
      } catch (err) {
        errores++;
        console.error(`[AVISOS] Error con ${cert.folio || docu.id}:`, err.message);
      }
    }
    console.log(`[AVISOS] Resumen: ${enviados} enviados, ${sinEmail} sin email, ${errores} errores.`);
  }
);
