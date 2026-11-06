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
- El establecimiento de conexión tiene además un límite explícito `ZK_TIMEOUT_MS`, porque el timeout del socket del SDK no rechaza por sí solo una conexión TCP sin respuesta. El error conserva nombre, IP y puerto del equipo para distinguir una falta de conectividad de otros errores del protocolo.
- La instalación aplica un parche idempotente a `node-zklib`: detiene la lectura cuando falla `requestData` y rechaza buffers nulos, cabeceras truncadas y tamaños de transferencia incompletos. Así conserva la causa original del fallo en lugar de generar un `TypeError` secundario.
- El scheduler evita ciclos superpuestos, registra los fallos por reloj y reintenta en el siguiente periodo. Un fallo al listar dispositivos tampoco deja un rechazo de promesa sin capturar.
- Las sincronizaciones registran el progreso parcial. Si también falla el registro del error, se conservan ambas causas y se libera el bloqueo del reloj.
- El arranque inicia el scheduler después de abrir el servidor. El cierre por señales espera el trabajo programado y cierra Prisma y el pool. Los fallos operativos se gestionan en su operación; un error irrecuperable produce un cierre ordenado con código de salida de error.

## Configuración del SilkBio-100TC

- Asigne una IP fija o una reserva DHCP al reloj.
- En el menú de comunicación, configure TCP/IP y el puerto `4370`.
- Habilite la comunicación standalone y, para la primera validación, use `Comm Key` igual a `0`.
- Antes de conectar, confirme que la computadora puede alcanzar la IP del reloj.

La ruta `POST /devices/:id/sync-attendance` solo lee y copia registros; no hay rutas ni comandos que borren las checadas del equipo. La sincronización es **acumulativa**: una descarga vacía o parcial no retira el historial de PostgreSQL. Checadas, resúmenes y tarjetas siempre consultan esta base, sin necesitar que el reloj conserve sus registros ni consultar el dispositivo para mostrar el historial.

La identidad de una checada nativa incluye el folio, usuario y fecha/hora original (hora local original cuando está disponible). Un folio reutilizado después de vaciar el reloj crea un registro independiente; no reemplaza otro usuario ni otra fecha. Las descargas repetidas no actualizan la fecha, estado, método de verificación, UUID ni datos originales ya guardados. Las identidades anteriores por folio/hash siguen reconociéndose sin reescribirlas. Los cálculos derivados se pueden actualizar, pero no sustituyen las checadas fuente. La conciliación de una marca importada con su original nativo conserva la evidencia del archivo como se describe abajo. La precarga de nombres comparte el bloqueo del recálculo antes de bloquear fichas, evitando interbloqueos entre sincronizaciones simultáneas y actualización de reportes.

Use `POST /devices/:id/sync-users` para copiar el catálogo de usuarios del reloj. Se almacenan el número de usuario, nombre, rol y tarjeta; contraseñas y datos biométricos se descartan. Una vez sincronizados, `GET /attendance` añade `userName` a cada checada cuando existe una coincidencia.

Para un resumen por persona use `GET /users/:userId/attendance-summary?deviceId=:deviceId`. El resumen utiliza la misma clasificación por horarios que Asistencia diaria e indica `inferred: true`. `punchState` se conserva como evidencia del reloj y no decide el movimiento. Las sesiones se forman solo con movimientos reconocidos; `workedMinutes: null` señala que faltan datos para determinar el tiempo trabajado. Incluye `issues` y `missingMovements`. Las respuestas mantienen los valores ISO en UTC y sus campos `*Local`.

## Administrar fecha y hora del reloj

En **Dispositivos → Fecha y hora** se consulta la hora local del equipo, la referencia del servidor convertida a la zona horaria de su sucursal y la diferencia en segundos. La consulta es una medición puntual; **Consultar hora** toma una lectura nueva.

- `GET /devices/:id/clock-time`: lectura del reloj, instante de medición, zona horaria, referencia local y diferencia (positiva si está adelantado).
- `POST /devices/:id/clock-time/synchronize`: cuerpo vacío `{}`; toma una lectura previa, envía la hora actual y verifica con una nueva lectura. La fecha se calcula dentro del proceso aislado, inmediatamente antes de enviar el comando. No acepta fechas arbitrarias del navegador.
- `POST /devices/:id/clock-time/manual`: `{ "localTime": "2026-10-28 16:30:00" }`; establece exactamente la fecha/hora local capturada, con segundos y sin sufijos UTC ni conversiones de zona del navegador. Valida calendario y años 2000–2099 antes de comunicarse con el reloj.
- `GET /devices/:id/clock-time/history`: últimos 20 intentos guardados en PostgreSQL, incluyendo estado, lecturas anterior/posterior, hora enviada y errores.

Disponible para el controlador TCP/IP directo (incluido su transporte UDP de respaldo) en relojes compatibles con `CMD_GET_TIME`/`CMD_SET_TIME`. Requiere una sucursal con zona horaria; México/Querétaro y Cancún usan sus propias referencias. El reloj no almacena una zona horaria: se envía la fecha/hora local correspondiente, sin alterar la configuración de la sucursal. La precisión de verificación es de cinco segundos. La referencia depende de que la hora del servidor sea correcta.

Consultar no cambia la hora ni crea un ajuste. **Sincronizar hora** es una operación manual; no se programa ni se reintenta automáticamente. Los intentos se registran antes de comunicarse con el dispositivo. Un ACK no basta para declarar éxito: si la lectura posterior no coincide o falla, el historial queda como no confirmado, conservando la evidencia disponible. La consulta, el ajuste, las pruebas de conexión y las descargas comparten el bloqueo por reloj dentro de la instancia de la aplicación (409 si está ocupado).

**Ajustar manualmente** permite capturar fecha y hora local en dos campos. La verificación compara la lectura posterior con el valor solicitado más los segundos transcurridos desde el envío, no con la hora del servidor. Por eso un ajuste manual puede quedar verificado aunque difiera de la referencia del servidor; esa diferencia se sigue mostrando como información. El historial conserva `mode` (`server`/`manual`) y `requestedLocalTime`, incluso si falla la primera conexión. La migración `20261028190000_manual_device_clock` agrega esos datos y clasifica los intentos anteriores como ajustes desde el servidor sin modificar su evidencia.

