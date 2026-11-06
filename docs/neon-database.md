# PostgreSQL en Neon

La aplicación utiliza una conexión directa de Neon en `DATABASE_URL`. El backend sigue ejecutándose dentro de la red para consultar los relojes y el servicio Windows de fotos. El navegador solo accede al backend; la conexión PostgreSQL no forma parte del frontend.

## Configuración

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST.neon.tech/neondb?sslmode=verify-full
NEON_DATABASE_URL=postgresql://USER:PASSWORD@HOST.neon.tech/neondb?sslmode=verify-full
LOCAL_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5435/reloj_checador
PG_CLIENT_IMAGE=postgres:18-alpine
```

`DATABASE_URL` es la conexión activa tanto para la aplicación como para Prisma Migrate. `NEON_DATABASE_URL` identifica el destino durante la migración. `LOCAL_DATABASE_URL` conserva la instancia local y se usa para las bases temporales de pruebas y verificaciones. No se versionan `.env`, respaldos ni informes con datos sensibles.

Se requiere la URL sin `-pooler` porque la aplicación configura `search_path` al abrir las conexiones. El cliente exige `sslmode=verify-full` para Neon, utiliza certificados confiables y permite SCRAM con channel binding cuando el servidor lo ofrece. El pool de la aplicación admite hasta 10 conexiones y espera hasta 25 segundos al conectar. Las transacciones operativas conservan su límite de 60 segundos.

## Operaciones por lotes

La sincronización nativa consulta las identidades guardadas de un reloj una sola vez y procesa inserciones/enriquecimientos en lotes de hasta 500. Una descarga repetida no ejecuta consultas por cada checada. Se conservan UUID, evidencias originales, folios reutilizados por usuario/instante y compatibilidad con claves anteriores. Las importaciones Talavie solo se enriquecen cuando existe una coincidencia única por minuto. Todo el lote se guarda dentro de una transacción y un bloqueo por reloj.

El recálculo mantiene las reglas de dominio y reutiliza las identidades de evaluaciones, incidencias y descuentos. Agrupa las escrituras y los contadores, evita actualizar resultados idénticos y reconcilia los registros obsoletos dentro de la misma transacción. No se modifica el cálculo de tolerancias, permisos, jornadas, rutas ni extras.

## Migración a una base vacía

1. Detener el backend y esperar que terminen sus operaciones. Si un proceso supervisor interrumpe una sincronización, registrar el intento como interrumpido, conservando su identidad e historial.
2. Crear un respaldo local con restauración comprobada:

   ```bash
   PG_CONTAINER=reloj-checador-postgres-1 BACKUP_LABEL=neon-cutover npm run backup:database
   ```

3. Restaurar y verificar:

   ```bash
   npm run db:migrate-neon -- backups/<manifiesto>.json
   ```

   El comando comprueba que el origen siga coincidiendo con el respaldo y que Neon esté vacío. No elimina ni sobrescribe tablas existentes. Restaura dentro de una única transacción, sin propietarios ni permisos de la instalación local, y compara las 38 tablas mediante cantidades y checksums, columnas, restricciones, índices e integridad de relaciones. Las fotos y hashes de contraseña forman parte de la comparación exacta.

   Para repetir únicamente la verificación antes de activar:

   ```bash
   npm run db:migrate-neon -- --verify-only backups/<manifiesto>.json
   ```

4. Activar el destino verificado:

   ```bash
   npm run db:activate-neon -- backups/<manifiesto>-neon-verification.json
   npm run migrate
   npm run dev
   ```

   La activación exige un informe del mismo destino, guarda la configuración anterior con permisos privados y actualiza `.env` de forma atómica. Conserva las demás opciones del backend. Si es necesario volver a la instancia local después de operar en Neon, primero deben trasladarse también las escrituras nuevas; cambiar solo la conexión dejaría datos recientes fuera de la instancia local.

## Respaldos y pruebas

```bash
BACKUP_LABEL=neon-active npm run backup:database
```

Para bases remotas se utiliza el cliente PostgreSQL 18 en Docker y certificados SSL del sistema del contenedor. Las credenciales se transmiten por variables de entorno, no en argumentos ni registros. Cada respaldo se comprueba restaurándolo en una base temporal del mismo servidor de origen, que se elimina al finalizar. La copia representa una instantánea consistente aunque el backend continúe trabajando.

Las pruebas de integración crean sus bases temporales en `LOCAL_DATABASE_URL` cuando está configurada:

```bash
npm run test:integration
PG_CONTAINER=reloj-checador-postgres-1 npm run verify:data -- backups/<manifiesto>.json
PG_CONTAINER=reloj-checador-postgres-1 npm run verify:baseline
```

La sincronización programada y las descargas de fotos requieren que la máquina del backend tenga acceso a las IP privadas de los relojes y a `ZK_PHOTO_BRIDGE_URL`. Alojar PostgreSQL en Neon no proporciona esa conectividad de red.
