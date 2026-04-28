/**
 * Media Worker — standalone BullMQ consumer for media-events queue.
 *
 * Phase C extraction. Handles media processing: image variant generation,
 * asset deletion, CDN invalidation, temp file cleanup via Cloudinary API.
 *
 * Sprint 3: Added image.uploaded pipeline — downloads from Cloudinary,
 * resizes via sharp to thumbnail/medium/large, re-uploads with suffixes,
 * updates MongoDB document, and emits image.processed notification event.
 */

import { Worker, Job, Queue } from 'bullmq';
import { bullmqRedis } from './config/redis';
import { createServiceLogger } from './config/logger';
import mongoose from 'mongoose';
import axios from 'axios';
import sharp from 'sharp';

const logger = createServiceLogger('media-worker');

export const QUEUE_NAME = 'media-events';

export interface MediaEvent {
  eventId: string;
  eventType: string;
  payload: {
    publicId?: string;
    url?: string;
    resourceType?: string;
    variants?: Array<{ width: number; height: number; crop?: string; suffix: string }>;
    invalidateUrls?: string[];
    olderThan?: string;
    // image.uploaded fields
    imageUrl?: string;
    entityType?: 'product' | 'store' | 'user';
    entityId?: string;
    sizes?: string[];
    [key: string]: any;
  };
  createdAt: string;
}

// ── Image size definitions for the optimization pipeline ─────────────────────
const IMAGE_SIZES: Record<string, { width: number; height: number }> = {
  thumbnail: { width: 150, height: 150 },
  medium:    { width: 400, height: 400 },
  large:     { width: 800, height: 800 },
};

// Notification queue for emitting image.processed events
const notificationQueue = new Queue('notification-events', { connection: bullmqRedis });

/**
 * Download an image from a URL and return it as a Buffer.
 */
// BAK-MEDIA-001 FIX: SSRF prevention via URL allowlist.
// Only HTTPS URLs from approved hosts may be downloaded. This prevents attackers
// from tricking the service into fetching internal network resources (localhost,
// 169.254.169.254 metadata endpoint, internal IPs, etc.).
const ALLOWED_IMAGE_HOSTS = (process.env.ALLOWED_IMAGE_HOSTS || 'res.cloudinary.com,images.unsplash.com,api.rez.money').split(',');

function isUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_IMAGE_HOSTS.includes(parsed.host);
  } catch {
    return false;
  }
}

/**
 * Downloads an image from a URL with SSRF protection via host allowlist.
 * Rejects any URL whose host is not in the configured INTERNAL_ASSETS_ALLOWED_HOSTS list.
 * @param url - The image URL to download
 * @returns The raw image buffer
 * @throws Error if the URL is not in the SSRF allowlist
 */
async function downloadImage(url: string): Promise<Buffer> {
  if (!isUrlAllowed(url)) {
    throw new Error(`SSRF block: URL host not in allowlist — ${url}`);
  }
  const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 30_000 });
  return Buffer.from(response.data);
}

/**
 * Resize an image buffer to the target dimensions using sharp (cover crop).
 */
/**
 * Resizes an image buffer to the target dimensions using sharp (cover crop).
 * @param buffer - The raw image buffer
 * @param width - Target width in pixels
 * @param height - Target height in pixels
 * @returns The resized image buffer as JPEG
 */
async function resizeImage(buffer: Buffer, width: number, height: number): Promise<Buffer> {
  return sharp(buffer)
    .resize(width, height, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 85, progressive: true })
    .toBuffer();
}

/**
 * Upload a buffer to Cloudinary, appending a suffix to the original publicId.
 * Returns the secure URL of the uploaded asset.
 */
/**
 * Uploads a resized image buffer to Cloudinary under the specified folder.
 * @param buffer - The resized image buffer
 * @param folder - The Cloudinary folder path
 * @param publicId - Optional custom public ID
 * @returns Cloudinary upload result with URL and dimensions
 */
async function uploadResizedToCloudinary(
  cloudinary: ReturnType<typeof import('cloudinary')['v2']['config']> extends void ? any : any,
  buffer: Buffer,
  publicId: string,
  suffix: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const targetPublicId = `${publicId}_${suffix}`;
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: targetPublicId,
        overwrite: true,
        resource_type: 'image',
        format: 'jpg',
      },
      (err: any, result: any) => {
        if (err) return reject(err);
        resolve(result.secure_url as string);
      },
    );
    stream.end(buffer);
  });
}