La migración aditiva `20261028180000_device_clock_adjustments` crea el historial. Ajustar la hora no descarga ni borra checadas, no reinterpreta registros históricos y no modifica identidades, fotos, horarios o descuentos.

## Administradores individuales del reloj

**Empleados → Opciones → Editar → Reloj** permite consultar y aplicar el rol del usuario activo asignado a la ficha. Se admiten **Usuario normal (0)** y **Administrador (14)**; una sucursal y un reloj pueden tener varios administradores. La validación del último administrador se hace contra el catálogo completo del equipo, no contra una cuenta global de la sucursal ni contra datos cacheados.

- `GET /employees/:id/clock-role?clockRecordId=UUID`: lectura manual del equipo; devuelve `clockRecordId` y `snapshot` con ID, UID, rol, administradores, usuarios totales y fecha de medición. El vínculo debe pertenecer a esa ficha, estar activo e identificado. La observación actualiza únicamente la metadata del rol.
- `POST /employees/:id/clock-role`: `{ clockRecordId, uid, expectedRole, role: 0 | 14 }`. Registra el intento antes de conectar; vuelve a comprobar identidad y rol en el equipo, bloquea quitar el último administrador y verifica el resultado. Devuelve el intento con `status: succeeded | blocked | failed | unconfirmed`, `code`, lecturas anterior/posterior y error. Un HTTP 200 significa que el intento quedó registrado; solo `succeeded` acredita el cambio verificado.
- `GET /employees/:id/clock-role/history`: últimos veinte intentos del empleado, con referencia al reloj y registro de usuario originales, incluso si después cambia de equipo.

La operación comparte el bloqueo por reloj de sincronización, usuarios, fotos y hora. El controlador ejecuta en el proceso aislado una lectura binaria completa, determina el formato por tamaño y número de usuarios y admite registros de 28/72 bytes. Cambia únicamente el byte de rol mediante `CMD_USER_WRQ (8)`, refresca con `CMD_REFRESHDATA (1013)` y vuelve a leer. Verifica el registro completo y los demás usuarios; contraseñas, tarjeta, nombre, grupo y bytes reservados se conservan en memoria. Los buffers completos y contraseñas no salen del worker ni se guardan en auditoría o logs. Huellas/rostros y checadas no forman parte de la escritura.

Un catálogo parcial, formato desconocido, identidad diferente o rol desactualizado impide escribir. Un ACK sin lectura posterior coincidente no acredita éxito. Ante pérdida de conexión o terminación del worker, el resultado queda sin confirmar y no hay reintento automático: consultar el equipo antes de otra operación. El registro almacenado solo cambia después de una lectura válida o cambio verificado; una inconsistencia de vínculo detectada al guardar se registra como no confirmada.

La migración aditiva `20261031010000_device_user_roles` agrega el historial `device_user_role_changes` y `device_users.role_observed_at`. La fecha de consulta del rol es independiente de `synced_at`, que conserva la fecha de sincronización completa del usuario. El cambio del reloj es una acción inmediata, independiente de la transacción Guardar del resto de pestañas.

`tests/device-user-role-protocol.test.ts` usa equipos TCP/UDP simulados con el worker real para comprobar lectura/escritura, conservación byte por byte, múltiples administradores, bloqueo del último, respuestas rechazadas y resultados no verificados. `tests/device-user-role.integration.test.ts` verifica auditoría, cache, identidad y bloqueo de concurrencia en PostgreSQL. La compatibilidad y el resultado en un equipo físico deben comprobarse desde la interfaz con una consulta nueva y su verificación posterior.

## Corregir vínculos con tarjetas de nómina

El número de empleado de nómina y el ID del usuario en el reloj son referencias independientes. En el Excel `Empleados_Tarjeta_Asistencia.xlsx`, **NÚMERO DE TARJETA** identifica al usuario del reloj, no al empleado de nómina ni al campo RFID `card_number` del dispositivo.

```bash
npm run import:employee-cards -- "/ruta/Empleados_Tarjeta_Asistencia.xlsx"
npm run import:employee-cards -- "/ruta/Empleados_Tarjeta_Asistencia.xlsx" --device-override 1545,3077=UUID-del-reloj
# Después de respaldar y revisar la conciliación:
npm run import:employee-cards -- "/ruta/Empleados_Tarjeta_Asistencia.xlsx" --device-override 1545,3077=UUID-del-reloj --apply
```

Requiere Python 3 (biblioteca estándar). Por defecto solo compara; `--apply` guarda el lote completo y recalcula el historial. Si un ID existe en varios relojes, exige elegir el dispositivo explícitamente; no deduce la sucursal por el prefijo del número. Las permutaciones entre fichas confirmadas se aplican atómicamente sin fusionarlas. Las fichas pendientes reemplazadas se archivan con el mecanismo de identificación existente. Solo se corrigen adscripciones iniciales erróneas con vigencia `1900-01-01`; un historial de traslados requiere conciliación individual.

La tabla `employee_clock_binding_imports` conserva hash del archivo, filas, vínculos y datos anteriores. Se mantienen UUID de fichas, registros del reloj, fotografías y checadas originales; el recálculo conserva las evaluaciones/incidencias/descuentos anteriores y desactiva los que dejan de corresponder. Repetir la conciliación no duplica vínculos ni auditorías. La sincronización de usuarios respeta el empleado ya vinculado.

`PG_CONTAINER=reloj-checador-postgres-1 npm run verify:employee-cards -- backups/manifiesto.json UUID-de-conciliacion` restaura el respaldo en una base temporal y verifica todos los registros anteriores, permitiendo exclusivamente los cambios de identidad documentados y la actualización de cálculos derivados. Comprueba además los vínculos del archivo y la integridad de relaciones.

## Importar archivos Talavie

En **Checadas → Importar archivo**, selecciona sucursal, reloj y un `.txt` UTF-8/ASCII (hasta 1 MB y 10 000 líneas). **Revisar archivo** ejecuta una vista previa de solo lectura; **Importar checadas** guarda únicamente las nuevas y recalcula asistencia, retardos y extras. Si todas ya existen, **Registrar archivo sin duplicar** conserva la evidencia de la carga sin crear checadas. El historial muestra las últimas 20 cargas del reloj.

