# Reloj checador backend

Servicio local para descargar, sin borrar, las checadas de dispositivos ZKTeco por TCP/IP.

## Inicio

1. Copie `.env.example` a `.env` (PostgreSQL se publica en el puerto local `5435`).
2. Ejecute `docker compose up -d`.
3. Ejecute `npm install` y después `npm run dev`. La instalación aplica un parche local al decodificador TCP de `node-zklib` para conservar los campos de verificación y estado de asistencia.
4. Abra `http://127.0.0.1:3005/docs` o ejecute las solicitudes de `requests/reloj-checador.http`.

La sincronización de fotos de usuario requiere un puente local en Windows con el SDK de ZKTeco; configure `ZK_PHOTO_BRIDGE_URL` y siga el contrato de `docs/sdk-bridge.md`. Sin ese servicio, las listas de usuarios siguen disponibles y las fotos aparecen cuando se sincronizan.

## Configuración del SilkBio-100TC

- Asigne una IP fija o una reserva DHCP al reloj.
- En el menú de comunicación, configure TCP/IP y el puerto `4370`.
- Habilite la comunicación standalone y, para la primera validación, use `Comm Key` igual a `0`.
- Antes de conectar, confirme que la computadora puede alcanzar la IP del reloj.

La ruta `POST /devices/:id/sync-attendance` solo lee y copia registros; no hay rutas ni comandos que borren las checadas del equipo.

Use `POST /devices/:id/sync-users` para copiar el catálogo de usuarios del reloj. Se almacenan el número de usuario, nombre, rol y tarjeta; contraseñas y datos biométricos se descartan. Una vez sincronizados, `GET /attendance` añade `userName` a cada checada cuando existe una coincidencia.

Para un resumen por persona use `GET /users/:userId/attendance-summary?deviceId=:deviceId`. El estado `punchState` del reloj identifica entrada, salida, descansos y tiempo extra; si algún registro no trae un estado reconocido, el resumen lo infiere cronológicamente e indica `inferred`. También señala `openEntry` cuando falta una salida. Las respuestas incluyen campos `*Local` en `America/Mexico_City`; los valores ISO originales se conservan en UTC.

## Sucursales, horarios y reglas

Todas las entidades nuevas usan UUID. La sucursal usa su UUID como único identificador y lo genera automáticamente al crearla; los números de empleado y del reloj se conservan como referencias externas.

- `GET /branches`, `POST /branches`, `PUT /branches/:id`: sucursales, dirección, contacto y zona horaria.
- `PATCH /devices/:id`: edición del nombre, IP, puerto, driver, intervalo y estado de sincronización del mismo reloj. Los dispositivos activos no pueden repetir la combinación de IP y puerto.
- `GET /branch-policies`, `POST /branches/:id/policies`: versiones de tolerancias y acumulación con `effectiveFrom`.
- `GET /work-schedules`, `POST /work-schedules`: roles de jornada y comida. `isDefault` establece la base de la sucursal.
- `GET /schedule-assignments`, `POST /organization/assignments`: asignación individual o masiva de sucursal y horario en una transacción. Acepta `employeeIds`, `deviceUserIds`, `deviceIds`, `effectiveFrom`, `branchId` y `scheduleId`. `scheduleId: null` restaura el horario base desde esa fecha. Los relojes solo reciben sucursal.
- `GET /employees`, `POST /employees`, `GET /employees/:id`, `PATCH /employees/:id`: ficha única de cada persona. Las referencias importadas son opcionales y el UUID es la identidad principal. `identificationStatus` distingue confirmados y pendientes; `clockRecords` conserva el registro actual e históricos del reloj.
- `POST /employees/:id/identify`: confirma una ficha pendiente o la asocia a `targetEmployeeId`. Los datos originales y conflictos se guardan en el historial. `useAsAssignedClock` selecciona ese registro como reloj actual.
- `POST /employees/:id/clock-record`: asigna un `clockRecordId` de la misma sucursal; conserva las asignaciones anteriores como históricas.
- `GET /employees/:id/history`: instantáneas originales, asociaciones de identidad e historial de reloj.
- `PATCH /users/:id/profile`: ruta de compatibilidad que actualiza la ficha canónica del empleado. La identificación se administra desde Empleados → Pendientes.
- `GET /attendance/daily?from=YYYY-MM-DD&to=YYYY-MM-DD`: jornadas, movimientos inferidos, incidencias, acumulados y descuentos del día. Filtros opcionales: `branchId` y `subjectId`.
- `GET /attendance/deductions`: mismo rango y filtros; incluye descuentos vigentes y anulados por recálculo.
- `POST /attendance/recalculate`: reconstrucción transaccional e idempotente de jornadas, incidencias y descuentos. También se ejecuta después de sincronizar checadas y modificar configuraciones relevantes.

La inicialización histórica del SilkBio existente conserva sus asignaciones a México. En bases nuevas, las sucursales se registran desde la interfaz y no se generan a partir de los códigos del catálogo importado. Los UUID existentes se conservan durante la migración. Los horarios y sus reglas se administran desde la interfaz con fecha de vigencia.

