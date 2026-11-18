/**
 * ============================================================================
 * SISTEMA DE AGENDA Y EXPEDIENTE CLÍNICO DENTAL - BACKEND GOOGLE APPS SCRIPT
 * ============================================================================
 *
 * INSTRUCCIONES DE INSTALACIÓN:
 * 1. Abre un archivo nuevo de Google Sheets en tu cuenta de Google.
 * 2. En el menú superior, haz clic en "Extensiones" > "Apps Script".
 * 3. Borra todo el código que aparece por defecto y pega TODO este código.
 * 4. Cambia el valor de CLAVE_ACCESO abajo (línea 24) por la contraseña que
 *    quieras usar en tu consultorio.
 * 5. Haz clic en el ícono de Guardar (disquete) y ejecuta una vez la función
 *    "inicializarHojas" desde el botón "Ejecutar" arriba para que cree las
 *    pestañas y encabezados automáticamente (te pedirá permisos, acéptalos).
 * 6. Haz clic en el botón azul "Implementar" > "Nueva implementación".
 * 7. En "Selecciona el tipo" (engrane), elige "Aplicación web".
 * 8. En "Ejecutar como", selecciona "Yo".
 * 9. En "Quién tiene acceso", selecciona "Cualquier persona" (el script exige
 *    tu CLAVE_ACCESO para leer o guardar cualquier dato).
 * 10. Haz clic en "Implementar", copia la "URL de la aplicación web" y pégala
 *     en la configuración de tu página web del consultorio.
 */

const CLAVE_ACCESO = "TU_CLAVE_SECRETA_AQUI"; // <-- CAMBIA ESTA CONTRASEÑA POR LA DE TU CONSULTORIO

const HOJA_PACIENTES = "Pacientes";
const HOJA_HISTORIAL = "Historial_Clinico";
const HOJA_AGENDA = "Agenda";

/**
 * Crea las hojas necesarias en el Google Sheet si no existen.
 */
function inicializarHojas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Hoja de Pacientes
  let sheetPacientes = ss.getSheetByName(HOJA_PACIENTES);
  if (!sheetPacientes) {
    sheetPacientes = ss.insertSheet(HOJA_PACIENTES);
    sheetPacientes.appendRow([
      "ID_Paciente",
      "Nombre_Completo",
      "Telefono",
      "Edad",
      "Alergias_Antecedentes",
      "Notas_Generales",
      "Fecha_Registro"
    ]);
    sheetPacientes.getRange("A1:G1").setFontWeight("bold").setBackground("#0284c7").setFontColor("#ffffff");
  }

  // 2. Hoja de Historial Clínico (Tratamientos realizados)
  let sheetHistorial = ss.getSheetByName(HOJA_HISTORIAL);
  if (!sheetHistorial) {
    sheetHistorial = ss.insertSheet(HOJA_HISTORIAL);
    sheetHistorial.appendRow([
      "ID_Registro",
      "ID_Paciente",
      "Nombre_Paciente",
      "Fecha_Atencion",
      "Procedimiento_Realizado",
      "Pieza_Dental",
      "Observaciones_Evo",
      "Costo",
      "Doctor"
    ]);
    sheetHistorial.getRange("A1:I1").setFontWeight("bold").setBackground("#0d9488").setFontColor("#ffffff");
  }

  // 3. Hoja de Agenda / Citas
  let sheetAgenda = ss.getSheetByName(HOJA_AGENDA);
  if (!sheetAgenda) {
    sheetAgenda = ss.insertSheet(HOJA_AGENDA);
    sheetAgenda.appendRow([
      "ID_Cita",
      "ID_Paciente",
      "Nombre_Paciente",
      "Telefono",
      "Fecha_Cita",
      "Hora_Cita",
      "Motivo_Tratamiento",
      "Estado",
      "Notas"
    ]);
    sheetAgenda.getRange("A1:I1").setFontWeight("bold").setBackground("#4f46e5").setFontColor("#ffffff");
  }
}

/**
 * Maneja peticiones GET (Lectura de datos)
 */
