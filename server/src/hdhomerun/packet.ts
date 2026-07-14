// HDHomeRun discovery wire codec (UDP port 65001) — the emulator half of libhdhomerun's packet layer.
//
// Frame:  uint16 type (BE) · uint16 payload_len (BE) · payload · uint32 CRC (LE, over type+len+payload).
// Payload: a sequence of TLVs — tag(1 byte) · length · value. Length is one byte when <=127 (MSB clear);
//          otherwise two bytes: (len & 0x7f)|0x80 then (len >> 7). The CRC is the standard reflected
//          Ethernet/zlib CRC-32 (poly 0xEDB88320), appended LITTLE-endian while everything else is big-endian.
//
// We only ever RECEIVE a DISCOVER_REQ and SEND DISCOVER_RPY packets, so this codec is intentionally minimal.

export const HDHR_DISCOVER_UDP_PORT = 65001;
export const HDHR_MAX_PACKET_SIZE = 1460;

export const TYPE_DISCOVER_REQ = 0x0002;
export const TYPE_DISCOVER_RPY = 0x0003;

export const TAG_DEVICE_TYPE = 0x01;
export const TAG_DEVICE_ID = 0x02;
export const TAG_TUNER_COUNT = 0x10;
export const TAG_LINEUP_URL = 0x27;
export const TAG_BASE_URL = 0x2a;
export const TAG_DEVICE_AUTH_STR = 0x2b;

export const DEVICE_TYPE_TUNER = 0x00000001;
export const DEVICE_TYPE_WILDCARD = 0xffffffff;
export const DEVICE_ID_WILDCARD = 0xffffffff;

// Standard reflected CRC-32 (zlib/PNG/Ethernet). No precomputed table — discovery packets are tiny and rare.
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function encodeTlv(tag: number, value: Buffer): Buffer {
  const len = value.length;
  const lenBytes =
    len <= 127 ? Buffer.from([len]) : Buffer.from([(len & 0x7f) | 0x80, (len >> 7) & 0xff]);
  return Buffer.concat([Buffer.from([tag & 0xff]), lenBytes, value]);
}

// Wrap a payload in the framed packet with its trailing little-endian CRC.
function seal(type: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type & 0xffff, 0);
  header.writeUInt16BE(payload.length & 0xffff, 2);
  const body = Buffer.concat([header, payload]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32LE(crc32(body), 0);
  return Buffer.concat([body, crcBuf]);
}

export interface DiscoverReply {
  deviceType: number; // DEVICE_TYPE_TUNER
  deviceId: number; // 32-bit numeric device id
  tunerCount: number;
  baseUrl: string; // e.g. http://192.168.1.50:3000/hdhr/<slug>
  lineupUrl: string; // e.g. <baseUrl>/lineup.json
  deviceAuth?: string;
}

/** Build a framed DISCOVER_RPY advertising one emulated tuner. */
export function buildDiscoverReply(r: DiscoverReply): Buffer {
  const parts = [
    encodeTlv(TAG_DEVICE_TYPE, u32be(r.deviceType)),
    encodeTlv(TAG_DEVICE_ID, u32be(r.deviceId)),
    encodeTlv(TAG_TUNER_COUNT, Buffer.from([r.tunerCount & 0xff])),
    encodeTlv(TAG_BASE_URL, Buffer.from(r.baseUrl, 'utf8')),
    encodeTlv(TAG_LINEUP_URL, Buffer.from(r.lineupUrl, 'utf8')),
  ];
  if (r.deviceAuth) parts.push(encodeTlv(TAG_DEVICE_AUTH_STR, Buffer.from(r.deviceAuth, 'utf8')));
  return seal(TYPE_DISCOVER_RPY, Buffer.concat(parts));
}

export interface ParsedTlv {
  tag: number;
  value: Buffer;
}

export interface ParsedPacket {
  type: number;
  tlvs: ParsedTlv[];
}

function decodeTlvs(payload: Buffer): ParsedTlv[] {
  const out: ParsedTlv[] = [];
  let i = 0;
  while (i + 2 <= payload.length) {
    const tag = payload[i++];
    let len = payload[i++];
    if (len & 0x80) {
      // 2-byte length continuation
      if (i >= payload.length) break;
      len = (len & 0x7f) | (payload[i++] << 7);
    }
    if (i + len > payload.length) break;
    out.push({ tag, value: payload.subarray(i, i + len) });
    i += len;
  }
  return out;
}

/** Parse + CRC-verify a received packet. Returns null on any malformation or CRC mismatch. */
export function parsePacket(buf: Buffer): ParsedPacket | null {
  if (buf.length < 8) return null; // 4 header + 0 payload + 4 crc
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  if (buf.length < 4 + len + 4) return null;
  const body = buf.subarray(0, 4 + len);
  const crcExpected = buf.readUInt32LE(4 + len);
  if (crc32(body) !== crcExpected) return null;
  return { type, tlvs: decodeTlvs(buf.subarray(4, 4 + len)) };
}

/** Read a numeric tag (u32 for device type/id) from a parsed packet, or a default when absent/short. */
export function readU32Tag(pkt: ParsedPacket, tag: number, dflt: number): number {
  const t = pkt.tlvs.find((x) => x.tag === tag);
  if (!t || t.value.length < 4) return dflt;
  return t.value.readUInt32BE(0) >>> 0;
}
