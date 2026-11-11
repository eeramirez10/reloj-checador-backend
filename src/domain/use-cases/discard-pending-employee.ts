import type { AuthPrincipal } from '../entities/auth.js';
import type { EmployeeDiscardRepository } from '../repositories/employee-discard-repository.js';
import { AppError } from '../errors/app-error.js';

export class DiscardPendingEmployee {
  constructor(private readonly repository: EmployeeDiscardRepository) {}
  execute(id: string,actor: AuthPrincipal,reason: string) {
    if (!['admin','hr'].includes(actor.role)) throw new AppError('Solo RH y administrador pueden eliminar pendientes.', 'FORBIDDEN');
    return this.repository.discard(id,actor,reason);
  }
}
