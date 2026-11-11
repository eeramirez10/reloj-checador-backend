# Portal del empleado y correo Microsoft 365

## Modelo y permisos

- `auth_accounts.employee_id` vincula una cuenta con un único empleado; las cuentas administrativas pueden permanecer sin vínculo.
- El usuario se captura libremente; el correo del expediente se utiliza para entregar accesos y notificaciones.
- El jefe se conserva en `employee_leave_profiles.manager_id`, referenciando otro empleado.
- Las solicitudes guardan su jefe responsable al crearse. Cambiar el jefe del expediente no reasigna solicitudes anteriores.
- Un jefe con cuenta `employee` o `manager` puede aprobar/rechazar únicamente las solicitudes que lo tienen asignado, incluso entre sucursales.
- Los roles `hr` y `admin` no pueden aprobar ni rechazar, aunque estén vinculados al jefe asignado. No existe excepción de administrador.
- El solicitante puede retirar su solicitud pendiente con motivo. RH/admin pueden cancelar solicitudes pendientes o aprobadas dentro de su alcance; un permiso aprobado solo puede cancelarse administrativamente. Se conservan la aprobación y el historial, se devuelven las vacaciones consumidas y se recalcula la asistencia en una sola transacción.
- Una solicitud cancelada puede originar una nueva solicitud corregida, vinculada a la anterior y sujeta a otra aprobación. Los tipos de trabajo autorizado y las reglas completas están en [offsite-leave.md](offsite-leave.md).
- Los empleados ven su asistencia de hoy, su tarjeta/PDF, sus solicitudes, las solicitudes asignadas como jefe y su perfil.
- Cada empleado puede editar su WhatsApp, teléfono alterno y tipo de sangre. RH/admin también pueden hacerlo dentro de sus alcances. Correo, jefe y datos laborales se administran por RH/admin.

RH puede elegir un jefe de otra sucursal mediante un catálogo reducido de ID, nombre y sucursal; eso no le concede acceso al expediente completo del jefe.

## Pantallas

1. Editar empleado → **Contacto**: registrar los datos de contacto que se necesiten y guardar. El correo es opcional para el acceso manual.
2. Editar empleado → **Permisos y vacaciones**: asignar jefe y saldo.
3. Editar empleado → **Acceso al sistema**: capturar usuario. La entrega inicia en **Manual, sin correo**: escribir o generar una contraseña temporal, copiarla y pulsar **Crear acceso manual**. Entregar usuario, contraseña y URL directamente al empleado.
4. La contraseña vence a las 24 horas y debe cambiarse en el primer acceso. Opcionalmente, elegir **Enviar por correo** y **Crear y enviar acceso** cuando el correo del empleado y la configuración de envío estén listos.
5. El jefe usa **Mis permisos → Por autorizar / mi equipo** o el enlace del correo para revisar y resolver.

En **Cuentas de acceso**, el administrador puede vincular cuentas existentes con empleados. Una cuenta de encargado sin vínculo conserva sus consultas por sucursal, pero necesita vincularse al jefe para resolver permisos.

### Crear cuentas sin Microsoft 365

En **Cuentas de acceso**, todos los roles permiten escribir o generar una contraseña temporal. Al crear una cuenta de empleado, seleccionar su ficha activa e identificada y guardar crea la cuenta y el vínculo de forma atómica; se respetan nombre, usuario y estado capturados. Al editar, una contraseña vacía conserva la anterior.

La entrega manual, tanto desde Cuentas de acceso como desde el expediente, no exige correo del empleado, `EMAIL_ENCRYPTION_KEY` ni credenciales de Microsoft. No crea mensajes en la cola ni devuelve contraseñas en respuestas de API. La contraseña capturada permanece únicamente en el formulario hasta cerrarlo, para poder copiarla; en la cuenta solo se guarda su hash. Regenerarla revoca las sesiones anteriores y mantiene una sola cuenta vinculada.

