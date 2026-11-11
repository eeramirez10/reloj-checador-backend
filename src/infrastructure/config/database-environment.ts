interface DatabaseEnvironment {
  APP_ENV?: string
  DATABASE_URL?: string
  PRODUCTION_DATABASE_URL?: string
}

function databaseIdentity(value: string): string {
  try {
    const url = new URL(value);
    return JSON.stringify([url.hostname.toLowerCase().replace('-pooler.', '.'), url.port || '5432', decodeURIComponent(url.pathname)]);
  } catch { throw new Error('La configuración de conexión PostgreSQL no es válida.'); }
}

export function databaseForEnvironment(configuration: DatabaseEnvironment): string {
  const environment = configuration.APP_ENV ?? 'production';
  if (!['development','production','test'].includes(environment)) throw new Error('APP_ENV debe ser development, production o test.');
  if (!configuration.DATABASE_URL) throw new Error('Configura DATABASE_URL.');
  if (environment === 'development') {
    if (!configuration.PRODUCTION_DATABASE_URL) throw new Error('Configura PRODUCTION_DATABASE_URL para identificar y proteger la base de producción.');
    if (databaseIdentity(configuration.DATABASE_URL) === databaseIdentity(configuration.PRODUCTION_DATABASE_URL)) {
      throw new Error('Desarrollo no puede utilizar la base de producción. Configura DEVELOPMENT_DATABASE_URL y ejecuta npm run dev:configure.');
    }
  }
  return configuration.DATABASE_URL;
}
