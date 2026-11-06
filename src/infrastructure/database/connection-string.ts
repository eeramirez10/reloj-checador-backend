export function connectionString(value: string): string {
  const url = new URL(value);
  if (url.hostname.endsWith('.neon.tech')) {
    if (url.hostname.includes('-pooler.')) throw new Error('Configura la conexión directa de Neon, sin pooler.');
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
}