`POST /employees/:id/access` acepta `{username,delivery:'manual',password}` o `{username,delivery:'email'}`. Por compatibilidad, omitir `delivery` conserva el flujo de correo existente. La respuesta es `{username,emailId}`, con `emailId:null` para entrega manual. El envío por correo sigue exigiendo dirección y clave de cifrado. Mientras Microsoft 365 esté pendiente, mantener `EMAIL_ENABLED=false` y utilizar entrega manual.

## Configurar Microsoft 365

Remitente previsto: **rhmex@tuvansa.com.mx**, buzón existente de Exchange Online.

### 1. Registrar la aplicación

En `https://entra.microsoft.com/`:

1. **Identidad → Aplicaciones → Registros de aplicaciones → Nuevo registro**.
2. Nombre: `Reloj Checador - Correo RH`.
3. Seleccionar únicamente el directorio corporativo, **single tenant**.
4. Dejar vacía la URI de redirección. Esta integración utiliza credenciales de aplicación en el backend, no inicio de sesión Microsoft.
5. Guardar el **Id. de directorio (tenant)** y el **Id. de aplicación (cliente)**.
6. En **Certificados y secretos**, generar un secreto de cliente. Guardar su **valor**, no su identificador, en el `.env` privado del servidor y registrar su vencimiento para rotarlo.
7. En **Aplicaciones empresariales**, localizar la aplicación y copiar el **Id. de objeto de la aplicación empresarial / service principal**. Es distinto del Id. de objeto de Registro de aplicaciones.

### 2. Autorizar únicamente el buzón de RH

Utilizar **Application RBAC de Exchange Online**. El rol se asigna con alcance al buzón; no requiere un permiso global `Mail.Send` adicional en Entra. Los permisos globales de Entra y los de Exchange RBAC se suman: un permiso global independiente ampliaría el acceso.

En PowerShell con permisos de administración de Exchange:

```powershell
# Instalar solo si el módulo no está disponible.
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline

$ClientId = '<Id de aplicación / cliente>'
$ServicePrincipalId = '<Id de objeto de Aplicaciones empresariales>'

$Mailbox = Get-EXOMailbox -Identity 'rhmex@tuvansa.com.mx' -Properties ExternalDirectoryObjectId
$Mailbox | Format-List PrimarySmtpAddress,ExternalDirectoryObjectId

New-ServicePrincipal -AppId $ClientId -ObjectId $ServicePrincipalId -DisplayName 'Reloj Checador - Correo RH'
New-ManagementScope -Name 'RelojChecador-RH-Mailbox' -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'rhmex@tuvansa.com.mx'"
New-ManagementRoleAssignment -Name 'RelojChecador-RH-MailSend' -Role 'Application Mail.Send' -App $ServicePrincipalId -CustomResourceScope 'RelojChecador-RH-Mailbox'

Test-ServicePrincipalAuthorization -Identity $ServicePrincipalId -Resource 'rhmex@tuvansa.com.mx'
```

En una configuración existente, consultar los objetos antes de crearlos para evitar duplicados. El resultado para `Application Mail.Send` debe mostrar `InScope=True` para RH. Verificar también un buzón ajeno al alcance, donde debe ser `False`. La propagación puede tardar entre 30 minutos y 2 horas.

Usar el **ExternalDirectoryObjectId del buzón** como `MICROSOFT_SENDER_ID`; no confundirlo con el Id. de la aplicación empresarial.

Referencias oficiales:
- https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac
- https://learn.microsoft.com/en-us/graph/api/user-sendmail

### 3. Entorno privado del backend Windows

