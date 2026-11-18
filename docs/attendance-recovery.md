# Recuperar checadas después de una interrupción de red

## Uso

1. Conecta el servidor a una red desde la que alcance las IP y puertos de los relojes.
2. Entra con RH o administrador a **Asistencia → Checadas → Recuperar ayer y hoy**, o a **Administración → Sincronización**.
3. Selecciona una sucursal y un reloj, o todos los relojes autorizados. Desde Checadas se precargan sus filtros actuales.
4. Pulsa **Recuperar ayer y hoy**. Se consulta un reloj a la vez y se muestra su avance, registros leídos y registros nuevos.
5. Revisa los resultados. Una falla de conexión no impide intentar los demás relojes. **Reintentar pendientes** repite únicamente los fallidos/no intentados; la acción principal permite repetir toda la selección.
6. Cierra el diálogo y consulta ayer u hoy en Checadas. Las consultas de asistencia, tarjetas, incidencias, extras e historial se invalidan al terminar, incluso ante un error con avances parciales.

**Actualizar** o **Actualizar historial** consulta la base de datos; no descarga checadas del reloj.

## Qué recupera

La acción reutiliza `POST /devices/:id/sync-attendance`: lee todos los registros que conserva el equipo, incluidos ayer, hoy y fechas anteriores. Las fechas del diálogo son una referencia en la zona horaria de cada reloj; los conteos corresponden a la descarga completa. No se descarta el histórico porque puede ser necesario para cerrar rutas que comenzaron antes del periodo.

La descarga conserva el comportamiento acumulativo y las identidades existentes: guarda únicamente eventos nuevos, reconoce repeticiones y mantiene UUID, segundos y evidencia original. No modifica el reloj ni elimina checadas. Una descarga vacía conserva lo que ya existe, pero no demuestra que se haya recuperado información; la interfaz lo señala.

La sincronización manual puede utilizarse aunque el reloj tenga pausada la sincronización automática, sin reactivarla ni cambiar sus intervalos. Mantiene autenticación, CSRF, alcance por sucursal y bloqueo de operación por reloj. Encargados y empleados no pueden iniciarla.

## Errores y reintentos

- Si no hay conexión, revisa red, IP, puerto y servicio del backend; después reintenta.
- Si el reloj está ocupado por otra sincronización, espera y consulta el historial antes de repetir.
- Cada petición permite hasta 180 segundos en el navegador para lectura y recálculo. No se reintenta automáticamente. Si vence el plazo, la operación puede continuar en el servidor; consulta **Sincronización** antes de reintentar.
- Si se guardan checadas y falla el recálculo, permanecen guardadas. El historial informa registros leídos/nuevos del intento fallido. Repetir vuelve a recalcular sin duplicarlas.
- Si cambia la sesión o los permisos, se detiene la cola de peticiones; abortar una petición del navegador no revierte el trabajo que el servidor ya haya iniciado.
- Solo se recupera lo que el reloj todavía conserva. La acción no crea checadas faltantes ni estima horas desconocidas.

## Verificación y publicación

`tests/attendance-recovery.integration.test.ts` verifica desconexión y recuperación, repetición sin duplicados, conservación de registros originales, rutas entre ayer y hoy, avance parcial ante fallo de recálculo, sincronización manual con el automático pausado y bloqueo de peticiones simultáneas. Las pruebas usan bases aisladas y relojes simulados.

Esta función reutiliza el endpoint existente y no agrega migraciones. Publicar el frontend compilado con `VITE_APP_BASE_PATH=/reloj/`, `VITE_API_BASE_URL=/reloj/api` y `npm run build -- --outDir dist-reloj`, conservando la configuración de Caddy y del backend. La recuperación debe ejecutarse desde el servidor Windows conectado a la red de relojes.
