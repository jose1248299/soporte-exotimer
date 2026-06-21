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
  "- La Creacion con IA sube bases, brochure o reglamento a /api/competitions/ai-create.",
  "- Ese endpoint usa OpenAI Responses con archivo input_file y extrae JSON: nombre, fecha, pais/ciudad/deporte/organizador sugeridos, horas, pago, distancias, categorias, tickets, supuestos y advertencias.",
  "- El sistema resuelve catalogos reales de pais, ciudad, deporte y organizador; si no encuentra organizador puede usar fallback y advertir.",
  "- Crea la competencia en /api/competition/create/.",
  "- Si el archivo es imagen se usa como banner; si es PDF se renderiza la primera pagina como banner.",
  "- Luego actualiza detalles de inscripcion en /api/competition/{id}/update/: description con pagos, bases, enlaces y adjunta el PDF como bases_competition cuando aplica.",
  "- Despues crea configuracion de eventos/distancias en /api/competition/event/create/ con puntos, salidas, categorias, tickets y lectores automaticos.",
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

function buildExotimerAssistantKnowledge() {
  return [
    ...SYSTEM_USER_CONTEXT,
    ...AI_COMPETITION_CREATION_CONTEXT,
    ...AI_START_LIST_CONTEXT,
    ...USER_MANUAL_CONTEXT,
  ].join("\n");
}

module.exports = {
  buildExotimerAssistantKnowledge,
};
