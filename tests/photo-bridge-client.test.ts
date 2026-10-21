import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhotoBridgeError, ZktecoPhotoBridgeClient } from '../src/integrations/zkteco/photo-bridge-client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ZktecoPhotoBridgeClient', () => {
  it('requests photos for a device and a selected batch of users', async () => {
    const photos = [{ userId: '1514', contentType: 'image/jpeg', dataBase64: '/9j/2Q==' }];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ photos }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new ZktecoPhotoBridgeClient('http://127.0.0.1:3200/');

    await expect(client.getUserPhotos({ ipAddress: '192.168.1.199', tcpPort: 4370 } as any, ['1514']))
      .resolves.toEqual(photos);

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3200/devices/users/photos', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ ipAddress: '192.168.1.199', tcpPort: 4370, userIds: ['1514'] }),
    }));
  });

  it('rejects failed bridge responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'SDK -4985: fallo de lectura' }),
      { status: 502, headers: { 'content-type': 'application/json' } }
    )));
    const client = new ZktecoPhotoBridgeClient('http://127.0.0.1:3200');

    await expect(client.getUserPhotos({ ipAddress: '192.168.1.199', tcpPort: 4370 } as any, ['1514']))
      .rejects.toMatchObject({ message: 'SDK -4985: fallo de lectura', statusCode: 502 });
  });
});
