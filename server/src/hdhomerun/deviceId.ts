// HDHomeRun DeviceID checksum — the emulator side of libhdhomerun's hdhomerun_discover_validate_device_id.
// A DeviceID is a 32-bit value rendered as 8 UPPERCASE hex digits. Clients (Plex/Emby) validate its
// checksum before trusting a discovered device, so a GENERATED id must satisfy it or the tuner is ignored.
//
// The check: XOR the 8 nibbles (MSB→LSB) where the ODD-position nibbles (bits 31-28, 23-20, 15-12, 7-4)
// pass through a lookup table and the EVEN-position nibbles XOR directly; the result must equal 0. Because
// the least-significant nibble (bits 3-0) XORs in directly, it acts as the checksum digit that balances the
// other seven. To generate a valid id we pick the high 7 nibbles and derive the LSB nibble.

const LOOKUP = [0xa, 0x5, 0xf, 0x6, 0x7, 0xc, 0x1, 0xb, 0x9, 0x2, 0x8, 0xd, 0x4, 0x3, 0xe, 0x0] as const;

import { randomBytes } from 'node:crypto';

/** True when the 32-bit numeric device id passes the HDHomeRun checksum. */
export function isValidDeviceId(id: number): boolean {
  const v = id >>> 0;
  let c = 0;
  c ^= LOOKUP[(v >>> 28) & 0xf];
  c ^= (v >>> 24) & 0xf;
  c ^= LOOKUP[(v >>> 20) & 0xf];
  c ^= (v >>> 16) & 0xf;
  c ^= LOOKUP[(v >>> 12) & 0xf];
  c ^= (v >>> 8) & 0xf;
  c ^= LOOKUP[(v >>> 4) & 0xf];
  c ^= v & 0xf;
  return c === 0;
}

/** The LSB nibble that makes the given high-28-bit value a valid device id. */
function checksumNibble(hi: number): number {
  const v = hi >>> 0;
  return (
    LOOKUP[(v >>> 28) & 0xf] ^
    ((v >>> 24) & 0xf) ^
    LOOKUP[(v >>> 20) & 0xf] ^
    ((v >>> 16) & 0xf) ^
    LOOKUP[(v >>> 12) & 0xf] ^
    ((v >>> 8) & 0xf) ^
    LOOKUP[(v >>> 4) & 0xf]
  );
}

/** Parse an 8-hex DeviceID string to its 32-bit numeric value (for the UDP DEVICE_ID tag). */
export function deviceIdToNumber(hex: string): number {
  return parseInt(hex, 16) >>> 0;
}

/**
 * A fresh, checksum-valid 8-hex DeviceID. 28 random high bits (top nibble forced non-zero so the id never
 * renders with a leading 0 that a strict client might mis-length), with the checksum nibble appended.
 */
export function generateDeviceId(): string {
  const buf = randomBytes(4);
  let hi = (((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) & 0xfffffff0) >>> 0; // clear LSB nibble
  if (((hi >>> 28) & 0xf) === 0) hi = (hi | 0x10000000) >>> 0; // ensure a non-zero leading nibble
  const id = (hi | (checksumNibble(hi) & 0xf)) >>> 0;
  return id.toString(16).toUpperCase().padStart(8, '0');
}
