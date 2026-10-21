declare module 'node-zklib' {
  class ZKLib {
    constructor(ip: string, port: number, timeout: number, inPort: number);
    createSocket(): Promise<void>;
    disconnect(): Promise<void>;
    getInfo(): Promise<unknown>;
    getAttendances(): Promise<{ data?: Record<string, unknown>[]; err?: unknown }>;
    getUsers(): Promise<{ data?: Record<string, unknown>[]; err?: unknown }>;
  }
  export = ZKLib;
}
