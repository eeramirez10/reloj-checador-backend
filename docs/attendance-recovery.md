# Recuperar checadas después de una interrupción de red

## Uso

1. Conecta el servidor a una red desde la que alcance las IP y puertos de los relojes.
2. Entra con RH o administrador a **Asistencia → Checadas → Recuperar por fecha**, o a **Administración → Sincronización**.
3. Selecciona **Fecha a recuperar**, sucursal y reloj, o todos los relojes autorizados. Desde Checadas se precargan la fecha y los filtros actuales; desde Sincronización se propone hoy y se puede cambiar.
4. Pulsa **Recuperar por fecha**. Se consulta un reloj a la vez y se muestra su avance, registros leídos del día y registros nuevos del día.
5. Revisa los resultados. Una falla de conexión no impide intentar los demás relojes. **Reintentar pendientes** repite únicamente los fallidos/no intentados; la acción principal permite repetir toda la selección.
6. Cierra el diálogo y consulta la fecha elegida en Checadas. Las consultas de asistencia, tarjetas, incidencias, extras e historial se invalidan al terminar, incluso ante un error con avances parciales. Cambiar la fecha o los filtros limpia los resultados anteriores.

**Actualizar** o **Actualizar historial** consulta la base de datos; no descarga checadas del reloj.

## Qué recupera

La acción utiliza `POST /devices/:id/sync-attendance` con `{date:'YYYY-MM-DD'}`. El calendario debe ser válido; los campos desconocidos se rechazan antes de contactar al reloj. El día abarca desde las 00:00 locales inclusive hasta las 00:00 del siguiente día exclusive, usando `device.timeZone` o `America/Mexico_City` si falta. Por ejemplo, una misma marca a las 05:30 UTC pertenece al día anterior en México y al día actual en Cancún.

El equipo puede devolver su historial completo, pero el backend filtra por la fecha antes de preparar usuarios y guardar eventos. No se crean fichas ni checadas a partir de otros días de esa descarga. `receivedCount` e `insertedCount` corresponden únicamente al día elegido. La respuesta confirma además `date` y `timeZone`; el frontend valida que la fecha coincida con la solicitada.

Omitir `date` conserva la sincronización completa existente para el scheduler, compatibilidad y acciones generales. Esos intentos mantienen sus conteos de descarga completa. El historial lista los conteos del alcance de cada intento.

El recálculo utiliza todo el historial ya guardado y puede actualizar fechas relacionadas. Si una ruta cruza días y falta su entrada o regreso, recupera también ese otro día: el sistema vuelve a enlazar las marcas disponibles sin inventar checadas ni horas.

La descarga conserva el comportamiento acumulativo y las identidades existentes: guarda únicamente eventos nuevos del día, reconoce repeticiones y mantiene UUID, segundos y evidencia original. No modifica el reloj ni elimina checadas. Una descarga sin coincidencias para la fecha conserva lo que ya existe y la interfaz lo señala.

La sincronización manual puede utilizarse aunque el reloj tenga pausada la sincronización automática, sin reactivarla ni cambiar sus intervalos. Mantiene autenticación, CSRF, alcance por sucursal y bloqueo de operación por reloj. Encargados y empleados no pueden iniciarla.

## Errores y reintentos

- Si no hay conexión, revisa red, IP, puerto y servicio del backend; después reintenta.
- Si el reloj está ocupado por otra sincronización, espera y consulta el historial antes de repetir.
- Cada petición permite hasta 180 segundos en el navegador para lectura y recálculo. No se reintenta automáticamente. Si vence el plazo, la operación puede continuar en el servidor; consulta **Sincronización** antes de reintentar.
- Si se guardan checadas y falla el recálculo, permanecen guardadas. El historial informa registros leídos/nuevos del intento fallido. Repetir vuelve a recalcular sin duplicarlas.
- Si cambia la sesión o los permisos, se detiene la cola de peticiones; abortar una petición del navegador no revierte el trabajo que el servidor ya haya iniciado.
- Solo se recupera lo que el reloj todavía conserva. La acción no crea checadas faltantes ni estima horas desconocidas.

## Verificación y publicación

`tests/attendance-recovery.integration.test.ts` verifica desconexión y recuperación, repetición sin duplicados, límites exactos de medianoche, zonas México/Cancún, exclusión de usuarios de otros días, rechazo de fechas inválidas, conservación de originales, rutas recuperadas por días en distinto orden, avance parcial ante fallo de recálculo, sincronización manual con el automático pausado y bloqueo de peticiones simultáneas. Las pruebas usan bases aisladas y relojes simulados.

No agrega migraciones. Actualizar primero el backend para habilitar el filtro `date`, reiniciar su servicio y publicar el frontend compilado con `VITE_APP_BASE_PATH=/reloj/`, `VITE_API_BASE_URL=/reloj/api` y `npm run build -- --outDir dist-reloj`, conservando entornos y Caddy. Se deben publicar ambos repositorios: la versión anterior del backend no filtraba por día. La recuperación se ejecuta en el backend Windows conectado a la red de relojes.
