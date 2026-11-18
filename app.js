/**
 * ============================================================================
 * LÓGICA PRINCIPAL DEL SISTEMA DE AGENDA Y EXPEDIENTE DENTAL
 * Sincronización con Google Sheets (Apps Script) + Respaldo Local + PDF
 * ============================================================================
 */

const DEFAULT_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycbzDL0Rc27aR4ZfGigjbMrDDagHriTxuzQOiUv2eD_SRvc1wm3LPHH8NHsmyy1e_RdW-BA/exec";

const STORAGE_KEYS = {
  CONFIG: "dental_config_v3",
  DATA: "dental_local_data_v3",
  QUEUE: "dental_pending_queue_v4"
};

const FDI_QUADRANTS = {
  supDer: ["18", "17", "16", "15", "14", "13", "12", "11"],
  supIzq: ["21", "22", "23", "24", "25", "26", "27", "28"],
  infDer: ["48", "47", "46", "45", "44", "43", "42", "41"],
  infIzq: ["31", "32", "33", "34", "35", "36", "37", "38"]
};

let state = {
  config: {
    clinicName: "Consultorio Dental Sonrisa Sana",
    scriptUrl: DEFAULT_SCRIPT_URL,
    accessKey: ""
  },
  pacientes: [],
  historial: [],
  agenda: [],
  pendingQueue: [],
  pacientePorId: new Map(),
  historialPorPaciente: new Map(),
  selectedPatientId: null,
  isSyncing: false
};

// Wrapper ligero de IndexedDB para soportar +500,000 registros localmente sin tope de 5 MB
const DentalIDB = {
  DB_NAME: "ConsultorioDentalDB",
  STORE_NAME: "estado",
  KEY_DATASET: "dataset_v5",
  _dbPromise: null,
  open() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve) => {
      try {
        const req = window.indexedDB.open(this.DB_NAME, 1);
        req.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(this.STORE_NAME)) {
            db.createObjectStore(this.STORE_NAME);
          }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
    return this._dbPromise;
  },
  async get(key) {
    const db = await this.open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.STORE_NAME, "readonly");
        const req = tx.objectStore(this.STORE_NAME).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  },
  async set(key, value) {
    const db = await this.open();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.STORE_NAME, "readwrite");
        tx.objectStore(this.STORE_NAME).put(value, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  },
  async clear() {
    const db = await this.open();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(this.STORE_NAME, "readwrite");
        tx.objectStore(this.STORE_NAME).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }
};

function reconstruirIndices() {
  const mapaPacientes = new Map();
  for (let i = 0; i < state.pacientes.length; i++) {
    const p = state.pacientes[i];
    if (p && p.ID_Paciente) {
      mapaPacientes.set(String(p.ID_Paciente), p);
    }
  }

  const mapaHistorial = new Map();
  for (let i = 0; i < state.historial.length; i++) {
    const h = state.historial[i];
    const pid = String(h.ID_Paciente || "");
    if (!pid) continue;
    let lista = mapaHistorial.get(pid);
    if (!lista) {
      lista = [];
      mapaHistorial.set(pid, lista);
    }
    lista.push(h);
  }

  // Preordenar el historial de cada paciente del más reciente al más antiguo
  mapaHistorial.forEach((lista) => {
    lista.sort((a, b) => (b.Fecha_Atencion || "").localeCompare(a.Fecha_Atencion || ""));
  });

  state.pacientePorId = mapaPacientes;
  state.historialPorPaciente = mapaHistorial;
}

