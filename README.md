# Reloj checador backend

Servicio local para descargar, sin borrar, las checadas de dispositivos ZKTeco por TCP/IP.

## Inicio

Requiere Node.js `^20.19`, `^22.12` o `>=24` y PostgreSQL 16. Verificado con Node.js 22.18.

1. Copie `.env.example` a `.env` (PostgreSQL se publica en el puerto local `5435`).
2. Ejecute `docker compose up -d`.
3. Ejecute `npm ci`. La instalación genera Prisma Client y aplica el parche TCP de `node-zklib` que conserva verificación y estado de asistencia.
4. En una base nueva, ejecute `npm run migrate`. Para adoptar una base existente, siga la sección de Prisma antes del primer despliegue.
5. Ejecute `npm run dev` y abra `http://127.0.0.1:3005/docs` o use `requests/reloj-checador.http`.

La sincronización de fotos de usuario requiere un puente local en Windows con el SDK de ZKTeco; configure `ZK_PHOTO_BRIDGE_URL` y siga el contrato de `docs/sdk-bridge.md`. Sin ese servicio, las listas de usuarios siguen disponibles y las fotos aparecen cuando se sincronizan.

## Arquitectura

```text
src/
  domain/
    entities/       # Entidades, tipos y reglas puras
    dtos/           # Datos de entrada y filtros
    datasources/    # Contratos de persistencia y relojes
    repositories/   # Contratos de repositorios y UnitOfWork
    use-cases/      # Sincronización, identificación, nombres y evaluación
    errors/         # Errores semánticos independientes de HTTP
  infrastructure/
    config/
    database/       # Prisma, transacciones e inicialización histórica
    datasources/    # Persistencia y mapeo de modelos a entidades
    repositories/   # Implementaciones que reciben datasources por contrato
    integrations/   # ZKTeco TCP/IP y puentes SDK/fotos
    imports/        # Lectura del catálogo externo
    jobs/           # Sincronización programada
  presentation/
    controllers/
    routes/
    validators/
    middlewares/    # Traducción de errores a respuestas HTTP
  main.ts           # Composición e inyección de dependencias
  server.ts         # Arranque, señales y cierre ordenado
```

El dominio recibe interfaces y devuelve entidades/DTOs propios. No importa Fastify, Zod, Prisma ni `pg`. Los errores llevan códigos semánticos; sus estados HTTP se resuelven en presentación. Las reglas de jornadas, acumulación, nombres y estado pueden probarse sin base de datos ni servidor.

Prisma ORM gestiona dispositivos, fotos, sincronizaciones, registro de empleados y escritura de evaluaciones/incidencias/descuentos. Las consultas históricas, CTEs y bloqueos específicos de PostgreSQL se ejecutan parametrizados a través de Prisma dentro de infraestructura. Las transacciones de edición usan `UnitOfWork`; identificación, precarga y recálculo tienen sesiones transaccionales y bloqueos de concurrencia propios.

Diagnóstico estructural de la guía: **7/7 criterios, 9/10**. Dependencias hacia el dominio, casos de uso independientes del transporte, persistencia sustituible mediante contratos, framework en presentación, grafo sin ciclos y composición explícita. `tests/architecture.test.ts` protege las fronteras y detecta ciclos.

## Prisma y migraciones

Las dependencias Prisma están fijadas en **7.9.1**, con `@prisma/adapter-pg`. El esquema introspectado está en `prisma/schema.prisma`; el cliente se genera en `src/infrastructure/database/generated/` y queda excluido de Git.

La baseline `00000000000000_baseline` representa las 19 tablas existentes al adoptar Prisma. Conserva las 18 restricciones `CHECK`, las claves foráneas, los índices parciales de reloj actual/conexión activa y la obligatoriedad del arreglo de incidencias. La relación empleado–registros de reloj es múltiple para incluir los históricos.

### Primera adopción de una base existente

La base debe corresponder al esquema posterior a la migración histórica 010. El procedimiento es:

```bash
PG_CONTAINER=reloj-checador-postgres-1 BACKUP_LABEL=clean-architecture-prisma npm run backup:database
npm run verify:baseline -- --baseline-only
npm run prisma:baseline
npm run migrate
npm run verify:baseline
npm run prisma:status
```

