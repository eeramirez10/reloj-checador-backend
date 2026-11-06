# Base de WhatsApp mediante Twilio

Implementación de la skill `.agents/skills/twilio-whatsapp-integration/SKILL.md`, adaptada a Fastify, casos de uso en `domain/use-cases` y PostgreSQL/Prisma. SDK oficial `twilio` 5.13.1 y `libphonenumber-js` 1.13.10, fijados en `package.json`.

## Alcance de esta etapa

La base recibe webhooks firmados, identifica al empleado por su teléfono registrado, guarda mensajes/trabajos, encola envíos internos y conserva estados de entrega. El transporte y la persistencia ya son funcionales; los comandos y conversaciones para permisos, vacaciones, retardos y checadas se conectarán mediante `WhatsAppMessageHandler` en la siguiente etapa.

Sin un manejador de conversación, los mensajes autorizados quedan en `whatsapp_inbox_jobs.state = awaiting_handler`, disponibles para revisión. No se interpretan como solicitudes de permisos ni se marcan como conversaciones atendidas. Se confirma a Twilio la recepción con `200 text/xml` y `<Response></Response>`.

Los eventos existentes en `leave_request_events` conservan `awaiting_configuration`. La conexión de esos eventos con las notificaciones al jefe será parte del flujo de permisos por WhatsApp.

## Componentes

| Ubicación | Responsabilidad |
| --- | --- |
| `src/domain/entities/whatsapp-message.ts` | Mensajes, contenido, identidad, ventana de atención y reglas de entrega. |
| `src/domain/datasources/whatsapp-messaging.ts` | Puertos del proveedor, validación del webhook y futuro manejador de conversación. |
| `src/domain/repositories/whatsapp-repository.ts` | Contrato de persistencia y reclamación de trabajos/intentos. |
| `src/domain/use-cases/*whatsapp*.ts` | Resolver empleado, recibir, encolar/enviar, procesar entrada y actualizar entrega. |
| `src/infrastructure/integrations/twilio/` | SDK oficial, firma y normalización de números. |
| `src/infrastructure/repositories/whatsapp-repository.ts` | Transacciones PostgreSQL, colas, reservas y recuperación. |
| `src/infrastructure/datasources/whatsapp-*-store.ts` | Consultas compartidas y correlación de callbacks. |
| `src/infrastructure/jobs/whatsapp-worker.ts` | Procesamiento duradero en segundo plano, con cierre ordenado. |
| `src/presentation/controllers/twilio-webhook-controller.ts` | Validación HTTP y traducción de formularios a casos de uso. |
| `src/presentation/routes/whatsapp-routes.ts` | Rutas y parser URL-encoded encapsulado. |
| `src/infrastructure/config/whatsapp.ts` | Validación de entorno, remitente, URLs y plantillas. |

El dominio no importa Twilio, Prisma, Fastify ni librerías de teléfonos. Los casos de uso se obtienen desde `buildApp().whatsapp`; los envíos son operaciones internas invocadas por los flujos del negocio y el worker.

## Configuración y activación

1. Instalar dependencias con `npm ci` y aplicar `npm run migrate` antes del arranque.
2. En el entorno del backend, configurar los valores reales de `.env.example`:

   ```dotenv
   TWILIO_WHATSAPP_ENABLED=false
   TWILIO_ACCOUNT_SID=
   TWILIO_AUTH_TOKEN=
   TWILIO_WHATSAPP_FROM=
   PUBLIC_API_URL=
   TWILIO_INCOMING_WEBHOOK_URL=
   TWILIO_STATUS_CALLBACK_URL=
   PHONE_DEFAULT_COUNTRY=MX
   TWILIO_WHATSAPP_TEMPLATES={}
   ```

   - `TWILIO_ACCOUNT_SID`: cuenta/subcuenta propietaria del WhatsApp Sender (`AC` y 32 caracteres hexadecimales).
   - `TWILIO_AUTH_TOKEN`: Auth Token de esa cuenta, exclusivamente en backend/gestor de secretos.
   - `TWILIO_WHATSAPP_FROM`: `whatsapp:` seguido del número internacional ya habilitado para WhatsApp. El alta para voz/SMS es independiente.
   - `PUBLIC_API_URL`: base HTTPS externa del backend, incluyendo el prefijo que quite el proxy, sin query string. Por ejemplo, `https://api.example.com/backend`.
   - Las dos URLs explícitas son opcionales si se derivan correctamente de `PUBLIC_API_URL`; permiten conservar un prefijo o query fijos de la publicación. Sus rutas deben finalizar en las indicadas abajo. `attemptId` y `bodySHA256` son parámetros reservados.
   - `PHONE_DEFAULT_COUNTRY` se usa al guardar números nacionales mediante la API. Los internacionales explícitos conservan su código de país. La interfaz de empleados solicita formato internacional.

