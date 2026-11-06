# Acceso al panel

Las cuentas del panel son independientes de empleados y usuarios de los relojes. Se guardan en la misma base PostgreSQL en `auth_accounts`, `auth_account_branches`, `auth_sessions` y `auth_audit_events`.

## Instalación y administrador inicial

```bash
npm run migrate
npm run auth:bootstrap -- --username admin --name "Administrador"
```

El comando genera una contraseña temporal aleatoria y la muestra una sola vez. No recibe contraseñas por argumentos ni usa una contraseña predeterminada. Solo permite crear el primer administrador si todavía no hay cuentas. El primer inicio de sesión exige cambiarla; después hay que iniciar sesión de nuevo.

El administrador crea las demás cuentas en **Administración → Cuentas de acceso**. Puede editar sus datos, desactivarlas, restablecer la contraseña y asignar una o varias sucursales. Guardar cambios revoca todas las sesiones de esa cuenta. Nadie puede desactivar ni degradar su propia cuenta administradora; debe permanecer al menos un administrador activo. Los cambios usan control de versión y se serializan para evitar conflictos.

Si se pierde el acceso al único administrador, el operador con acceso a la máquina del backend puede ejecutar:

```bash
npm run auth:bootstrap -- --username admin --reset
```

Solo restablece cuentas administradoras existentes. Genera otra contraseña temporal, revoca sus sesiones y registra la recuperación en auditoría.

## Roles y sucursales

| Acción | Administrador | RH | Encargado |
| --- | --- | --- | --- |
| Consultar empleados, asistencia, permisos y reportes/PDF | Todas | Asignadas | Asignadas |
| Resolver permisos | Sí | Asignadas | Asignadas |
| Gestionar empleados, horarios, vacaciones y adscripciones | Sí | Asignadas | No |
| Importar checadas, sincronizar usuarios, marcas y fotos | Sí | Asignadas | No |
| Administrar cuentas, crear/editar sucursales y dispositivos | Sí | No | No |
| Ajustar hora o rol de administrador del reloj | Sí | No | No |
| Recálculo global y documentación API | Sí | No | No |

RH y encargados deben tener al menos una sucursal explícita; una lista vacía nunca concede acceso global. La ubicación laboral de la persona no determina sus permisos. Un encargado o una cuenta de RH pueden recibir varias sucursales. Las cuentas administradoras incluyen todas, también las creadas después.

Los filtros de lectura se aplican en SQL antes de límites, paginación y totales. Se validan además los IDs de recursos y las referencias de cuerpos/consultas, incluyendo origen y destino de reasignaciones. Los relojes y perfiles históricos de otra sucursal no se exponen en el catálogo. Un periodo de asistencia que abarca una sucursal no autorizada se rechaza; hay que consultar un periodo permitido o asignar ambas sucursales. La edición y el historial completo de un empleado trasladado requieren acceso a sus sucursales históricas.

La identidad del operador proviene de su sesión. Los eventos de permisos y movimientos de vacaciones guardan `actor_account_id` dentro de la misma transacción; `actor_employee_id` conserva el responsable de negocio en cuyo nombre se registra la resolución y sigue validándose. El detalle muestra la cuenta que ejecutó la acción. La auditoría general registra las operaciones HTTP exitosas sin copiar cuerpos, contraseñas, imágenes ni secretos.

## Sesiones y configuración

- Contraseñas Argon2id, versión 19, memoria 19 MiB, 2 iteraciones y paralelismo 1, con sal aleatoria de 16 bytes. Implementación `@noble/hashes` asíncrona, sin bloquear continuamente el bucle de eventos.
- Cookie HttpOnly, SameSite=Strict, sin Domain. Con HTTPS usa Secure y el prefijo `__Host-`. No se guardan tokens en localStorage/sessionStorage.
- PostgreSQL guarda únicamente SHA-256 del token aleatorio de sesión. La vigencia absoluta predeterminada es de 8 horas. Cerrar sesión, cambiar/restablecer contraseña o editar accesos revoca sesiones en el servidor.
- Cada petición comprueba el estado y alcance actual de la cuenta. Las escrituras requieren un origen permitido y el encabezado `x-csrf-token` obtenido en `/auth/me`. El login también verifica el origen.
- El login admite hasta 5 intentos por minuto/IP por proceso. El proxy debe conservar el esquema de despliegue y no debe habilitarse confianza indiscriminada en `X-Forwarded-For`.
- Las respuestas autenticadas y las fotos usan `Cache-Control: no-store`. El frontend limpia consultas y mutaciones privadas al cerrar/cambiar sesión y vuelve a comprobar la sesión al recuperar foco y cada minuto. Al salir de Empleados se detiene la cola de fotos.

Desarrollo local:

```env
AUTH_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3005
AUTH_COOKIE_SECURE=false
AUTH_SESSION_HOURS=8
```

Producción, con frontend y API bajo el mismo origen mediante `/api`:

```env
AUTH_ALLOWED_ORIGINS=https://checador.example.com
AUTH_COOKIE_SECURE=true
AUTH_SESSION_HOURS=8
```

Los orígenes se comparan exactamente, sin comodines. Para abrir el panel mediante la IP LAN se agrega su origen completo con puerto. Se recomienda mantener frontend/API bajo el mismo origen; no se habilitan peticiones CORS con credenciales a sitios externos.

## API

- `POST /auth/login`: `{username,password}`; configura la cookie.
- `GET /auth/me`: cuenta actual y token CSRF, sin hash ni token de sesión.
- `POST /auth/logout`: revoca la sesión y elimina la cookie.
- `POST /auth/change-password`: `{currentPassword,newPassword}`; revoca todas las sesiones.
- `GET/POST /auth/accounts`, `PATCH /auth/accounts/:id`: exclusivamente administrador. La edición requiere `expectedVersion`; `password` es opcional para restablecerla.
- `GET /auth/audit`: últimos 200 eventos, exclusivamente administrador.

`/health` y los webhooks concretos de Twilio quedan fuera del login del panel. Los webhooks mantienen su firma, cuenta y remitente verificados mediante su integración existente. La sincronización programada sigue siendo interna. No hay opción de entorno para desactivar la autenticación; las pruebas de regresión inyectan explícitamente un principal en bases aisladas y las pruebas de auth usan sesiones reales.
