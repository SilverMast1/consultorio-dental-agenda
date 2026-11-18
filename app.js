/**
 * ============================================================================
 * LÓGICA PRINCIPAL DEL SISTEMA DE AGENDA Y EXPEDIENTE DENTAL
 * Sincronización con Google Sheets (Apps Script) + Respaldo Local + PDF
 * ============================================================================
 */

const STORAGE_KEYS = {
  CONFIG: "dental_config_v1",
  DATA: "dental_local_data_v1"
};

let state = {
  config: {
    clinicName: "Consultorio Dental Sonrisa Sana",
    scriptUrl: "",
    accessKey: "dental2026"
  },
  pacientes: [],
  historial: [],
  agenda: [],
  selectedPatientId: null,
  isSyncing: false
};

// Datos iniciales de ejemplo por si se abre por primera vez sin Google Sheets aún
const DEMO_DATA = {
  pacientes: [
    {
      ID_Paciente: "PAC-1001",
      Nombre_Completo: "María Fernanda López García",
      Telefono: "55 4123 8910",
      Edad: "32",
      Alergias_Antecedentes: "Alergia a Penicilina",
      Notas_Generales: "Paciente en tratamiento de rehabilitación molar superior derecho.",
      Fecha_Registro: "2026-10-12"
    },
    {
      ID_Paciente: "PAC-1002",
      Nombre_Completo: "Roberto Carlos Mendoza Ruiz",
      Telefono: "55 8921 3344",
      Edad: "45",
      Alergias_Antecedentes: "Ninguna reportada",
      Notas_Generales: "Control periodontal semestral.",
      Fecha_Registro: "2026-11-01"
    }
  ],
  historial: [
    {
      ID_Registro: "TRAT-2001",
      ID_Paciente: "PAC-1001",
      Nombre_Paciente: "María Fernanda López García",
      Fecha_Atencion: "2026-10-12",
      Procedimiento_Realizado: "Valoración diagnóstica, radiografía periapical y limpieza dental con ultrasonido",
      Pieza_Dental: "General / OD 16",
      Observaciones_Evo: "Se detecta caries profunda en OD 16. Se programa resina compuesta.",
      Costo: "700",
      Doctor: "Dr. Titular"
    },
    {
      ID_Registro: "TRAT-2002",
      ID_Paciente: "PAC-1001",
      Nombre_Paciente: "María Fernanda López García",
      Fecha_Atencion: "2026-11-10",
      Procedimiento_Realizado: "Eliminación de caries y colocación de Resina Compuesta Fotopolimerizable",
      Pieza_Dental: "OD 16 (Molar Sup. Der.)",
      Observaciones_Evo: "Anestesia articaina 4%, recubrimiento pulpar indirecto. Buena oclusión.",
      Costo: "1200",
      Doctor: "Dr. Titular"
    },
    {
      ID_Registro: "TRAT-2003",
      ID_Paciente: "PAC-1002",
      Nombre_Paciente: "Roberto Carlos Mendoza Ruiz",
      Fecha_Atencion: "2026-11-01",
      Procedimiento_Realizado: "Profilaxis dental completa y aplicación de flúor",
      Pieza_Dental: "Arcada superior e inferior",
      Observaciones_Evo: "Encías saludables, se recomienda cepillo interdental.",
      Costo: "650",
      Doctor: "Dr. Titular"
    }
  ],
  agenda: [
    {
      ID_Cita: "CITA-3001",
      ID_Paciente: "PAC-1001",
      Nombre_Paciente: "María Fernanda López García",
      Telefono: "55 4123 8910",
      Fecha_Cita: obtenerFechaHoy(),
      Hora_Cita: "11:00",
      Motivo_Tratamiento: "Revisión de resina OD 16 y pulido final",
      Estado: "Programada",
      Notas: "Confirmó asistencia por WhatsApp"
    }
  ]
};

function obtenerFechaHoy() {
  const hoy = new Date();
  const yyyy = hoy.getFullYear();
  const mm = String(hoy.getMonth() + 1).padStart(2, "0");
  const dd = String(hoy.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ============================================================================
// INICIALIZACIÓN
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  lucide.createIcons();
  cargarConfiguracionLocal();
  cargarDatosLocales();
  inicializarEventos();

  // Poner fecha de hoy por defecto en formularios
  document.getElementById("regFechaAtencion").value = obtenerFechaHoy();
  document.getElementById("citaFecha").value = obtenerFechaHoy();

  // Si ya tenía configuración guardada, entramos directo
  const savedConfig = localStorage.getItem(STORAGE_KEYS.CONFIG);
  if (savedConfig) {
    document.getElementById("authModal").classList.add("hidden");
    actualizarEncabezado();
    renderizarTodo();
    if (state.config.scriptUrl) {
      sincronizarDesdeGoogleSheets();
    }
  } else {
    renderizarTodo();
  }
});

function cargarConfiguracionLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.CONFIG);
    if (raw) {
      state.config = { ...state.config, ...JSON.parse(raw) };
    }
    document.getElementById("configClinicName").value = state.config.clinicName || "";
    document.getElementById("configScriptUrl").value = state.config.scriptUrl || "";
    document.getElementById("configAccessKey").value = state.config.accessKey || "dental2026";
    document.getElementById("regDoctor").value = state.config.clinicName || "Odontólogo Titular";
  } catch (e) {
    console.error("Error cargando configuración:", e);
  }
}

function cargarDatosLocales() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DATA);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.pacientes = parsed.pacientes || [];
      state.historial = parsed.historial || [];
      state.agenda = parsed.agenda || [];
    } else {
      state.pacientes = DEMO_DATA.pacientes;
      state.historial = DEMO_DATA.historial;
      state.agenda = DEMO_DATA.agenda;
      guardarDatosLocales();
    }
  } catch (e) {
    console.error("Error cargando datos locales:", e);
  }
}

function guardarDatosLocales() {
  localStorage.setItem(
    STORAGE_KEYS.DATA,
    JSON.stringify({
      pacientes: state.pacientes,
      historial: state.historial,
      agenda: state.agenda
    })
  );
}

// ============================================================================
// COMUNICACIÓN CON GOOGLE SHEETS (GOOGLE APPS SCRIPT)
// ============================================================================
async function sincronizarDesdeGoogleSheets() {
  if (!state.config.scriptUrl) {
    mostrarToast("Modo Local activo (configura tu URL de Google Sheets cuando gustes)");
    actualizarEncabezado();
    return;
  }

  try {
    state.isSyncing = true;
    actualizarEncabezado("Sincronizando...");
    const url = `${state.config.scriptUrl}?key=${encodeURIComponent(state.config.accessKey)}&t=${Date.now()}`;
    const response = await fetch(url, { method: "GET" });
    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.error || "Error al autenticar con Google Sheets");
    }

    state.pacientes = data.pacientes || [];
    state.historial = data.historial || [];
    state.agenda = data.agenda || [];
    guardarDatosLocales();
    renderizarTodo();
    actualizarEncabezado("Conectado a Google Sheets", true);
    mostrarToast("Datos sincronizados con Google Sheets");
  } catch (err) {
    console.error(err);
    actualizarEncabezado("Error de conexión (Modo Local)", false, true);
    mostrarToast("No se pudo conectar a Google Sheets: " + err.message);
  } finally {
    state.isSyncing = false;
  }
}

async function enviarAccionGoogleSheets(payload) {
  if (!state.config.scriptUrl) {
    return { ok: true, localOnly: true };
  }

  try {
    const body = JSON.stringify({
      ...payload,
      key: state.config.accessKey
    });

    const response = await fetch(state.config.scriptUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: body
    });

    const res = await response.json();
    if (!res.ok) {
      throw new Error(res.error || "Error guardando en Google Sheets");
    }
    return res;
  } catch (err) {
    console.error("Error enviando a Google Sheets:", err);
    mostrarToast("Guardado localmente (error de red con Google Sheets)");
    return { ok: false, error: err.message };
  }
}