3. Configurar en Twilio la URL entrante **exacta**, método `POST`:

   ```text
   https://api.example.com/backend/integrations/twilio/whatsapp/incoming
   ```

   El backend monta internamente `POST /integrations/twilio/whatsapp/incoming`. Si el proxy elimina `/backend`, la firma se valida conservando ese prefijo externo.

4. La URL de estados para ese ejemplo es:

   ```text
   https://api.example.com/backend/integrations/twilio/whatsapp/status
   ```

   Se envía en cada `messages.create` como `statusCallback`, agregando `attemptId=UUID`. Twilio debe conservar esa query en el callback. La firma incluye la URL con la query exacta. El backend monta internamente `POST /integrations/twilio/whatsapp/status`.

5. Registrar los teléfonos de empleados y jefes en **Empleados → Editar → Permisos y vacaciones**.
6. Establecer `TWILIO_WHATSAPP_ENABLED=true` y reiniciar el backend con su comando habitual `npm start` o el proceso de despliegue existente. Al habilitar, las credenciales, URLs HTTPS, país, teléfono remitente y mapa de plantillas se validan antes de escuchar peticiones.

Con la integración desactivada, los dos webhooks responden `503` y el worker no se inicia. Los ejemplos de dominio y SID de esta guía son marcadores, no configuración operativa. Activar el transporte recibe y registra mensajes; el menú requiere conectar el manejador de la siguiente etapa.

## Identidad y autorización

- Se valida primero `X-Twilio-Signature` con el helper oficial, Auth Token y URL externa configurada. No se utilizan `Host` ni encabezados reenviados para construir una URL confiable.
- Solo se admiten formularios `application/x-www-form-urlencoded`, hasta 64 KiB. Se conservan todos los parámetros para verificar la firma, incluidos los adicionales y repetidos; después se validan los campos del protocolo. Los parámetros críticos repetidos se rechazan.
- Se verifica que `AccountSid` y el número de negocio coincidan con la configuración del entorno y que las direcciones pertenezcan a WhatsApp.
- El `From` entrante se normaliza y busca en `employee_leave_profiles.whatsapp_phone`. Debe corresponder a un empleado activo y confirmado. El cuerpo del mensaje no decide el empleado, aunque incluya nombres o UUID.
- Los mensajes de números desconocidos/inactivos quedan como `unauthorized`, sin trabajo de conversación ni envíos automáticos. El TwiML de recepción es el mismo y no revela si existe un empleado.
- La propiedad del teléfono se comprueba al procesar y antes de enviar. Una respuesta pendiente no pasa a otra persona si cambia el número. Un manejador recibe la identidad resuelta y debe autorizar cualquier acción sobre permisos a partir de ella.
- Los teléfonos se validan al guardar mediante `libphonenumber-js/max`, se almacenan como E.164 y tienen unicidad en la base. Se agrega `whatsapp:` una sola vez al enviar. Prefijos históricos inválidos como `+521...` requieren corregir la ficha; no se reescriben silenciosamente.

## Cola y estados

La migración aditiva `20261030210000_whatsapp_foundation` crea:

- `whatsapp_conversations`: aislamiento por cuenta, número del negocio y participante; última entrada autorizada.
- `whatsapp_messages`: mensaje lógico, dirección, empleado asociado, contenido, SID, estado y clave de operación. Una secuencia durable fija el orden de recepción/envío.
- `whatsapp_inbox_jobs`: procesamiento de entradas y reserva con token/vencimiento.
- `whatsapp_attempts`: cada intento saliente, resultado, SID, error y reserva.
- `whatsapp_delivery_events`: respuesta inicial del SDK y callbacks, incluidos los que todavía no se pudieron correlacionar.

Mensaje entrante y trabajo se insertan atómicamente; la unicidad por cuenta y `MessageSid` evita procesar reintentos de Twilio. La fecha de un mensaje duplicado no renueva la ventana. El worker revisa cada dos segundos, procesa hasta diez pares entrada/salida por ciclo y admite una ejecución local a la vez. Las reservas y transacciones protegen también frente a varias instancias.