- `POST /attendance/imports/preview`: JSON `{ branchId, deviceId, fileName, content }`; devuelve filas, conteos, zona horaria y `token`.
- `POST /attendance/imports`: mismo contenido y `expectedToken`; guarda en una transacción y devuelve referencia, `insertedCount`, `alreadyImported` y `recalculated`. Un cambio posterior a la vista previa devuelve 409 para volver a revisar. Si falla solo el recálculo, la respuesta indica que los datos quedaron guardados y permite reintentarlo.
- `GET /attendance/imports?deviceId=UUID`: últimas cargas, nombres, fechas y conteos, sin devolver todo el contenido.

El registro `01 | 0000603 | 00000 | 15-10-26 | 001 | 1802 | B` corresponde al usuario 603 el 15/10/2026 a las 18:02 locales. El año de dos dígitos se interpreta como 2000–2099. Se conservan los bloques y la letra; B/E no deciden movimientos ni se utilizan como identidad de sucursal. La asociación usa reloj e ID del usuario, incluyendo sus vínculos históricos. Los IDs desconocidos se vinculan mediante las reglas existentes de identidad o quedan pendientes. Las líneas vacías se omiten; se soportan BOM UTF-8 y finales LF/CRLF/CR, conservando el texto original completo.

El archivo tiene precisión de minutos. Una coincidencia única del mismo reloj/usuario/minuto se marca existente, conservando segundos, UUID y datos nativos. Varias marcas nativas en ese minuto quedan ambiguas y no se fusionan. Las repeticiones dentro del archivo y las líneas inválidas se señalan con su número y no crean registros. Cambios de sucursal históricos del reloj incompatibles con la carga se señalan por fila.

La tabla aditiva `attendance_file_imports` conserva texto, hash SHA-256, nombre y resultado completo de la carga, incluso filas omitidas. Repetir un mismo archivo para el mismo reloj es idempotente; archivos superpuestos también se comparan por minuto. Un bloqueo transaccional por reloj coordina cargas y descargas nativas. Si el reloj descarga posteriormente una marca importada, se incorporan sus segundos/estado/ID nativo conservando el UUID y la evidencia importada; marcas nativas adicionales distintas del mismo minuto se mantienen separadas. La migración `20261023150000_attendance_file_import` no reescribe datos existentes.

## Permisos y vacaciones

La página **Asistencia → Permisos** registra solicitudes para faltar, llegar tarde o salir temprano, con fechas inclusivas, motivo y goce de sueldo. Para permisos parciales se captura una hora autorizada, aplicada a cada día laborable del rango en su zona local. Tomar vacaciones solo se permite para faltar con goce de sueldo.

- `GET /employees/:id/leave-profile`: jefe directo, WhatsApp, saldo manual de vacaciones, versión e historial de movimientos.
- `PUT /employees/:id/leave-profile`: `{ managerId, whatsappPhone, vacationBalance, expectedVersion, adjustmentReason }`. Los teléfonos opcionales se validan y normalizan a E.164 con `libphonenumber-js`, sin duplicarse entre fichas; para números nacionales se usa `PHONE_DEFAULT_COUNTRY`, inicialmente `MX`. La interfaz solicita el código internacional explícito. Un cambio de saldo exige motivo; cambios concurrentes de configuración o saldo devuelven 409. No se permiten jefes inactivos, pendientes ni ciclos jerárquicos.
- `PATCH /employees/:id` también acepta `leaveProfile` con ese mismo objeto, junto con los datos personales, `isActive` y `scheduling`. La edición por pestañas se guarda completa en una sola transacción y reutiliza las mismas reglas que la ruta individual. Un jefe inválido, WhatsApp duplicado, saldo o jornada desactualizados revierte nombre, estado, versiones de jornada y movimientos de vacaciones. Los clientes anteriores pueden seguir omitiendo `leaveProfile`; solo se escriben los grupos enviados.
- `POST /leave-requests/preview`: `{ employeeId, kind, from, to, authorizedTime, paid, useVacation, reason }`, con `kind: absence | late_arrival | early_exit`. Devuelve jefe responsable, días laborables con jornada/zona por fecha, saldo, días solicitados y token SHA-256. `authorizedTime` es `null` para faltar o `HH:mm` para permisos parciales. Admite hasta 366 días inclusivos y exige al menos uno laborable.
- `POST /leave-requests`: `{ input, previewToken, sourceKey }`, donde `sourceKey` es un UUID estable por envío. Crea una solicitud pendiente y su evento en una sola transacción. Reintentar con la misma clave y contenido devuelve la misma solicitud. Un cambio de horario, jefe o saldo posterior a la revisión devuelve 409.
- `GET /leave-requests?from=YYYY-MM-DD&to=YYYY-MM-DD`: lista paginada de solicitudes que intersectan el rango, con filtros opcionales `branchId`, `employeeId`, `managerId`, `kind` y `status`; `page` inicia en 1 y `limit` en 25, máximo 100.
- `GET /leave-requests/:id`: solicitud, instantánea original de días/jefe e historial de eventos.
- `POST /leave-requests/:id/resolve`: `{ action: approve | reject | cancel, expectedVersion, actorEmployeeId, comments }`. Aprobación/rechazo se registran desde la página administrativa a nombre del jefe responsable. El empleado o jefe también pueden cancelar. Rechazar/cancelar requiere motivo. La identidad capturada documenta la resolución administrativa; no representa autenticación personal del jefe por WhatsApp.

El saldo es manual: no se generan días por antigüedad ni vencimientos. Solo se descuentan los días laborables al aprobar, verificando nuevamente el saldo y el calendario. Si cambia la jornada pendiente, se requiere cancelar y registrar una solicitud nueva. Cancelar un aprobado devuelve exactamente los días consumidos. Solicitudes con intervalos superpuestos pendientes/aprobados se rechazan. Los movimientos de vacaciones, decisión, evento y recálculo se guardan atómicamente: si falla cualquiera, se revierte toda la resolución. Los bloqueos usan el mismo orden que la evaluación de asistencia para coordinar aprobaciones, cambios de saldo y sincronizaciones.