// ============================================================================
// RENDERIZADO DE LA INTERFAZ
// ============================================================================
function actualizarEncabezado(statusText, isOnline = false, isError = false) {
  document.getElementById("headerClinicName").textContent =
    state.config.clinicName || "Consultorio Dental";

  const badge = document.getElementById("syncBadge");
  if (isOnline || (state.config.scriptUrl && !isError)) {
    badge.className =
      "inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800";
    badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span> ${statusText || "Google Sheets Conectado"}`;
  } else if (isError) {
    badge.className =
      "inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-800";
    badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-red-500"></span> ${statusText || "Sin conexión"}`;
  } else {
    badge.className =
      "inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-800";
    badge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span> Modo Local`;
  }
}

function renderizarTodo() {
  renderizarEstadisticas();
  renderizarListaPacientes();
  renderizarSelectoresPacientes();
  renderizarExpedienteSeleccionado();
  renderizarAgenda();
  lucide.createIcons();
}

function renderizarEstadisticas() {
  const hoy = obtenerFechaHoy();
  document.getElementById("statTotalPacientes").textContent = state.pacientes.length;
  document.getElementById("statTotalTratamientos").textContent = state.historial.length;

  const citasHoy = state.agenda.filter(
    (c) => c.Fecha_Cita === hoy && c.Estado !== "Cancelada"
  ).length;
  const citasPendientes = state.agenda.filter(
    (c) => c.Estado === "Programada"
  ).length;

  document.getElementById("statCitasHoy").textContent = citasHoy;
  document.getElementById("statCitasPendientes").textContent = citasPendientes;
}

function renderizarListaPacientes() {
  const container = document.getElementById("patientsListContainer");
  const filtro = (document.getElementById("searchPatientsList").value || "").toLowerCase().trim();

  const filtrados = state.pacientes.filter((p) => {
    const nombre = (p.Nombre_Completo || "").toLowerCase();
    const tel = (p.Telefono || "").toLowerCase();
    const id = (p.ID_Paciente || "").toLowerCase();
    return nombre.includes(filtro) || tel.includes(filtro) || id.includes(filtro);
  });

  if (filtrados.length === 0) {
    container.innerHTML = `
      <div class="p-6 text-center text-xs text-slate-400">
        No se encontraron pacientes con ese criterio.
      </div>
    `;
    return;
  }

  container.innerHTML = filtrados
    .map((p) => {
      const isSelected = String(p.ID_Paciente) === String(state.selectedPatientId);
      const numVisitas = state.historial.filter(
        (h) => String(h.ID_Paciente) === String(p.ID_Paciente)
      ).length;

      return `
        <button type="button" onclick="seleccionarPaciente('${p.ID_Paciente}')"
          class="w-full text-left p-3 rounded-xl hover:bg-slate-50 transition flex items-center justify-between gap-2 ${
            isSelected ? "patient-item-active" : ""
          }">
          <div class="min-w-0">
            <p class="text-sm font-semibold text-slate-900 truncate">${escaparHTML(p.Nombre_Completo)}</p>
            <p class="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
              <span>${escaparHTML(p.Telefono || "Sin teléfono")}</span>
              <span>&bull;</span>
              <span class="text-teal-600 font-medium">${numVisitas} consulta(s)</span>
            </p>
          </div>
          <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400 shrink-0"></i>
        </button>
      `;
    })
    .join("");
}

function renderizarSelectoresPacientes() {
  const opcionesHTML =
    `<option value="">-- Paciente Nuevo / Escribir manualmente --</option>` +
    state.pacientes
      .map(
        (p) =>
          `<option value="${p.ID_Paciente}">${escaparHTML(p.Nombre_Completo)} (${escaparHTML(p.Telefono || "S/T")})</option>`
      )
      .join("");

  document.getElementById("regSelectPaciente").innerHTML = opcionesHTML;
  document.getElementById("citaSelectPaciente").innerHTML = opcionesHTML;
}

window.seleccionarPaciente = function (idPaciente) {
  state.selectedPatientId = idPaciente;
  activarPestana("tab-expedientes");
  renderizarListaPacientes();
  renderizarExpedienteSeleccionado();
  lucide.createIcons();
};

function renderizarExpedienteSeleccionado() {
  const emptyState = document.getElementById("emptyExpedienteState");
  const activeView = document.getElementById("activeExpedienteView");

  const paciente = state.pacientes.find(
    (p) => String(p.ID_Paciente) === String(state.selectedPatientId)
  );

  if (!paciente) {
    emptyState.classList.remove("hidden");
    activeView.classList.add("hidden");
    return;
  }

  emptyState.classList.add("hidden");
  activeView.classList.remove("hidden");

  const iniciales = (paciente.Nombre_Completo || "P")
    .split(" ")
    .map((n) => n[0])
    .join("")
    .substring(0, 2)
    .toUpperCase();

  document.getElementById("expAvatar").textContent = iniciales;
  document.getElementById("expNombre").textContent = paciente.Nombre_Completo || "";
  document.getElementById("expIdBadge").textContent = paciente.ID_Paciente || "";
  document.getElementById("expTelefono").textContent = paciente.Telefono || "No registrado";
  document.getElementById("expEdad").textContent = paciente.Edad ? `${paciente.Edad} años` : "No registrada";
  document.getElementById("expFechaAlta").textContent = paciente.Fecha_Registro || "-";
  document.getElementById("expAlergias").textContent =
    paciente.Alergias_Antecedentes || "Ninguna reportada";
  document.getElementById("expNotas").textContent =
    paciente.Notas_Generales || "Sin notas adicionales";

  // Obtener todo el historial del paciente ordenado del más reciente al más antiguo
  const trabajos = state.historial
    .filter((h) => String(h.ID_Paciente) === String(paciente.ID_Paciente))
    .sort((a, b) => (b.Fecha_Atencion || "").localeCompare(a.Fecha_Atencion || ""));

  document.getElementById("expCountTratamientos").textContent = `${trabajos.length} registro(s)`;

  const timeline = document.getElementById("expHistorialTimeline");
  if (trabajos.length === 0) {
    timeline.innerHTML = `
      <div class="p-8 rounded-2xl border border-dashed border-slate-200 text-center">
        <p class="text-sm text-slate-500 mb-3">Aún no hay procedimientos registrados para este paciente.</p>
        <button type="button" onclick="irARegistrarTrabajoParaPaciente('${paciente.ID_Paciente}')"
          class="px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold rounded-xl shadow-sm">
          Registrar Primer Procedimiento
        </button>
      </div>
    `;
    return;
  }

  timeline.innerHTML = trabajos
    .map(
      (t) => `
      <div class="p-4 rounded-xl border border-slate-200 bg-slate-50/60 hover:bg-white transition shadow-2xs">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-1.5">
          <div class="flex items-center gap-2">
            <span class="px-2.5 py-0.5 rounded-lg bg-teal-600 text-white text-xs font-bold">
              ${escaparHTML(t.Fecha_Atencion || "Sin fecha")}
            </span>
            <span class="text-xs font-semibold px-2.5 py-0.5 rounded-lg bg-sky-100 text-sky-800">
              Pieza / Zona: ${escaparHTML(t.Pieza_Dental || "General")}
            </span>
          </div>
          <div class="text-xs text-slate-500 flex items-center gap-3">
            ${
              t.Costo && Number(t.Costo) > 0
                ? `<span class="font-bold text-emerald-700">$${Number(t.Costo).toLocaleString("es-MX", { minimumFractionDigits: 2 })}</span>`
                : ""
            }
            <span>Atendió: <strong>${escaparHTML(t.Doctor || "Odontólogo")}</strong></span>
          </div>
        </div>
        <h4 class="text-sm font-bold text-slate-900 mt-1">
          ${escaparHTML(t.Procedimiento_Realizado)}
        </h4>
        ${
          t.Observaciones_Evo
            ? `<p class="text-xs text-slate-600 mt-1.5 bg-white p-2.5 rounded-lg border border-slate-100">
                <strong>Evolución / Notas:</strong> ${escaparHTML(t.Observaciones_Evo)}
              </p>`
            : ""
        }
      </div>
    `
    )
    .join("");
}

window.irARegistrarTrabajoParaPaciente = function (idPaciente) {
  const paciente = state.pacientes.find((p) => String(p.ID_Paciente) === String(idPaciente));
  if (!paciente) return;

  activarPestana("tab-registrar");
  const select = document.getElementById("regSelectPaciente");
  select.value = paciente.ID_Paciente;
  autocompletarFormularioTratamiento(paciente.ID_Paciente);
};

function autocompletarFormularioTratamiento(idPaciente) {
  const paciente = state.pacientes.find((p) => String(p.ID_Paciente) === String(idPaciente));
  const extraFields = document.getElementById("regNuevoPacienteFields");
  if (paciente) {
    document.getElementById("regNombrePaciente").value = paciente.Nombre_Completo || "";
    document.getElementById("regTelefono").value = paciente.Telefono || "";
    document.getElementById("regEdad").value = paciente.Edad || "";
    document.getElementById("regAlergias").value = paciente.Alergias_Antecedentes || "";
    extraFields.classList.add("hidden");
  } else {
    document.getElementById("regNombrePaciente").value = "";
    document.getElementById("regTelefono").value = "";
    document.getElementById("regEdad").value = "";
    document.getElementById("regAlergias").value = "";
    extraFields.classList.remove("hidden");
  }
}

// ============================================================================
// RENDERIZADO DE LA AGENDA DE CITAS
// ============================================================================
function renderizarAgenda() {
  const container = document.getElementById("agendaListContainer");
  const filtroFecha = document.getElementById("agendaFilterDate").value;

  let citas = [...state.agenda];
  if (filtroFecha) {
    citas = citas.filter((c) => c.Fecha_Cita === filtroFecha);
  }

  citas.sort((a, b) => {
    const cmpFecha = (a.Fecha_Cita || "").localeCompare(b.Fecha_Cita || "");
    if (cmpFecha !== 0) return cmpFecha;
    return (a.Hora_Cita || "").localeCompare(b.Hora_Cita || "");
  });

  if (citas.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center border border-dashed border-slate-200 rounded-2xl text-slate-400 text-sm">
        No hay citas registradas para el filtro seleccionado.
      </div>
    `;
    return;
  }

  container.innerHTML = citas
    .map((c) => {
      let badgeColor = "bg-indigo-100 text-indigo-800";
      if (c.Estado === "Atendida") badgeColor = "bg-emerald-100 text-emerald-800";
      if (c.Estado === "Cancelada") badgeColor = "bg-rose-100 text-rose-800";

      return `
        <div class="p-4 rounded-xl border border-slate-200 hover:border-indigo-200 bg-white shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="px-2.5 py-0.5 rounded-lg bg-slate-900 text-white text-xs font-bold">
                ${escaparHTML(c.Fecha_Cita)} &bull; ${escaparHTML(c.Hora_Cita)}
              </span>
              <span class="text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${badgeColor}">
                ${escaparHTML(c.Estado || "Programada")}
              </span>
            </div>
            <h4 class="text-sm font-bold text-slate-900">${escaparHTML(c.Nombre_Paciente)}</h4>
            <p class="text-xs text-slate-600">
              <strong>Motivo:</strong> ${escaparHTML(c.Motivo_Tratamiento)}
              ${c.Telefono ? ` &bull; <strong>Tel:</strong> ${escaparHTML(c.Telefono)}` : ""}
            </p>
            ${c.Notas ? `<p class="text-[11px] text-slate-500 italic">${escaparHTML(c.Notas)}</p>` : ""}
          </div>

          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <button type="button" onclick="atenderCitaPaciente('${c.ID_Cita}')"
              class="px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-xs font-semibold transition flex items-center gap-1">
              <i data-lucide="Stethoscope" class="w-3.5 h-3.5"></i>
              Atender / Abrir Expediente
            </button>
            ${
              c.Estado !== "Cancelada"
                ? `<button type="button" onclick="cambiarEstadoCita('${c.ID_Cita}', 'Cancelada')"
                    class="px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-rose-50 hover:text-rose-600 text-slate-500 text-xs transition">
                    Cancelar
                  </button>`
                : ""
            }
          </div>
        </div>
      `;
    })
    .join("");
}

