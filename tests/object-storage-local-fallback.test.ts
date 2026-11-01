import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const s3Variables = ['S3_BUCKET', 'S3_REGION', 'S3_ENDPOINT', 'S3_FORCE_PATH_STYLE', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marshgo-photo-fallback-'));

// objectStorage resolves LOCAL_STORAGE_DIR when the module loads, so the environment is set before the dynamic import.
for (const name of s3Variables) delete process.env[name];
process.env.LOCAL_STORAGE_DIR = localDir;
const storage = await import('../server/objectStorage');

function pngSignature(): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLength = Buffer.alloc(4);
  ihdrLength.writeUInt32BE(13);
  const chunk = Buffer.concat([ihdrLength, Buffer.from('IHDR'), Buffer.alloc(13), Buffer.alloc(4)]);
  return Buffer.concat([signature, chunk, Buffer.from([0xff, 0xda])]);
}

after(() => {
  fs.chmodSync(localDir, 0o700);
  fs.rmSync(localDir, { recursive: true, force: true });
  delete process.env.LOCAL_STORAGE_DIR;
  for (const name of s3Variables) delete process.env[name];
});

describe('local photo storage fallback when S3 is unconfigured', () => {
  it('stores the object on disk', async () => {
    await storage.putPhotoObject('vehicle-photos/user-a/vehicle-a/photo-a', pngSignature(), 'image/png');
    const written = await fs.promises.readFile(path.join(localDir, 'vehicle-photos/user-a/vehicle-a/photo-a'));
    assert.ok(written.length > 8);
  });

  it('reports a storage outage instead of blaming the upload when the local store cannot be written', async () => {
    // A regular file where the key needs a directory makes every write attempt fail with ENOTDIR,
    // which reproduces the root-owned-volume outage without depending on the test user's privileges.
    await fs.promises.writeFile(path.join(localDir, 'blocked'), 'x');
    await assert.rejects(
      () => storage.putPhotoObject('blocked/vehicle-photos/photo-x', pngSignature(), 'image/png'),
      (error: unknown) => error instanceof storage.ObjectStorageUnavailableError,
    );
  });

  it('still rejects a body that is not the declared image type', async () => {
    await assert.rejects(
      () => storage.putPhotoObject('vehicle-photos/user-c/vehicle-c/photo-c', Buffer.from('not an image'), 'image/png'),
      /Unsupported photo|content does not match/,
    );
  });
});
