import { buildApp as buildApplication, type AppDependencies } from '../../src/main.js';
import type { AuthPrincipal } from '../../src/domain/entities/auth.js';
export { createAttendanceEvaluation, createEmployeeRegistry, createEmployeeNames } from '../../src/main.js';

const principal: AuthPrincipal = {
  id: '00000000-0000-4000-8000-000000000001', username: 'test-admin', name: 'Test admin', role: 'admin',
  branchIds: [], isActive: true, mustChangePassword: false, version: 1, sessionHash: 'test', csrfToken: 'test',
};

export async function buildApp(dependencies: AppDependencies) {
  if (!dependencies.database) throw new Error('Las pruebas deben utilizar una base aislada.');
  await dependencies.database.query(`INSERT INTO auth_accounts(id,username,name,password_hash,role,must_change_password)
    VALUES($1,'test-admin','Test admin','test-only-no-login','admin',FALSE) ON CONFLICT(id) DO NOTHING`, [principal.id]);
  return buildApplication({ ...dependencies, authentication: { testPrincipal: principal } });
}
