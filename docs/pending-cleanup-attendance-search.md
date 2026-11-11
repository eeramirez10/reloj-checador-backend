# Limpieza de pendientes y búsqueda en tarjetas

## Confirmar registros sincronizados

Los usuarios nuevos del reloj crean fichas pendientes. **Identificar → Completar y confirmar esta ficha → Guardar identificación** confirma el expediente conservando el mismo vínculo con el reloj. La alternativa de asociar con otro empleado corresponde a una ficha ya existente.

## Eliminar pendientes sin checadas

RH y administrador pueden usar **Empleados → Pendientes de identificar → Opciones → Eliminar de la lista**.

- Solo se permiten fichas pendientes sin ninguna checada registrada, revisando todos sus vínculos activos/históricos, todos los dispositivos y todas las fechas.
- Se conserva el empleado, UUID, vínculos, fotos, empresa, horarios y auditoría. La ficha deja de aparecer en el directorio, selectores de usuarios y reportes generales.
- La operación conserva el estado laboral y las fechas de alta/baja. No modifica ni elimina usuarios del equipo físico.
- Un registro confirmado o con referencias de negocio protegidas —cuenta de acceso, permisos, movimientos de vacaciones, evaluaciones o fusiones— requiere revisión y no se descarta.
- Se valida el alcance sobre la sucursal actual y las históricas. Encargados y empleados no tienen permiso para esta operación.
- El botón se deshabilita si la ficha ya tiene checadas; el servidor repite todas las comprobaciones dentro de la transacción.

La comprobación utiliza los registros ya importados a la aplicación. Una sincronización posterior puede traer asistencia antigua del reloj y recuperar la ficha.

### Recuperación automática

Sincronizar nuevamente los usuarios del reloj o preparar sus vínculos no levanta el descarte. Al insertarse una checada real —nativa o importada de archivo— se recupera **el mismo empleado como pendiente** en la misma transacción que guarda esa asistencia.

La deduplicación conserva su comportamiento: repetir una descarga o archivo no crea otro empleado ni otro evento de recuperación. Una importación o inserción fallida revierte también la recuperación y su auditoría. Se conserva el ID exacto del usuario por dispositivo, incluyendo ceros iniciales.

El historial del empleado recuperado incluye **Eliminaciones de la lista y recuperaciones**, con fecha, motivo y cuenta que realizó el descarte; la recuperación referencia la checada que la originó.

### API y almacenamiento

- `POST /employees/:id/discard`, body `{}` o `{reason}` (hasta 500 caracteres), devuelve 204. Requiere sesión, origen autorizado, CSRF y rol RH/admin.
- `employees.discarded_at` conserva el descarte; la identificación permanece `pending`.
- `employee_discard_events` guarda eventos `discarded`/`restored`, cuenta responsable y referencia de asistencia.
- Los bloqueos de ingestión por dispositivo se adquieren antes de bloquear al empleado y se estabilizan los vínculos frente a identificación/asociaciones.
- Un trigger `AFTER INSERT` en `attendance_logs` recupera al empleado descartado de ese par dispositivo/usuario y registra el evento de manera atómica.
- `Employee.hasAttendance` informa si cualquiera de sus vínculos tiene checadas, para presentar la acción correctamente. La decisión definitiva corresponde al servidor.

## Reporte general de tarjetas

En **Tarjetas de asistencia**, únicamente **Estado del empleado** cambia su valor inicial a **Activos**; se puede seleccionar Inactivos. Sucursal y fechas permanecen pendientes de selección y Empresa conserva Todas las empresas.

**Buscar empleado** admite coincidencias parciales por nombre/apellidos o ID del reloj, sin distinguir mayúsculas. Se combina con sucursal, empresa, estado y periodo; dejarlo vacío consulta a todos los que coincidan con los demás filtros.

La búsqueda se aplica al pulsar **Consultar** o Enter. Cambiarla limpia el resultado y la exportación anteriores; la siguiente consulta comienza en la primera página.

Los filtros de búsqueda, permisos y descarte se aplican en SQL antes del conteo y paginación. El PDF solicita todos los resultados de la misma selección y muestra la búsqueda utilizada en el encabezado y nombre del archivo.

La API de tarjetas (`/attendance/cards` y `/attendance/cards/export`) admite `search` opcional, con espacios exteriores recortados y máximo de 120 caracteres. El texto se parametriza y `%`, `_` y barra invertida se tratan como caracteres literales. Los IDs históricos solo participan si el usuario tiene acceso a la sucursal del reloj.

## Publicación Windows

1. Respaldar la base y conservar el entorno privado y la compilación anterior.
2. Instalar la versión revisada de backend y frontend; detener `RelojChecadorBackend` mientras se actualiza el esquema.
3. Backend: `npm ci --include=dev`, `npm run migrate`, `npm run prisma:generate`, `npm run prisma:status`.
4. Confirmar aplicada **`20261113000000_pending_employee_discard`**. Usar Prisma Migrate: la migración incluye el trigger de recuperación, además de las tablas/campos.
5. Compilar frontend con `VITE_APP_BASE_PATH=/reloj/`, `VITE_API_BASE_URL=/reloj/api` y `npm run build -- --outDir dist-reloj`.
6. Iniciar backend y verificar health/login. El Caddyfile y el puerto 8080 mantienen su configuración.
7. Verificar el estado Activos inicial, búsqueda y PDF. Probar descarte solo sobre un pendiente de prueba sin checadas; una checada real posterior debe recuperar su mismo UUID como pendiente.

## Verificación técnica

Las pruebas de integración cubren permisos y CSRF, conservación de fotos/datos, sincronización repetida de usuarios, ingestión nativa y de archivos con ceros iniciales, checadas históricas/equipos eliminados, IDs iguales entre equipos independientes, historial protegido, rollback y concurrencia en ambos órdenes entre descarte e ingestión. La búsqueda se verifica antes de paginar, en exportaciones completas y con filtros por sucursal/empresa.
