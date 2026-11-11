export const leaveRequestColumns = `id, employee_id AS "employeeId", manager_id AS "managerId", branch_id AS "branchId", kind,
  from_date::text AS "from", to_date::text AS "to", authorized_time AS "authorizedTime", paid, use_vacation AS "useVacation",
  reason, status, details, source, version, created_at AS "createdAt", resolved_at AS "resolvedAt", resolved_by AS "resolvedBy",
  client_name AS "clientName",full_day AS "fullDay",replaces_request_id AS "replacesRequestId"`;
