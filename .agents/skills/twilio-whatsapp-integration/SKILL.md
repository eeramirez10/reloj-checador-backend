---
name: twilio-whatsapp-integration
description: Integra o adapta WhatsApp mediante Twilio en un proyecto backend, con un numero remitente, arquitectura por capas, mensajes, plantillas, documentos, webhooks firmados y seguimiento de entrega. Usar al conectar un numero nuevo o trasladar una integracion de WhatsApp a otro proyecto.
---

# Integrar WhatsApp con Twilio

Implementa una integracion reutilizable y comprobable en el proyecto destino.
Esta skill es autocontenida: no depende del proyecto de origen, de rutas locales,
de credenciales existentes ni de otra skill. Los ejemplos usan Node.js/TypeScript;
si el destino usa otro lenguaje, conserva los contratos y usa su SDK oficial.

## 1. Descubrir el destino y delimitar la integracion

- Leer las instrucciones del repositorio, stack, autenticacion, persistencia,
  almacenamiento, procesos en segundo plano y configuracion por entorno.
- Identificar adaptadores o webhooks existentes antes de crear otros. Respetar
  la arquitectura y el gestor de paquetes del destino; no reestructurarlo entero.
- Implementar el alcance solicitado: envio, recepcion, plantillas y estados.
  Los documentos se incorporan cuando aplican al caso de uso. Bandeja, IA,
  reportes y control humano son extensiones, no dependencias de Twilio.
- Confirmar con la configuracion disponible la cuenta/subcuenta, remitente,
  dominio publico, rutas y plantillas. Preguntar solo lo que no pueda descubrirse.
  Si faltan secretos, completar codigo y pruebas con dobles e informar los
  pendientes; no inventar configuracion ni afirmar que hubo entrega real.

## 2. Arquitectura y dependencias

Usar puertos y adaptadores, adaptando los nombres a las convenciones existentes.
En un proyecto nuevo, esta es una estructura de referencia:

```text
src/
  domain/
    entities/whatsapp-message.ts
    contracts/whatsapp-messaging.port.ts
    contracts/whatsapp-message-repository.port.ts
    contracts/attachment-storage.port.ts
  application/
    send-whatsapp-message.use-case.ts
    receive-whatsapp-message.use-case.ts
    update-whatsapp-delivery.use-case.ts
  infrastructure/
    messaging/twilio-whatsapp.adapter.ts
    persistence/whatsapp-message.repository.ts
    storage/attachment-storage.adapter.ts
  presentation/
    http/whatsapp.routes.ts
    http/twilio-webhooks.controller.ts
    workers/whatsapp.worker.ts                 # Solo si se necesita
  config/
    env.ts
    composition.ts
```

En proyectos que ubican los casos de uso en `domain/use-cases`, conservar esa
convencion. El dominio y los casos de uso dependen de contratos; el SDK Twilio
y el ORM quedan en infraestructura. La composicion conecta implementaciones.

```text
Frontend -> API autenticada -> Caso de uso -> Puerto -> Adaptador Twilio
Twilio -> Webhook con firma validada -> Caso de uso -> Repositorio
Worker opcional -> Caso de uso -> Puerto -> Adaptador Twilio
```

Contratos orientativos; adaptar los identificadores a la aplicacion:

```typescript
type OutboundContent =
  | { kind: "TEXT"; body: string }
  | { kind: "MEDIA"; url: string; caption?: string }
  | { kind: "TEMPLATE"; templateKey: string; variables: Record<string, string> };

type DeliveryState = "PENDING" | "QUEUED" | "SENT" | "DELIVERED" | "READ" | "FAILED";

interface WhatsAppMessagingPort {
  send(input: {
    attemptId: string;
    recipientE164: string;
    content: OutboundContent;
  }): Promise<{
    providerMessageId: string;
    state: DeliveryState;
    providerStatus: string;
  }>;
}

interface WhatsAppMessageRepositoryPort {
  createOrGetAttempt(input: {
    idempotencyKey: string; recipientE164: string;
  }): Promise<{ id: string; created: boolean }>;
  claimAttempt(attemptId: string): Promise<boolean>;
  attachProviderReceipt(attemptId: string, providerMessageId: string, state: DeliveryState): Promise<void>;
  recordInboundOnce(input: {
    accountSid: string; messageSid: string; businessE164: string;
    participantE164: string; body: string;
  }): Promise<{ created: boolean }>;
}
```

El adaptador resuelve `templateKey` a un Content SID y un mapeo de variables
configurados. El frontend no elige cuentas, secretos, remitentes o URLs de
callback arbitrarios. Los controladores traducen HTTP, validan identidad y
delegan; las reglas de ventana y entrega pertenecen a los casos de uso.

## 3. Numero nuevo y configuracion

