import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { fileTypeFromBuffer } from 'file-type';

const maxPhotoBytes = 10 * 1024 * 1024;
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxVerificationEvidenceBytes = 8 * 1024 * 1024;
const allowedVerificationEvidenceTypes = new Set(['image/jpeg', 'image/png', 'application/pdf']);
let client: S3Client | null = null;

export class ObjectStorageUnavailableError extends Error {
  constructor() { super('S3-compatible object storage is not configured'); }
}

export class StoredEvidenceUnavailableError extends Error {
  constructor() { super('Private verification evidence is missing or invalid'); }
}

function s3() {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION;
  if (!bucket || !region) throw new ObjectStorageUnavailableError();
  if (!client) client = new S3Client({
    region,
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' } : {}),
    ...(process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } }
      : {}),
  });
  return { client, bucket };
}

export function isAllowedPhotoType(value: unknown): value is string {
  return typeof value === 'string' && allowedImageTypes.has(value);
}

export function isAllowedVerificationEvidenceType(value: unknown): value is string {
  return typeof value === 'string' && allowedVerificationEvidenceTypes.has(value);
}

export async function createVehiclePhotoUpload(key: string, contentType: string) {
  const { client: s3Client, bucket } = s3();
  const post = await createPresignedPost(s3Client, {
    Bucket: bucket,
    Key: key,
    Expires: 300,
    Fields: { 'Content-Type': contentType },
    Conditions: [
      ['content-length-range', 1, maxPhotoBytes],
      ['eq', '$Content-Type', contentType],
    ],
  });
  return { ...post, expiresInSeconds: 300, maxBytes: maxPhotoBytes };
}

export async function createVerificationEvidenceUpload(key: string, contentType: string) {
  if (!isAllowedVerificationEvidenceType(contentType)) throw new Error('Unsupported verification evidence media type');
  const { client: s3Client, bucket } = s3();
  const post = await createPresignedPost(s3Client, {
    Bucket: bucket,
    Key: key,
    Expires: 300,
    Fields: { 'Content-Type': contentType },
    Conditions: [
      ['content-length-range', 1, maxVerificationEvidenceBytes],
      ['eq', '$Content-Type', contentType],
    ],
  });
  return { ...post, expiresInSeconds: 300, maxBytes: maxVerificationEvidenceBytes };
}

export async function verifyVerificationEvidenceObject(key: string, expectedType: string) {
  if (!isAllowedVerificationEvidenceType(expectedType)) return false;
  const { client: s3Client, bucket } = s3();
  const metadata = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (!metadata.ContentLength || metadata.ContentLength < 1 || metadata.ContentLength > maxVerificationEvidenceBytes || metadata.ContentType !== expectedType) {
    return false;
  }
  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-4095' }));
  if (!response.Body) return false;
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  const detected = await fileTypeFromBuffer(bytes);
  return detected?.mime === expectedType;
}

export async function verifyVehiclePhotoObject(key: string, expectedType: string) {
  const { client: s3Client, bucket } = s3();
  const metadata = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (!metadata.ContentLength || metadata.ContentLength < 1 || metadata.ContentLength > maxPhotoBytes || metadata.ContentType !== expectedType) {
    return false;
  }
  const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: 'bytes=0-4095' }));
  if (!response.Body) return false;
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  const detected = await fileTypeFromBuffer(bytes);
  return detected?.mime === expectedType;
}

export async function getVehiclePhotoUrl(key: string) {
  const { client: s3Client, bucket } = s3();
  return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 });
}

export async function deleteStoredVehiclePhoto(key: string) {
  const { client: s3Client, bucket } = s3();
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function getVerificationEvidenceUrl(key: string) {
  const { client: s3Client, bucket } = s3();
  const metadata = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (!metadata.ContentLength || metadata.ContentLength > maxVerificationEvidenceBytes ||
      !isAllowedVerificationEvidenceType(metadata.ContentType)) throw new StoredEvidenceUnavailableError();
  return getSignedUrl(s3Client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 180 });
}

export async function deleteStoredVerificationEvidence(key: string) {
  const { client: s3Client, bucket } = s3();
  await s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