/**
 * Get the MongoDB collection name for a given entity type.
 */
function collectionForEntity(entityType: 'product' | 'store' | 'user'): string {
  const map: Record<string, string> = { product: 'products', store: 'stores', user: 'users' };
  return map[entityType];
}

/**
 * Update the MongoDB document with the new variant URLs.
 * Stores image URLs under: images.thumbnail, images.medium, images.large
 */
/**
 * Updates the image URLs on an entity (product/store/category) in MongoDB.
 * @param entityType - The entity type (product, store, category)
 * @param entityId - The entity ID
 * @param resizedUrl - The Cloudinary URL of the resized image
 * @param resizedPublicId - The Cloudinary public ID of the resized image
 */
async function updateEntityImages(
  entityType: 'product' | 'store' | 'user',
  entityId: string,
  variantUrls: Record<string, string>,
): Promise<void> {
  const collection = mongoose.connection.collection(collectionForEntity(entityType));
  const setFields: Record<string, string> = {};
  for (const [size, url] of Object.entries(variantUrls)) {
    setFields[`images.${size}`] = url;
  }
  await collection.updateOne(
    { _id: new mongoose.Types.ObjectId(entityId) },
    { $set: setFields },
  );
}

async function getCloudinary() {
  const cloudinary = await import('cloudinary');
  cloudinary.v2.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  return cloudinary.v2;
}

let _worker: Worker | null = null;

/**
 * Starts the BullMQ media worker on the 'media-processing' queue.
 * Handles resize and upload events for product and store images.
 * @returns The BullMQ worker instance (singleton)
 */