Los permisos aprobados aparecen en asistencia diaria y tarjetas, incluso en días sin checadas. `authorized_absence` distingue una ausencia autorizada; `leaveAuthorizations` conserva tipo, goce, vacaciones, motivo e intervalo. Los permisos parciales solo justifican su intervalo y mantienen incidencias por el exceso; los acumulados/descuentos se reconcilian al aprobar o cancelar. Se mantienen la jornada base, checadas originales y tiempo realmente observado; el cálculo de extras sigue anclado a la jornada original, también en rutas.

La migración aditiva `20261029233000_employee_leave_requests` crea perfiles, solicitudes, movimientos y eventos sin reescribir las fichas existentes. Los eventos guardan el destinatario y teléfono resueltos al ocurrir, con `notification_status: awaiting_configuration`. La API actual crea solicitudes de origen `web`; `whatsapp` y `source_key` permiten extender el caso de uso al futuro flujo conversacional. La base de transporte Twilio está documentada en la sección siguiente.

## Base técnica de WhatsApp/Twilio

Implementada siguiendo `.agents/skills/twilio-whatsapp-integration/SKILL.md`. Incluye SDK oficial, firma con URL pública confiable, aislamiento de cuenta/remitente, identificación del empleado por su WhatsApp registrado y activo, colas duraderas de PostgreSQL, intentos idempotentes, ventana de 24 horas, plantillas explícitas, callbacks y estados de conciliación para envíos inciertos.

- `POST /integrations/twilio/whatsapp/incoming`: formulario firmado; persiste mensaje y trabajo antes de confirmar con TwiML vacío.
- `POST /integrations/twilio/whatsapp/status`: formulario firmado; conserva el estado antes del `200`, incluso cuando el callback llega antes que la respuesta del SDK.

Las variables se encuentran en `.env.example`, con `TWILIO_WHATSAPP_ENABLED=false` por defecto. La migración `20261030210000_whatsapp_foundation` agrega conversaciones, mensajes, intentos, eventos y trabajos. Los mensajes autorizados esperan al futuro `WhatsAppMessageHandler` con estado `awaiting_handler`. El menú, solicitudes por WhatsApp, consultas de asistencia/vacaciones y conexión de avisos al jefe son la siguiente etapa.

Ver **[configuración, estructura, estados y activación de Twilio](docs/whatsapp-twilio.md)** para las URLs HTTPS externas exactas, variables de entorno, mapeo de plantillas y pruebas con SDK simulado.

## Sucursales, horarios y reglas

Todas las entidades nuevas usan UUID. La sucursal usa su UUID como único identificador y lo genera automáticamente al crearla; los números de empleado y del reloj se conservan como referencias externas.

- `GET /branches`, `POST /branches`, `PUT /branches/:id`: sucursales, dirección, contacto y zona horaria.
- `PATCH /devices/:id`: edición del nombre, IP, puerto, driver, intervalo y estado de sincronización del mismo reloj. Los dispositivos activos no pueden repetir la combinación de IP y puerto.
- `GET /branch-policies`, `POST /branches/:id/policies`: versiones de tolerancias, acumulación y margen de entradas repetidas con `effectiveFrom`. `settings.entryRepeatWindowMinutes` admite 0–120 minutos; por defecto usa 20, también para políticas históricas que no tienen el campo.
- `GET /branch-configurations`, `GET /branches/:id/configuration`: jornada y reglas vigentes, primera fecha con checadas e historial conjunto por sucursal.
- `POST /branches/:id/configuration`: guarda atómicamente jornada, comida, reconocimiento y política con una misma vigencia, luego recalcula. Acepta `effectiveFrom`, `workHours`, `meal`, `recognitionMarginMinutes`, `policy` y `expectedVersionId` (token opaco del GET). Un conflicto devuelve 409 y conserva la configuración anterior.
- `DELETE /branches/:id/configuration/versions/:versionId`: retira una configuración conjunta o una versión anterior de horario/reglas y recalcula con las versiones restantes. Conserva UUID y referencias mediante `deleted_at`; no borra físicamente checadas, fotografías, perfiles, asignaciones ni historial. Las versiones eliminadas aparecen solo en el historial cuando se solicita mostrarlas y no admiten nuevas asignaciones. Al retirar la última jornada aplicable se mantiene la evidencia con estado sin configuración. Las líneas temporales se reconstruyen para recuperar versiones sustituidas por una revisión retroactiva.
- `GET /work-schedules`, `POST /work-schedules`: rutas de compatibilidad para roles anteriores de jornada. `isDefault` establece la base de la sucursal; los nuevos clientes utilizan la configuración unificada. Los antiguos campos de comida general no se reactivan: solo `settings.branchMeal` de la nueva configuración define la comida heredada.
- `GET /schedule-assignments`, `POST /organization/assignments`: asignación individual o masiva de sucursal y jornada en una transacción. Acepta `employeeIds`, `deviceUserIds`, `deviceIds`, `effectiveFrom`, `branchId` y `scheduleId`. Asignar o quitar un rol conserva la comida individual. `scheduleId: null` restaura la jornada base desde esa fecha. Los relojes solo reciben sucursal.
- `GET /employees`, `POST /employees`, `GET /employees/:id`, `PATCH /employees/:id`: ficha única de cada persona. Las referencias importadas son opcionales y el UUID es la identidad principal. `identificationStatus` distingue confirmados y pendientes; `clockRecords` conserva el registro actual e históricos del reloj.
- `GET /employees/:id/scheduling?date=YYYY-MM-DD`: configuración individual, jornada base vigente, resolución efectiva, primera fecha con checadas e historial. La fecha es opcional y usa el día local de la sucursal.
- `GET /employees/:id/attendance?from=YYYY-MM-DD&to=YYYY-MM-DD`: tarjeta individual de asistencia con todos los días del periodo (hasta 366 inclusivos), movimientos canónicos, jornada histórica por fecha y resumen. Distingue descansos, días sin registros, jornadas en curso y fechas futuras; no convierte la falta de registros en una sanción. Conserva las marcas repetidas en el detalle y deja en `null` las horas desconocidas. La consulta es de solo lectura y no recalcula ni modifica checadas, incidencias o descuentos.
- `PUT /employees/:id/scheduling`: agrega una versión de jornada/comida. También se admite `scheduling` en `POST /employees` y `PATCH /employees/:id`, guardando los datos personales, estado y horario en una sola transacción.
- `POST /employees/:id/identify`: confirma una ficha pendiente o la asocia a `targetEmployeeId`. Los datos originales y conflictos se guardan en el historial. `useAsAssignedClock` selecciona ese registro como reloj actual.
- `POST /employees/:id/clock-record`: asigna un `clockRecordId` de la misma sucursal; conserva las asignaciones anteriores como históricas.
- `GET /employees/:id/history`: instantáneas originales, asociaciones de identidad e historial de reloj.
- `PATCH /users/:id/profile`: ruta de compatibilidad que actualiza la ficha canónica del empleado. La identificación se administra desde Empleados → Pendientes.
- `GET /attendance/daily?from=YYYY-MM-DD&to=YYYY-MM-DD`: jornadas, movimientos inferidos, incidencias, acumulados y descuentos del día. Filtros opcionales: `branchId` y `subjectId`.
- `GET /attendance/cards?branchId=UUID&employeeStatus=active|inactive&from=YYYY-MM-DD&to=YYYY-MM-DD`: tarjetas de todos los empleados que coincidan con su sucursal y estado actuales, incluidas las fichas sin checadas. Reutiliza el mismo calendario, historial y cálculo de la tarjeta individual. Requiere los cuatro filtros y admite hasta 366 días inclusivos. La paginación usa `page` (inicialmente 1) y `limit` (5 por defecto, máximo 10), con orden estable por nombre, número y UUID. Devuelve sucursal, periodo, estado, totales, página y tarjetas. Carga los datos de la página por lote en una transacción de solo lectura, sin recalcular ni escribir información.
- `GET /attendance/cards/export?branchId=UUID&employeeStatus=active|inactive&from=YYYY-MM-DD&to=YYYY-MM-DD`: devuelve JSON con todas las tarjetas coincidentes y `generatedAt`, desde una única instantánea de solo lectura. No admite `page` ni `limit`; la exportación no queda limitada a la página visible. El frontend genera el archivo PDF con estos datos. Comparte filtros, calendario, orden y cálculos con las tarjetas paginadas e individuales; conserva checadas, fotos y registros originales.
- `GET /attendance/overtime?branchId=UUID&employeeStatus=active|inactive&from=YYYY-MM-DD&to=YYYY-MM-DD`: empleados con extras habilitadas en alguna fecha del periodo, seleccionados por sucursal/estado actuales. Requiere los cuatro filtros y hasta 366 días inclusivos; admite `page` y `limit` (5 por defecto, máximo 10). Devuelve desglose diario, totales por empleado y globales de todos los coincidentes antes de paginar. La consulta es de solo lectura.
- `GET /attendance/deductions`: mismo rango y filtros; incluye descuentos vigentes y anulados por recálculo.
- `POST /attendance/recalculate`: reconstrucción transaccional e idempotente de jornadas, incidencias y descuentos. También se ejecuta después de sincronizar checadas y modificar configuraciones relevantes.