Verificar que el numero este registrado y habilitado como WhatsApp Sender en
la cuenta/subcuenta correcta. Un numero comprado o verificado para voz/SMS no
demuestra que este habilitado para WhatsApp. Comprobar la WABA asociada y que
las plantillas esten disponibles y aprobadas para esa configuracion. Reutilizar
las existentes si corresponde; no asumir que un SID sirve en otra cuenta.
Consultar el [alta oficial de remitentes](https://www.twilio.com/docs/whatsapp/self-sign-up).

Crear o actualizar un `.env.example` sin secretos. Estos nombres son
convenciones propuestas de la aplicacion, no variables que Twilio lea por si solo:

```dotenv
TWILIO_WHATSAPP_ENABLED=false
TWILIO_ACCOUNT_SID=AC_REEMPLAZAR
TWILIO_AUTH_TOKEN=REEMPLAZAR
TWILIO_WHATSAPP_FROM=whatsapp:+15551234567
PUBLIC_API_URL=https://api.example.com/backend
TWILIO_INCOMING_WEBHOOK_URL=https://api.example.com/backend/api/integrations/twilio/whatsapp/incoming
TWILIO_STATUS_CALLBACK_URL=https://api.example.com/backend/api/integrations/twilio/whatsapp/status
PHONE_DEFAULT_COUNTRY=MX

# Solo para los casos que necesitan plantillas o documentos:
TWILIO_WHATSAPP_NOTIFICATION_CONTENT_SID=HX_REEMPLAZAR
TWILIO_WHATSAPP_DOCUMENT_CONTENT_SID=HX_REEMPLAZAR
DOCUMENT_SIGNING_SECRET=REEMPLAZAR_POR_SECRETO_ALEATORIO_ESTABLE
```

- Conservar nombres equivalentes ya usados en el destino. Validar los valores
  activos al arrancar; los ejemplos ficticios no son configuracion valida.
- Guardar las credenciales solo en backend/gestor de secretos. Para autenticar
  envios pueden usarse API keys si el destino ya las adopta; conservar el Auth
  Token correspondiente para validar firmas de webhooks.
- Mantener bases, remitentes, URLs y mapeos de plantillas separados por entorno.
  Un despliegue de desarrollo no debe cambiar webhooks de otro numero activo.
- `TWILIO_VERIFY_SERVICE_SID` solo se necesita si se implementa Twilio Verify;
  no es requisito de la mensajeria ordinaria.

## 4. Envio y seleccion de plantilla

Persistir el intento local antes de llamar al proveedor. Generar una clave de
idempotencia por operacion, documento/version y destinatario segun el negocio;
protegerla con unicidad y una reclamacion atomica del intento. Evitar que dos
peticiones o workers envien simultaneamente la misma operacion.

Normalizar el telefono con una libreria de numeracion y un pais predeterminado
configurable. Conservar numeros internacionales explicitos y rechazar los
invalidos. Guardar E.164 (`+...`) y agregar `whatsapp:` una sola vez al enviar.
No fijar `+52` para todos los proyectos ni transformar prefijos historicos sin
una regla de compatibilidad verificada. Normalizar tambien al guardar contactos.

Calcular la ventana por cuenta/remitente y participante, usando el ultimo mensaje
entrante del usuario. Dura 24 horas; un envio saliente no la renueva. Sin entrada
registrada, no asumir una ventana abierta. Fuera de ella, exigir una plantilla
aprobada y respetar el consentimiento y preferencias de contacto de la aplicacion.
Ver [reglas del canal](https://www.twilio.com/docs/whatsapp/api).

| Modalidad | Parametros del SDK Node en `messages.create` |
| --- | --- |
| Texto dentro de ventana | `from`, `to`, `body`, `statusCallback` |
| Archivo dentro de ventana | `from`, `to`, `mediaUrl`, `statusCallback`; texto solo si el canal/tipo admite esa combinacion |
| Plantilla aprobada | `from`, `to`, `contentSid`, `contentVariables: JSON.stringify(...)`, `statusCallback` |

En una solicitud de plantilla, no combinar `body` o `mediaUrl` con `contentSid`.
Definir un mapeo explicito por plantilla, incluidos orden y significado de las
variables. La variable de un medio puede ser solo el sufijo de una URL fija,
segun su definicion aprobada. No asumir que siempre contiene una URL completa.
Ver [envio de Content Templates](https://www.twilio.com/docs/content/send-templates-created-with-the-content-template-builder).

Guardar `sid` y el estado inicial de la respuesta. Un SID confirma que existe
un mensaje del proveedor; no acredita entrega al destinatario. Si texto y PDF
requieren dos envios, registrar ambos SIDs como partes de la misma operacion;
la entrega del texto no prueba que llego el archivo.

Si un timeout deja incierto si Twilio acepto el envio, conservar el intento como
pendiente de conciliacion y evitar un reenvio ciego. No asumir que el endpoint
de creacion ofrece idempotencia del proveedor. Conciliar mediante callbacks,
el SID disponible o diagnostico del intento antes de decidir otro envio.

## 5. HTTP, firma y proxy

Rutas de referencia, ajustadas al prefijo y convenciones del destino:

| Ruta | Acceso y respuesta |
| --- | --- |
| `POST /api/whatsapp/messages` | Usuario autenticado y autorizado sobre el destinatario/operacion; responder intento y estado real, normalmente `202` |
| `POST /api/integrations/twilio/whatsapp/incoming` | Firma Twilio valida; persistir y confirmar recepcion |
| `POST /api/integrations/twilio/whatsapp/status` | Firma Twilio valida; persistir el cambio antes del `2xx` |
| `GET /api/whatsapp/messages/:id` | Autenticacion y autorizacion para consultar el resultado |

Los webhooks no usan el JWT de los usuarios. Para las solicitudes de formulario
convencionales, parsear `application/x-www-form-urlencoded`, recoger todos los
parametros y validar `X-Twilio-Signature` con el helper oficial y el Auth Token
de la cuenta correcta. Hacerlo antes de normalizar, filtrar o ejecutar efectos.
Una firma invalida debe impedir persistencia, respuestas del bot y envios.

La firma debe comprobarse con la URL externa exacta que invoco Twilio: HTTPS,
host, prefijo del proxy, ruta, barra final y query string cuando exista. Obtener
la base de configuracion confiable; no aceptar cualquier Host o encabezado
reenviado. Si un proxy publica `/backend/` y lo elimina internamente, conservar
ese prefijo en la validacion. Configurar confianza de proxy segun el despliegue.
Para payloads de otro tipo, aplicar el procedimiento oficial correspondiente;
no reutilizar sin mas la validacion de formularios.
Ver [validacion de firmas](https://www.twilio.com/docs/usage/security) y
[webhooks seguros](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

Recibir `MessageSid`, `AccountSid`, `From`, `To`, `Body`, `NumMedia`,
`MediaUrlN` y `MediaContentTypeN` segun corresponda. Tolerar campos adicionales.
Usar cuenta/remitente y participante para resolver la conversacion; no mezclar
clientes por compartir el numero remitente entre instalaciones o tenants.

Deduplicar el mensaje entrante por cuenta y `MessageSid`. Persistir mensaje y
trabajo pendiente de forma durable y atomica (outbox o mecanismo equivalente).
Solo el registro nuevo debe disparar efectos. Confirmar pronto y procesar
descargas/IA fuera del webhook; si falla la persistencia, no confirmar exito.
Si no hay respuesta inmediata, devolver TwiML vacio `200 text/xml`:

```xml
<Response></Response>
```

Ver [webhooks de mensajeria](https://www.twilio.com/docs/usage/webhooks/messaging-webhooks)
y [campos entrantes](https://www.twilio.com/docs/messaging/guides/webhook-request).

## 6. Entrega, persistencia y errores

Modelo minimo adaptable: conversacion, mensaje/intento, archivo y evento de
estado. Reutilizar tablas existentes; agregar migraciones compatibles cuando
se necesiten. Conservar mensaje logico e intentos separados para no perder
trazabilidad al reintentar. Guardar como minimo direccion, cuenta/remitente,
participante, SID, estado, fechas y errores del proveedor.

| Proveedor | Estado o texto de la aplicacion |
| --- | --- |
| Intento local sin respuesta del proveedor | Pendiente / pendiente de conciliacion |
| `accepted`, `queued`, `sending` | Pendiente de entrega |
| `sent` | Enviado al canal |
| `delivered` | Entregado |
| `read` | Leido, cuando el destinatario permite confirmaciones |
| `failed`, `undelivered` | Fallido; conservar `ErrorCode` y detalle |

Guardar el estado inicial de la respuesta API: no se emite callback para ese
primer estado. Procesar callbacks repetidos sin duplicar efectos; conservar
eventos tardios y evitar retrocesos como `READ -> SENT`. Ante estados terminales
contradictorios, conciliar con el proveedor. La ausencia de `read` no es un fallo.
Prever callbacks que lleguen antes de persistir el SID mediante correlacion del
intento o almacenamiento durable de eventos pendientes. Si se agrega `attemptId`
a la URL, incluir esa query exacta al validar la firma.
Ver [ciclo de estados y callbacks](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks).

Traducir errores a la respuesta API y al toast/componente de estado del frontend.
Mostrar "solicitud aceptada / pendiente de entrega" al encolar, no "entregado".
Registrar IDs y codigos de error con correlacion; evitar secretos, tokens de
documentos y cuerpos sensibles completos en logs. Reintentar solo errores
transitorios con limite y espera creciente. Corregir primero numero, plantilla,
ventana, permisos o archivo cuando el error sea permanente.

## 7. Documentos y adjuntos

- Para salida, generar la URL del archivo real del entorno activo, con HTTPS,
  MIME y nombre/extensiones coherentes. Preferir acceso firmado y acotado, con
  vigencia suficiente para descarga y reintentos; no exigir una sesion del navegador.
- Comprobar desde fuera del servidor respuesta y contenido efectivos. Un `200`
  puede contener una pantalla HTML, una pagina de tunel o el PDF de muestra.
- Probar `HEAD` y `GET` donde corresponda; una prevalidacion no reemplaza el
  seguimiento posterior de entrega y errores.
- En plantillas, comprobar el medio aprobado y la URL final tras sustituir
  variables. Un link correcto en el cuerpo no prueba que el adjunto del encabezado
  sea correcto. El archivo usado para aprobar la plantilla no es el documento
  de cada envio. No fijar `sample.pdf` como archivo operativo.
- Limitar tipos/tamanos conforme al canal y verificar las restricciones vigentes;
  no reutilizar limites de MMS como si fueran de WhatsApp.
- Para entrada, descargar con las credenciales y destinos admitidos por Twilio;
  no reenviar autenticacion a hosts arbitrarios tras una redireccion. Aplicar
  limites, saneamiento de nombres y almacenamiento privado.
- Persistir estado `PENDING/READY/FAILED` del adjunto. Una IA o extractor que
  dependa de el espera `READY`. Un audio se identifica por MIME, no por el nombre;
  la aceptacion o rechazo depende del producto destino, no de esta skill.

Ver [plantillas de medios](https://www.twilio.com/docs/content/twilio-media) y
[diagnostico de descarga](https://www.twilio.com/docs/api/errors/63019).

## 8. Extensiones cuando el proyecto las solicite

- **Bandeja:** usar mensajes persistidos y permisos existentes para historial,
  adjuntos, lecturas y actualizaciones en tiempo real.
- **IA:** exponer un puerto de agente e implementarlo en infraestructura. Un
  worker carga contexto permitido y registra su respuesta por el mismo caso de
  envio; no entregar credenciales Twilio al modelo ni tratar mensajes como
  autorizacion para ejecutar acciones privilegiadas.
- **Mensajes consecutivos:** si hay IA, procesar con exclusividad por conversacion
  y agrupacion breve configurable. No perder mensajes al recibir otra entrada
  mientras se genera una respuesta.
- **Control humano:** definir prioridad, vencimiento y devolucion del control
  segun el negocio para evitar respuestas simultaneas o conversaciones abandonadas.
- **Notificaciones/reportes:** reutilizar el puerto y las plantillas configuradas.
  No copiar entidades comerciales del proyecto de origen al nuevo proyecto.

## 9. Verificacion y entrega

Cubrir con pruebas significativas las partes implementadas:

1. Telefonos nacionales/internacionales, invalidos y prefijo `whatsapp:` duplicado.
2. Remitente habilitado y aislamiento de cuenta, entorno y destinatarios autorizados.
3. Texto en ventana; plantilla obligatoria fuera; variable ausente o medio incorrecto.
4. Firma valida/invalida, prefijo del proxy y query string; ningun efecto con firma invalida.
5. Entrada duplicada: un mensaje persistido y un unico procesamiento.
6. Callback repetido, fuera de orden y anterior al guardado del SID.
7. Envio aceptado que luego falla; conservar el error y actualizar la UI.
8. Operacion con texto y archivo: fallo parcial del PDF no se presenta como entrega completa.
9. Timeout ambiguo y dos peticiones concurrentes: evitar reenvios ciegos o duplicados locales.
10. URL de otro entorno, archivo vencido, HTML con HTTP 200 y PDF de muestra.

Comprobar tipos/build y rutas antes de activar. Usar SDK simulado para pruebas
automaticas. Una prueba real se limita al remitente y destinatario de prueba
autorizados para la tarea; no hacer envios masivos para validar la integracion.
El sandbox puede comprobar flujos iniciales, pero no acredita la configuracion
de un numero real ni sus plantillas propias.

Entregar ubicacion de los componentes, variables pendientes, rutas externas
exactas, mapeos de plantillas, pruebas realizadas y pasos de activacion/reinicio
del despliegue existente. Distinguir lo verificado con dobles de lo observado
con Twilio y el telefono receptor. Si falta configuracion externa, precisarla
sin afirmar que el envio real ya funciona.

## Vigencia de las referencias

Documentacion oficial consultada el 2026-10-30. Antes de aplicar la skill,
revisar nuevamente los enlaces relevantes para el SDK, el alta del numero,
las plantillas y los limites del canal que se vaya a utilizar.