En **Dispositivos → Editar** se puede cambiar el nombre y la conexión sin recrear el reloj. La asignación de sucursal se gestiona por separado con su historial de vigencias. En **Empleados → Editar** se muestran Nombre(s), Apellidos, RFC, NSS, sucursal, reloj e ID del reloj. Los datos técnicos de origen permanecen en **Historial**. Los RFC modificados se normalizan a mayúsculas y los NSS nuevos o modificados requieren 11 dígitos y conservan sus ceros iniciales. Las sincronizaciones del reloj conservan estos datos.

### Estado y nombres del empleado

El switch **Activo / Dado de baja** guarda `isActive`. La baja utiliza automáticamente la fecha local de la sucursal; reactivarlo limpia la baja vigente y conserva la fecha de alta original. Cada transición se registra en `employee_status_events`, con estado anterior, fechas, zona horaria e instantánea de la ficha. Los reintentos del mismo estado no duplican el historial. Las fechas de alta/baja son de consulta y el API rechaza su modificación manual. Los empleados nuevos reciben fecha de alta automática.

Los nombres y apellidos se precargan respetando el formato de apellidos primero del catálogo, las referencias del reloj y los apellidos compuestos. Los registros con solo nombre se cargan en Nombre(s); los identificadores sin nombre real siguen pendientes. `originalName` conserva íntegro el nombre original y `nameSplitMethod` identifica el criterio de separación. Los datos ya corregidos manualmente no se sobrescriben durante la precarga ni las sincronizaciones.

### Registro unificado y conservación de información

La interfaz utiliza exclusivamente **Empleados**; `/users` redirige a `/employees`. Cada persona tiene una ficha y un reloj actual de su sucursal. Los registros `device_users` se conservan internamente como identificadores técnicos y evidencia original del equipo, con sus nombres, tarjetas, perfiles anteriores y fotos; ya no ofrecen una ficha personal separada. Los registros nuevos sin coincidencia comprobada generan empleados pendientes. La sincronización de checadas también detecta IDs que todavía no aparecen en el catálogo descargado.

La migración 009 conserva los UUID de empleados existentes y reutiliza el UUID del registro del reloj para cada ficha pendiente. Guarda instantáneas previas, copia las asignaciones a la identidad canónica y mantiene los UUID de jornadas, incidencias y descuentos existentes. Las asociaciones manuales conservan la ficha anterior como histórica, junto con una copia completa de sus datos y asignaciones. El historial de fotos y las checadas originales permanecen ligados al reloj de origen.

Antes de migrar, `npm run backup:database` crea un archivo PostgreSQL completo, un manifiesto de cantidades y checksums, y verifica el respaldo restaurándolo en una base temporal. Para el PostgreSQL de Docker: `PG_CONTAINER=reloj-checador-postgres-1 npm run backup:database`. Los archivos están en `backups/`, excluidos del control de versiones. Después de migrar, `PG_CONTAINER=reloj-checador-postgres-1 npx tsx scripts/verify-employee-unification.ts backups/<manifiesto>.json` compara los registros originales, fotos y relaciones con el respaldo restaurado y genera un informe de verificación.

El regreso esperado es la salida real más la duración asignada. Con tolerancia cero, cualquier retraso posterior al límite cuenta. Salir tarde y regresar tarde generan dos incidencias de comida. Lecturas repetidas con menos de un minuto de diferencia conservan su registro original y se identifican como repetidas. Las jornadas con checadas faltantes o ambiguas no reciben movimientos inventados.

El driver TCP/IP interpreta las fechas locales de `node-zklib` con la zona horaria de la sucursal antes de guardarlas en UTC. Por ejemplo, Cancún usa `America/Cancun`, una hora adelante de Ciudad de México. La hora original se conserva en `rawData.deviceLocalTime`; una nueva sincronización corrige las horas por número de registro del reloj sin duplicar las checadas.

La zona se elige en **Sucursales → Editar → Zona horaria**. Al guardar se recalculan las jornadas y se actualizan las vistas. **Checadas** usa la zona de la sucursal o reloj seleccionado y consulta el día completo entre sus medianoches locales; con todas las sucursales utiliza Ciudad de México como referencia. Los cambios de visualización conservan los instantes UTC almacenados. Las zonas fronterizas respetan sus cambios estacionales de horario.

Los contadores de llegada y comida son independientes. Con tres retardos permitidos, el cuarto genera un día de descuento y consume ese grupo. El siguiente grupo comienza con su primer retardo. Se puede elegir mes calendario o periodos de 30 días desde el primer retardo; el extremo final del periodo es exclusivo. Los descuentos son registros de días para consulta y nómina, no movimientos bancarios. Un recálculo conserva los UUID de las incidencias y descuentos que siguen vigentes; las sanciones que dejan de corresponder quedan anuladas con historial.

El resumen anterior basado en `punchState` sigue disponible para diagnóstico. La clasificación por horarios es la de `/attendance/daily` y la vista **Asistencia diaria**.

## Verificación

Ejecute `npm run typecheck` y `npm test`. Para incluir PostgreSQL, configure `INTEGRATION_DATABASE_URL` con una base de pruebas y ejecute `npm test`. Las pruebas de organización y unificación crean esquemas aislados y los eliminan al terminar; cubren migraciones repetidas, relojes con IDs iguales, asignaciones con historial, tolerancias, descuentos, conservación de fotos/perfiles y recálculo sin duplicar descuentos.
