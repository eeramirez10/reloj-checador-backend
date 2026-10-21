import { env } from '../../config/env.js';
import type { Device } from '../../../domain/entities/device.js';
import { NodeZkLibClient } from './node-zklib-client.js';
import { SdkBridgeClient } from './sdk-bridge-client.js';
import type { DeviceClientFactory, ZktecoDeviceClient } from '../../../domain/datasources/device-client.js';

export class ZktecoClientFactory implements DeviceClientFactory {
  private readonly nodeClient = new NodeZkLibClient(env.ZK_TIMEOUT_MS, env.ZK_INPORT);
  private readonly sdkBridgeClient = new SdkBridgeClient(env.ZK_SDK_BRIDGE_URL);

  getClient(device: Device): ZktecoDeviceClient {
    return device.driver === 'sdk-bridge' ? this.sdkBridgeClient : this.nodeClient;
  }
}