`verify:baseline -- --baseline-only` compara exclusivamente la baseline histórica con una base posterior a la migración 010. Después de adoptar y migrar, `verify:baseline` aplica todas las migraciones en una base temporal y compara columnas, nulabilidad, valores predeterminados, restricciones e índices con la base configurada. Verifica también que repetir el despliegue sea idempotente. `prisma:baseline` se ejecuta una sola vez por base existente: registra la migración como aplicada y conserva sus tablas y datos.

Para despliegues posteriores use `npm run migrate` (`prisma migrate deploy`) antes de iniciar el servidor. Para preparar migraciones nuevas, use `prisma migrate dev` en una base de desarrollo aislada y revise el SQL generado, incluyendo las restricciones propias de PostgreSQL. Las migraciones históricas de `migrations/` se conservan para probar actualizaciones anteriores; su ejecutor solo admite bases o esquemas con prefijo `test_`.

Comandos de consulta: `npm run prisma:validate`, `npm run prisma:generate` y `npm run prisma:status`.

## Recuperación ante errores

- El handler global conserva el formato `{ message }`, normaliza errores de validación/Prisma y registra detalles internos mediante logs estructurados.
- El SDK ZKTeco se ejecuta en un proceso hijo por operación. Los errores en sus callbacks, rechazos no controlados o cierres inesperados se convierten en errores de sincronización y quedan aislados de la API. La comunicación entre procesos conserva las fechas y referencias originales.
- `ZK_TIMEOUT_MS` controla la espera de conexión/lectura del SDK (10 segundos por defecto). `ZK_OPERATION_TIMEOUT_MS` limita la operación completa (120 segundos), permitiendo descargas que necesitan varias lecturas. El supervisor espera también el cierre de la conexión y termina los procesos bloqueados. Los puentes HTTP tienen timeout.
- La instalación aplica un parche idempotente a `node-zklib`: detiene la lectura cuando falla `requestData` y rechaza buffers nulos, cabeceras truncadas y tamaños de transferencia incompletos. Así conserva la causa original del fallo en lugar de generar un `TypeError` secundario.
- El scheduler evita ciclos superpuestos, registra los fallos por reloj y reintenta en el siguiente periodo. Un fallo al listar dispositivos tampoco deja un rechazo de promesa sin capturar.
- Las sincronizaciones registran el progreso parcial. Si también falla el registro del error, se conservan ambas causas y se libera el bloqueo del reloj.
- El arranque inicia el scheduler después de abrir el servidor. El cierre por señales espera el trabajo programado y cierra Prisma y el pool. Los fallos operativos se gestionan en su operación; un error irrecuperable produce un cierre ordenado con código de salida de error.

## Configuración del SilkBio-100TC

- Asigne una IP fija o una reserva DHCP al reloj.
- En el menú de comunicación, configure TCP/IP y el puerto `4370`.
- Habilite la comunicación standalone y, para la primera validación, use `Comm Key` igual a `0`.
- Antes de conectar, confirme que la computadora puede alcanzar la IP del reloj.

La ruta `POST /devices/:id/sync-attendance` solo lee y copia registros; no hay rutas ni comandos que borren las checadas del equipo.

Use `POST /devices/:id/sync-users` para copiar el catálogo de usuarios del reloj. Se almacenan el número de usuario, nombre, rol y tarjeta; contraseñas y datos biométricos se descartan. Una vez sincronizados, `GET /attendance` añade `userName` a cada checada cuando existe una coincidencia.

Para un resumen por persona use `GET /users/:userId/attendance-summary?deviceId=:deviceId`. El resumen utiliza la misma clasificación por horarios que Asistencia diaria e indica `inferred: true`. `punchState` se conserva como evidencia del reloj y no decide el movimiento. Las sesiones se forman solo con movimientos reconocidos; `workedMinutes: null` señala que faltan datos para determinar el tiempo trabajado. Incluye `issues` y `missingMovements`. Las respuestas mantienen los valores ISO en UTC y sus campos `*Local`.

## Sucursales, horarios y reglas

Todas las entidades nuevas usan UUID. La sucursal usa su UUID como único identificador y lo genera automáticamente al crearla; los números de empleado y del reloj se conservan como referencias externas.

