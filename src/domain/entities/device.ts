export type DeviceDriver = 'node' | 'sdk-bridge';
export interface Device {
  id: string; name: string; ipAddress: string; tcpPort: number; driver: DeviceDriver; enabled: boolean;
  syncIntervalSeconds: number; createdAt: Date; updatedAt: Date; branchId?: string; timeZone?: string;
}
export interface CreateDeviceInput {
  name: string; ipAddress: string; tcpPort?: number; driver?: DeviceDriver; enabled?: boolean;
  syncIntervalSeconds?: number; branchId?: string;
}
