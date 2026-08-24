// ═══════════════════════════════════════════════════════════
//  ALTA EXPRESS DE EMPRESA ALIADA — Programa Aliado Certificador IPCI
//
//  Crea el espacio completo de una empresa externa en la plataforma:
//  su consultora (con código de folio propio), su coordinador y
//  sus vendedores. Aislada de todas las demás por las reglas.
//
//  Uso (PowerShell, en C:\Users\user\ipci-backend\functions):
//    $env:GOOGLE_APPLICATION_CREDENTIALS = ".\serviceAccountKey.json"
//    node alta-aliado.js "Nombre de la Empresa" CODIGO coord@empresa.com "ClaveCoord.123" "Nombre del Coordinador" ["vend@empresa.com|Clave.V1|Nombre Vendedor"] [...]
//
//  Ejemplo:
//    node alta-aliado.js "Academia Dental del Norte" ADNO direccion@adnorte.mx "Adno.2026!" "Dra. Sofia Ruiz" "ventas@adnorte.mx|Adno.Ventas1|Juan Perez"
//
//  · CODIGO: 3-6 letras mayúsculas, único (será el prefijo del folio:
//    IPCI-ADNO-2026-0001). NO se puede cambiar después sin romper folios.
//  · Los vendedores son opcionales (0 o más), formato email|clave|nombre.
// ═══════════════════════════════════════════════════════════
const admin = require("firebase-admin");

admin.initializeApp({ projectId: "ipci-certificados" });
const db = admin.firestore();
const auth = admin.auth();

const [nombre, codigoRaw, coordEmail, coordPass, coordNombre, ...vendArgs] = process.argv.slice(2);

