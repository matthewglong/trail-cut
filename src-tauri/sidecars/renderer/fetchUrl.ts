// Network fetcher for tile-cache misses. Shared by both backends: chrome
// reaches it through the trailcutFetch bridge (page → exposeFunction →
// tileCache.get(originalUrl, fetchUrl)), native calls tileCache.get
// directly from the mbgl request callback. One implementation → one set of
// HTTP semantics (redirects, content-encoding) → identical cached bytes.
// (Moved verbatim from index.ts in the Phase 5 backend split.)

import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';

export function fetchUrl(
  url: string,
  cb: (err: Error | null, data?: Buffer) => void,
  redirectsLeft = 5,
): void {
  let parsed: URL;
  try { parsed = new URL(url); } catch (e) { cb(e as Error); return; }
  const proto = parsed.protocol === 'https:' ? https : http;
  proto
    .get(
      url,
      { headers: { 'Accept-Encoding': 'gzip, deflate, br' } },
      (res) => {
        const status = res.statusCode ?? 0;
        if (
          status >= 300 && status < 400 &&
          res.headers.location && redirectsLeft > 0
        ) {
          res.resume();
          fetchUrl(
            new URL(res.headers.location, url).toString(),
            cb,
            redirectsLeft - 1,
          );
          return;
        }
        if (status !== 200 && status !== 204) {
          res.resume();
          cb(new Error(`HTTP ${status} for ${url}`));
          return;
        }
        let stream: NodeJS.ReadableStream = res;
        const enc = res.headers['content-encoding'];
        if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => cb(null, Buffer.concat(chunks)));
        stream.on('error', (e: Error) => cb(e));
      },
    )
    .on('error', (e) => cb(e));
}
