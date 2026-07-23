// MinIO clients (DESIGN.md §1a, §4). Two clients on purpose:
//   • internal — bound to the internal host; does getObject + the pending_→approved_
//     rename (copy+remove) over the App→DMZ hop.
//   • public   — bound to the PUBLIC upload host, so presigned-POST signatures are
//     computed for ads-upload.gpsaswimming.org and validate there (MinIO runs with
//     MINIO_SERVER_URL set to the same host).
// Size/type are enforced by the presign policy, never trusted from the client (§3 inv 6).

import { Client } from 'minio';

import { streamToBuffer } from '../util.js';

/** Parse a URL like http://minio.gpsa.local:9000 into minio Client options. */
export function parseEndpoint(raw) {
  const u = new URL(raw);
  const useSSL = u.protocol === 'https:';
  return {
    endPoint: u.hostname,
    port: u.port ? Number(u.port) : useSSL ? 443 : 80,
    useSSL,
  };
}

/** Build the object key for an ad: `{ad_uuid}/pending_{filename}`. */
export function pendingKey(adId, filename) {
  return `${adId}/pending_${filename}`;
}

/** Approved counterpart: `{ad_uuid}/approved_{filename}`. */
export function approvedKeyFromPending(key) {
  return key.replace('/pending_', '/approved_');
}

/** Extract the Ad_ID (first path segment) from an object key. */
export function adIdFromKey(key) {
  return String(key || '').split('/')[0] || null;
}

export function createMinioClients(cfg) {
  const common = { accessKey: cfg.accessKey, secretKey: cfg.secretKey, region: 'us-east-1' };
  const internal = new Client({ ...parseEndpoint(cfg.endpointInternal), ...common });
  const publicClient = new Client({ ...parseEndpoint(cfg.endpointPublic), ...common });
  const bucket = cfg.bucket;

  return {
    bucket,

    /**
     * Presigned POST scoped to this ad's pending_ key, with the storage-enforced
     * size + content-type policy. Signed against the public upload host.
     */
    async presignUpload(adId, filename, contentType) {
      const key = pendingKey(adId, filename);
      const policy = publicClient.newPostPolicy();
      policy.setBucket(bucket);
      policy.setKey(key);
      policy.setContentType(contentType);
      policy.setContentLengthRange(1, cfg.maxUploadBytes);
      policy.setExpires(new Date(Date.now() + cfg.presignExpirySeconds * 1000));
      const { postURL, formData } = await publicClient.presignedPostPolicy(policy);
      return { url: postURL, fields: formData, key };
    },

    /** Fetch object bytes over the internal host (for dimension + Gemini checks). */
    async getObjectBuffer(key) {
      const stream = await internal.getObject(bucket, key);
      return streamToBuffer(stream);
    },

    /** Rename pending_→approved_ (copy then delete). Returns the new key. */
    async renameToApproved(pendingObjectKey) {
      const newKey = approvedKeyFromPending(pendingObjectKey);
      await internal.copyObject(bucket, newKey, `/${bucket}/${pendingObjectKey}`);
      await internal.removeObject(bucket, pendingObjectKey);
      return newKey;
    },
  };
}