- `GET /branches`, `POST /branches`, `PUT /branches/:id`: sucursales, dirección, contacto y zona horaria.
- `PATCH /devices/:id`: edición del nombre, IP, puerto, driver, intervalo y estado de sincronización del mismo reloj. Los dispositivos activos no pueden repetir la combinación de IP y puerto.
- `GET /branch-policies`, `POST /branches/:id/policies`: versiones de tolerancias y acumulación con `effectiveFrom`.
- `GET /work-schedules`, `POST /work-schedules`: roles de jornada y comida. `isDefault` establece la base de la sucursal.
- `GET /schedule-assignments`, `POST /organization/assignments`: asignación individual o masiva de sucursal y rol completo en una transacción. Acepta `employeeIds`, `deviceUserIds`, `deviceIds`, `effectiveFrom`, `branchId` y `scheduleId`. `scheduleId: null` restaura la jornada base desde esa fecha y conserva la comida individual. Los relojes solo reciben sucursal.
- `GET /employees`, `POST /employees`, `GET /employees/:id`, `PATCH /employees/:id`: ficha única de cada persona. Las referencias importadas son opcionales y el UUID es la identidad principal. `identificationStatus` distingue confirmados y pendientes; `clockRecords` conserva el registro actual e históricos del reloj.
- `GET /employees/:id/scheduling?date=YYYY-MM-DD`: configuración individual, jornada base vigente, resolución efectiva, primera fecha con checadas e historial. La fecha es opcional y usa el día local de la sucursal.
- `PUT /employees/:id/scheduling`: agrega una versión de jornada/comida. También se admite `scheduling` en `POST /employees` y `PATCH /employees/:id`, guardando los datos personales, estado y horario en una sola transacción.
- `POST /employees/:id/identify`: confirma una ficha pendiente o la asocia a `targetEmployeeId`. Los datos originales y conflictos se guardan en el historial. `useAsAssignedClock` selecciona ese registro como reloj actual.
- `POST /employees/:id/clock-record`: asigna un `clockRecordId` de la misma sucursal; conserva las asignaciones anteriores como históricas.
- `GET /employees/:id/history`: instantáneas originales, asociaciones de identidad e historial de reloj.
- `PATCH /users/:id/profile`: ruta de compatibilidad que actualiza la ficha canónica del empleado. La identificación se administra desde Empleados → Pendientes.
- `GET /attendance/daily?from=YYYY-MM-DD&to=YYYY-MM-DD`: jornadas, movimientos inferidos, incidencias, acumulados y descuentos del día. Filtros opcionales: `branchId` y `subjectId`.
- `GET /attendance/deductions`: mismo rango y filtros; incluye descuentos vigentes y anulados por recálculo.
- `POST /attendance/recalculate`: reconstrucción transaccional e idempotente de jornadas, incidencias y descuentos. También se ejecuta después de sincronizar checadas y modificar configuraciones relevantes.

La inicialización histórica del SilkBio existente conserva sus asignaciones a México. En bases nuevas, las sucursales se registran desde la interfaz y no se generan a partir de los códigos del catálogo importado. Los UUID existentes se conservan durante la migración. Los horarios y sus reglas se administran desde la interfaz con fecha de vigencia.

En **Dispositivos → Editar** se puede cambiar el nombre y la conexión sin recrear el reloj. La asignación de sucursal se gestiona por separado con su historial de vigencias. En **Empleados → Editar** se muestran Nombre(s), Apellidos, RFC, NSS, sucursal, reloj e ID del reloj. Los datos técnicos de origen permanecen en **Historial**. Los RFC modificados se normalizan a mayúsculas y los NSS nuevos o modificados requieren 11 dígitos y conservan sus ceros iniciales. Las sincronizaciones del reloj conservan estos datos.

### Jornada heredada y comida individual

En **Empleados → Editar → Horario y comida** se configuran tres aspectos independientes:

- **Jornada:** por defecto hereda la base vigente de la sucursal. El switch de horario especial permite fijar días, entrada y salida propios. Quitar esa excepción conserva la comida individual y vuelve a heredar los cambios futuros de la sucursal.
- **Comida:** puede quedar pendiente, configurarse con hora/rango de salida y duración, o desactivarse explícitamente. La duración inicial es 60 minutos, editable entre 1 y 240. Para una hora fija, los campos Desde/Hasta llevan la misma hora. Debe permitir regresar antes de finalizar la jornada.
- **Reconocimiento:** margen inicial de 30 minutos, editable entre 0 y 120. Ayuda a distinguir la comida y los movimientos intermedios; no limita las horas reales de entrada y salida laboral. Es independiente de las tolerancias de retardo de la sucursal.