function doGet(e) {
  try {
    inicializarHojas();
    const params = e.parameter || {};
    const key = params.key || "";

    if (key !== CLAVE_ACCESO) {
      return respuestaJSON({ ok: false, error: "Clave de acceso del consultorio incorrecta." });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const pacientes = leerHojaComoObjetos(ss.getSheetByName(HOJA_PACIENTES));
    const historial = leerHojaComoObjetos(ss.getSheetByName(HOJA_HISTORIAL));
    const agenda = leerHojaComoObjetos(ss.getSheetByName(HOJA_AGENDA));

    return respuestaJSON({
      ok: true,
      pacientes: pacientes,
      historial: historial,
      agenda: agenda
    });
  } catch (err) {
    return respuestaJSON({ ok: false, error: err.toString() });
  }
}

/**
 * Busca el número de fila (1-based) donde aparece un ID en la columna A
 * leyendo únicamente la columna 1 para minimizar memoria y latencia con +50k filas.
 */
function buscarFilaPorIdColumnaA(sheet, idBuscado) {
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return -1;
  const colValues = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const target = String(idBuscado);
  for (let i = 0; i < colValues.length; i++) {
    if (String(colValues[i][0]) === target) {
      return i + 2;
    }
  }
  return -1;
}

/**
 * Ejecuta una acción individual sobre las hojas de cálculo.
 */
function procesarAccion(ss, payload) {
  const action = payload.action;

  // --- GUARDAR O ACTUALIZAR PACIENTE ---
  if (action === "guardarPaciente") {
    const sheet = ss.getSheetByName(HOJA_PACIENTES);
    const p = payload.paciente;
    const idPaciente = p.ID_Paciente || ("PAC-" + new Date().getTime());
    const filaExistente = buscarFilaPorIdColumnaA(sheet, idPaciente);

    const filaDatos = [
      idPaciente,
      p.Nombre_Completo || "",
      p.Telefono || "",
      p.Edad || "",
      p.Alergias_Antecedentes || "Ninguna reportada",
      p.Notas_Generales || "",
      p.Fecha_Registro || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd")
    ];

    if (filaExistente > 0) {
      sheet.getRange(filaExistente, 1, 1, filaDatos.length).setValues([filaDatos]);
    } else {
      sheet.appendRow(filaDatos);
    }

    return { ok: true, idPaciente: idPaciente, mensaje: "Paciente guardado correctamente." };
  }

  // --- REGISTRAR ATENCIÓN / TRATAMIENTO EN EXPEDIENTE ---
  if (action === "agregarHistorial") {
    const sheetH = ss.getSheetByName(HOJA_HISTORIAL);
    const sheetP = ss.getSheetByName(HOJA_PACIENTES);
    const h = payload.registro;

    let idPaciente = h.ID_Paciente;
    if (!idPaciente) {
      idPaciente = "PAC-" + new Date().getTime();
      sheetP.appendRow([
        idPaciente,
        h.Nombre_Paciente || "",
        h.Telefono || "",
        h.Edad || "",
        h.Alergias_Antecedentes || "Ninguna reportada",
        h.Notas_Generales || "",
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd")
      ]);
    }

    const idRegistro = h.ID_Registro || ("TRAT-" + new Date().getTime());
    sheetH.appendRow([
      idRegistro,
      idPaciente,
      h.Nombre_Paciente || "",
      h.Fecha_Atencion || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
      h.Procedimiento_Realizado || "",
      h.Pieza_Dental || "General",
      h.Observaciones_Evo || "",
      h.Costo || "0",
      h.Doctor || "Odontólogo Titular"
    ]);

    return { ok: true, idRegistro: idRegistro, idPaciente: idPaciente, mensaje: "Tratamiento registrado en el expediente." };
  }

  // --- GUARDAR O ACTUALIZAR CITA EN LA AGENDA ---
  if (action === "guardarCita") {
    const sheetA = ss.getSheetByName(HOJA_AGENDA);
    const c = payload.cita;
    const idCita = c.ID_Cita || ("CITA-" + new Date().getTime());
    const filaExistente = buscarFilaPorIdColumnaA(sheetA, idCita);

    const filaCita = [
      idCita,
      c.ID_Paciente || "",
      c.Nombre_Paciente || "",
      c.Telefono || "",
      c.Fecha_Cita || "",
      c.Hora_Cita || "",
      c.Motivo_Tratamiento || "",
      c.Estado || "Programada",
      c.Notas || ""
    ];

    if (filaExistente > 0) {
      sheetA.getRange(filaExistente, 1, 1, filaCita.length).setValues([filaCita]);
    } else {
      sheetA.appendRow(filaCita);
    }

    return { ok: true, idCita: idCita, mensaje: "Cita guardada en la agenda." };
  }

  // --- CAMBIAR ESTADO DE CITA ---
  if (action === "estadoCita") {
    const sheetA = ss.getSheetByName(HOJA_AGENDA);
    const filaExistente = buscarFilaPorIdColumnaA(sheetA, payload.idCita);
    if (filaExistente > 0) {
      sheetA.getRange(filaExistente, 8).setValue(payload.estado);
      return { ok: true, mensaje: "Estado de cita actualizado." };
    }
    return { ok: false, error: "Cita no encontrada." };
  }

  return { ok: false, error: "Acción no reconocida: " + action };
}

/**
 * Maneja peticiones POST (Guardar pacientes, tratamientos, citas y lotes)
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    inicializarHojas();
    const payload = JSON.parse(e.postData.contents);

    if (payload.key !== CLAVE_ACCESO) {
      return respuestaJSON({ ok: false, error: "Clave de acceso del consultorio incorrecta." });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // --- PROCESAMIENTO EN LOTE (múltiples acciones en una sola transacción) ---
    if (payload.action === "lote" && Array.isArray(payload.acciones)) {
      const resultados = [];
      for (let i = 0; i < payload.acciones.length; i++) {
        resultados.push(procesarAccion(ss, payload.acciones[i]));
      }
      return respuestaJSON({ ok: true, procesadas: resultados.length, resultados: resultados });
    }

    return respuestaJSON(procesarAccion(ss, payload));
  } catch (err) {
    return respuestaJSON({ ok: false, error: err.toString() });
  } finally {
    try {
      lock.releaseLock();
    } catch (lockErr) {}
  }
}

/**
 * Convierte las filas de una hoja de cálculo en un arreglo de objetos JSON
 */
function leerHojaComoObjetos(sheet) {
  if (!sheet) return [];
  const rows = sheet.getDataRange().getDisplayValues();
  if (rows.length <= 1) return [];
  const headers = rows[0];
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = {};
    let vacia = true;
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = rows[i][j];
      if (rows[i][j] !== "") vacia = false;
    }
    if (!vacia) result.push(obj);
  }
  return result;
}

function respuestaJSON(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
