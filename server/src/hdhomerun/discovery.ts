// HDHomeRun UDP discovery responder (port 65001). A DVR app broadcasts a DISCOVER_REQ to the subnet; we
// reply (unicast) with one DISCOVER_RPY per ENABLED tuner so each appears as its own device. Runs in Node
// (it needs the tuner rows from Mongo — Rust never reads Mongo). Broadcast only reaches this process on host
// networking / macvlan / bare metal; on Docker bridge networking the broadcast never arrives (add the tuner
// by direct IP instead). Bind failure is NON-FATAL — like the Rust sidecar, a missing responder only
// disables auto-discovery.

import dgram from 'node:dgram';
import os from 'node:os';
import { logger } from '../sources/core/logger.js';
import { HdhrTuner, type HdhrTunerDoc } from '../models/HdhrTuner.js';
import { deviceIdToNumber } from './deviceId.js';
import {
  HDHR_DISCOVER_UDP_PORT,
  TYPE_DISCOVER_REQ,
  DEVICE_TYPE_TUNER,
  DEVICE_TYPE_WILDCARD,
  DEVICE_ID_WILDCARD,
  TAG_DEVICE_TYPE,
  TAG_DEVICE_ID,
  buildDiscoverReply,
  parsePacket,
  readU32Tag,
} from './packet.js';

let socket: dgram.Socket | null = null;
let httpPort = 0; // the PUBLIC HTTP port the advertised BaseURL points at (config.port, even in edge mode)

// A short TTL cache so a discovery burst (clients send several probes) doesn't hammer Mongo.
let cache: { at: number; tuners: HdhrTunerDoc[] } | null = null;
const CACHE_MS = 3000;
async function enabledTuners(): Promise<HdhrTunerDoc[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.tuners;
  const tuners = await HdhrTuner.find({ enabled: true }, { _id: 0 }).lean<HdhrTunerDoc[]>();
  cache = { at: now, tuners };
  return tuners;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((a, o) => ((a << 8) + (parseInt(o, 10) & 0xff)) >>> 0, 0) >>> 0;
}
function sameSubnet(a: string, b: string, mask: string): boolean {
  return (ipToInt(a) & ipToInt(mask)) >>> 0 === ((ipToInt(b) & ipToInt(mask)) >>> 0);
}

// The local IPv4 to advertise in BaseURL: an explicit override, else the interface on the requester's subnet,
// else the first non-internal IPv4.
function pickAdvertiseHost(remote: string): string {
  const override = process.env.MASQ_HDHR_ADVERTISE_HOST;
  if (override) return override;
  let fallback: string | null = null;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (fallback == null) fallback = ni.address;
      if (remote && ni.netmask && sameSubnet(ni.address, remote, ni.netmask)) return ni.address;
    }
  }
  return fallback ?? '127.0.0.1';
}

async function onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
  const pkt = parsePacket(msg);
  if (!pkt || pkt.type !== TYPE_DISCOVER_REQ) return;

  // Honor the request's filters: device type must be tuner or wildcard; device id wildcard or an exact match.
  const wantType = readU32Tag(pkt, TAG_DEVICE_TYPE, DEVICE_TYPE_WILDCARD);
  if (wantType !== DEVICE_TYPE_WILDCARD && wantType !== DEVICE_TYPE_TUNER) return;
  const wantId = readU32Tag(pkt, TAG_DEVICE_ID, DEVICE_ID_WILDCARD);

  let tuners: HdhrTunerDoc[];
  try {
    tuners = await enabledTuners();
  } catch (err) {
    logger.warn('hdhr', `discovery db read failed: ${(err as Error).message}`);
    return;
  }
  if (!tuners.length) return;

  const host = pickAdvertiseHost(rinfo.address);
  for (const t of tuners) {
    const idNum = deviceIdToNumber(t.deviceId);
    if (wantId !== DEVICE_ID_WILDCARD && wantId !== idNum) continue;
    const base = `http://${host}:${httpPort}/hdhr/${t.id}`;
    const reply = buildDiscoverReply({
      deviceType: DEVICE_TYPE_TUNER,
      deviceId: idNum,
      tunerCount: t.tunerCount,
      baseUrl: base,
      lineupUrl: `${base}/lineup.json`,
    });
    socket?.send(reply, rinfo.port, rinfo.address); // best-effort; a broadcast-reply drop is harmless
  }
}

/** Start the UDP discovery responder. `port` is the PUBLIC HTTP port advertised in BaseURL. Non-fatal. */
export function startHdhrDiscovery(port: number): void {
  if (socket) return;
  httpPort = port;
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('error', (err) => {
    logger.warn('hdhr', `discovery socket error (disabling UDP discovery): ${err.message}`);
    try {
      s.close();
    } catch {
      /* already closing */
    }
    if (socket === s) socket = null;
  });
  s.on('message', (msg, rinfo) => void onMessage(msg, rinfo));
  s.on('listening', () => {
    try {
      s.setBroadcast(true);
    } catch {
      /* not fatal */
    }
    logger.info('hdhr', `discovery responder listening on udp/${HDHR_DISCOVER_UDP_PORT}`);
  });
  s.bind(HDHR_DISCOVER_UDP_PORT); // EADDRINUSE etc. surface on the 'error' event above (non-fatal)
  socket = s;
}

export async function stopHdhrDiscovery(): Promise<void> {
  const s = socket;
  socket = null;
  cache = null;
  if (!s) return;
  await new Promise<void>((resolve) => {
    try {
      s.close(() => resolve());
    } catch {
      resolve();
    }
  });
}
