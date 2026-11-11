# Desarrollo en Mac y producción en Windows

| Entorno | Código | Base | Procesos automáticos |
| --- | --- | --- | --- |
| Mac | `development`, `feature/*`, `fix/*` | Rama independiente `development` de Neon | Relojes y WhatsApp desactivados |
| Windows | `main` | Rama de producción de Neon | Sincronización de relojes activa |

Las ramas de Git y las de Neon son independientes. Cambiar una rama de Git no cambia la conexión PostgreSQL. Cada equipo mantiene su propio `.env`, excluido de Git.

## Crear la rama de Neon

1. Abrir el proyecto en la consola de Neon.
2. Entrar en **Branches → Create branch**.
3. Escribir `development` y seleccionar como padre la rama que utiliza Windows.
4. Crear la rama con sus datos. Las modificaciones posteriores de cada rama quedan separadas; no hay sincronización automática de datos entre desarrollo y producción.
5. En **Connect**, seleccionar la rama `development`, la base y el rol, desactivar **Connection pooling** y copiar la URL completa con SSL.
6. Agregar esa URL únicamente en `backend/.env` de la Mac:

   ```env
   DEVELOPMENT_DATABASE_URL=postgresql://USER:PASSWORD@DEVELOPMENT_HOST.neon.tech/neondb?sslmode=verify-full
   ```

No se necesita copiar de nuevo un dump ni crear otro administrador: la rama comienza con las tablas y cuentas del padre. Una rama puede requerir una contraseña distinta al conectarse; se debe utilizar la URL que ofrece Neon.

## Configurar la Mac

```bash
npm run dev:configure
npm run migrate
npm run dev
```

El primer comando verifica que la conexión de desarrollo no identifique la misma base que producción, realiza una consulta de solo lectura para comprobar que la copia tenga las tablas necesarias y actualiza `.env` de forma atómica. Guarda una copia privada de la configuración anterior en `backups/`.

La configuración resultante incluye:

```env
APP_ENV=development
DATABASE_URL=URL_DE_LA_RAMA_DEVELOPMENT
PRODUCTION_DATABASE_URL=URL_DE_PRODUCCION_SOLO_COMO_REFERENCIA
SYNC_ENABLED=false
TWILIO_WHATSAPP_ENABLED=false
AUTH_COOKIE_SECURE=false
AUTH_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:3005
```

El backend y Prisma Migrate rechazan el acceso a la base de producción cuando `APP_ENV=development`, incluso si se usan otras credenciales o parámetros SSL. El backend también rechaza la configuración de desarrollo si se habilitan los procesos automáticos de relojes o WhatsApp.

Para preparar las protecciones antes de disponer de la URL de desarrollo:

```bash
npm run dev:configure -- --prepare-only
```

Hasta agregar `DEVELOPMENT_DATABASE_URL` y ejecutar el comando sin esa opción, el backend permanece detenido y su arranque contra producción queda bloqueado.

La sincronización manual sigue disponible para pruebas controladas. Los relojes físicos son los mismos aunque las bases estén separadas: una operación manual de hora o roles modifica el equipo real.

El frontend utiliza su configuración local con `/api` y se inicia normalmente con `npm run dev`. El backend de desarrollo debe estar disponible en `127.0.0.1:3005`.

## Configurar Windows

Conservar el `.env` propio del servidor y su conexión actual de Neon:

```env
APP_ENV=production
DATABASE_URL=URL_ACTUAL_DE_PRODUCCION
SYNC_ENABLED=true
```

El servidor conserva sus opciones de cookies, origen HTTPS y puente de fotos. No se copia el `.env` de la Mac al actualizar código. Windows ejecuta `npm start` mediante su servicio; no necesita las ramas de trabajo de desarrollo.

## Publicar una versión

1. Crear una rama `feature/*` o `fix/*` desde `development` y probar los cambios con la base de desarrollo.
2. Guardar en Git las migraciones nuevas junto con el código; no mover los datos de desarrollo a producción.
3. Revisar e integrar la versión terminada en `main` y publicarla.
4. En Windows, actualizar `main` con `git pull --ff-only`, instalar dependencias, aplicar `npm run migrate` y reiniciar el servicio del backend de forma controlada.
5. Actualizar el frontend con `git pull --ff-only`, `npm ci` y `npm run build`.

Los cambios del esquema se promueven mediante archivos de migración, no fusionando bases de Neon ni copiando las checadas de pruebas. Antes de aplicar cambios de esquema a producción se crea un respaldo verificado. La sincronización automática de los relojes queda a cargo de Windows.
