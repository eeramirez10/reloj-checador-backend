import type { Device } from '../../devices/device-repository.js';

export interface UserPhotoFile {
  userId: string;
  contentType: 'image/jpeg';
  dataBase64: string;
}

export class PhotoBridgeError extends Error {
  constructor(message: string, readonly statusCode: number = 502) {
    super(message);
  }
}

function isUserPhotoFile(value: unknown): value is UserPhotoFile {
  if (typeof value !== 'object' || value === null) return false;
  const photo = value as Record<string, unknown>;
  return typeof photo.userId === 'string'
    && photo.contentType === 'image/jpeg'
    && typeof photo.dataBase64 === 'string';
}

export class ZktecoPhotoBridgeClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async getUserPhotos(device: Device, userIds: string[]): Promise<UserPhotoFile[]> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/devices/users/photos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ipAddress: device.ipAddress,
          tcpPort: device.tcpPort,
          userIds
        }),
        signal: AbortSignal.timeout(120_000)
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Error de red desconocido.';
      throw new PhotoBridgeError(`No se pudo conectar con el puente de fotos: ${detail}`, 503);
    }

    if (!response.ok) {
      let message = `El puente de fotos respondió HTTP ${response.status}.`;
      try {
        const payload: unknown = await response.json();
        if (typeof payload === 'object' && payload !== null && 'message' in payload
          && typeof payload.message === 'string' && payload.message.trim()) {
          message = payload.message;
        }
      } catch {
        // Usa el status HTTP cuando el puente no devuelve JSON.
      }
      throw new PhotoBridgeError(message, response.status === 503 ? 503 : 502);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PhotoBridgeError('El puente de fotos devolvió una respuesta inválida.');
    }

    if (typeof payload !== 'object' || payload === null || !('photos' in payload)) {
      throw new PhotoBridgeError('El puente de fotos devolvió una respuesta inválida.');
    }

    const photos = (payload as { photos: unknown }).photos;
    if (!Array.isArray(photos) || !photos.every(isUserPhotoFile)) {
      throw new PhotoBridgeError('El puente de fotos devolvió una lista de imágenes inválida.');
    }

    return photos;
  }
}