function debounce(fn, waitMs = 120) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), waitMs);
  };
}

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
document.addEventListener("DOMContentLoaded", async () => {
  ["dental_config_v1", "dental_local_data_v1", "dental_config_v2", "dental_local_data_v2"].forEach(
    (k) => localStorage.removeItem(k)
  );
  lucide.createIcons();
  cargarConfiguracionLocal();
  await cargarDatosLocales();
  cargarColaPendiente();
  inicializarOdontogramaSelector();
  inicializarEventos();

  // Poner fecha de hoy por defecto en formularios
  document.getElementById("regFechaAtencion").value = obtenerFechaHoy();
  document.getElementById("citaFecha").value = obtenerFechaHoy();

  // Si ya tenía configuración guardada con clave de acceso, entramos directo y validamos
  const savedConfig = localStorage.getItem(STORAGE_KEYS.CONFIG);
  if (savedConfig && state.config.accessKey) {
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
    state.config.scriptUrl = DEFAULT_SCRIPT_URL;
    const clinicInput = document.getElementById("configClinicName");
    if (clinicInput) clinicInput.value = state.config.clinicName || "";
    const urlInput = document.getElementById("configScriptUrl");
    if (urlInput) urlInput.value = state.config.scriptUrl || "";
    document.getElementById("configAccessKey").value = state.config.accessKey || "";
    document.getElementById("regDoctor").value = state.config.clinicName || "Odontólogo Titular";
  } catch (e) {
    console.error("Error cargando configuración:", e);
  }
}

async function cargarDatosLocales() {
  try {
    const idbData = await DentalIDB.get(DentalIDB.KEY_DATASET);
    if (idbData) {
      state.pacientes = idbData.pacientes || [];
      state.historial = idbData.historial || [];
      state.agenda = idbData.agenda || [];
      reconstruirIndices();
      return;
    }

    const raw = localStorage.getItem(STORAGE_KEYS.DATA);
    if (raw) {
      const parsed = JSON.parse(raw);
      state.pacientes = parsed.pacientes || [];
      state.historial = parsed.historial || [];
      state.agenda = parsed.agenda || [];
    } else if (state.config.scriptUrl) {
      state.pacientes = [];
      state.historial = [];
      state.agenda = [];
    } else {
      state.pacientes = DEMO_DATA.pacientes;
      state.historial = DEMO_DATA.historial;
      state.agenda = DEMO_DATA.agenda;
      guardarDatosLocales();
    }
    reconstruirIndices();
  } catch (e) {
    console.error("Error cargando datos locales:", e);
  }
}

function guardarDatosLocales() {
  reconstruirIndices();
  const payload = {
    pacientes: state.pacientes,
    historial: state.historial,
    agenda: state.agenda
  };

  // Almacenamiento masivo en IndexedDB (soporta cientos de MB sin error de cuota)
  DentalIDB.set(DentalIDB.KEY_DATASET, payload);

  // Respaldo rápido en localStorage protegido contra QuotaExceededError (>5 MB)
  try {
    localStorage.setItem(STORAGE_KEYS.DATA, JSON.stringify(payload));
  } catch (err) {
    // Si supera los 5 MB de localStorage, liberamos esa llave para dejar espacio a CONFIG/QUEUE
    try {
      localStorage.removeItem(STORAGE_KEYS.DATA);
    } catch (e) {}
  }
}

function cargarColaPendiente() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.QUEUE);
    state.pendingQueue = raw ? JSON.parse(raw) : [];
  } catch (e) {
    state.pendingQueue = [];
  }
}

function guardarColaPendiente() {
  localStorage.setItem(STORAGE_KEYS.QUEUE, JSON.stringify(state.pendingQueue || []));
}

async function enviarPeticionPost(url, payload) {
  const body = JSON.stringify({
    ...payload,
    key: state.config.accessKey
  });
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: body
  });
  return response.json();
}

async function vaciarColaPendiente() {
  if (!state.pendingQueue || state.pendingQueue.length === 0) return true;
  if (!state.config.accessKey) return false;

  const url = state.config.scriptUrl || DEFAULT_SCRIPT_URL;
  const restantes = [];
  let huboErrorClave = false;

  for (let i = 0; i < state.pendingQueue.length; i++) {
    const item = state.pendingQueue[i];
    try {
      const res = await enviarPeticionPost(url, item);
      if (!res.ok) {
        if ((res.error || "").toLowerCase().includes("clave")) {
          huboErrorClave = true;
          restantes.push(...state.pendingQueue.slice(i));
          break;
        }
        // Si el servidor devolvió error lógico de negocio (ej. cita no encontrada), no lo reencolamos infinito
        continue;
      }
    } catch (e) {
      restantes.push(...state.pendingQueue.slice(i));
      break;
    }
  }

  state.pendingQueue = restantes;
  guardarColaPendiente();
  return !huboErrorClave;
}

// ============================================================================
// COMUNICACIÓN CON GOOGLE SHEETS (GOOGLE APPS SCRIPT)
// ============================================================================
async function sincronizarDesdeGoogleSheets() {
  if (!state.config.scriptUrl) {
    mostrarToast("Modo Local activo (configura tu URL de Google Sheets cuando gustes)");
    actualizarEncabezado();
    return false;
  }

  const authErrorEl = document.getElementById("authError");
  const authModalEl = document.getElementById("authModal");

  try {
    state.isSyncing = true;
    if (authErrorEl) authErrorEl.classList.add("hidden");
    actualizarEncabezado("Sincronizando...");

    if (state.pendingQueue.length > 0) {
      const okCola = await vaciarColaPendiente();
      if (!okCola) {
        throw new Error("Clave de acceso del consultorio incorrecta.");
      }
    }

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
    return true;
  } catch (err) {
    console.error(err);
    actualizarEncabezado("Error de conexión (Modo Local)", false, true);
    if ((err.message || "").toLowerCase().includes("clave") && authModalEl) {
      state.config.accessKey = "";
      authModalEl.classList.remove("hidden");
    }
    if (authModalEl && !authModalEl.classList.contains("hidden") && authErrorEl) {
      authErrorEl.textContent = err.message;
      authErrorEl.classList.remove("hidden");
    }
    mostrarToast("No se pudo conectar a Google Sheets: " + err.message);
    return false;
  } finally {
    state.isSyncing = false;
  }
}