Los mensajes se procesan en orden por conversación. Las reservas duran dos minutos. Un trabajo entrante interrumpido o fallido admite hasta tres intentos; los manejadores que produzcan efectos deben usar el UUID del mensaje como clave idempotente de negocio. La finalización del trabajo y el encolado de su respuesta son una transacción y vuelven a comprobar el teléfono.

Para envíos, cada operación usa una clave estable por conversación/destinatario y contenido. Dos reclamaciones simultáneas no producen dos llamadas al proveedor. La respuesta inicial `queued` significa **pendiente de entrega**, no entregado. Un envío saliente no abre ni renueva la ventana de atención.

| Estado local | Significado |
| --- | --- |
| `pending` | Operación guardada y pendiente de reclamar. |
| `sending` | Intento persistido, en curso de comunicación con Twilio. |
| `queued` | Twilio aceptó o está preparando el mensaje. |
| `sent` | Enviado al canal, todavía sin prueba de entrega. |
| `delivered` | Twilio informó entrega. |
| `read` | Twilio informó lectura. La ausencia de lectura no es un fallo. |
| `failed` | Rechazo confirmado, fallo de entrega o destinatario/ventana/contenido inválidos. |
| `reconciliation` | Aceptación incierta, envío interrumpido o evidencia terminal contradictoria. |

Los callbacks repetidos son idempotentes y `read` no retrocede a `sent`. Eventos terminales contradictorios se conservan y marcan para conciliación. El intento existe antes de llamar a Twilio: un callback anticipado se correlaciona mediante `attemptId`. Si falta ese parámetro, el evento se guarda y se vincula al conocer el SID de la respuesta.

Solo un rechazo HTTP `429` confirmado se reintenta automáticamente, con esperas de 30/60 segundos y máximo tres intentos. Timeouts, desconexiones o errores de servidor dejan aceptación incierta y no se reenvían a ciegas. Lo mismo ocurre si Twilio acepta pero falla la persistencia de la respuesta. Un callback firmado posterior puede conciliar un intento incierto por su `attemptId`/SID. Ante evidencia contradictoria o sin SID/callback suficiente se requiere diagnóstico con los registros de Twilio; un intento incierto anterior retiene envíos posteriores de esa conversación hasta su conciliación. Esta etapa no expone una acción de reenvío manual.

## Texto, plantillas y adjuntos

El texto libre solo se envía dentro de las 24 horas posteriores a una entrada autorizada del usuario, para la misma cuenta/remitente/participante. Sin una entrada o fuera de la ventana se necesita una plantilla aprobada y configurada.

El mapa de plantillas usa claves del negocio y un orden explícito de variables:

```json
{
  "leave_request": {
    "contentSid": "HX_REEMPLAZAR_CON_SID_REAL",
    "variables": ["employeeName", "requestReference"]
  }
}
```

Al configurar, sustituir el SID por uno aprobado de la cuenta/WABA correcta. El caso de uso recibe `{ kind: 'template', templateKey: 'leave_request', variables: { employeeName: 'María', requestReference: 'folio' } }`; el adaptador transforma los nombres a `{"1":"María","2":"folio"}`. Una plantilla usa únicamente `contentSid`/`contentVariables`, sin combinarlos con `body` ni `mediaUrl`. El texto usa `{ kind: 'text', body: '...' }`, hasta 1600 caracteres.

Se guarda la metadata de hasta diez adjuntos entrantes (`MediaUrlN` y `MediaContentTypeN`), sin descargarlos ni marcarlos como documentos procesados. La descarga privada de audio/documentos, su interpretación y el envío de PDF se incorporarán cuando un flujo lo requiera.

## Verificación

```bash
npm run prisma:validate
npm run typecheck
npm run test:integration
PG_CONTAINER=reloj-checador-postgres-1 npm run verify:baseline
```

`tests/whatsapp.test.ts` comprueba teléfonos, configuración, prefijo/query de firmas, SDK de plantillas, ventana y estados. `tests/whatsapp.integration.test.ts` usa PostgreSQL temporal y el SDK simulado para comprobar firmas, cuenta/remitente/destinatario, autorización, duplicados, reservas, ventana, carreras de callbacks, errores, reintentos y recuperación después de perder la respuesta.

Las pruebas automáticas no hacen envíos reales ni acreditan la configuración de un teléfono real. La activación debe comprobarse con el número habilitado y un destinatario de prueba autorizado del entorno. Los logs del worker son genéricos; el cuerpo completo y las credenciales no se escriben en logs operativos.