La inicialización histórica del SilkBio existente conserva sus asignaciones a México. En bases nuevas, las sucursales se registran desde la interfaz y no se generan a partir de los códigos del catálogo importado. Los UUID existentes se conservan durante la migración. Los horarios y sus reglas se administran desde la interfaz con fecha de vigencia.

En **Dispositivos → Editar** se puede cambiar el nombre y la conexión sin recrear el reloj. La asignación de sucursal se gestiona por separado con su historial de vigencias. En **Empleados → Editar** se muestran Nombre(s), Apellidos, RFC, NSS, sucursal, reloj e ID del reloj. Los datos técnicos de origen permanecen en **Historial**. Los RFC modificados se normalizan a mayúsculas y los NSS nuevos o modificados requieren 11 dígitos y conservan sus ceros iniciales. Las sincronizaciones del reloj conservan estos datos.

### Configuración unificada y excepciones individuales

En **Horarios y reglas → Configurar** se editan juntos días laborables, entrada, salida, comida (automática, con horario o sin movimientos), duración, márgenes de reconocimiento/repetición, tolerancias y acumulación de retardos. Un solo guardado crea las dos versiones relacionadas por `configuration_id`; no queda una política guardada sin su jornada si falla la operación. El historial reúne también las versiones previas independientes y permite eliminarlas. La configuración inicial conserva los horarios y reglas existentes; una comida heredada solo se activa al guardarla explícitamente.

En **Empleados → Opciones → Editar → Horario y comida** se configuran tres aspectos independientes:

- **Jornada:** por defecto hereda la base vigente de la sucursal. El switch de horario especial permite fijar días, entrada y salida propios. Quitar esa excepción conserva la comida individual y vuelve a heredar los cambios futuros de la sucursal.
- **Comida:** las fichas sin excepción heredan la sucursal. Puede elegirse una excepción automática, una comida individual con hora/rango y duración, o sin movimientos. La duración inicial es 60 minutos, editable entre 1 y 240. Para una hora fija, Desde/Hasta llevan la misma hora y deben permitir regresar antes de finalizar la jornada.
- **Reconocimiento:** puede heredarse de la sucursal o fijarse individualmente entre 0 y 120 minutos (inicialmente 30). Ayuda a distinguir la comida y los movimientos intermedios; no limita las horas reales de entrada y salida laboral. Es independiente de las tolerancias de retardo de la sucursal.

`workHours: null` significa heredar la jornada. `mealMode: inherit` hereda la comida de sucursal; `automatic` fuerza detección automática; `individual` utiliza `meal` con `enabled: true/false`. Por compatibilidad, una versión anterior o petición que omite `mealMode` conserva el significado anterior: `meal: null` es automático y un objeto es una excepción individual. `recognitionMarginInherited: true` hereda el margen. Una comida configurada no congela las horas de sucursal. Si un cambio de jornada hace incompatible una comida, su configuración se conserva y queda para revisión; no se sustituye silenciosamente por automático ni genera retardos contra una configuración inválida.

La resolución expone `mealDetection`: `automatic`, `configured`, `disabled` o `invalid`, y `settings.mealSource` identifica sucursal o excepción individual/automática. Una comida personal tiene prioridad sobre la sucursal. La configuración individual previa del ID 1517 se mantiene, al igual que la jornada 09:00–18:00 del 3040. Asignar o quitar un rol de compatibilidad conserva el modo y margen individual; la interfaz habitual ofrece heredar la jornada y editar excepciones directamente en el empleado.