window.atenderCitaPaciente = async function (idCita) {
  const cita = state.agenda.find((c) => String(c.ID_Cita) === String(idCita));
  if (!cita) return;

  cita.Estado = "Atendida";
  guardarDatosLocales();
  enviarAccionGoogleSheets({ action: "estadoCita", idCita: cita.ID_Cita, estado: "Atendida" });

  // Buscar si el paciente ya existe por ID o por Nombre
  let paciente = state.pacientes.find(
    (p) =>
      (cita.ID_Paciente && String(p.ID_Paciente) === String(cita.ID_Paciente)) ||
      (p.Nombre_Completo || "").toLowerCase() === (cita.Nombre_Paciente || "").toLowerCase()
  );

  if (paciente) {
    seleccionarPaciente(paciente.ID_Paciente);
    mostrarToast(`Expediente de ${paciente.Nombre_Completo} abierto`);
  } else {
    activarPestana("tab-registrar");
    document.getElementById("regSelectPaciente").value = "";
    autocompletarFormularioTratamiento("");
    document.getElementById("regNombrePaciente").value = cita.Nombre_Paciente || "";
    document.getElementById("regTelefono").value = cita.Telefono || "";
    document.getElementById("regProcedimiento").value = cita.Motivo_Tratamiento || "";
    mostrarToast("Registra el tratamiento realizado para crear su expediente");
  }
  renderizarTodo();
};