```dotenv
APP_ENV=production
EMAIL_ENABLED=true
EMAIL_ENCRYPTION_KEY=<64 caracteres hexadecimales aleatorios>
APP_PUBLIC_URL=http://tuvansa-server.dyndns.org:8080/reloj/
MICROSOFT_TENANT_ID=<Id del directorio>
MICROSOFT_CLIENT_ID=<Id de aplicación / cliente>
MICROSOFT_CLIENT_SECRET=<Valor del secreto>
MICROSOFT_SENDER_ID=<ExternalDirectoryObjectId del buzón rhmex@tuvansa.com.mx>
```

Generar la clave de cifrado en el servidor:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Guardar esta clave junto con el entorno privado. Conservarla mientras haya mensajes pendientes cifrados con ella. Las credenciales de Microsoft y la clave no deben añadirse a Git ni al frontend.

Microsoft Graph utiliza conexiones HTTPS salientes hacia Microsoft. La publicación de la aplicación conserva el puerto entrante 8080 y la ruta `/reloj/`.

## Cola y estados de correo

- La cuenta y el mensaje de bienvenida se registran en una única transacción. Solo se almacena el hash de la contraseña en la cuenta; el contenido pendiente del correo se cifra con AES-256-GCM, asociado al ID del mensaje.
- Regenerar el acceso invalida la contraseña y las sesiones anteriores. Los mensajes de bienvenida de versiones anteriores se vencen antes de enviarse.
- El worker procesa un mensaje cada 2 segundos, con reclamación por lease y exclusión entre procesos. Aplica hasta 5 intentos para rechazos recuperables y respeta `Retry-After` de Microsoft.
- `accepted` significa **aceptado por Microsoft Graph**, no entrega confirmada al destinatario. El contenido cifrado se elimina al aceptarse, vencer o fallar definitivamente.
- `uncertain` requiere revisión: Microsoft puede haber aceptado el mensaje aunque se haya perdido la respuesta. No se reenvía automáticamente para evitar duplicados. Revisar Elementos enviados y el seguimiento de mensajes de Exchange; para accesos, se puede generar uno nuevo desde el expediente.
- Los mensajes se vencen si el destinatario registrado cambia, el empleado queda inactivo, vence el plazo o la cuenta de bienvenida cambia de versión.
- Las notificaciones corresponden a eventos nuevos. El historial anterior permanece intacto.

La ficha del empleado muestra el estado de sus envíos de acceso. El detalle de cada permiso muestra el estado de sus notificaciones. Un error de entrega no revierte una solicitud o aprobación ya registrada.

## Desarrollo y pruebas

En desarrollo se exige `EMAIL_ENABLED=false`, junto con el aislamiento de base de datos y los trabajos existentes desactivados. Se puede configurar una clave de cifrado de desarrollo independiente para probar el registro de la cola sin activar envíos. Las pruebas automatizadas usan bases temporales y transportes simulados.

```bash
npm run typecheck
npm run test:integration
```

## Publicación Windows

1. Respaldar la base y los archivos privados de entorno.
2. Instalar el código revisado y sus dependencias. Detener el backend mientras se aplica la migración.
3. Desde el backend: `npm ci --include=dev`, `npm run migrate`, `npm run prisma:generate`.
4. Configurar Microsoft 365 y el entorno privado.
5. Compilar frontend conservando la publicación del subdirectorio:

```powershell
$env:VITE_APP_BASE_PATH = '/reloj/'
$env:VITE_API_BASE_URL = '/reloj/api'
npm ci
npm run lint
npm run build -- --outDir dist-reloj
```

6. Iniciar `RelojChecadorBackend` y verificar health, login y generación de un acceso de prueba. Mantener el Caddyfile y la publicación existente.
7. Confirmar la recepción real del correo, el cambio obligatorio de contraseña, el acceso personal y la aprobación por un jefe de otra sucursal. Verificar que RH/admin no vean acciones de aprobar/rechazar y que las peticiones directas también se rechacen.

La migración es `20261111000000_employee_portal`. Los vínculos con empleados son explícitos; no se asignan cuentas existentes por coincidencia de nombres o correos.
