import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthPrincipal } from '../../domain/entities/auth.js';

const storage = new AsyncLocalStorage<{ principal?: AuthPrincipal }>();
export const accessContext = {
  run<T>(callback: () => T): T { return storage.run({}, callback); },
  set(principal: AuthPrincipal) {
    const context = storage.getStore();
    if (!context) throw new Error('Falta el contexto de acceso de la solicitud.');
    context.principal = principal;
  },
  current() { return storage.getStore()?.principal; },
};

export function scopedBranchIds(): string[] | undefined {
  const principal = accessContext.current();
  return principal && principal.role !== 'admin' ? principal.branchIds : undefined;
}

export function branchScopeSql(column: string): string {
  const ids = scopedBranchIds();
  if (!ids) return 'TRUE';
  // Los IDs provienen de PostgreSQL y se validan nuevamente antes de interpolar el alcance.
  if (!ids.every((id) => /^[0-9a-f-]{36}$/i.test(id))) throw new Error('Alcance de sucursales inválido.');
  return ids.length ? `COALESCE(${column} = ANY(ARRAY[${ids.map((id) => `'${id}'::uuid`).join(',')}]),FALSE)` : 'FALSE';
}
