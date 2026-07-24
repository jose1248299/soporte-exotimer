const SYSTEM_USER_CONTEXT = [
  "Contexto para SYSTEM_USER dentro de ExoTimer:",
  "- Es un usuario autenticado del sistema, no un atleta externo. Puede pedir consultas, cambios operativos y explicaciones de uso.",
  "- El mensaje llega con contexto confiable de ExoTimer: competitionId, page y section. Usa ese competitionId antes de pedir el nombre de la competencia.",
  "- Si la consulta solo busca informacion o instrucciones, responde con guia clara y no ejecutes acciones.",
  "- Si la consulta pide cambiar datos y hay identificadores suficientes, devuelve una accion ExoTimer concreta.",
  "- Si falta el identificador de la entidad afectada, pide el dato exacto: dorsal/resultId, ticket, inscripcion, salida, raw o participante.",
  "- No inventes endpoints ni afirmes que existe una automatizacion si no hay accion disponible.",
];

const AI_COMPETITION_CREATION_CONTEXT = [
  "Flujo IA de creacion/configuracion de competencias:",
  "- En ExoTimer el modal Crear Competencia permite Creacion Manual o Creacion con IA.",
  "- La Creacion con IA analiza bases, brochure o reglamento y extrae JSON: nombre, fecha, pais/ciudad/deporte/organizador sugeridos, horas, pago, eventos, categorias, tickets, supuestos y advertencias.",
  "- El sistema resuelve catalogos reales de pais, ciudad, deporte y organizador; si no encuentra organizador puede usar fallback y advertir.",
  "- Race Line crea competencia, eventos, categorias y timing de forma atomica con POST /catalog/api/v1/competitions/setup?create_timing_configs=true.",
  "- El banner y el reglamento se cargan con POST /catalog/api/v1/competitions/{id}/media/banner_url y /media/bases_url.",
  "- Los tickets se crean en POST /registration/api/v1/tickets/ y se vinculan a event_id y category_ids reales.",
  "- Tickets: solo usa montos numericos reales de inscripcion. No convierte transporte, multas, merchandising o textos como 'segun fase' en tickets.",
  "- Si hay datos de pago pero no precios numericos, puede crear tickets fallback o devolver que se completen precios manualmente segun el caso.",
  "- Para triatlon/duatlon/acuatlon trata modalidades competitivas como eventos, no los segmentos internos como tickets separados.",
];

const AI_START_LIST_CONTEXT = [
  "Flujo IA de normalizacion de listados Start List:",
  "- En /competitions/[id]/start-list el usuario puede subir CSV/XLS/XLSX, elegir hoja, detectar cabecera, mapear campos y homologar valores.",
  "- El endpoint /api/start-list/ai-normalize analiza headers, schemaFields, muestra de filas, valores unicos, distanceOptions y categorias permitidas por distancia.",
  "- Devuelve sugerencias JSON: mapping, distanceRenameMap, genderRenameMap, categoryRenameMap, categoryMode y warnings.",
  "- Reglas importantes: usar solo columnas existentes, no inventar participantes, mapear nombre completo como fullNameFirst/fullNameLast si viene en una sola columna.",
  "- Si hay dorsal pero no chip, puede sugerir chip desde dorsal cuando la carrera no usa chip fisico.",
  "- Columnas como ticket/entrada/inscripcion pueden contener distancia; debe extraer la distancia deportiva e ignorar beneficios comerciales como bus o polo.",
  "- distancia debe homologarse a una opcion real; genero a Masculino/Femenino; categoria a una categoria exacta permitida para la distancia.",
  "- salida solo se mapea si viene en archivo; si no, se asigna luego desde salidas configuradas por distancia.",
  "- DNI y email son importantes; intenta mapear al menos uno si existe.",
  "- Luego el usuario revisa observaciones, categorias, salidas, filas normalizadas y envia el CSV normalizado al importador masivo.",
];