export function startMediaWorker(): Worker {
  if (_worker) return _worker;

  _worker = new Worker(
    QUEUE_NAME,
    async (job: Job<MediaEvent>) => {
      const event = job.data;

      logger.debug('[Worker] Processing media event', {
        type: event.eventType,
        publicId: event.payload.publicId,
        attempt: job.attemptsMade,
      });

      switch (event.eventType) {
        case 'image.uploaded': {
          const { imageUrl, entityType, entityId, sizes } = event.payload;

          if (!imageUrl || !entityType || !entityId) {
            logger.warn('[Worker] image.uploaded missing required fields', {
              imageUrl, entityType, entityId,
            });
            break;
          }

          if (!mongoose.isValidObjectId(entityId)) {
            logger.warn('[Worker] image.uploaded invalid entityId', { entityId });
            break;
          }

          const requestedSizes = (sizes && sizes.length > 0)
            ? sizes
            : ['thumbnail', 'medium', 'large'];

          const cloudinary = await getCloudinary();

          // Derive a Cloudinary publicId from the URL or use entityType+entityId as fallback
          const urlSegments = imageUrl.split('/');
          const filenameWithExt = urlSegments[urlSegments.length - 1] ?? '';
          const basePublicId = filenameWithExt.replace(/\.[^.]+$/, '') || `${entityType}_${entityId}`;

          logger.info('[Worker] image.uploaded — starting optimization pipeline', {
            entityType, entityId, sizes: requestedSizes,
          });

          // Download original once
          const originalBuffer = await downloadImage(imageUrl);

          const variantUrls: Record<string, string> = {};

          for (const sizeName of requestedSizes) {
            const sizeConfig = IMAGE_SIZES[sizeName];
            if (!sizeConfig) {
              logger.warn('[Worker] Unknown size requested, skipping', { sizeName });
              continue;
            }
            try {
              const resized = await resizeImage(originalBuffer, sizeConfig.width, sizeConfig.height);
              const uploadedUrl = await uploadResizedToCloudinary(cloudinary, resized, basePublicId, sizeName);
              variantUrls[sizeName] = uploadedUrl;
              logger.debug('[Worker] Variant uploaded', { sizeName, url: uploadedUrl });
            } catch (err: any) {
              logger.error('[Worker] Failed to process variant', {
                sizeName, entityId, error: err.message,
              });
            }
          }

          // Update MongoDB document with new image URLs
          if (Object.keys(variantUrls).length > 0) {
            try {
              const validEntityTypes = ['product', 'store', 'user'];
              if (!validEntityTypes.includes(entityType)) {
                throw new Error(`Invalid entity type: ${entityType}. Must be one of: ${validEntityTypes.join(', ')}`);
              }
              await updateEntityImages(entityType as 'product' | 'store' | 'user', entityId, variantUrls);
              logger.info('[Worker] MongoDB document updated with variant URLs', { entityId, entityType });
            } catch (err: any) {
              logger.error('[Worker] MongoDB update failed', { entityId, error: err.message });
            }
          }

          // Emit image.processed notification event
          await notificationQueue.add('image.processed', {
            eventType: 'image.processed',
            entityType,
            entityId,
            variantUrls,
            processedAt: new Date().toISOString(),
          }, {
            jobId: `img.processed:${entityId}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          });

          logger.info('[Worker] image.uploaded pipeline complete', { entityId, entityType });
          break;
        }

        case 'generate-variants': {
          const cloudinary = await getCloudinary();
          const variants = event.payload.variants || [];

          for (const variant of variants) {
            try {
              await cloudinary.uploader.explicit(event.payload.publicId!, {
                type: 'upload',
                eager: [{
                  width: variant.width,
                  height: variant.height,
                  crop: variant.crop || 'fill',
                  quality: 'auto',
                  fetch_format: 'auto',
                }],
              });
              logger.debug('[Worker] Variant generated', {
                publicId: event.payload.publicId,
                suffix: variant.suffix,
                size: `${variant.width}x${variant.height}`,
              });
            } catch (err: any) {
              logger.error('[Worker] Variant generation failed', {
                publicId: event.payload.publicId,
                suffix: variant.suffix,
                error: err.message,
              });
            }
          }
          break;
        }

        case 'delete-asset': {
          const cloudinary = await getCloudinary();
          try {
            const resourceType = event.payload.resourceType || 'image';
            await cloudinary.uploader.destroy(event.payload.publicId!, {
              resource_type: resourceType,
            });
            logger.info('[Worker] Asset deleted', { publicId: event.payload.publicId });
          } catch (err: any) {
            logger.error('[Worker] Asset deletion failed', {
              publicId: event.payload.publicId,
              error: err.message,
            });
            throw err;
          }
          break;
        }

        case 'invalidate-cdn': {
          const cloudinary = await getCloudinary();
          const urls: string[] = event.payload.invalidateUrls || [];
          if (urls.length > 0) {
            try {
              // Cloudinary CDN invalidation via URL purge.
              // Previously passed event.payload.publicId for every iteration,
              // ignoring the individual URL — now each URL's publicId is extracted.
              for (const url of urls) {
                // Extract publicId from Cloudinary URL (everything between /upload/ and the extension)
                const baseUrl = url.split('?')[0]; // Strip query params before regex
                const match = baseUrl.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.\w+)?$/);
                const publicId = match ? match[1] : event.payload.publicId!;
                await cloudinary.uploader.explicit(publicId, {
                  type: 'upload',
                  invalidate: true,
                });
              }
              logger.info('[Worker] CDN invalidated', { count: urls.length });
            } catch (err: any) {
              logger.error('[Worker] CDN invalidation failed', { error: err.message });
            }
          }
          break;
        }

        case 'cleanup-temp': {
          logger.info('[Worker] Temp cleanup triggered', {
            olderThan: event.payload.olderThan,
          });
          // Future: cleanup temp uploads older than threshold
          break;
        }

        default:
          logger.debug('[Worker] Unhandled event type', { type: event.eventType });
      }
    },
    {
      connection: bullmqRedis,
      concurrency: 5,
      limiter: { max: 50, duration: 1000 }, // Cloudinary API rate limits
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    },
  );

  _worker.on('failed', (job, err) => {
    logger.error('[Worker] Job failed', {
      jobId: job?.id,
      type: job?.name,
      error: err.message,
      attempts: job?.attemptsMade,
    });
  });

  _worker.on('error', (err) => {
    logger.error('[Worker] Error:', err.message);
  });

  logger.info('[Worker] Started — queue: ' + QUEUE_NAME);
  return _worker;
}

export async function stopWorker(): Promise<void> {
  if (_worker) {
    await _worker.close();
    _worker = null;
  }
  await notificationQueue.close();
}
