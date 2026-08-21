import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { clipboard } from 'electron';

/**
 * One-click "upload and get a shareable link" via GoFile.
 *
 * GoFile allows fully ANONYMOUS uploads — no account, no API key, no OAuth. A
 * single multipart POST creates a guest folder and returns a public share page.
 * (This is why we moved off pixeldrain, which now requires an API key.)
 *
 * Files can be multi-GB, so the file is STREAMED into the multipart body rather
 * than read into memory. We frame the multipart request by hand — preamble
 * Buffer, then the file stream, then the epilogue Buffer — and set an exact
 * Content-Length so GoFile accepts a non-chunked upload. Node's `https.request`
 * is used (not `fetch`) so we can count the bytes leaving the file stream and
 * report real upload progress.
 *
 * Retention is inactivity-based (~10 days without a download, resets on view),
 * which the settings copy makes clear.
 */

const API_HOST = 'api.gofile.io';
const FALLBACK_UPLOAD_HOST = 'upload.gofile.io';
const USER_AGENT = 'EzScreenRecord/1.0';

/** Progress emitted while a single upload runs. */
export interface UploadProgress {
  /** Correlates a stream of progress events with one upload. */
  id: string;
  /** Bytes sent so far. */
  uploaded: number;
  /** Total bytes to send (the file size). */
  total: number;
  phase: 'starting' | 'uploading' | 'done' | 'error';
}

interface GofileUploadResponse {
  status?: string;
  data?: { downloadPage?: string; id?: string; code?: string };
}

/**
 * Stream `filePath` to GoFile and return its shareable download-page URL.
 *
 * @param uploadId   Correlation id echoed back on every progress event.
 * @param onProgress Called as bytes are sent, plus a final 'done'/'error'.
 *
 * Tries a healthy upload server chosen from GoFile's /servers list, falling
 * back to the global entry point. No credentials are used or stored.
 */
export async function uploadAndShare(
  filePath: string,
  uploadId: string,
  onProgress: (p: UploadProgress) => void,
): Promise<{ viewUrl: string }> {
  let total = 0;
  try {
    total = fs.statSync(filePath).size;
  } catch (err) {
    onProgress({ id: uploadId, uploaded: 0, total: 0, phase: 'error' });
    throw err;
  }

  onProgress({ id: uploadId, uploaded: 0, total, phase: 'starting' });

  // Prefer a server picked from /servers; on any trouble, use the global entry
  // point. Both accept the same anonymous multipart upload.
  const primary = (await pickServerHost()) ?? FALLBACK_UPLOAD_HOST;

  try {
    return await putMultipart(primary, filePath, total, uploadId, onProgress);
  } catch (err) {
    // One retry against the global entry point if we hadn't already used it —
    // a single GoFile server can be briefly unhealthy.
    if (primary !== FALLBACK_UPLOAD_HOST) {
      try {
        return await putMultipart(FALLBACK_UPLOAD_HOST, filePath, total, uploadId, onProgress);
      } catch {
        /* fall through to the original error */
      }
    }
    onProgress({ id: uploadId, uploaded: 0, total, phase: 'error' });
    throw err as Error;
  }
}

/** Ask GoFile for a healthy upload server; null if the lookup fails. */
function pickServerHost(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = https.request(
      { host: API_HOST, method: 'GET', path: '/servers', headers: { 'User-Agent': USER_AGENT } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              status?: string;
              data?: { servers?: Array<{ name?: string }> };
            };
            const name = json.status === 'ok' ? json.data?.servers?.[0]?.name : undefined;
            resolve(name ? `${name}.gofile.io` : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** Frame and stream one multipart upload to a given GoFile host. */
function putMultipart(
  host: string,
  filePath: string,
  total: number,
  uploadId: string,
  onProgress: (p: UploadProgress) => void,
): Promise<{ viewUrl: string }> {
  return new Promise((resolve, reject) => {
    const boundary = `----EzScreenRecord${randomUUID()}`;
    const filename = path.basename(filePath);
    // The multipart envelope around the raw file bytes. CRLFs are significant —
    // Content-Length below counts these exact bytes plus the file size.
    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: video/mp4\r\n\r\n`,
      'utf-8',
    );
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8');
    const contentLength = preamble.length + total + epilogue.length;

    const req = https.request(
      {
        host,
        method: 'POST',
        path: '/contents/uploadfile',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(contentLength),
          'User-Agent': USER_AGENT,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: GofileUploadResponse = {};
          try {
            parsed = JSON.parse(body) as GofileUploadResponse;
          } catch {
            /* handled below */
          }
          const status = res.statusCode ?? 0;
          const page = parsed.data?.downloadPage;
          if (status >= 200 && status < 300 && parsed.status === 'ok' && page) {
            try {
              clipboard.writeText(page);
            } catch {
              /* clipboard may be unavailable; the URL is still returned */
            }
            onProgress({ id: uploadId, uploaded: total, total, phase: 'done' });
            resolve({ viewUrl: page });
          } else {
            reject(new Error(`GoFile upload failed (HTTP ${status || 'no response'}).`));
          }
        });
      },
    );

    req.on('error', reject);

    // Write the preamble, stream the file (counting bytes for progress), then
    // the epilogue. Do not end the request until the file has fully flowed.
    req.write(preamble);
    const source = fs.createReadStream(filePath);
    let uploaded = 0;
    source.on('data', (chunk: Buffer | string) => {
      uploaded += Buffer.byteLength(chunk);
      onProgress({ id: uploadId, uploaded, total, phase: 'uploading' });
    });
    source.on('end', () => {
      req.end(epilogue);
    });
    source.on('error', (err) => {
      req.destroy(err);
    });
    source.pipe(req, { end: false });
  });
}
