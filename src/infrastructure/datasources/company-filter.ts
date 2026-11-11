export function companyFilterSql(column: string, parameter: number): string {
  const value = `$${parameter}`;
  return `(${value}::text IS NULL OR CASE WHEN ${value}='unassigned' THEN ${column} IS NULL ELSE ${column}=NULLIF(${value},'unassigned')::uuid END)`;
}
