/**
 * Minimal tus 1.0.0 client for the host's resumable upload endpoint
 * (`/api/v1/spindle-uploads`). Enough for one-shot model ZIP uploads.
 */

const ENDPOINT = '/api/v1/spindle-uploads';
const PATCH_CHUNK = 8 * 1024 * 1024;

function encodeMetadata(pairs: Record<string, string>): string {
  return Object.entries(pairs)
    .map(([key, value]) => `${key} ${btoa(unescape(encodeURIComponent(value)))}`)
    .join(',');
}

export async function tusUpload(
  bytes: Uint8Array,
  filename: string,
  extensionIdentifier: string,
  onProgress?: (sent: number, total: number) => void,
): Promise<string> {
  const created = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Tus-Resumable': '1.0.0',
      'Upload-Length': String(bytes.length),
      'Upload-Metadata': encodeMetadata({ filename, extension: extensionIdentifier }),
    },
    credentials: 'same-origin',
  });
  if (created.status !== 201) {
    throw new Error(`Upload could not be created (HTTP ${created.status}).`);
  }
  const location = created.headers.get('Location');
  if (!location) throw new Error('Upload endpoint returned no Location header.');
  const uploadUrl = new URL(location, window.location.origin).toString();

  let offset = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, Math.min(offset + PATCH_CHUNK, bytes.length));
    const patched = await fetch(uploadUrl, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(offset),
        'Content-Type': 'application/offset+octet-stream',
      },
      credentials: 'same-origin',
      body: chunk as unknown as BodyInit,
    });
    if (patched.status !== 204) {
      throw new Error(`Upload chunk failed (HTTP ${patched.status}).`);
    }
    offset = Number(patched.headers.get('Upload-Offset') ?? offset + chunk.length);
    onProgress?.(offset, bytes.length);
  }

  const uploadId = uploadUrl.split('/').filter(Boolean).pop();
  if (!uploadId) throw new Error('Could not determine upload id.');
  return uploadId;
}
