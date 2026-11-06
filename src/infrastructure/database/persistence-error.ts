import { AppError, ConfigurationError, ConflictError } from '../../domain/errors/app-error.js';
import { inspect } from 'node:util';

export function persistenceError(error: unknown): AppError | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = String(error.code);
  const metadata = 'meta' in error ? inspect(error.meta, { depth: 5 }) : '';
  const constraint = 'constraint' in error ? String(error.constraint) : '';
  const detail = `${constraint} ${metadata}`;
  if (code === 'P2002' || code === '23505' || (code === 'P2010' && detail.includes('23505'))) {
    const message = /devices_active_endpoint_idx|ip_address/.test(detail) ? 'Ya existe un reloj con esa dirección IP y puerto.'
      : /device_users_active_employee_idx/.test(detail) ? 'El empleado ya tiene un reloj actual asignado.'
      : /employee_leave_profiles_whatsapp_phone_key/.test(detail) ? 'El número de WhatsApp ya está asignado a otro empleado.' : 'Ya existe un registro con esos datos.';
    return new ConflictError(message, { cause: error });
  }
  if (code === 'P2003' || code === '23503' || (code === 'P2010' && detail.includes('23503'))) {
    return new ConfigurationError('La sucursal, persona u horario seleccionado no existe.');
  }
  if (code === 'P2025') return new AppError('Registro no encontrado.', 'NOT_FOUND', { cause: error });
  if (code === 'P2034') return new ConflictError('Otra operación modificó estos datos. Intenta nuevamente.', { cause: error });
  if (['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'ECONNREFUSED', 'ECONNRESET', '57P01'].includes(code)
    || (code === 'P2010' && /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ConnectionClosed|ConnectionError|57P01/.test(detail))) {
    return new AppError('La base de datos no está disponible temporalmente.', 'PERSISTENCE_UNAVAILABLE', { cause: error });
  }
  if (code === '22P02' || (code === 'P2010' && detail.includes('22P02'))) return new ConfigurationError('Identificador o valor inválido.');
  if (code === '23514' || (code === 'P2010' && detail.includes('23514'))) return new ConfigurationError('Los datos incumplen una restricción de validación.');
  return undefined;
}