window.cambiarEstadoCita = async function (idCita, nuevoEstado) {
  const cita = state.agenda.find((c) => String(c.ID_Cita) === String(idCita));
  if (!cita) return;
  cita.Estado = nuevoEstado;
  guardarDatosLocales();
  renderizarTodo();
  await enviarAccionGoogleSheets({ action: "estadoCita", idCita, estado: nuevoEstado });
  mostrarToast("Estado de la cita actualizado");
};

// ============================================================================
// GENERADOR DE PDF DEL EXPEDIENTE CLÍNICO DEL PACIENTE
// ============================================================================
function descargarExpedientePDF() {
  const paciente = state.pacientes.find(
    (p) => String(p.ID_Paciente) === String(state.selectedPatientId)
  );
  if (!paciente) {
    mostrarToast("Selecciona un paciente primero");
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();

  const nombreConsultorio = state.config.clinicName || "Consultorio Dental";
  const fechaImpresion = obtenerFechaHoy();

  // Encabezado Azul Clínico
  doc.setFillColor(2, 132, 199);
  doc.rect(0, 0, 210, 34, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text(nombreConsultorio.toUpperCase(), 14, 15);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text("EXPEDIENTE CLÍNICO ODONTOLÓGICO E HISTORIAL DE TRATAMIENTOS", 14, 23);
  doc.text(`Fecha de emisión: ${fechaImpresion}`, 14, 29);

  // Recuadro de Datos del Paciente
  doc.setTextColor(30, 41, 59);
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(203, 213, 225);
  doc.roundedRect(14, 40, 182, 42, 3, 3, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(`PACIENTE: ${paciente.Nombre_Completo || ""}`, 19, 49);
  doc.setFontSize(9);
  doc.text(`ID EXPEDIENTE: ${paciente.ID_Paciente || ""}`, 145, 49);

  doc.setFont("helvetica", "normal");
  doc.text(`Teléfono: ${paciente.Telefono || "No registrado"}`, 19, 57);
  doc.text(`Edad: ${paciente.Edad ? paciente.Edad + " años" : "No registrada"}`, 85, 57);
  doc.text(`Fecha de Alta: ${paciente.Fecha_Registro || "-"}`, 145, 57);

  doc.setFont("helvetica", "bold");
  doc.setTextColor(180, 83, 9);
  doc.text(
    `Alergias / Antecedentes Médicos: ${paciente.Alergias_Antecedentes || "Ninguna reportada"}`,
    19,
    66
  );

  doc.setTextColor(51, 65, 85);
  doc.setFont("helvetica", "normal");
  const notasSplit = doc.splitTextToSize(
    `Notas Generales: ${paciente.Notas_Generales || "Sin observaciones generales."}`,
    172
  );
  doc.text(notasSplit, 19, 74);

  // Tabla de Procedimientos Realizados
  const trabajos = state.historial
    .filter((h) => String(h.ID_Paciente) === String(paciente.ID_Paciente))
    .sort((a, b) => (b.Fecha_Atencion || "").localeCompare(a.Fecha_Atencion || ""));

  const filasTabla = trabajos.map((t) => [
    t.Fecha_Atencion || "-",
    t.Pieza_Dental || "General",
    t.Procedimiento_Realizado || "-",
    t.Observaciones_Evo || "-",
    t.Doctor || "-",
    t.Costo ? `$${Number(t.Costo).toFixed(2)}` : "-"
  ]);

  doc.autoTable({
    startY: 88,
    head: [["Fecha", "Pieza / Zona", "Procedimiento Realizado", "Evolución / Indicaciones", "Atendió", "Costo"]],
    body:
      filasTabla.length > 0
        ? filasTabla
        : [["-", "-", "Sin procedimientos registrados a la fecha", "-", "-", "-"]],
    theme: "grid",
    headStyles: {
      fillColor: [13, 148, 136],
      textColor: 255,
      fontSize: 9,
      fontStyle: "bold"
    },
    bodyStyles: {
      fontSize: 8.5,
      textColor: [30, 41, 59]
    },
    columnStyles: {
      0: { cellWidth: 23 },
      1: { cellWidth: 25 },
      2: { cellWidth: 52 },
      3: { cellWidth: 46 },
      4: { cellWidth: 20 },
      5: { cellWidth: 16 }
    }
  });

  // Pie de página con firma
  const finalY = doc.lastAutoTable.finalY + 22;
  if (finalY < 270) {
    doc.setDrawColor(148, 163, 184);
    doc.line(70, finalY, 140, finalY);
    doc.setFontSize(9);
    doc.setTextColor(100, 116, 139);
    doc.text("Firma y Sello del Odontólogo Responsable", 105, finalY + 6, { align: "center" });
  }

  const nombreArchivo = `Expediente_${(paciente.Nombre_Completo || "Paciente")
    .replace(/[^a-zA-Z0-9]/g, "_")}.pdf`;
  doc.save(nombreArchivo);
  mostrarToast("PDF del expediente descargado correctamente");
}

// ============================================================================
// EVENTOS Y FORMULARIOS
// ============================================================================
function activarPestana(tabId) {
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.add("hidden");
  });
  document.getElementById(tabId).classList.remove("hidden");

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    if (btn.dataset.tab === tabId) {
      btn.classList.add("active-tab");
      btn.classList.remove("text-slate-600");
    } else {
      btn.classList.remove("active-tab");
      btn.classList.add("text-slate-600");
    }
  });
}

