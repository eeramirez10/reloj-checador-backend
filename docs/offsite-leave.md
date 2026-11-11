# Trabajo autorizado, cancelaciones y correcciones

## Solicitar

Desde **Mis permisos** o **Asistencia → Permisos → Nueva solicitud**, elige tipo, fechas y motivo, revisa la solicitud y envíala al jefe asignado:

| Tipo | Captura y efecto al aprobar |
| --- | --- |
| Home office | Día completo o rango de fechas, con goce y sin vacaciones. No solicita horas. |
| Visita a cliente | Nombre del cliente opcional (hasta 200 caracteres), día completo o visita abierta sin horario. Con goce y sin vacaciones. No solicita entrada, salida ni regreso. |
| Llegar tarde / Salir temprano | Hora autorizada opcional. Con hora se evalúa el exceso; sin hora se justifica únicamente ese movimiento, no una ausencia completa. |
| Faltar | Con o sin goce; puede consumir vacaciones únicamente con goce. |

Home office y visitas aprobadas se muestran como **Trabajo autorizado** (`authorized_work`) en asistencia diaria, tarjetas y PDF. El resumen incluye `authorizedWorkDays`; las observaciones conservan tipo, cliente, modalidad y motivo. La modalidad abierta no define un intervalo: la autorización cubre las fechas laborables aprobadas.

Las checadas originales siguen disponibles para comprobar si hubo presencia en oficina. Se suprimen incidencias de presencia y faltantes de comida correspondientes al trabajo autorizado; las marcas intermedias permanecen como evidencia sin clasificarse como comida. No se inventan horas trabajadas, movimientos ni extras. Las extras quedan pendientes o sin registros según la evidencia disponible.

## Aprobar, retirar y cancelar

- **Aprobar / Rechazar:** exclusivamente el jefe asignado, con cuenta `employee` o `manager` vinculada, incluso entre sucursales. RH/admin no pueden resolver esas decisiones.
- **Retirar:** el solicitante puede cancelar su solicitud mientras siga pendiente, indicando motivo.
- **Cancelar administrativamente:** RH/admin pueden cancelar solicitudes pendientes o aprobadas dentro de su alcance. Para un aprobado esta es la única vía de cancelación; no requiere una cuenta administrativa vinculada a un empleado. El motivo es obligatorio.

La cancelación conserva la solicitud, aprobación y eventos anteriores. El nuevo evento registra motivo, estado anterior, cuenta, rol y empleado vinculado cuando existe. Se devuelven exactamente las vacaciones consumidas y se recalculan incidencias y descuentos con las reglas y checadas existentes. La decisión, devolución, evento y recálculo se guardan en una transacción; cualquier fallo revierte toda la operación. Las versiones impiden devoluciones duplicadas ante cancelaciones concurrentes.

## Corregir una solicitud

El solicitante o RH/admin dentro de su alcance pueden abrir una solicitud cancelada y pulsar **Crear solicitud corregida**. El formulario precarga los datos para modificarlos y exige otra revisión antes de enviar. Se crea una solicitud nueva pendiente con `replacesRequestId` apuntando a la cancelada del mismo empleado; no se edita ni se hereda la aprobación anterior. El jefe debe aprobar nuevamente.

## API y migración

Los contratos de preview, creación y resolución están en la sección **Permisos y vacaciones** del [README](../README.md). La API devuelve capacidades de aprobar, rechazar, cancelar y corregir; el servidor vuelve a validar cuenta, rol, versión y alcance al escribir.

`20261114000000_offsite_leave` agrega los tipos `home_office`/`client_visit`, permite hora nula para permisos parciales, añade `client_name`, `full_day`, `replaces_request_id` y los campos de auditoría `previous_status`/`actor_role`. Las restricciones impiden trabajo autorizado sin goce o con vacaciones y reservan la modalidad abierta y el nombre del cliente para visitas. Los permisos existentes mantienen su información.

Para actualizar Windows, respalda la base y el entorno privado, detén `RelojChecadorBackend`, instala dependencias y ejecuta `npm run migrate`, `npm run prisma:generate` y `npm run prisma:status` en el backend. Se aplican todas las migraciones pendientes, incluida `20261113000000_pending_employee_discard`. Compila frontend con `VITE_APP_BASE_PATH=/reloj/`, `VITE_API_BASE_URL=/reloj/api` y `npm run build -- --outDir dist-reloj`; inicia el servicio y verifica acceso, aprobación del jefe, cancelación RH, historial y PDF. Conserva la publicación HTTP y el Caddyfile existentes.

## Verificación

`tests/offsite-leave-company-assignment.integration.test.ts` comprueba checadas conservadas, ausencia de horas ficticias, cancelación administrativa, restitución de incidencias, horas opcionales, devolución concurrente única y rollback ante fallo de recálculo. Los flujos previos de permisos y vacaciones se verifican en `tests/leave.integration.test.ts`.

```bash
npm run typecheck
npm run prisma:validate
npm run test:integration
```

Las pruebas usan bases temporales. Desarrollo conserva `EMAIL_ENABLED=false`, `SYNC_ENABLED=false` y `TWILIO_WHATSAPP_ENABLED=false`.
