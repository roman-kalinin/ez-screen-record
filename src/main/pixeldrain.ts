import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { clipboard } from 'electron';

/**
 * One-click "upload and get a shareable link" via pixeldrain.
 *
 * No account or OAuth: anonymous uploads work out of the box, and an optional
 * API key (from settings) only raises the limits. The returned view URL is a
 * pixeldrain viewer page with a built-in player; links live ~60 days.
 *
 * Files can be multi-GB, so the upload streams straight from disk — the file is
 * never read into memory. Node's `https.request` is used rather than `fetch`
 * precisely because it exposes the request body stream, which lets us count the
 * bytes actually sent and report real upload progress (fetch gives none).
 */

const HOST = 'pixeldrain.com';

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

interface PixeldrainResponse {
  success?: boolean;
  id?: string;
  message?: string;
  value?: string;
}

/**
 * Stream `filePath` to pixeldrain and return its shareable view URL.
 *
 * @param apiKey  Optional pixeldrain key. Empty/null uploads anonymously — the
 *                Authorization header is OMITTED entirely in that case.
 * @param uploadId  Correlation id echoed back on every progress event.
 * @param onProgress  Called as bytes are sent, plus a final 'done'/'error'.
 *
 * The key is never logged.
 */
export function uploadAndShare(
  filePath: string,
  apiKey: string | null,
  uploadId: string,
  onProgress: (p: UploadProgress) => void,
): Promise<{ viewUrl: string }> {
  return new Promise((resolve, reject) => {
    let total = 0;
    try {
      total = fs.statSync(filePath).size;
    } catch (err) {
      reject(err);
      return;
    }

    const name = encodeURIComponent(path.basename(filePath));
    onProgress({ id: uploadId, uploaded: 0, total, phase: 'starting' });

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(total),
    };
    // HTTP Basic with an empty username. OMIT the header entirely when
    // anonymous — sending an empty key would authenticate as a broken account.
    const key = apiKey && apiKey.trim() ? apiKey.trim() : null;
    if (key) {
      headers.Authorization = 'Basic ' + Buffer.from(':' + key).toString('base64');
    }

    const req = https.request(
      {
        host: HOST,
        method: 'PUT',
        path: `/api/file/${name}`,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          let parsed: PixeldrainResponse = {};
          try {
            parsed = JSON.parse(body) as PixeldrainResponse;
          } catch {
            /* leave parsed empty; handled below */
          }

          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300 && parsed.success && parsed.id) {
            const viewUrl = `https://${HOST}/u/${parsed.id}`;
            // Copy for the user immediately — the toast still shows it too.
            try {
              clipboard.writeText(viewUrl);
            } catch {
              /* clipboard may be unavailable; the URL is still returned */
            }
            onProgress({ id: uploadId, uploaded: total, total, phase: 'done' });
            resolve({ viewUrl });
          } else {
            const message =
              parsed.message ||
              parsed.value ||
              `pixeldrain upload failed (HTTP ${status || 'no response'})`;
            onProgress({ id: uploadId, uploaded: 0, total, phase: 'error' });
            reject(new Error(message));
          }
        });
      },
    );

    req.on('error', (err) => {
      onProgress({ id: uploadId, uploaded: 0, total, phase: 'error' });
      reject(err);
    });

    // Stream the file in, counting bytes as they leave for real progress.
    const source = fs.createReadStream(filePath);
    let uploaded = 0;
    source.on('data', (chunk: Buffer | string) => {
      uploaded += Buffer.byteLength(chunk);
      onProgress({ id: uploadId, uploaded, total, phase: 'uploading' });
    });
    source.on('error', (err) => {
      req.destroy(err);
    });
    source.pipe(req);
  });
}
