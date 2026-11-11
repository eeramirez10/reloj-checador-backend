# Empresas y clasificación de empleados

## Uso

1. El administrador abre **Administración → Empresas** y agrega nombre, código interno opcional, observaciones opcionales y estado.
2. RH o administrador abre **Empleados → Opciones → Editar → Datos generales → Empresa** y guarda la ficha. También puede elegir la empresa al crear un empleado.
   - Para asignar varias fichas, abre **Administración → Empresas → Asignar empleados**. Filtra por sucursal, empresa actual o Sin empresa y busca por nombre o ID del reloj.
   - Ordena por nombre, sucursal o empresa, ascendente o descendente. La selección se conserva al recorrer páginas o cambiar filtros; el guardado afecta únicamente a los empleados seleccionados.
   - Se puede cambiar a empleados desde otra empresa. La tabla muestra su empresa actual antes de confirmar. Si un vínculo cambió desde la consulta, se rechaza todo el lote para revisarlo nuevamente.
3. En Empleados, Asistencia diaria, Tarjetas de asistencia y Horas extras, combina **Sucursal** con **Empresa**:
   - **Todas las empresas**: todos los empleados que coincidan con los demás filtros, mostrando su empresa.
   - Una empresa concreta: únicamente sus empleados.
   - **Sin empresa**: empleados pendientes de clasificación.
4. Los PDF de tarjetas y horas extras muestran la empresa actual, el filtro aplicado y todos los resultados coincidentes, incluyendo las demás páginas.

El empleado puede consultar su empresa desde Mi perfil y su tarjeta. La asignación la administra RH/admin.

RH puede abrir Empresas para asignar empleados; crear o editar el catálogo sigue siendo exclusivo del administrador. El directorio de Empleados también permite ordenar por nombre, sucursal o empresa en ambos sentidos.

## Criterio de los reportes

Se utiliza la **empresa actual del expediente**, también al consultar periodos anteriores. Cambiarla reclasifica las consultas posteriores sin cambiar checadas, jornadas evaluadas, incidencias, descuentos, cuenta de acceso ni ID del empleado.

Las sucursales mantienen su comportamiento existente: tarjetas y extras seleccionan la sucursal/estado actuales del empleado, mientras la asistencia diaria consulta la sucursal de cada jornada. La clasificación empresarial no amplía los permisos por sucursal.

Una empresa inactiva continúa visible en consultas y conserva sus empleados. No se puede asignar a empleados nuevos ni a empleados de otra empresa; un empleado que ya la tenga puede conservarla al guardar su ficha.

Los empleados existentes quedan sin empresa. No se crean empresas ni vínculos automáticamente a partir de códigos importados. El campo externo `company_code` se conserva por separado; reimportarlo no sobrescribe `company_id`.

Al asociar una ficha pendiente con una confirmada, una empresa existente se conserva cuando la ficha destino no tiene ninguna. Si ambas tienen empresas distintas, la asociación se rechaza para que se revise explícitamente la clasificación. El snapshot de la asociación conserva los valores anteriores.

## API y permisos

- `GET /companies`: catálogo, disponible para administrador, RH y encargado. No expone empleados ni totales globales por empresa.
- `POST /companies`: exclusivamente administrador; `{name,code,active,notes}`. Código y observaciones son opcionales.
- `PATCH /companies/:id`: exclusivamente administrador; datos del catálogo y `expectedVersion`. Cambios concurrentes devuelven 409.
- `GET /companies/:id/employees`: RH/admin; candidatos con `branchId`, `companyId` (UUID o `unassigned`), `search`, `sortBy=name|branch|company`, `sortOrder=asc|desc`, `page` y `limit` (hasta 100). Alcance y filtros se aplican antes de paginar.
- `POST /companies/:id/employees`: RH/admin; `{expectedVersion,assignments:[{employeeId,expectedCompanyId}]}`, hasta 500 empleados. `expectedCompanyId` es UUID o `null`. Valida empresa activa, versión, cuenta y alcance, bloquea las fichas y guarda todo el lote con auditoría o revierte todo. No recalcula asistencia.
- `POST /employees` y `PATCH /employees/:id`: aceptan `companyId`, UUID o `null`, dentro de la transacción de la ficha. El cambio exclusivo de empresa no dispara recálculos de asistencia.
- `GET /employees`: admite `branchId` y `companyId`; ambos pueden ser un UUID o `unassigned`. Admite `sortBy=name|branch|company` y `sortOrder=asc|desc`. Las restricciones y filtros se aplican antes del límite.
- `GET /attendance/daily` y `/attendance/deductions`: admiten `companyId` y devuelven `companyId`/`companyName` actuales por registro.
- `GET /attendance/cards`, `/attendance/cards/export`, `/attendance/overtime` y `/attendance/overtime/export`: admiten `companyId`; cuando se filtra devuelven `companyFilter: {id,name}`. Para Sin empresa, `id` es `null`.
- Omitir `companyId` selecciona todas las empresas dentro del alcance autorizado y los otros filtros.

El catálogo solo se administra por cuentas administradoras; RH/administrador asignan empresas a empleados de su alcance. El rol empleado mantiene sus rutas personales y no puede editar su empresa. Se conservan autenticación, CSRF y validación de origen.

## Modelo y migración

`20261112000000_employee_companies` agrega:

- `companies`: nombre, código opcional, activo, observaciones, versión y fechas de registro/actualización.
- `employees.company_id`: FK opcional, una empresa por empleado.
- Índices para nombres/códigos sin duplicados por mayúsculas y selección por sucursal/empresa/estado.

La asignación no altera el jefe directo ni las facultades de aprobación de permisos.

## Actualización en Windows

1. Respaldar la base y conservar el entorno privado del backend.
2. Instalar la versión revisada de ambos repositorios; incluye el portal del empleado implementado previamente.
3. Detener `RelojChecadorBackend` mientras se actualiza el esquema.
4. En el backend, ejecutar:

```powershell
npm ci --include=dev
npm run migrate
npm run prisma:generate
npm run prisma:status
```

5. Compilar el frontend bajo la ruta publicada:

```powershell
$env:VITE_APP_BASE_PATH = '/reloj/'
$env:VITE_API_BASE_URL = '/reloj/api'
npm ci
npm run lint
npm run build -- --outDir dist-reloj
```

6. Iniciar `RelojChecadorBackend` y verificar health y login. Caddy sigue sirviendo `dist-reloj` y el proxy `/reloj/api/` existente.
7. Crear las empresas reales, clasificar empleados y verificar México + Todas las empresas, una empresa concreta y Sin empresa. Descargar ambos PDF.

## Verificación

Las pruebas de integración usan bases temporales: catálogo y versiones, permisos, empresas inactivas, asignación atómica, filtros antes de límites/paginación, exportación completa, totales de extras, etiquetas actuales sin modificar checadas, importaciones y asociación de fichas.

```bash
npm run typecheck
npm run test:integration
```

En desarrollo se conserva la base aislada y los trabajos externos desactivados. La configuración de correo Microsoft 365 está documentada por separado en `employee-portal-microsoft365.md`.