`workHours: null` significa heredar la jornada; `meal: null` significa comida pendiente. Una comida configurada no congela una copia de las horas de sucursal. Si un cambio de jornada hace incompatible la comida guardada, se conserva su versión y queda pendiente de revisión, sin generar retardos de comida a partir de esa configuración inválida.

Las versiones son inmutables, tienen `effectiveFrom` y aparecen en **Historial**. `expectedVersionId` toma el `latestVersionId` del GET y evita sobrescribir cambios concurrentes: una versión desactualizada devuelve 409 y revierte toda la edición. Los errores de configuración también revierten juntos los cambios personales y de estado.

La migración `20261021190000_employee_scheduling` agrega `employee_schedule_versions` y `schedule_migration_snapshots`. Conserva los roles y asignaciones anteriores y separa sus comidas de la herencia laboral. Las bases sustituidas conservan sus filas y se delimitan con `superseded_from`. Para la instalación existente de México deja la base **08:30–17:30** desde la primera checada local (**2026-07-31**) y la excepción del ID **3040** en **09:00–18:00** desde su primer registro. Las horas de comida se capturan individualmente; no se asigna una hora global por suposición.

### Clasificación automática por estados de jornada

El clasificador usa el horario vigente para la fecha y la zona de la sucursal. Reconoce entrada, salida a comer, regreso y salida laboral aunque el reloj marque todas como Entrada o Salida.

- La primera checada válida identifica la entrada real, incluidas las llegadas anticipadas y tardías, sin recortarla a la hora configurada. Una primera marca que coincide con comida sin entrada previa sigue señalando el faltante para revisión.
- La salida laboral toma la última marca válida identificada como final de jornada, aunque sea anterior o posterior al horario. El horario sirve como referencia y para los plazos de faltantes, no como límite para mostrar esas horas.
- Una sola marca no llena entrada y salida a la vez. Una última salida a comer o un regreso de comida sin otra marca conservan la salida laboral pendiente. Las marcas intermedias de una jornada todavía abierta no se convierten automáticamente en salidas.
- En días no laborables se conservan las horas observadas y el estado de día no laboral, sin generar retardos de esa jornada.
- Una checada adicional fuera de las ventanas se conserva como **Fuera de horario** y no avanza la secuencia.
- El regreso esperado se calcula desde la salida real más la duración; volver antes de consumir todo el tiempo también es válido.
- Entrada, salida a comer y salida laboral sin regreso permiten identificar la salida y señalar **Regreso de comida no registrado**.
- Los faltantes de regreso y salida aparecen cuando vencen sus plazos, evitando avisos prematuros durante la jornada.
- Si una marca coincide con regreso y salida y las demás checadas no permiten resolverla, se conserva como ambigua para revisión.
- Duplicados, faltantes y marcas fuera de horario no se convierten por sí solos en sanciones. Los retardos se calculan sobre movimientos reconocidos y reglas vigentes; una fecha anterior a la primera política puede clasificarse sin aplicar reglas futuras.
- Asistencia diaria, Checadas y el resumen por usuario comparten esta clasificación. Las marcas originales, UUID, fotos e historial se conservan. El recálculo es idempotente y anula descuentos obsoletos conservando sus filas e identidad.

### Estado y nombres del empleado

El switch **Activo / Dado de baja** guarda `isActive`. La baja utiliza automáticamente la fecha local de la sucursal; reactivarlo limpia la baja vigente y conserva la fecha de alta original. Cada transición se registra en `employee_status_events`, con estado anterior, fechas, zona horaria e instantánea de la ficha. Los reintentos del mismo estado no duplican el historial. Las fechas de alta/baja son de consulta y el API rechaza su modificación manual. Los empleados nuevos reciben fecha de alta automática.

Los nombres y apellidos se precargan respetando el formato de apellidos primero del catálogo, las referencias del reloj y los apellidos compuestos. Los registros con solo nombre se cargan en Nombre(s); los identificadores sin nombre real siguen pendientes. `originalName` conserva íntegro el nombre original y `nameSplitMethod` identifica el criterio de separación. Los datos ya corregidos manualmente no se sobrescriben durante la precarga ni las sincronizaciones.

### Registro unificado y conservación de información

La interfaz utiliza exclusivamente **Empleados**; `/users` redirige a `/employees`. Cada persona tiene una ficha y un reloj actual de su sucursal. Los registros `device_users` se conservan internamente como identificadores técnicos y evidencia original del equipo, con sus nombres, tarjetas, perfiles anteriores y fotos; ya no ofrecen una ficha personal separada. Los registros nuevos sin coincidencia comprobada generan empleados pendientes. La sincronización de checadas también detecta IDs que todavía no aparecen en el catálogo descargado.