En modo automático, cuatro checadas efectivas se ordenan como entrada, salida a comer, regreso y salida laboral. Se calculan la duración real observada y el tiempo trabajado, sin inventar una hora de comida programada ni aplicar retardos de comida. Las reglas de llegada siguen usando la jornada y política vigentes. El bloque inicial de entradas repetidas usa el margen de sucursal, inicialmente 20 minutos inclusivos desde la primera entrada, sin encadenar ventanas. No se aplica a los pares de comida ni sustituye una ventana individual de comida. Con 0 se desactiva este margen ampliado; las lecturas repetidas de menos de un minuto siguen detectándose. Todos los registros originales se conservan como `duplicate` cuando corresponde.

Con tres checadas efectivas de una jornada cerrada, se identifica entrada, salida a comer y salida laboral, señalando **Regreso de comida no registrado**. Con dos faltan ambas marcas de comida; con más de cuatro se requiere revisar las intermedias. No se fuerza una comida completa ni se calcula un tiempo trabajado desconocido. Mientras una jornada parcial está abierta permanece en curso; las horas reales de entrada y salida se conservan cuando son identificables. Seleccionar explícitamente `meal.enabled: false` mantiene el modo sin movimientos de comida y permite una jornada de entrada/salida.

Las versiones son inmutables, tienen `effectiveFrom` y aparecen en **Historial**. `expectedVersionId` toma el `latestVersionId` del GET y evita sobrescribir cambios concurrentes: una versión desactualizada devuelve 409 y revierte toda la edición. Los errores de configuración también revierten juntos los cambios personales y de estado.

La migración `20261021190000_employee_scheduling` agrega `employee_schedule_versions` y `schedule_migration_snapshots`. Conserva los roles y asignaciones anteriores y separa sus comidas de la herencia laboral. Las bases sustituidas conservan sus filas y se delimitan con `superseded_from`. Para la instalación existente de México deja la base **08:30–17:30** desde la primera checada local (**2026-07-31**) y la excepción del ID **3040** en **09:00–18:00** desde su primer registro. Las horas de comida se capturan individualmente; no se asigna una hora global por suposición.

La migración `20261022000000_unified_branch_configuration` añade metadatos de versiones conjuntas, eliminación y herencia sin reescribir perfiles ni configuraciones existentes. Las comidas automáticas/personales previas conservan su significado y sus márgenes; los modos heredados nuevos son explícitos. El borrado de configuración invalida resultados derivados mediante recálculo, manteniendo IDs de evaluaciones, incidencias y descuentos; estos últimos se anulan con historial cuando dejan de corresponder.

### Horas extras, rutas y descansos

**Empleados → Opciones → Editar → Horas extras** habilita el cálculo por persona; inicialmente está desactivado. `scheduling.overtime` se guarda con la misma vigencia e historial de jornada/comida:

```json
{
  "enabled": true,
  "workMode": "route",
  "restEnabled": true,
  "dailyRest": { "startTime": "22:00", "endTime": "06:00" },
  "additionalRestMinutes": 120
}
```

`workMode` admite `daily` o `route`. Con extras habilitadas, la referencia de jornada y retardo es la **base de la sucursal vigente en cada fecha**, aunque exista un horario personal distinto; esa excepción se conserva para cuando se deshabiliten las extras. Se suman los tramos anteriores a entrada y posteriores a salida sin compensar retardos. Un día de descanso cuenta todo el intervalo reconocido como extra, excluyendo comidas completas registradas y descansos configurados; sábado/domingo laborables conservan su jornada normal.

En jornada diaria, las extras son independientes de la validación de comida: basta una entrada y salida laboral reconocidas, en orden y con una jornada de sucursal vigente. La falta de comida completa, una sola marca de comida o su clasificación pendiente no bloquean las extras. Se excluye únicamente la comida real cuyo inicio y regreso están registrados; no se inventan marcas ni duraciones. Las observaciones, el estado de asistencia y los faltantes se conservan, y las horas trabajadas totales siguen sin calcularse cuando no pueden determinarse. Los descuentos de descanso siguen aplicándose una vez por jornada. Si falta entrada/salida laboral válida o la jornada de referencia, las extras permanecen pendientes.

**Horarios y reglas → Configurar sucursal → Márgenes de horas extras** guarda `policy.overtimeEntryMarginMinutes` y `policy.overtimeExitMarginMinutes` (enteros 0–240) con la misma vigencia e historial de reglas. Inicialmente son cero, también para políticas históricas que no contienen estos campos. Son independientes de tolerancias de retardo, repetición de entradas y reconocimiento de movimientos. Las peticiones antiguas que omiten los campos conservan el valor aplicable a su fecha; enviar cero explícito lo desactiva.

Los márgenes son descontables: para jornada 08:30–17:30 con 30 minutos de cada lado, las extras se reconocen antes de 08:00 y después de 18:00. Entrada 08:00 y salida 18:00 dan cero; entrada 07:00 reconoce 1 hora y salida 18:30 reconoce 30 minutos. Los límites son exactos, sin redondear segundos ni compensar retardos. `beforeSeconds`, `afterSeconds` y `grossSeconds` ya excluyen los márgenes; los descansos configurados se aplican después y no vuelven a descontar intervalos excluidos. El tiempo trabajado observado no se reduce por estos márgenes. En días no laborables no se aplican. En ruta se usan las reglas y jornada vigentes en cada tramo diario, sin descontar repetidamente un mismo intervalo por tener varias rutas ese día.

Los resultados calculados incluyen `entryMarginMinutes` y `exitMarginMinutes` efectivos; los pendientes no inventan esos valores y los días de descanso usan cero. Pantalla, detalle, tarjetas y PDF muestran los márgenes aplicados por fecha. Guardar, versionar o eliminar las reglas recalcula los reportes y conserva las checadas y configuraciones personales. Los campos viven en el JSONB de políticas existente y no requieren una migración ni reescritura de políticas anteriores.