const USER_MANUAL_CONTEXT = [
  "Manual de usuario ExoTimer, resumen operativo:",
  "- Etapas recomendadas: preparar catalogos, crear competencia, configurar distancias/puntos/salidas/categorias, cargar participantes, validar datos, operar raws/resultados y cerrar evento.",
  "- Catalogos: organizadores, decoders/readers y camaras deben existir antes de operar competencias complejas.",
  "- Competencia: agrupa datos generales, distancias, participantes, tickets, configuracion tecnica y resultados.",
  "- Configuracion de evento: cada distancia/evento necesita salida/meta, puntos, tiempo minimo, salidas, categorias, locaciones, decoders y camaras cuando aplica.",
  "- Tickets: crear tickets por distancia con fechas, moneda y monto; configurar metodo de pago, instrucciones, bases, WhatsApp y campos extra.",
  "- Participantes: importar o agregar manualmente, revisar dorsales/chips duplicados, homologar distancia, genero, categoria y salida.",
  "- Raws: son lecturas crudas de chip, tiempo y equipo; se cargan, filtran por ventana y pueden vincularse a resultados.",
  "- Validaciones y metricas: usar para detectar duplicados, chips compartidos, raws no asignados, tiempos sospechosos y salud operativa.",
  "- Video Finish y Respaldo Manual: sirven para evidencia visual y correcciones controladas; no ajustar tiempos sin causa clara.",
  "- Reclamos: permiten revisar conversaciones/casos vinculados a una competencia.",
  "- Problemas frecuentes: si no aparece una distancia, revisar configuracion y nombres exactos; si hay muchos raws no asignados, revisar chips/dorsales/rangos/locacion; si no se ve camara, revisar catalogo y asignacion a locacion.",
];

const TIMER_EVENT_CREATION_CONTEXT = [
  "Conocimiento operativo para TIMER sobre creacion/configuracion de eventos:",
  "- Un TIMER puede preparar una competencia desde mensaje, afiche o reglamento PDF. Primero usa EXOTIMER_PREVIEW_COMPETITION_SETUP; nunca crea directamente.",
  "- El preview extrae nombre, fecha, sede, catalogos, eventos, categorias, timing, tickets, precios, pagos y archivos; tambien detecta duplicados.",
  "- Datos minimos para aplicar: nombre, fecha, pais, ciudad, deporte, organizador y al menos un evento. Categorias y tickets pueden quedar vacios solo si el Timer lo acepta expresamente.",
  "- Catalogos Race Line: /catalog/api/v1/countries, /catalog/api/v1/cities, /catalog/api/v1/sports/ y /identity/api/v1/organizations/.",
  "- La aplicacion confirmada usa EXOTIMER_APPLY_COMPETITION_SETUP y conserva el objeto plan firmado sin reconstruirlo.",
  "- La competencia y sus eventos se crean con /catalog/api/v1/competitions/setup; cada evento puede incluir categorias, Salida, Meta, waves, ruta y readers.",
  "- Los tickets se crean en /registration/api/v1/tickets/ con event_bindings y category_ids reales. Para duplas/equipos conserva team_size en metadata.",
  "- Los pagos se guardan en description.type_pay y description.payments_details. No inventes bancos, cuentas, CCI ni precios.",
  "- El afiche se conserva como banner_url y el PDF como bases_url cuando fueron recibidos por WhatsApp.",
  "- El estado por defecto es draft. Solo usa published si el Timer lo pide o lo confirma dentro del plan.",
  "- Si no hay organizador confirmado, se puede usar el organizador de catalogo Sin Asignar solo si el usuario lo autoriza.",
  "- No inventes categorias. Si el usuario pide no crearlas, deja claro que se deben crear o asociar luego al cargar listado de participantes.",
  "- La verificacion final lee /catalog/api/v1/competitions/{id}/full, /registration/api/v1/tickets/?competition_id={id} y /timing/api/v1/raws/config/salidas/{id}/.",
  "- Si una etapa posterior falla, el plan puede reanudarse por fingerprint y completar tickets o archivos sin duplicar la competencia.",
  "- Aprendizaje de produccion: PowerShell puede mostrar caracteres acentuados con mojibake; para validar nombres con acentos conviene verificar UTF-8/codepoints o usar fetch/Node.",
  "- Aprendizaje de produccion: el importador de participantes es sensible a espacios finales en DNI/documento y puede generar fallos Participante no encontrado.",
  "- Aprendizaje de produccion: si se reintenta una importacion parcial, verificar duplicados por dorsal/chip y conteo total porque puede haber efectos parciales.",
];

function buildExotimerAssistantKnowledge() {
  return [
    ...SYSTEM_USER_CONTEXT,
    ...AI_COMPETITION_CREATION_CONTEXT,
    ...AI_START_LIST_CONTEXT,
    ...USER_MANUAL_CONTEXT,
  ].join("\n");
}

function buildTimerAssistantKnowledge() {
  return [
    ...TIMER_EVENT_CREATION_CONTEXT,
    ...AI_START_LIST_CONTEXT,
  ].join("\n");
}

module.exports = {
  buildExotimerAssistantKnowledge,
  buildTimerAssistantKnowledge,
};