async function main() {
  // ── Validaciones ──
  if (!nombre || !codigoRaw || !coordEmail || !coordPass || !coordNombre) {
    console.error("❌ Faltan argumentos.\nUso: node alta-aliado.js \"Empresa\" CODIGO coord@email \"Clave\" \"Nombre Coordinador\" [\"vend@email|Clave|Nombre\"] ...");
    process.exit(1);
  }
  const codigo = codigoRaw.toUpperCase().trim();
  if (!/^[A-Z]{3,6}$/.test(codigo)) {
    console.error(`❌ CODIGO inválido: "${codigo}". Debe ser 3-6 letras (A-Z), sin números ni espacios.`);
    process.exit(1);
  }
  if (coordPass.length < 8) {
    console.error("❌ La clave del coordinador debe tener al menos 8 caracteres.");
    process.exit(1);
  }

  const vendedores = vendArgs.map((v, i) => {
    const [email, pass, nom] = v.split("|").map(s => (s || "").trim());
    if (!email || !pass || !nom || pass.length < 8) {
      console.error(`❌ Vendedor #${i + 1} mal formado: "${v}". Formato: email|clave(8+)|nombre`);
      process.exit(1);
    }
    return { email, pass, nombre: nom };
  });

  // ── Código único ──
  const dup = await db.collection("consultoras").where("codigo", "==", codigo).get();
  if (!dup.empty) {
    console.error(`❌ El código ${codigo} ya lo usa: ${dup.docs[0].data().nombre} (${dup.docs[0].id}). Elige otro.`);
    process.exit(1);
  }
  const mismoNombre = (await db.collection("consultoras").get()).docs
    .filter(d => (d.data().nombre || "").toLowerCase() === nombre.toLowerCase());
  if (mismoNombre.length) {
    console.error(`❌ Ya existe una consultora llamada "${nombre}" (${mismoNombre[0].id}).`);
    process.exit(1);
  }

  // ── Emails libres ──
  for (const email of [coordEmail, ...vendedores.map(v => v.email)]) {
    try {
      await auth.getUserByEmail(email);
      console.error(`❌ El correo ${email} ya tiene cuenta en el sistema. Usa otro o resuélvelo primero.`);
      process.exit(1);
    } catch (e) {
      if (e.code !== "auth/user-not-found") throw e;
    }
  }

  console.log(`\n🏗  Dando de alta a: ${nombre} (${codigo})\n`);

  // ── 1) Consultora (el espacio de la empresa) ──
  const consRef = await db.collection("consultoras").add({
    nombre,
    codigo,
    tipo: "aliado",                 // ← distingue aliados externos de la red propia
    plan: "fundador",
    activo: true,
    estadoSuscripcion: "pendiente_pago",  // el webhook de Stripe lo pondrá en "activa" al pagar
    creditos: 0,                          // se abonan solos al pagar (100/mes o 1,200/año + paquetes)
    contadorFolio: 0,
    firmaTexto: nombre,             // firma del PDF genérico mientras no tenga plantilla propia
    creadoEn: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`   ✓ Espacio creado: ${consRef.id}`);
  console.log(`   ✓ Sus folios serán: IPCI-${codigo}-${new Date().getFullYear()}-0001, 0002...`);

  // ── 2) Coordinador ──
  const cUser = await auth.createUser({ email: coordEmail, password: coordPass, displayName: coordNombre });
  await db.collection("usuarios").doc(cUser.uid).set({
    rol: "coordinador",
    consultoraId: consRef.id,
    nombre: coordNombre,
    email: coordEmail,
    tipoCuenta: "aliado",           // ← lo excluye de los canales internos del equipo IPCI
    activo: true,
    creadoEn: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`   ✓ Coordinador: ${coordEmail}`);

  // ── 3) Vendedores ──
  for (const v of vendedores) {
    const u = await auth.createUser({ email: v.email, password: v.pass, displayName: v.nombre });
    await db.collection("usuarios").doc(u.uid).set({
      rol: "vendedor",
      consultoraId: consRef.id,
      nombre: v.nombre,
      email: v.email,
      tipoCuenta: "aliado",
      activo: true,
      creadoEn: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`   ✓ Vendedor: ${v.email}`);
  }

  // ── Resumen para entregar al aliado ──
  console.log(`
═══════════════════════════════════════════════════════════
  ✅ ${nombre.toUpperCase()} — ACCESO LISTO
═══════════════════════════════════════════════════════════
  Panel:        https://ipcil.org/panel/
  Coordinador:  ${coordEmail}  /  ${coordPass}
${vendedores.map(v => `  Vendedor:     ${v.email}  /  ${v.pass}`).join("\n")}
  ID interno:   ${consRef.id}
  Folio:        IPCI-${codigo}-AAAA-NNNN

  💳 MODELO DE COBRO:
     · Mensual $3,000 → 100 certificados ($30 c/u)
     · Anual $30,000 → 1,200 certificados ($25 c/u)
     · Créditos extra: 50=$1,500 ($30) · 100=$2,900 ($29)
       · 500=$13,500 ($27) — no caducan, se acumulan
     Cada certificado emitido descuenta 1 crédito; en 0 la
     emisión se pausa hasta recargar.

     LINK DE PAGO (Stripe): toma tu Payment Link del plan
     o paquete y agrégale al final:
     ?client_reference_id=${consRef.id}
     Ejemplo:
     https://buy.stripe.com/XXXX?client_reference_id=${consRef.id}
     Al pagar, el webhook lo pone en "activa" solo. Si deja de
     pagar, pasa a "suspendida" y la emisión se bloquea sola.
  Certificados: diseño institucional IPCI automático
                (plantilla personalizada disponible después)

  ONBOARDING 48H — siguientes pasos con el aliado:
   1. El coordinador entra al panel y crea su primer curso
      (nombre, ponente, mínimo de alumnos, modalidad, duración).
   2. Genera un certificado de PRUEBA a su propio nombre.
   3. Escanea el QR → ve su validación, su padrón, su LinkedIn.
   4. Cambian sus claves desde el primer acceso.
   5. A vender: cada alumno certificado queda en el ecosistema.

  DESACTIVAR (fin de licencia): en Firestore, poner
  activo:false en su consultora y en sus usuarios — pierden
  acceso y emisión al instante, sin borrar su historial.
═══════════════════════════════════════════════════════════`);
  process.exit(0);
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