La migración 009 conserva los UUID de empleados existentes y reutiliza el UUID del registro del reloj para cada ficha pendiente. Guarda instantáneas previas, copia las asignaciones a la identidad canónica y mantiene los UUID de jornadas, incidencias y descuentos existentes. Las asociaciones manuales conservan la ficha anterior como histórica, junto con una copia completa de sus datos y asignaciones. El historial de fotos y las checadas originales permanecen ligados al reloj de origen.

Antes de migrar, `npm run backup:database` crea un archivo PostgreSQL completo, un manifiesto de cantidades y checksums, y verifica el respaldo restaurándolo en una base temporal. Para el PostgreSQL de Docker: `PG_CONTAINER=reloj-checador-postgres-1 npm run backup:database`. Los archivos están en `backups/`, excluidos del control de versiones.

Después de refactorizar o migrar, `PG_CONTAINER=reloj-checador-postgres-1 npm run verify:data -- backups/<manifiesto>.json` restaura el respaldo en otra base temporal y compara los registros con la base actual. Protege fichas, nombres, fechas, perfiles originales, checadas, fotos binarias, asignaciones e historial; para resultados derivados comprueba sus identidades y relaciones. Admite registros nuevos de sincronización, comprueba relaciones huérfanas/relojes duplicados y guarda un informe en `backups/`.

El regreso esperado es la salida real más la duración asignada. Con tolerancia cero, cualquier retraso posterior al límite cuenta. Salir tarde y regresar tarde generan dos incidencias de comida. Lecturas repetidas con menos de un minuto de diferencia conservan su registro original y se identifican como repetidas. Las jornadas con checadas faltantes o ambiguas no reciben movimientos inventados.

El driver TCP/IP interpreta las fechas locales de `node-zklib` con la zona horaria de la sucursal antes de guardarlas en UTC. Por ejemplo, Cancún usa `America/Cancun`, una hora adelante de Ciudad de México. La hora original se conserva en `rawData.deviceLocalTime`; una nueva sincronización corrige las horas por número de registro del reloj sin duplicar las checadas.

La zona se elige en **Sucursales → Editar → Zona horaria**. Al guardar se recalculan las jornadas y se actualizan las vistas. **Checadas** usa la zona de la sucursal o reloj seleccionado y consulta el día completo entre sus medianoches locales; con todas las sucursales utiliza Ciudad de México como referencia. Los cambios de visualización conservan los instantes UTC almacenados. Las zonas fronterizas respetan sus cambios estacionales de horario.

Los contadores de llegada y comida son independientes. Con tres retardos permitidos, el cuarto genera un día de descuento y consume ese grupo. El siguiente grupo comienza con su primer retardo. Se puede elegir mes calendario o periodos de 30 días desde el primer retardo; el extremo final del periodo es exclusivo. Los descuentos son registros de días para consulta y nómina, no movimientos bancarios. Un recálculo conserva los UUID de las incidencias y descuentos que siguen vigentes; las sanciones que dejan de corresponder quedan anuladas con historial.

El estado original del reloj se muestra como dato de verificación en **Checadas**. La etiqueta principal de movimiento y los resúmenes utilizan la clasificación automática por horarios.

## Verificación

Ejecute `npm run typecheck` y `npm test` para las comprobaciones de tipos y pruebas unitarias. Para ejecutar toda la suite con PostgreSQL, use `npm run test:integration`: crea una base temporal, aplica Prisma Migrate, ejecuta las pruebas y elimina la base al terminar.

También se admite `INTEGRATION_DATABASE_URL` explícita hacia una base de pruebas con prefijo `test_`. Las pruebas de organización/unificación usan además esquemas aislados y los eliminan al terminar. Cubren migraciones repetidas, UUID, relojes con IDs iguales, asignaciones con historial, tolerancias, descuentos, fotos/perfiles originales, rollback, compatibilidad HTTP y recuperación después de fallos del reloj. La regresión del SDK reproduce el callback `null.subarray`, comprueba que `/health` sigue respondiendo, registra la sincronización fallida y ejecuta otra sincronización exitosa. También prueba paquetes TCP binarios con el worker real y la terminación de procesos bloqueados.