async function enviarAccionGoogleSheets(payload) {
  const url = state.config.scriptUrl || DEFAULT_SCRIPT_URL;
  if (!state.config.accessKey) {
    const authModalEl = document.getElementById("authModal");
    const authErrorEl = document.getElementById("authError");
    if (authErrorEl) {
      authErrorEl.textContent = "Ingresa la contraseña del consultorio para guardar en Google Sheets.";
      authErrorEl.classList.remove("hidden");
    }
    if (authModalEl) authModalEl.classList.remove("hidden");
    return { ok: false, error: "Falta contraseña de acceso." };
  }

  try {
    if (state.pendingQueue.length > 0) {
      await vaciarColaPendiente();
    }

    const res = await enviarPeticionPost(url, payload);
    if (!res.ok) {
      const serverErr = new Error(res.error || "Error guardando en Google Sheets");
      serverErr.isServerRejection = true;
      throw serverErr;
    }
    actualizarEncabezado("Conectado a Google Sheets", true);
    mostrarToast("Guardado en Google Sheets correctamente");
    return res;
  } catch (err) {
    console.error("Error enviando a Google Sheets:", err);
    const msg = err.message || "Error de conexión";
    if (msg.toLowerCase().includes("clave")) {
      state.config.accessKey = "";
      const authModalEl = document.getElementById("authModal");
      const authErrorEl = document.getElementById("authError");
      if (authErrorEl) {
        authErrorEl.textContent = msg;
        authErrorEl.classList.remove("hidden");
      }
      if (authModalEl) authModalEl.classList.remove("hidden");
      mostrarToast("Error en Google Sheets: " + msg);
    } else if (!err.isServerRejection) {
      state.pendingQueue.push(payload);
      guardarColaPendiente();
      actualizarEncabezado(`Pendientes por subir: ${state.pendingQueue.length}`, false, true);
      mostrarToast(
        `Sin red: guardado localmente (${state.pendingQueue.length} pendiente(s) por sincronizar)`
      );
    } else {
      mostrarToast("Error en Google Sheets: " + msg);
    }
    return { ok: false, error: msg };
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
  reconstruirIndices();
  renderizarEstadisticas();
  renderizarListaPacientes();
  renderizarSelectoresPacientes();
  renderizarExpedienteSeleccionado();
  renderizarAgenda();
  lucide.createIcons();
}

function renderizarEstadisticas() {
  const hoy = obtenerFechaHoy();
  const mesActual = hoy.substring(0, 7); // YYYY-MM

  document.getElementById("statTotalPacientes").textContent = state.pacientes.length;
  document.getElementById("statTotalTratamientos").textContent = state.historial.length;

  const citasHoy = state.agenda.filter(
    (c) => c.Fecha_Cita === hoy && c.Estado !== "Cancelada"
  ).length;
  const citasPendientes = state.agenda.filter(
    (c) => c.Estado === "Programada"
  ).length;

  const ingresosMes = state.historial.reduce((acc, item) => {
    const fecha = String(item.Fecha_Atencion || "");
    if (fecha.startsWith(mesActual)) {
      const monto = parseFloat(item.Costo);
      if (!Number.isNaN(monto)) return acc + monto;
    }
    return acc;
  }, 0);

  document.getElementById("statCitasHoy").textContent = citasHoy;
  document.getElementById("statCitasPendientes").textContent = citasPendientes;
  const statIngresosEl = document.getElementById("statIngresosMes");
  if (statIngresosEl) {
    statIngresosEl.textContent = `$${ingresosMes.toLocaleString("es-MX", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }
}

function renderizarListaPacientes() {
  const container = document.getElementById("patientsListContainer");
  const filtro = (document.getElementById("searchPatientsList").value || "").toLowerCase().trim();

  const filtrados = state.pacientes.filter((p) => {
    if (!filtro) return true;
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

  const MAX_VISIBLES = 100;
  const visibles = filtrados.slice(0, MAX_VISIBLES);

  let html = visibles
    .map((p) => {
      const pid = String(p.ID_Paciente);
      const isSelected = pid === String(state.selectedPatientId);
      const numVisitas = (state.historialPorPaciente.get(pid) || []).length;

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

  if (filtrados.length > MAX_VISIBLES) {
    html += `
      <div class="p-3 text-center text-[11px] font-medium text-sky-700 bg-sky-50 rounded-xl mt-2">
        Mostrando los primeros ${MAX_VISIBLES} de ${filtrados.length} pacientes. Usa el buscador para filtrar por nombre o teléfono.
      </div>
    `;
  }

  container.innerHTML = html;
}

function renderizarSelectoresPacientes() {
  const MAX_SELECT_OPTIONS = 250;
  const baseLista = state.pacientes.slice(0, MAX_SELECT_OPTIONS);

  // Asegurar que el paciente seleccionado actualmente esté disponible en el select si excede los 250
  if (state.selectedPatientId) {
    const selectedIdStr = String(state.selectedPatientId);
    const yaEsta = baseLista.some((p) => String(p.ID_Paciente) === selectedIdStr);
    if (!yaEsta) {
      const selectedObj = state.pacientePorId.get(selectedIdStr);
      if (selectedObj) {
        baseLista.unshift(selectedObj);
      }
    }
  }

  const opcionesHTML =
    `<option value="">-- Paciente Nuevo / Escribir manualmente --</option>` +
    baseLista
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

  const paciente = state.selectedPatientId
    ? state.pacientePorId.get(String(state.selectedPatientId))
    : null;

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

  // Obtener todo el historial del paciente en O(1) ya preordenado del más reciente al más antiguo
  const trabajos = state.historialPorPaciente.get(String(paciente.ID_Paciente)) || [];

  const ultimaVisita = trabajos.length > 0 ? trabajos[0].Fecha_Atencion || "-" : "Sin visitas";
  const totalPagado = trabajos.reduce((sum, t) => {
    const val = parseFloat(t.Costo);
    return sum + (Number.isNaN(val) ? 0 : val);
  }, 0);

  const expUltimaEl = document.getElementById("expUltimaVisita");
  if (expUltimaEl) expUltimaEl.textContent = ultimaVisita;
  const expTotalEl = document.getElementById("expTotalPagado");
  if (expTotalEl) {
    expTotalEl.textContent = `$${totalPagado.toLocaleString("es-MX", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })}`;
  }

  // Renderizar odontograma compacto con piezas tratadas en el historial
  const piezasTratadas = new Set();
  trabajos.forEach((t) => {
    const matches = String(t.Pieza_Dental || "").match(/\b(1[1-8]|2[1-8]|3[1-8]|4[1-8])\b/g);
    if (matches) matches.forEach((m) => piezasTratadas.add(m));
  });
  renderizarOdontogramaResumen(piezasTratadas);

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
  const paciente = state.pacientePorId.get(String(idPaciente));
  if (!paciente) return;

  activarPestana("tab-registrar");
  const select = document.getElementById("regSelectPaciente");
  if (!Array.from(select.options).some((opt) => opt.value === String(paciente.ID_Paciente))) {
    const opt = document.createElement("option");
    opt.value = paciente.ID_Paciente;
    opt.textContent = `${paciente.Nombre_Completo} (${paciente.Telefono || "S/T"})`;
    select.appendChild(opt);
  }
  select.value = paciente.ID_Paciente;
  autocompletarFormularioTratamiento(paciente.ID_Paciente);
};

function autocompletarFormularioTratamiento(idPaciente) {
  const paciente = idPaciente ? state.pacientePorId.get(String(idPaciente)) : null;
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
    citas.sort((a, b) => (a.Hora_Cita || "").localeCompare(b.Hora_Cita || ""));
  } else {
    // En modo "Ver Todas", ordenamos de la más reciente/próxima hacia atrás para mostrar las 200 vigentes
    citas.sort((a, b) => {
      const cmpFecha = (b.Fecha_Cita || "").localeCompare(a.Fecha_Cita || "");
      if (cmpFecha !== 0) return cmpFecha;
      return (a.Hora_Cita || "").localeCompare(b.Hora_Cita || "");
    });
  }

  if (citas.length === 0) {
    container.innerHTML = `
      <div class="p-8 text-center border border-dashed border-slate-200 rounded-2xl text-slate-400 text-sm">
        No hay citas registradas para el filtro seleccionado.
      </div>
    `;
    return;
  }

  const MAX_AGENDA_SIN_FILTRO = 200;
  const hayMasCitas = !filtroFecha && citas.length > MAX_AGENDA_SIN_FILTRO;
  const citasVisibles = hayMasCitas ? citas.slice(0, MAX_AGENDA_SIN_FILTRO) : citas;

  let html = citasVisibles
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
            <button type="button" onclick="enviarRecordatorioWhatsApp('${c.ID_Cita}')"
              title="Enviar recordatorio por WhatsApp"
              class="px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition flex items-center gap-1">
              <i data-lucide="message-circle" class="w-3.5 h-3.5"></i>
              WhatsApp
            </button>
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

  if (hayMasCitas) {
    html += `
      <div class="p-3 text-center text-[11px] font-medium text-indigo-700 bg-indigo-50 rounded-xl mt-2">
        Mostrando las ${MAX_AGENDA_SIN_FILTRO} citas más recientes de ${citas.length} totales. Selecciona una fecha arriba para consultar cualquier día específico.
      </div>
    `;
  }

  container.innerHTML = html;
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
  const paciente = state.selectedPatientId
    ? state.pacientePorId.get(String(state.selectedPatientId))
    : null;
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

  // Tabla de Procedimientos Realizados (lectura O(1) desde índice preordenado)
  const trabajos = state.historialPorPaciente.get(String(paciente.ID_Paciente)) || [];

  const totalAcumulado = trabajos.reduce((sum, t) => {
    const val = parseFloat(t.Costo);
    return sum + (Number.isNaN(val) ? 0 : val);
  }, 0);

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
    foot:
      filasTabla.length > 0
        ? [[
            "TOTAL",
            "",
            `${trabajos.length} procedimiento(s) realizado(s)`,
            "",
            "Acumulado:",
            `$${totalAcumulado.toFixed(2)}`
          ]]
        : undefined,
    theme: "grid",
    headStyles: {
      fillColor: [13, 148, 136],
      textColor: 255,
      fontSize: 9,
      fontStyle: "bold"
    },
    footStyles: {
      fillColor: [241, 245, 249],
      textColor: [15, 23, 42],
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

function descargarReciboUltimaConsultaPDF() {
  const paciente = state.selectedPatientId
    ? state.pacientePorId.get(String(state.selectedPatientId))
    : null;
  if (!paciente) {
    mostrarToast("Selecciona un paciente primero");
    return;
  }

  const trabajos = state.historialPorPaciente.get(String(paciente.ID_Paciente)) || [];

  if (trabajos.length === 0) {
    mostrarToast("El paciente aún no tiene consultas registradas para generar recibo");
    return;
  }

  const fechaUltima = trabajos[0].Fecha_Atencion || obtenerFechaHoy();
  const trabajosFecha = trabajos.filter((t) => (t.Fecha_Atencion || "") === fechaUltima);
  const totalRecibo = trabajosFecha.reduce((sum, t) => {
    const val = parseFloat(t.Costo);
    return sum + (Number.isNaN(val) ? 0 : val);
  }, 0);

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const nombreConsultorio = state.config.clinicName || "Consultorio Dental";

  doc.setFillColor(79, 70, 229);
  doc.rect(0, 0, 210, 32, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.text(nombreConsultorio.toUpperCase(), 14, 14);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.text("COMPROBANTE DE ATENCIÓN Y HONORARIOS ODONTOLÓGICOS", 14, 22);
  doc.text(`Fecha de atención: ${fechaUltima}`, 14, 28);

  doc.setTextColor(30, 41, 59);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text(`Paciente: ${paciente.Nombre_Completo || ""}`, 14, 43);
  doc.setFont("helvetica", "normal");
  doc.text(`Expediente: ${paciente.ID_Paciente || ""}   |   Teléfono: ${paciente.Telefono || "-"}`, 14, 50);

  const filas = trabajosFecha.map((t) => [
    t.Pieza_Dental || "General",
    t.Procedimiento_Realizado || "-",
    t.Observaciones_Evo || "-",
    t.Costo ? `$${Number(t.Costo).toFixed(2)}` : "$0.00"
  ]);

  doc.autoTable({
    startY: 57,
    head: [["Pieza / Zona", "Procedimiento Realizado", "Indicaciones", "Importe"]],
    body: filas,
    foot: [["", "TOTAL DEL DÍA", "", `$${totalRecibo.toFixed(2)}`]],
    theme: "grid",
    headStyles: { fillColor: [79, 70, 229], textColor: 255, fontSize: 9, fontStyle: "bold" },
    footStyles: { fillColor: [238, 242, 255], textColor: [30, 41, 59], fontSize: 10, fontStyle: "bold" },
    bodyStyles: { fontSize: 9 }
  });

  const finalY = doc.lastAutoTable.finalY + 20;
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text("Gracias por su confianza.", 105, finalY, { align: "center" });

  const nombreArchivo = `Recibo_${(paciente.Nombre_Completo || "Paciente").replace(/[^a-zA-Z0-9]/g, "_")}_${fechaUltima}.pdf`;
  doc.save(nombreArchivo);
  mostrarToast("Recibo PDF de la última consulta descargado");
}

function exportarRespaldoCSV() {
  if (state.pacientes.length === 0 && state.historial.length === 0) {
    mostrarToast("No hay datos cargados para exportar");
    return;
  }

  const mapaPacientes = {};
  state.pacientes.forEach((p) => {
    mapaPacientes[String(p.ID_Paciente)] = p;
  });

  const escaparCSV = (val) => {
    const s = String(val ?? "").replace(/"/g, '""');
    return `"${s}"`;
  };

  const encabezados = [
    "ID_Paciente",
    "Nombre_Paciente",
    "Telefono",
    "Edad",
    "Alergias_Antecedentes",
    "Fecha_Atencion",
    "Pieza_Dental",
    "Procedimiento_Realizado",
    "Observaciones_Evo",
    "Costo",
    "Doctor"
  ];

  const filas = [encabezados.map(escaparCSV).join(",")];
  const pacientesConHistorial = new Set();

  state.historial.forEach((h) => {
    const pid = String(h.ID_Paciente || "");
    pacientesConHistorial.add(pid);
    const p = mapaPacientes[pid] || {};
    filas.push(
      [
        pid,
        h.Nombre_Paciente || p.Nombre_Completo || "",
        p.Telefono || "",
        p.Edad || "",
        p.Alergias_Antecedentes || "",
        h.Fecha_Atencion || "",
        h.Pieza_Dental || "",
        h.Procedimiento_Realizado || "",
        h.Observaciones_Evo || "",
        h.Costo || "0",
        h.Doctor || ""
      ]
        .map(escaparCSV)
        .join(",")
    );
  });

  // Incluir pacientes que aún no tienen historial clínico
  state.pacientes.forEach((p) => {
    const pid = String(p.ID_Paciente || "");
    if (!pacientesConHistorial.has(pid)) {
      filas.push(
        [
          pid,
          p.Nombre_Completo || "",
          p.Telefono || "",
          p.Edad || "",
          p.Alergias_Antecedentes || "",
          p.Fecha_Registro || "",
          "",
          "Sin procedimientos aún",
          p.Notas_Generales || "",
          "0",
          ""
        ]
          .map(escaparCSV)
          .join(",")
      );
    }
  });

  const csvContent = "\uFEFF" + filas.join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `Respaldo_Consultorio_Dental_${obtenerFechaHoy()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  mostrarToast("Respaldo CSV descargado para Excel");
}

function abrirWhatsApp(telefono, mensaje) {
  const digitos = String(telefono || "").replace(/\D/g, "");
  if (!digitos) {
    mostrarToast("El paciente no tiene teléfono registrado");
    return;
  }
  // Si tiene 10 dígitos locales (ej. México), anteponemos 52; si ya incluye código, lo usamos tal cual
  const numeroFinal = digitos.length === 10 ? `52${digitos}` : digitos;
  const url = `https://wa.me/${numeroFinal}?text=${encodeURIComponent(mensaje)}`;
  window.open(url, "_blank", "noopener");
}

window.enviarRecordatorioWhatsApp = function (idCita) {
  const cita = state.agenda.find((c) => String(c.ID_Cita) === String(idCita));
  if (!cita) return;
  const clinica = state.config.clinicName || "Consultorio Dental";
  const msg = `Hola ${cita.Nombre_Paciente || ""}, te recordamos tu cita en ${clinica} el día ${cita.Fecha_Cita} a las ${cita.Hora_Cita} hrs (${cita.Motivo_Tratamiento || "consulta dental"}). ¡Te esperamos!`;
  abrirWhatsApp(cita.Telefono, msg);
};

function renderizarOdontogramaResumen(piezasTratadas) {
  const cont = document.getElementById("expOdontogramaResumen");
  if (!cont) return;

  const renderFila = (lista) =>
    lista
      .map((pieza) => {
        const tratada = piezasTratadas.has(pieza);
        return `<span class="tooth-btn ${tratada ? "tooth-badge-treated" : "opacity-60"}">${pieza}</span>`;
      })
      .join("");

  cont.innerHTML = `
    <div class="flex items-center gap-2 min-w-max">
      <div class="flex gap-1">${renderFila(FDI_QUADRANTS.supDer)}</div>
      <span class="text-slate-300 font-bold">|</span>
      <div class="flex gap-1">${renderFila(FDI_QUADRANTS.supIzq)}</div>
    </div>
    <div class="flex items-center gap-2 min-w-max">
      <div class="flex gap-1">${renderFila(FDI_QUADRANTS.infDer)}</div>
      <span class="text-slate-300 font-bold">|</span>
      <div class="flex gap-1">${renderFila(FDI_QUADRANTS.infIzq)}</div>
    </div>
  `;
}

function inicializarOdontogramaSelector() {
  const cont = document.getElementById("odontogramaSelector");
  if (!cont) return;

  const renderFila = (lista) =>
    lista
      .map(
        (pieza) =>
          `<button type="button" data-tooth="${pieza}" class="tooth-btn">${pieza}</button>`
      )
      .join("");

  cont.innerHTML = `
    <div class="flex items-center gap-2 min-w-max">
      <div class="flex gap-1">${renderFila(FDI_QUADRANTS.supDer)}</div>
      <span class="text-slate-300 font-bold">|</span>
      <div class="flex gap-1">${renderFila(FDI_QUADRANTS.supIzq)}</div>
    </div>
    <div class="flex items-center gap-2 min-w-max">
      <div class="flex gap-1">${renderFila(FDI_QUADRANTS.infDer)}</div>
      <span class="text-slate-300 font-bold">|</span>
      <div class="flex gap-1">${renderFila(FDI_QUADRANTS.infIzq)}</div>
    </div>
  `;

  const inputPieza = document.getElementById("regPiezaDental");
  cont.querySelectorAll(".tooth-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pieza = btn.dataset.tooth;
      const etiqueta = `OD ${pieza}`;
      const actuales = inputPieza.value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && !["General", "Arcada Sup.", "Arcada Inf."].includes(s));

      const idx = actuales.findIndex((item) => item === etiqueta || item === pieza);
      if (idx >= 0) {
        actuales.splice(idx, 1);
      } else {
        actuales.push(etiqueta);
      }
      inputPieza.value = actuales.join(", ");
      actualizarOdontogramaSelectorVisual();
    });
  });

  document.querySelectorAll(".zone-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      inputPieza.value = btn.dataset.zone;
      actualizarOdontogramaSelectorVisual();
    });
  });

  inputPieza.addEventListener("input", actualizarOdontogramaSelectorVisual);
}

