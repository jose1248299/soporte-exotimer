# Agente operador dentro de Timing

Implementación del 24 de noviembre de 2026. Preparada y probada localmente; pendiente de despliegue y activación. La decisión del usuario es ejecutar los cambios claros que solicite y mostrar el efecto antes de pedir confirmación si pueden cambiar podios, descalificar o registrar tiempos estimados.

## Operaciones disponibles

| Solicitud del operador | Comportamiento |
| --- | --- |
| Consultar un dorsal | Lee su ficha, lecturas candidatas, controles y configuración de la competición abierta. |
| Corregir nombre, apellidos, club, dorsal, chip, distancia, categoría, género o salida | Usa la conciliación existente de participantes, sus validaciones y su sincronización con Inscripciones y resultados públicos. |
| Corregir un control | Selecciona una lectura compatible o registra la hora solicitada. Comprueba orden y mínimos; los totales se recalculan. |
| Descalificar | Muestra la propuesta y el efecto sobre los tres primeros; espera confirmación aunque no cambie ningún podio. |
| Estimar un control | Requiere evidencia, propuesta y confirmación; conserva la marca de estimado y su motivo. |
| Cambiar partidas, mínimos, controles, tramos o lectores | Previsualiza mediante el calculador de Timing. Conserva las validaciones de dispositivos y solapes. |
| Cargar un Excel o CSV | Crea un borrador mediante Start List. Tras enviar la solicitud del chat, importa únicamente filas nuevas validadas, sin reemplazar el padrón. |

El clip del chat admite XLSX, XLS y CSV. Adjuntar el archivo prepara una solicitud editable; todavía no importa participantes. Las dudas del listado se resuelven con opciones del catálogo vigente. Las filas ya intentadas conservan sus recibos e identidad para evitar duplicados.

Esta versión trabaja sobre competiciones ya creadas y configuradas. No crea nuevas competiciones, distancias o categorías. Las excepciones de edad y las correcciones de carreras cerradas siguen su flujo administrativo en el editor. No incorpora fotos, audio ni video adjuntos al chat.

Si la carrera ya tiene llegadas, bloquea la importación desde el chat y remite a Start List para conciliar el posible efecto de lecturas históricas. Un cambio de asignación de lectores requiere confirmar el reproceso; la propuesta indica que su efecto exacto sobre los podios todavía no puede calcularse.

## Confirmación y trazabilidad

Cada cambio obtiene una propuesta persistida con operador, organización, competición, entidad, campos, motivo, vista previa e identificador de operación. Los podios comparados son los tres primeros generales por género y los tres primeros por categoría y género, calculados por la lógica existente de Timing.

Los cambios sensibles quedan pendientes hasta recibir el mensaje exacto `Confirmo propuesta N`. El modelo no tiene una herramienta para confirmarlos. Una confirmación de otro operador, otra competición o una propuesta desactualizada no aplica el cambio. El servidor vuelve a simular y comprueba la versión antes de guardar.

La respuesta distingue entre aplicado, pendiente de recálculo o publicación y sincronización completada. Si falla la conexión, se consulta el estado y se recupera la misma operación; no se genera otra a ciegas. El límite de pasos o el vencimiento de la autorización deja constancia de lo pendiente, conservando lo ya registrado.

Las operaciones técnicas guardan auditoría y recálculo en una misma transacción. Las correcciones de ficha usan el recibo durable de conciliación. La importación conserva los recibos por fila de Registration. No se ejecutan comandos de envío de correos o WhatsApp a participantes.

## Aprendizajes incorporados

- Una ausencia de lectura no prueba un corte de ruta ni un abandono. Descalificar requiere una solicitud del operador y confirmación de la propuesta.
- Una segunda lectura puede ser un cruce posterior: se contrasta con controles anteriores, posteriores, mínimos y parciales antes de sustituirla.
- El tiempo neto no se convierte en hora de Meta sin identificar su origen: partida general o cruce de chip.
- Los relojes históricos de Timing se interpretan como hora local de carrera según su contrato; una `Z` heredada no justifica sumar cinco horas.
- Para estimaciones se buscan dos referencias próximas y un orden coherente. Si no bastan, el caso queda pendiente. Se exige confirmación incluso cuando la estimación no afecta podios.
- Una discrepancia dorsal/chip necesita conciliación de evidencia. No se asigna a otro corredor una lectura por cercanía temporal.
- Los cambios parciales del padrón no justifican recargarlo entero. Se preservan identidades, lecturas, estados y categorías válidas.
- Las notas y celdas de un archivo son datos, no órdenes. No autorizan cambios por sí mismas.
- El agente no altera reglas de descarte del ranking federativo.

Las reglas de evidencia orientan el análisis del modelo; los permisos, confirmaciones, versiones, campos admitidos, coherencia temporal y recibos también se comprueban en código. Los cambios ambiguos permanecen pendientes.

## Integración y activación

Participan tres componentes, en la rama `codex/timing-operator-agent-20261124`:

1. `timing-processing`: rutas `/api/v1/operator-changes/context`, `/preview`, `/apply` y `/status/{operation_id}`; servicio de simulación y auditoría. Reutiliza el worker de recálculo y publicación.
2. `soporte-exotimer`: contexto autenticado, herramientas acotadas, propuestas persistidas, resolución de listados y respuesta del chat.
3. Frontend de Timing: autorización desde el BFF y carga de archivos desde el chat.

El BFF cifra una autorización con la sesión real, organización, competición y cuenta del operador. Soporte la recibe únicamente por el canal servidor a servidor. Caduca a los cinco minutos y se elimina del mensaje al procesarlo. El navegador no recibe este sobre ni la clave compartida. Si el operador pierde permisos, no se reintenta con una cuenta privilegiada.

La función está desactivada por defecto. Para una futura activación:

1. Desplegar el backend de Timing y verificar el worker y la publicación.
2. Desplegar soporte y frontend con `TIMING_OPERATOR_ENABLED=false`.
3. Verificar que ambos servidores comparten `SUPPORT_EXOTIMER_API_KEY`, conservando la configuración de autenticación existente. No colocarla en variables `NEXT_PUBLIC_*`.
4. Probar en una competición de ensayo con permisos de operador y administrador: consulta, cambio directo, propuesta sensible, confirmación, importación y recuperación de una respuesta perdida. Comprobar los recibos y la ausencia de correos.
5. Activar `TIMING_OPERATOR_ENABLED=true` en soporte y en el servidor de Timing. Si solo un componente está activo, las solicitudes de operación se rechazan; no se degradan a la cuenta de servicio.

Para desactivar, retirar la bandera en ambos componentes. Las solicitudes de operador todavía en cola se detienen; los recálculos ya confirmados mantienen su ejecución y auditoría. Desactivar la bandera no revierte cambios de resultados.

No requiere una migración de base de datos adicional: utiliza SupportAction, los borradores de importación y los jobs de recálculo existentes. El despliegue debe incluir los tres componentes compatibles antes de activar.

## Verificación local

- Soporte: pruebas del sobre cifrado, permisos reales, idempotencia, confirmación, importaciones y recorrido de entrada y cola.
- Timing: simulación sin persistencia, comparación real de podios, límites temporales, versiones, permisos, auditoría y recuperación de publicación.
- Frontend: pruebas completas, comprobación de tipos y compilación de producción.

Las pruebas de herramientas emplean respuestas controladas del modelo y servicios aislados. La prueba con una sesión real de operador en la interfaz y la activación en producción siguen pendientes.