En ruta, la primera marca efectiva abre el recorrido y la siguiente efectiva lo cierra, sin límite de dos días. Las repeticiones iniciales respetan el margen de sucursal y las menores de un minuto siguen siendo repetidas aun con margen cero. La ruta no requiere movimientos de comida; incluye noches y todo el intervalo hasta el regreso. Una marca intermedia efectiva se interpreta como regreso, por lo que este modo corresponde a quienes solo registran inicio/regreso. `punchState` no decide el movimiento. La comida personal permanece guardada para el modo diario. Solo la entrada inicial evalúa retardo; el regreso no es una nueva llegada. Deshabilitar extras detiene nuevas rutas, y una ruta ya abierta conserva su regreso pendiente.

Los resultados incluyen `routes` con IDs/fechas de las marcas originales y segmentos derivados por fecha local; no se insertan checadas sintéticas. Una ruta abierta permanece pendiente y se extiende hasta el día actual en cada recálculo. Los días sin marcas dentro de una ruta aparecen en tarjetas y resúmenes, con sesiones `inferredFromRoute: true`. Los horarios y zonas aplicables se resuelven por fecha.

Los descansos solo se descuentan al habilitarlos: horario diario opcional (puede cruzar medianoche) y cantidad adicional una vez por jornada/ruta, combinables. Se excluyen solapamientos con comidas/otros intervalos y solo reducen extras coincidentes, nunca debajo de cero. El adicional de una ruta usa su configuración de inicio y se prorratea proporcionalmente a las extras disponibles por día después del descanso diario, conservando segundos exactos. Consultar solo parte de la ruta no vuelve a aplicar ese descanso. Si falta una jornada aplicable, la ruta queda pendiente de cálculo.

`overtime` diario distingue `calculated`, `pending` y `no_records`; los tiempos se expresan en **segundos** y son `null` cuando no pueden determinarse. Los totales excluyen pendientes y muestran su cantidad. Guardar configuraciones del empleado, modificar/eliminar la jornada de sucursal y sincronizar nuevas marcas recalcula los resultados. Las peticiones antiguas que omiten `overtime` conservan el ajuste vigente; asignaciones y unificación también lo preservan. La migración `20261022230000_employee_overtime` agrega un JSONB inicialmente deshabilitado sin modificar checadas ni perfiles originales.

`GET /attendance/overtime/export?branchId=UUID&employeeStatus=active|inactive&from=YYYY-MM-DD&to=YYYY-MM-DD` devuelve todos los empleados elegibles, desglose diario, totales individuales/globales y `generatedAt` para el reporte imprimible. Usa los mismos cálculos que `/attendance/overtime`, en una sola instantánea PostgreSQL `REPEATABLE READ, READ ONLY`, sin paginación ni recálculo. Rechaza `page`/`limit` para evitar exportaciones parciales. La consulta y generación del PDF no alteran checadas, fichas, configuraciones, evaluaciones ni descuentos.

### Clasificación automática por estados de jornada

El clasificador usa el horario vigente para la fecha y la zona de la sucursal. Reconoce entrada, salida a comer, regreso y salida laboral aunque el reloj marque todas como Entrada o Salida.

- La primera checada válida identifica la entrada real, incluidas las llegadas anticipadas y tardías, sin recortarla a la hora configurada. Con comida individual configurada, una primera marca que coincide con comida sin entrada previa sigue señalando el faltante para revisión.
- Al cerrarse la jornada, la salida laboral toma siempre la última marca efectiva cuando hay al menos dos, aunque sea anterior o posterior al horario o coincida con una ventana de comida. El horario sirve como referencia y para los plazos de faltantes, no como límite para mostrar esas horas.
- Una sola marca efectiva no llena entrada y salida a la vez. Las marcas intermedias de una jornada parcial abierta no se convierten automáticamente en salidas.
- En días no laborables se conservan las horas observadas y el estado de día no laboral, sin generar retardos de esa jornada.
- Con horario de comida individual, una checada adicional fuera de las ventanas se conserva como **Fuera de horario** y no avanza la secuencia. En automático, más de cuatro marcas efectivas quedan para revisión porque no existe una franja personal para escoger las intermedias.
- El regreso esperado se calcula desde la salida real más la duración; volver antes de consumir todo el tiempo también es válido.
- Entrada, salida a comer y salida laboral sin regreso permiten identificar la salida y señalar **Regreso de comida no registrado**.
- Los faltantes de regreso y salida aparecen cuando vencen sus plazos, evitando avisos prematuros durante la jornada.
- Una marca final de jornada tiene prioridad como salida laboral sobre un posible regreso de comida; el regreso faltante se señala sin inventar una hora ni duración.
- Duplicados, faltantes y marcas fuera de horario no se convierten por sí solos en sanciones. Los retardos se calculan sobre movimientos reconocidos y reglas vigentes; una fecha anterior a la primera política puede clasificarse sin aplicar reglas futuras.
- Asistencia diaria, Checadas y el resumen por usuario comparten esta clasificación. Las marcas originales, UUID, fotos e historial se conservan. El recálculo es idempotente y anula descuentos obsoletos conservando sus filas e identidad.

### Tolerancias por minuto completo

Las tolerancias de entrada y comida incluyen todo el minuto límite en la zona de la sucursal. Se comparan los minutos de reloj de la hora real y la esperada, sin redondear los segundos hacia arriba. Por ejemplo, una entrada a las 08:30 con tolerancia de 15 minutos permite checar hasta las 08:45:59.999; desde las 08:46:00 corresponde un retardo de 16 minutos. Con tolerancia cero también se admite todo el minuto esperado.

En comida, el regreso esperado conserva los segundos de la salida real más la duración asignada: si resulta 16:00:37 y la tolerancia es de 15 minutos, se permite regresar hasta las 16:15:59.999. El mismo criterio se aplica a la entrada inicial de una ruta y a la evaluación de permisos autorizados. Las checadas originales, las duraciones observadas y las horas extras conservan sus segundos exactos.

El recálculo aplica este criterio también al histórico, actualiza los contadores, inactiva las incidencias que dejan de corresponder y anula sus descuentos obsoletos, conservando sus registros e identidad.

### Estado y nombres del empleado

El switch **Activo / Dado de baja** guarda `isActive`. La baja utiliza automáticamente la fecha local de la sucursal; reactivarlo limpia la baja vigente y conserva la fecha de alta original. Cada transición se registra en `employee_status_events`, con estado anterior, fechas, zona horaria e instantánea de la ficha. Los reintentos del mismo estado no duplican el historial. Las fechas de alta/baja son de consulta y el API rechaza su modificación manual. Los empleados nuevos reciben fecha de alta automática.