function actualizarOdontogramaSelectorVisual() {
  const cont = document.getElementById("odontogramaSelector");
  const inputPieza = document.getElementById("regPiezaDental");
  if (!cont || !inputPieza) return;
  const texto = inputPieza.value || "";
  const seleccionadas = new Set(texto.match(/\b(1[1-8]|2[1-8]|3[1-8]|4[1-8])\b/g) || []);
  cont.querySelectorAll(".tooth-btn").forEach((btn) => {
    if (seleccionadas.has(btn.dataset.tooth)) {
      btn.classList.add("tooth-btn-selected");
    } else {
      btn.classList.remove("tooth-btn-selected");
    }
  });
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

  // Configuración / Login Modal (si existiera el botón)
  const btnOpenConfig = document.getElementById("btnOpenConfig");
  if (btnOpenConfig) {
    btnOpenConfig.addEventListener("click", () => {
      document.getElementById("authModal").classList.remove("hidden");
    });
  }

  // Bloquear / Cerrar sesión
  document.getElementById("btnLockSession").addEventListener("click", async () => {
    localStorage.removeItem(STORAGE_KEYS.CONFIG);
    localStorage.removeItem(STORAGE_KEYS.DATA);
    localStorage.removeItem(STORAGE_KEYS.QUEUE);
    await DentalIDB.clear();
    state.config.accessKey = "";
    state.pacientes = [];
    state.historial = [];
    state.agenda = [];
    state.pendingQueue = [];
    state.pacientePorId = new Map();
    state.historialPorPaciente = new Map();
    state.selectedPatientId = null;
    document.getElementById("configAccessKey").value = "";
    document.getElementById("authError").classList.add("hidden");
    renderizarTodo();
    actualizarEncabezado();
    document.getElementById("authModal").classList.remove("hidden");
    mostrarToast("Sesión bloqueada");
  });

  document.getElementById("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const authErrorEl = document.getElementById("authError");
    authErrorEl.classList.add("hidden");

    const clinicInput = document.getElementById("configClinicName");
    const urlInput = document.getElementById("configScriptUrl");
    if (clinicInput) {
      state.config.clinicName = clinicInput.value.trim() || "Consultorio Dental";
    }
    state.config.scriptUrl = urlInput ? urlInput.value.trim() || DEFAULT_SCRIPT_URL : DEFAULT_SCRIPT_URL;
    state.config.accessKey = document.getElementById("configAccessKey").value.trim();

    if (state.config.scriptUrl) {
      const btnConnect = document.getElementById("btnConnect");
      const textoOriginal = btnConnect.innerHTML;
      btnConnect.disabled = true;
      btnConnect.textContent = "Conectando con Google Sheets...";
      const exito = await sincronizarDesdeGoogleSheets();
      btnConnect.disabled = false;
      btnConnect.innerHTML = textoOriginal;
      lucide.createIcons();

      if (!exito) {
        return;
      }
    } else {
      mostrarToast("Sesión iniciada en Modo Local");
    }

    localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(state.config));
    document.getElementById("authModal").classList.add("hidden");
    actualizarEncabezado();
  });

  // Botón Sincronizar
  document.getElementById("btnSyncNow").addEventListener("click", () => {
    sincronizarDesdeGoogleSheets();
  });

  // Botón Exportar Respaldo CSV para Excel
  const btnExportCSV = document.getElementById("btnExportCSV");
  if (btnExportCSV) {
    btnExportCSV.addEventListener("click", exportarRespaldoCSV);
  }

  // Filtro en lista de pacientes (con debounce para escalar a decenas de miles de registros)
  document.getElementById("searchPatientsList").addEventListener(
    "input",
    debounce(() => {
      renderizarListaPacientes();
      lucide.createIcons();
    }, 120)
  );

  // Buscador global superior (con debounce)
  const globalInput = document.getElementById("globalPatientSearch");
  const globalResults = document.getElementById("globalSearchResults");
  globalInput.addEventListener(
    "input",
    debounce(() => {
      const q = globalInput.value.toLowerCase().trim();
      if (!q) {
        globalResults.classList.add("hidden");
        return;
      }
      const matches = state.pacientes
        .filter(
          (p) =>
            (p.Nombre_Completo || "").toLowerCase().includes(q) ||
            (p.Telefono || "").toLowerCase().includes(q) ||
            (p.ID_Paciente || "").toLowerCase().includes(q)
        )
        .slice(0, 30);
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
    }, 120)
  );

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

  // Botón Descargar PDF del expediente completo
  document.getElementById("btnDownloadPDF").addEventListener("click", descargarExpedientePDF);

  // Botón Descargar Recibo PDF de la última consulta
  const btnReceipt = document.getElementById("btnDownloadReceiptPDF");
  if (btnReceipt) {
    btnReceipt.addEventListener("click", descargarReciboUltimaConsultaPDF);
  }

  // Botón Contactar al paciente por WhatsApp
  const btnWaPatient = document.getElementById("btnWhatsAppPatient");
  if (btnWaPatient) {
    btnWaPatient.addEventListener("click", () => {
      const p = state.selectedPatientId
        ? state.pacientePorId.get(String(state.selectedPatientId))
        : null;
      if (!p) return;
      const clinica = state.config.clinicName || "Consultorio Dental";
      const msg = `Hola ${p.Nombre_Completo || ""}, te saludamos de ${clinica}.`;
      abrirWhatsApp(p.Telefono, msg);
    });
  }

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
    const p = state.selectedPatientId
      ? state.pacientePorId.get(String(state.selectedPatientId))
      : null;
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
    let pacienteNuevoCreado = null;

    if (!idPaciente) {
      idPaciente = "PAC-" + Date.now();
      pacienteNuevoCreado = {
        ID_Paciente: idPaciente,
        Nombre_Completo: nombrePaciente,
        Telefono: document.getElementById("regTelefono").value.trim(),
        Edad: document.getElementById("regEdad").value.trim(),
        Alergias_Antecedentes:
          document.getElementById("regAlergias").value.trim() || "Ninguna reportada",
        Notas_Generales: "",
        Fecha_Registro: obtenerFechaHoy()
      };
      state.pacientes.unshift(pacienteNuevoCreado);
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
    actualizarOdontogramaSelectorVisual();

    seleccionarPaciente(idPaciente);
    mostrarToast("Trabajo registrado en el expediente del paciente");

    if (pacienteNuevoCreado) {
      await enviarAccionGoogleSheets({
        action: "guardarPaciente",
        paciente: pacienteNuevoCreado
      });
    }

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
