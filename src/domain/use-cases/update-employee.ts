import type { UnitOfWork } from '../repositories/unit-of-work.js';

export class UpdateEmployee {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(id: string, fields: Record<string, string | null>, isActive?: boolean): Promise<boolean> {
    return this.unitOfWork.execute(({ employees }) => employees.update(id, fields, isActive));
  }
}
