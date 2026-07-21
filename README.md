# Soporte Exotimer

Backend de atencion y soporte por WhatsApp para Finisher Data.

## Que hace

- Recibe mensajes de WhatsApp Cloud API en `POST /api/webhook`.
- Guarda conversaciones y mensajes en PostgreSQL con Prisma.
- Identifica Timers por tabla `TimerContact` y clasifica Buyers, Organizers y Athletes por IA.
- Responde por WhatsApp usando Meta Cloud API.
- Registra y ejecuta acciones contra endpoints propios de Exotimer cuando el tipo de usuario tiene permiso.

## Tipos de usuario

- `TIMER`: identificado exclusivamente por numero telefonico registrado en `TimerContact`.
- `BUYER`: consulta precios o cotizaciones.
- `ORGANIZER`: solicita cambios de tickets o inscripciones.
- `ATHLETE`: solicita correcciones de resultados.

## Desarrollo local

1. Instalar dependencias:

```bash
npm install
```

2. Crear `.env` usando `.env.example`.

3. Configurar `DATABASE_URL` con una base PostgreSQL. En desarrollo, si `DATABASE_URL` esta vacio, la pantalla de configuracion carga permisos por defecto en modo solo lectura; para guardar cambios se necesita PostgreSQL.

4. Crear la base de datos y ejecutar migraciones:

```bash
npm run prisma:migrate
```

5. Sembrar politicas iniciales:

```bash
npm run prisma:seed-policies
```

6. Levantar el backend:

```bash
npm run dev
```

## Endpoints principales

- `GET /health`: estado del servicio.
- `GET /health/db`: verifica conectividad con PostgreSQL.
- `GET /api/webhook`: verificacion de Meta.
- `POST /api/webhook`: recepcion de mensajes de WhatsApp.
- `GET /api/timers`: lista de Timers autorizados.
- `POST /api/timers`: crea o actualiza un Timer por telefono.
- `GET /api/conversations`: lista conversaciones.
- `GET /api/conversations/:id`: detalle de conversacion, mensajes y acciones.
- `GET /api/actions?status=PROPOSED`: lista acciones propuestas por IA pendientes de confirmacion.
- `POST /api/actions/:id/execute`: ejecuta una accion propuesta con confirmacion humana.
- `POST /api/actions/:id/skip`: omite una accion propuesta.

Ejemplo para registrar un Timer:

```bash
curl -X POST http://localhost:4000/api/timers \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"Timer Principal\",\"phone\":\"+51999999999\"}"
```

## Acciones Exotimer

Las acciones estan centralizadas en `backend/src/services/exotimerClient.js`.
El inventario de endpoints y casos detectados en `app-exotimer` esta en `docs/EXOTIMER_INTEGRATION_ANALYSIS.md`.

- Lecturas seguras: listar competencias, buscar competencia, consultar eventos, tickets, inscripciones, resultados, raws, readers y validacion pre-carrera.
- Escrituras acotadas: registrar consulta comercial y registrar caso de correccion de resultado.
- Escrituras con confirmacion humana: cambiar tickets, crear raw manual, editar hora de salida y editar tiempos de resultado.

Las acciones con riesgo quedan como `PROPOSED` y se ejecutan desde el panel de confirmaciones o por `POST /api/actions/:id/execute`.

## Variables de entorno

- `DATABASE_URL`: PostgreSQL.
- `META_ACCESS_TOKEN`: token permanente o de sistema de Meta.
- `META_WABA_ID`: id del WhatsApp Business Account.
- `META_PHONE_NUMBER_ID`: id del numero de WhatsApp.
- `META_WEBHOOK_VERIFY_TOKEN`: token que configuras en Meta para verificar el webhook.
- `META_GRAPH_VERSION`: version de Graph API.
- `OPENAI_API_KEY`: activa clasificacion y respuestas IA.
- `OPENAI_MODEL`: modelo para clasificacion/respuesta. Por compatibilidad con `finanzas-platform`, usar `gpt-4.1`.
- `RACELINE_API_BASE_URL`: gateway de los microservicios Race Line, por ejemplo `https://dev.raceline.app`.
- `RACELINE_API_EMAIL` y `RACELINE_API_PASSWORD`: cuenta de servicio de Identity usada para obtener el Bearer JWT.
- `RACELINE_API_TOKEN`: token opcional; las credenciales son preferibles porque permiten renovar la sesion ante un `401`.
- `EXOTIMER_API_BASE_URL`, `EXOTIMER_API_TOKEN`, `EXOTIMER_API_USER` y `EXOTIMER_API_PASSWORD`: aliases legacy aceptados durante la migracion.
- `PUBLIC_BASE_URL`: URL publica del servicio.

## Despliegue en DigitalOcean Apps

El archivo `.do/app.yaml` define tres componentes:

- `api`: servicio Node/Express.
- `web`: sitio estatico Vite/React.
- `soporte-db`: PostgreSQL administrado enlazado por `DATABASE_URL=${soporte-db.DATABASE_PRIVATE_URL}`.

Para produccion, crea primero un cluster PostgreSQL administrado llamado `soporte-exotimer-db` o ajusta `cluster_name` en `.do/app.yaml` al nombre real del cluster. DigitalOcean requiere `cluster_name` para bases de datos de produccion asociadas al App.

1. Reemplazar `github.repo` en `.do/app.yaml` por el repositorio real.
2. Crear o seleccionar el cluster PostgreSQL administrado.
3. Configurar secretos en DigitalOcean: Meta, OpenAI y Exotimer.
4. Desplegar con App Platform usando `.do/app.yaml`.
5. El comando de build del API:

```bash
npm install && npm run prisma:generate
```

6. El comando de run del API ejecuta migraciones, inicializa politicas y arranca:

```bash
npm run prisma:deploy && npm run prisma:seed-policies && npm start
```

7. Verificar:

```bash
curl https://TU-DOMINIO/health
curl https://TU-DOMINIO/health/db
```

8. En Meta Developers, configurar el webhook:

```text
https://TU-DOMINIO/api/webhook
```

9. Suscribir el campo `messages` en WhatsApp Business Account.
