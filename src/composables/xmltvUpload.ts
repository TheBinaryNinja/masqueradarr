
export interface XmltvBody {
  body: Blob | File;
  contentType: string;
}

async function isGzip(file: File): Promise<boolean> {
  if (/\.gz$/i.test(file.name)) return true;
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

export async function fileToXmltvBody(file: File): Promise<XmltvBody> {
  if (await isGzip(file)) return { body: file, contentType: 'application/gzip' };
  if (typeof CompressionStream === 'function') {
    const gz = file.stream().pipeThrough(new CompressionStream('gzip'));
    const blob = await new Response(gz).blob();
    return { body: blob, contentType: 'application/gzip' };
  }
  return { body: file, contentType: 'application/xml' };
}
