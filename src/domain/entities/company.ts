export interface CompanyInput { name: string; code: string | null; active: boolean; notes: string }
export interface Company extends CompanyInput { id: string; version: number }
export interface CompanyFilter { companyId?: string }
export interface CompanySelection { id: string | null; name: string }
