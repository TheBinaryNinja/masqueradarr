// Browser-side XMLTV upload transport. XMLTV guides are large (a multi-day national guide runs 50–150 MB
// uncompressed); sending one as a JSON string field both inflates the payload (escaping) and stacks against
// the body-parser limit. Instead we ship the file as a RAW gzip body (Content-Type: application/gzip): an
// already-gzipped `.xml.gz` goes verbatim, a plain `.xml` is gzipped in-stream via CompressionStream so the
// browser never holds more than a chunk. The server gunzips it (server/src/epg/xmltvIngest.ts →
// decodeXmltvBody). Falls back to a raw `application/xml` body when CompressionStream is unavailable (the
// server accepts that too). See restapi-sources.md.

export interface XmltvBody {
  body: Blob | File;
  contentType: string;
}

// Is the file already gzip? — a `.gz` name or the gzip magic bytes (1f 8b) at the head.
async function isGzip(file: File): Promise<boolean> {
  if (/\.gz$/i.test(file.name)) return true;
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

// Turn the chosen file into a ready-to-POST body. Gzip once here, then reuse the returned Blob for both the
// validate pre-flight and the commit (a Blob is immutable and re-readable across fetches).
export async function fileToXmltvBody(file: File): Promise<XmltvBody> {
  if (await isGzip(file)) return { body: file, contentType: 'application/gzip' };
  if (typeof CompressionStream === 'function') {
    const gz = file.stream().pipeThrough(new CompressionStream('gzip'));
    const blob = await new Response(gz).blob();
    return { body: blob, contentType: 'application/gzip' };
  }
  return { body: file, contentType: 'application/xml' }; // legacy-browser fallback: raw xml
}