Los nombres y apellidos se precargan respetando el formato de apellidos primero del catálogo, las referencias del reloj y los apellidos compuestos. Los registros con solo nombre se cargan en Nombre(s); los identificadores sin nombre real siguen pendientes. `originalName` conserva íntegro el nombre original y `nameSplitMethod` identifica el criterio de separación. Los datos ya corregidos manualmente no se sobrescriben durante la precarga ni las sincronizaciones.

### Registro unificado y conservación de información

La interfaz utiliza exclusivamente **Empleados**; `/users` redirige a `/employees`. Cada persona tiene una ficha y un reloj actual de su sucursal. Los registros `device_users` se conservan internamente como identificadores técnicos y evidencia original del equipo, con sus nombres, tarjetas, perfiles anteriores y fotos; ya no ofrecen una ficha personal separada. Los registros nuevos sin coincidencia comprobada generan empleados pendientes. La sincronización de checadas también detecta IDs que todavía no aparecen en el catálogo descargado.

La migración 009 conserva los UUID de empleados existentes y reutiliza el UUID del registro del reloj para cada ficha pendiente. Guarda instantáneas previas, copia las asignaciones a la identidad canónica y mantiene los UUID de jornadas, incidencias y descuentos existentes. Las asociaciones manuales conservan la ficha anterior como histórica, junto con una copia completa de sus datos y asignaciones. El historial de fotos y las checadas originales permanecen ligados al reloj de origen.

Antes de migrar, `npm run backup:database` crea un archivo PostgreSQL completo, un manifiesto de cantidades y checksums, y verifica el respaldo restaurándolo en una base temporal. Para el PostgreSQL de Docker: `PG_CONTAINER=reloj-checador-postgres-1 npm run backup:database`. Los archivos están en `backups/`, excluidos del control de versiones.

Después de refactorizar o migrar, `PG_CONTAINER=reloj-checador-postgres-1 npm run verify:data -- backups/<manifiesto>.json` restaura el respaldo en otra base temporal y compara los registros con la base actual. Protege fichas, nombres, fechas, perfiles originales, checadas, fotos binarias, asignaciones e historial; para resultados derivados comprueba sus identidades y relaciones. Admite registros nuevos de sincronización, comprueba relaciones huérfanas/relojes duplicados y guarda un informe en `backups/`.

Con comida individual configurada, el regreso esperado es la salida real más la duración asignada. Los retardos se evalúan por minuto completo, incluso con tolerancia cero. Salir tarde y regresar tarde generan dos incidencias de comida. En modo automático se registra únicamente la duración observada, sin sanciones de comida contra un horario inexistente. Las lecturas repetidas conservan su registro original y las jornadas incompletas o ambiguas no reciben movimientos inventados.

El driver TCP/IP interpreta las fechas locales de `node-zklib` con la zona horaria de la sucursal antes de guardarlas en UTC. Por ejemplo, Cancún usa `America/Cancun`, una hora adelante de Ciudad de México. La hora original se conserva en `rawData.deviceLocalTime`; una nueva sincronización reconoce la misma marca sin modificar su instante UTC ni sus datos originales, aunque cambie la configuración de visualización de la sucursal.

La zona se elige en **Sucursales → Editar → Zona horaria**. Al guardar se recalculan las jornadas y se actualizan las vistas. **Checadas** usa la zona de la sucursal o reloj seleccionado y consulta el día completo entre sus medianoches locales; con todas las sucursales utiliza Ciudad de México como referencia. Los cambios de visualización conservan los instantes UTC almacenados. Las zonas fronterizas respetan sus cambios estacionales de horario.

Los contadores de llegada y comida son independientes. Con tres retardos permitidos, el cuarto genera un día de descuento y consume ese grupo. El siguiente grupo comienza con su primer retardo. Se puede elegir mes calendario o periodos de 30 días desde el primer retardo; el extremo final del periodo es exclusivo. Los descuentos son registros de días para consulta y nómina, no movimientos bancarios. Un recálculo conserva los UUID de las incidencias y descuentos que siguen vigentes; las sanciones que dejan de corresponder quedan anuladas con historial.

El estado original del reloj se muestra como dato de verificación en **Checadas**. La etiqueta principal de movimiento y los resúmenes utilizan la clasificación automática por horarios.

## Acceso al panel

El panel requiere usuario y contraseña. Las cuentas son independientes de empleados y tienen rol administrador, RH o encargado; RH y encargados reciben una o varias sucursales explícitas. El backend restringe listas, recursos por ID, fotos, operaciones y exportaciones. El primer acceso con una contraseña temporal exige cambiarla. La instalación, recuperación del administrador, permisos y configuración de cookies/orígenes están en [docs/panel-auth.md](docs/panel-auth.md).

## Base de datos en Neon

La aplicación admite PostgreSQL en Neon mediante conexión directa y SSL con verificación de certificado. La sincronización y el recálculo guardan resultados por lotes para reducir viajes de red, conservando identidades, checadas originales e historial. La configuración, migración verificada, activación y respaldos se describen en [docs/neon-database.md](docs/neon-database.md).

## Verificación

Ejecute `npm run typecheck` y `npm test` para las comprobaciones de tipos y pruebas unitarias. Para ejecutar toda la suite con PostgreSQL, use `npm run test:integration`: crea una base temporal, aplica Prisma Migrate, ejecuta las pruebas y elimina la base al terminar.

También se admite `INTEGRATION_DATABASE_URL` explícita hacia una base de pruebas con prefijo `test_`. Las pruebas de organización/unificación usan además esquemas aislados y los eliminan al terminar. Cubren migraciones repetidas, UUID, relojes con IDs iguales, asignaciones con historial, tolerancias, descuentos, fotos/perfiles originales, rollback, compatibilidad HTTP y recuperación después de fallos del reloj. La regresión del SDK reproduce el callback `null.subarray`, comprueba que `/health` sigue respondiendo, registra la sincronización fallida y ejecuta otra sincronización exitosa. También prueba paquetes TCP binarios con el worker real y la terminación de procesos bloqueados.
