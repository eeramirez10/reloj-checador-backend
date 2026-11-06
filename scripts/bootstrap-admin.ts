import { createHash, randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { env } from '../src/infrastructure/config/env.js';
import { Database } from '../src/infrastructure/database/database.js';
import { PrismaAuthRepository } from '../src/infrastructure/repositories/auth-repository.js';
import { ArgonPasswordHasher } from '../src/infrastructure/security/password-hasher.js';
import { ManageAuth } from '../src/domain/use-cases/manage-auth.js';
import { accountSchema } from '../src/presentation/validators/auth.js';

const { values } = parseArgs({ options: { username: { type: 'string', default: 'admin' }, name: { type: 'string', default: 'Administrador' }, reset: { type: 'boolean', default: false } } });
const database = new Database(env.DATABASE_URL);
try {
  const repository = new PrismaAuthRepository(database);
  const auth = new ManageAuth(repository, new ArgonPasswordHasher(), {
    random: () => randomBytes(32).toString('base64url'), hash: value => createHash('sha256').update(value).digest('hex'),
  });
  const temporaryPassword = randomBytes(24).toString('base64url');
  const existing = values.reset ? await repository.credentials(values.username!.toLowerCase()) : undefined;
  if (values.reset && existing?.role !== 'admin') throw new Error('Indica el usuario de una cuenta administradora existente.');
  const input = accountSchema.omit({ password: true }).parse({ username: values.username, name: existing?.name ?? values.name, role: 'admin', isActive: true, branchIds: [] });
  const account = await auth.save(existing?.id ?? null, input, temporaryPassword, existing?.id, existing?.version);
  if (values.reset) await repository.audit(account.id,'console_admin_reset',account.id);
  console.log(`Usuario: ${account.username}\nContraseña temporal: ${temporaryPassword}\nSe requiere cambiar la contraseña al iniciar sesión. No guardes este valor en el repositorio.`);
} finally { await database.close(); }
