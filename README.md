# Sistema de Agenda y Expediente Clínico Electrónico Dental

Sistema web para consultorio odontológico conectado a **Google Sheets** y listo para alojarse en **GitHub Pages**.

## Características principales
1. **Directorio y Buscador de Pacientes:** Encuentra a cualquier paciente al instante cuando llega al consultorio y abre su **Expediente Clínico Electrónico** con todas sus visitas anteriores.
2. **Registro de Tratamientos por Fecha:** Registra el nombre del paciente, qué procedimiento se le realizó, pieza dental, notas de evolución, costo y fecha.
3. **Descarga de Expediente en PDF:** Genera un documento PDF profesional con membrete del consultorio, ficha médica/alergias del paciente y la tabla cronológica de todos los trabajos realizados.
4. **Agenda de Citas:** Control de citas por fecha y hora con botón directo para atender al paciente y pasar a su expediente.
5. **Privacidad y Seguridad:** Ningún dato de los pacientes se guarda en el repositorio de GitHub. Todos los datos viven únicamente en tu hoja privada de **Google Sheets** protegida mediante clave de acceso en `google-apps-script.gs`.

## Archivos del proyecto
- `index.html`: Interfaz completa del sistema odontológico.
- `styles.css`: Estilos visuales de la aplicación.
- `app.js`: Lógica de expedientes, agenda, generación de PDF y sincronización con Google Sheets.
- `google-apps-script.gs`: Código para copiar y pegar en `Extensiones > Apps Script` dentro de tu archivo de Google Sheets.
