# Puente del SDK oficial ZKTeco

El backend funciona en macOS/Linux mediante el driver Node. El SDK Standalone oficial de ZKTeco distribuye DLLs para Windows, por lo que se integra mediante un servicio local independiente en Windows.

## Puente de fotos de usuario

El SilkBio-100TC guarda fotos de usuario separadas de sus plantillas faciales. Para descargar fotos por red, el puente usa el SDK Standalone de Windows y el backend llama a `ZK_PHOTO_BRIDGE_URL` (predeterminado `http://127.0.0.1:3200`). El SDK documenta `DownloadUserPhoto` y `GetAllUserPhoto`; la compatibilidad debe validarse con el firmware del equipo.

El puente debe exponer:

- `POST /devices/users/photos`
- Solicitud: `{ "ipAddress": "192.168.1.199", "tcpPort": 4370, "userIds": ["1008", "1514"] }`
- Respuesta: `{ "photos": [{ "userId": "1008", "contentType": "image/jpeg", "dataBase64": "/9j/4AA..." }] }`

Devuelve solo las fotos existentes solicitadas. Las imágenes deben ser JPEG con el ID del usuario asociado desde el nombre de archivo `ID.jpg`. El puente no debe modificar ni eliminar datos del reloj.

El backend solicita lotes de hasta 25 IDs, comprueba que cada imagen pertenezca al lote, valida el tipo y la firma JPEG, y rechaza imágenes mayores de 512 KiB. Las fotos se guardan en PostgreSQL, asociadas al dispositivo y al ID de usuario. El acceso se hace mediante `GET /devices/:deviceId/users/:userId/photo`.

Mantenga el puente limitado a localhost o a una red privada, y no exponga el endpoint de fotos directamente a Internet.

Configure un dispositivo con `"driver": "sdk-bridge"` y defina `ZK_SDK_BRIDGE_URL`. El puente debe escuchar solo en localhost o estar protegido por una red privada, y exponer:

- `POST /devices/test-connection` con `{ "ipAddress", "tcpPort" }`, respuesta `DeviceInfo`.
- `POST /devices/attendance` con `{ "ipAddress", "tcpPort" }`, respuesta con eventos `{ "deviceLogId", "userId", "verificationType", "punchState", "occurredAt", "raw" }`.
- `POST /devices/users` con `{ "ipAddress", "tcpPort" }`, respuesta con usuarios sin contraseñas ni plantillas biométricas.

El paquete del SDK y sus DLLs no se incluyen por licenciamiento; colóquelos fuera del repositorio, en una ruta ignorada por Git. El puente no debe borrar registros del reloj.
