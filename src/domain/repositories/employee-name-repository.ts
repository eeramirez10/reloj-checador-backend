export interface EmployeeNameCandidate {
  id: string; name: string; originalName: string | null; splitMethod: string | null;
  employeeNumber: string | null; clockNames: string[];
}
export interface EmployeeNameSession {
  candidates(refreshAutomatic: boolean): Promise<EmployeeNameCandidate[]>;
  save(id: string, firstName: string, lastName: string | undefined, method: string): Promise<void>;
}
export interface EmployeeNameRepository {
  transaction<T>(operation: (session: EmployeeNameSession) => Promise<T>): Promise<T>;
}
