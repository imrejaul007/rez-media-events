/**
 * Cloudinary configuration + upload helper.
 *
 * B6 (MASTER-PLAN-2026-04-19): Centralized Cloudinary client. Uploads stream
 * directly from in-memory buffers (multer memoryStorage) to Cloudinary —
 * no ephemeral disk writes. Files live on Cloudinary CDN and survive Render
 * container restarts/redeploys.
 *
 * Environment variables (required in prod, warned at startup by src/index.ts):
 *   CLOUDINARY_CLOUD_NAME
 *   CLOUDINARY_API_KEY
 *   CLOUDINARY_API_SECRET
 */

import { v2 as cloudinary, UploadApiErrorResponse, UploadApiResponse } from 'cloudinary';

// Configure once at module load. If env vars are missing, Cloudinary calls will
// fail at request time with a clear error — startup logs the warning already
// (see src/index.ts#validateEnv).
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export { cloudinary };

export interface CloudinaryUploadResult {
  url: string;
  publicId: string;
  format: string;
  width: number;
  height: number;
  bytes: number;
  resourceType: string;
}

export interface UploadOptions {
  mimeType: string;
  folder?: string;
  originalFilename?: string;
}

/**
 * Stream a Buffer to Cloudinary. Resource type is inferred from mimeType prefix
 * (`video/*` -> 'video', everything else -> 'image'). Cloudinary assigns a
 * unique public_id when `unique_filename: true` is set, so collisions are
 * impossible even if two clients upload files with the same originalname.
 */
export function uploadBufferToCloudinary(
  buffer: Buffer,
  opts: UploadOptions,
): Promise<CloudinaryUploadResult> {
  const resourceType: 'video' | 'image' = opts.mimeType.startsWith('video/') ? 'video' : 'image';

  return new Promise<CloudinaryUploadResult>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: opts.folder ?? 'rez/media-events',
        resource_type: resourceType,
        unique_filename: true,
        use_filename: Boolean(opts.originalFilename),
        filename_override: opts.originalFilename,
        overwrite: false,
      },
      (err: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
        if (err) {
          reject(err);
          return;
        }
        if (!result) {
          reject(new Error('Cloudinary upload returned no result'));
          return;
        }
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          format: result.format,
          width: result.width,
          height: result.height,
          bytes: result.bytes,
          resourceType: result.resource_type,
        });
      },
    );
    stream.end(buffer);
  });
}