function inicializarEventos() {
  // Navegación por pestañas
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => activarPestana(btn.dataset.tab));
  });

  // Configuración / Login Modal
  document.getElementById("btnOpenConfig").addEventListener("click", () => {
    document.getElementById("authModal").classList.remove("hidden");
  });

  document.getElementById("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    state.config.clinicName =
      document.getElementById("configClinicName").value.trim() || "Consultorio Dental";
    state.config.scriptUrl = document.getElementById("configScriptUrl").value.trim();
    state.config.accessKey = document.getElementById("configAccessKey").value.trim() || "dental2026";

    localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(state.config));
    document.getElementById("authModal").classList.add("hidden");
    actualizarEncabezado();

    if (state.config.scriptUrl) {
      await sincronizarDesdeGoogleSheets();
    } else {
      mostrarToast("Sesión iniciada en Modo Local");
    }
  });

  // Botón Sincronizar
  document.getElementById("btnSyncNow").addEventListener("click", () => {
    sincronizarDesdeGoogleSheets();
  });

  // Filtro en lista de pacientes
  document.getElementById("searchPatientsList").addEventListener("input", () => {
    renderizarListaPacientes();
    lucide.createIcons();
  });

  // Buscador global superior
  const globalInput = document.getElementById("globalPatientSearch");
  const globalResults = document.getElementById("globalSearchResults");
  globalInput.addEventListener("input", () => {
    const q = globalInput.value.toLowerCase().trim();
    if (!q) {
      globalResults.classList.add("hidden");
      return;
    }
    const matches = state.pacientes.filter(
      (p) =>
        (p.Nombre_Completo || "").toLowerCase().includes(q) ||
        (p.Telefono || "").toLowerCase().includes(q)
    );
    if (matches.length === 0) {
      globalResults.innerHTML = `<div class="p-3 text-xs text-slate-400">Sin coincidencias</div>`;
    } else {
      globalResults.innerHTML = matches
        .map(
          (p) => `
          <button type="button" onclick="seleccionarDesdeBuscadorGlobal('${p.ID_Paciente}')"
            class="w-full text-left px-4 py-2.5 hover:bg-sky-50 text-xs flex items-center justify-between">
            <span class="font-semibold text-slate-800">${escaparHTML(p.Nombre_Completo)}</span>
            <span class="text-slate-400">${escaparHTML(p.Telefono || "")}</span>
          </button>
        `
        )
        .join("");
    }
    globalResults.classList.remove("hidden");
  });

  window.seleccionarDesdeBuscadorGlobal = function (idPaciente) {
    globalResults.classList.add("hidden");
    globalInput.value = "";
    seleccionarPaciente(idPaciente);
  };

  // Botones rápidos de procedimientos
  document.querySelectorAll(".quick-proc").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = document.getElementById("regProcedimiento");
      input.value = input.value ? `${input.value}, ${btn.textContent}` : btn.textContent;
    });
  });

  // Selector de paciente en pestaña Registrar Tratamiento
  document.getElementById("regSelectPaciente").addEventListener("change", (e) => {
    autocompletarFormularioTratamiento(e.target.value);
  });

  // Selector de paciente en pestaña Agenda
  document.getElementById("citaSelectPaciente").addEventListener("change", (e) => {
    const p = state.pacientes.find((x) => String(x.ID_Paciente) === String(e.target.value));
    if (p) {
      document.getElementById("citaNombrePaciente").value = p.Nombre_Completo || "";
      document.getElementById("citaTelefono").value = p.Telefono || "";
    }
  });

  // Botón Descargar PDF
  document.getElementById("btnDownloadPDF").addEventListener("click", descargarExpedientePDF);

  // Botón Agregar Trabajo desde el expediente activo
  document.getElementById("btnAddTreatmentFromExp").addEventListener("click", () => {
    if (state.selectedPatientId) {
      irARegistrarTrabajoParaPaciente(state.selectedPatientId);
    }
  });

  // Botones para abrir Modal de Paciente (Nuevo o Editar)
  const abrirModalNuevoPaciente = () => {
    document.getElementById("patientModalTitle").textContent = "Registrar Nuevo Paciente";
    document.getElementById("modalPatientId").value = "";
    document.getElementById("modalPatientName").value = "";
    document.getElementById("modalPatientPhone").value = "";
    document.getElementById("modalPatientAge").value = "";
    document.getElementById("modalPatientAllergies").value = "";
    document.getElementById("modalPatientNotes").value = "";
    document.getElementById("patientModal").classList.remove("hidden");
  };

  document.getElementById("btnNuevoPacienteModal").addEventListener("click", abrirModalNuevoPaciente);
  document.getElementById("btnEmptyNuevoPaciente").addEventListener("click", abrirModalNuevoPaciente);
  document.getElementById("btnEmptyRegistrarTrabajo").addEventListener("click", () => {
    activarPestana("tab-registrar");
  });

  document.getElementById("btnEditPatient").addEventListener("click", () => {
    const p = state.pacientes.find(
      (x) => String(x.ID_Paciente) === String(state.selectedPatientId)
    );
    if (!p) return;
    document.getElementById("patientModalTitle").textContent = "Editar Expediente del Paciente";
    document.getElementById("modalPatientId").value = p.ID_Paciente;
    document.getElementById("modalPatientName").value = p.Nombre_Completo || "";
    document.getElementById("modalPatientPhone").value = p.Telefono || "";
    document.getElementById("modalPatientAge").value = p.Edad || "";
    document.getElementById("modalPatientAllergies").value = p.Alergias_Antecedentes || "";
    document.getElementById("modalPatientNotes").value = p.Notas_Generales || "";
    document.getElementById("patientModal").classList.remove("hidden");
  });

  const cerrarModalPaciente = () => {
    document.getElementById("patientModal").classList.add("hidden");
  };
  document.getElementById("btnClosePatientModal").addEventListener("click", cerrarModalPaciente);
  document.getElementById("btnCancelPatientModal").addEventListener("click", cerrarModalPaciente);

  // Guardar Paciente desde Modal
  document.getElementById("formPacienteModal").addEventListener("submit", async (e) => {
    e.preventDefault();
    const idExistente = document.getElementById("modalPatientId").value;
    const idPaciente = idExistente || "PAC-" + Date.now();

    const nuevoPaciente = {
      ID_Paciente: idPaciente,
      Nombre_Completo: document.getElementById("modalPatientName").value.trim(),
      Telefono: document.getElementById("modalPatientPhone").value.trim(),
      Edad: document.getElementById("modalPatientAge").value.trim(),
      Alergias_Antecedentes:
        document.getElementById("modalPatientAllergies").value.trim() || "Ninguna reportada",
      Notas_Generales: document.getElementById("modalPatientNotes").value.trim(),
      Fecha_Registro: obtenerFechaHoy()
    };

    const idx = state.pacientes.findIndex((p) => String(p.ID_Paciente) === String(idPaciente));
    if (idx >= 0) {
      nuevoPaciente.Fecha_Registro = state.pacientes[idx].Fecha_Registro;
      state.pacientes[idx] = nuevoPaciente;
    } else {
      state.pacientes.unshift(nuevoPaciente);
    }

    state.selectedPatientId = idPaciente;
    guardarDatosLocales();
    cerrarModalPaciente();
    renderizarTodo();
    mostrarToast("Expediente del paciente guardado");

    await enviarAccionGoogleSheets({
      action: "guardarPaciente",
      paciente: nuevoPaciente
    });
  });

  // Guardar Procedimiento / Atención Realizada
  document.getElementById("formRegistrarTratamiento").addEventListener("submit", async (e) => {
    e.preventDefault();

    let idPaciente = document.getElementById("regSelectPaciente").value;
    const nombrePaciente = document.getElementById("regNombrePaciente").value.trim();

    if (!idPaciente) {
      idPaciente = "PAC-" + Date.now();
      const nuevoP = {
        ID_Paciente: idPaciente,
        Nombre_Completo: nombrePaciente,
        Telefono: document.getElementById("regTelefono").value.trim(),
        Edad: document.getElementById("regEdad").value.trim(),
        Alergias_Antecedentes:
          document.getElementById("regAlergias").value.trim() || "Ninguna reportada",
        Notas_Generales: "",
        Fecha_Registro: obtenerFechaHoy()
      };
      state.pacientes.unshift(nuevoP);
    }

    const nuevoRegistro = {
      ID_Registro: "TRAT-" + Date.now(),
      ID_Paciente: idPaciente,
      Nombre_Paciente: nombrePaciente,
      Fecha_Atencion: document.getElementById("regFechaAtencion").value,
      Procedimiento_Realizado: document.getElementById("regProcedimiento").value.trim(),
      Pieza_Dental: document.getElementById("regPiezaDental").value.trim() || "General",
      Observaciones_Evo: document.getElementById("regObservaciones").value.trim(),
      Costo: document.getElementById("regCosto").value || "0",
      Doctor: document.getElementById("regDoctor").value.trim() || "Odontólogo Titular",
      Telefono: document.getElementById("regTelefono").value.trim(),
      Edad: document.getElementById("regEdad").value.trim(),
      Alergias_Antecedentes: document.getElementById("regAlergias").value.trim()
    };

    state.historial.unshift(nuevoRegistro);
    state.selectedPatientId = idPaciente;
    guardarDatosLocales();

    // Limpiar campos del procedimiento y abrir el expediente del paciente
    document.getElementById("regProcedimiento").value = "";
    document.getElementById("regPiezaDental").value = "";
    document.getElementById("regObservaciones").value = "";
    document.getElementById("regCosto").value = "";

    seleccionarPaciente(idPaciente);
    mostrarToast("Trabajo registrado en el expediente del paciente");

    await enviarAccionGoogleSheets({
      action: "agregarHistorial",
      registro: nuevoRegistro
    });
  });

  // Guardar Nueva Cita en Agenda
  document.getElementById("formNuevaCita").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nuevaCita = {
      ID_Cita: "CITA-" + Date.now(),
      ID_Paciente: document.getElementById("citaSelectPaciente").value || "",
      Nombre_Paciente: document.getElementById("citaNombrePaciente").value.trim(),
      Telefono: document.getElementById("citaTelefono").value.trim(),
      Fecha_Cita: document.getElementById("citaFecha").value,
      Hora_Cita: document.getElementById("citaHora").value,
      Motivo_Tratamiento: document.getElementById("citaMotivo").value.trim(),
      Estado: "Programada",
      Notas: document.getElementById("citaNotas").value.trim()
    };

    state.agenda.push(nuevaCita);
    guardarDatosLocales();
    renderizarTodo();

    document.getElementById("citaNombrePaciente").value = "";
    document.getElementById("citaTelefono").value = "";
    document.getElementById("citaMotivo").value = "";
    document.getElementById("citaNotas").value = "";
    document.getElementById("citaSelectPaciente").value = "";

    mostrarToast("Cita agendada correctamente");

    await enviarAccionGoogleSheets({
      action: "guardarCita",
      cita: nuevaCita
    });
  });

  // Filtros de fecha en Agenda
  document.getElementById("agendaFilterDate").addEventListener("change", () => {
    renderizarAgenda();
    lucide.createIcons();
  });
  document.getElementById("btnAgendaVerTodas").addEventListener("click", () => {
    document.getElementById("agendaFilterDate").value = "";
    renderizarAgenda();
    lucide.createIcons();
  });
}

function mostrarToast(mensaje) {
  const toast = document.getElementById("toastNotification");
  document.getElementById("toastMessage").textContent = mensaje;
  toast.classList.remove("hidden");
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 3500);
}

function escaparHTML(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
