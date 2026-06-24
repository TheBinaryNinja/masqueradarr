// Tubi uapi signing self-check — the unit gate for adapters/tubi/api/sign.ts.
//
// Reproduces a CAPTURED, known-good token request signature byte-for-byte (offline, no network) so a future
// edit to the signer is caught immediately. Optionally (`--live`) runs the real anonymous-token bootstrap +
// a catalog fetch against uapi.production-public.tubi.io to confirm end-to-end (needs US egress).
//
// Usage (from server/):  tsx scripts/tubi-sign-check.ts          (offline unit gate)
//                        tsx scripts/tubi-sign-check.ts --live   (also hit the live uapi)

import { signTubiRequest, pkceChallenge } from '../src/sources/adapters/tubi/api/sign.js';

// ── Captured ground truth (live tubitv.com web client, 2026-06-19) ──
const GT = {
  signingKeyB64: 'xBh/Cz5sgbrJP5ecI4FjPBNSV1KcTHW0uSNPDldGd3M=',
  body: JSON.stringify({
    verifier: '797e12ef14df0a36d0f47bc51e2d0ff0',
    id: 'a986a154-3750-44af-9a1a-1176c635487f',
    platform: 'web',
    device_id: '8fe39b7b-ccaf-46d2-82da-0771b4ee8d93',
  }),
  date: '20260619T135355Z',
  path: '/device/anonymous/token',
  expectedSig: 'e6dba1300b71986f89c8c2a02a0f7496f0415c1e398683e48009b344e9cb24c2',
  verifier: '797e12ef14df0a36d0f47bc51e2d0ff0',
  expectedChallenge: '5G0hLGbVtS4Q_6UIkoHrQ3DIcJ8CPB0-632olx-lFCE=',
};

function unitGate(): void {
  // Inject the captured timestamp so the date matches the captured request exactly.
  const captured = new Date('2026-06-19T13:53:55.000Z');
  const sig = signTubiRequest(GT.body, GT.signingKeyB64, GT.path, captured)['X-Tubi-Signature'];
  const challenge = pkceChallenge(GT.verifier);

  const sigOk = sig === GT.expectedSig;
  const chOk = challenge === GT.expectedChallenge;
  console.log(`signature : ${sig}  ${sigOk ? 'OK' : `FAIL (expected ${GT.expectedSig})`}`);
  console.log(`challenge : ${challenge}  ${chOk ? 'OK' : `FAIL (expected ${GT.expectedChallenge})`}`);
  if (!sigOk || !chOk) {
    console.error('tubi-sign-check: UNIT GATE FAILED — the signer no longer reproduces the captured request.');
    process.exit(1);
  }
  console.log('tubi-sign-check: unit gate PASSED.');
}

async function liveCheck(): Promise<void> {
  const { getAccessToken, getDeviceId } = await import('../src/sources/adapters/tubi/api/deviceToken.js');
  const { fetchApiCatalog } = await import('../src/sources/adapters/tubi/api/catalog.js');
  console.log(`\n[live] device_id = ${getDeviceId()}`);
  const token = await getAccessToken();
  console.log(`[live] access token minted (${token.slice(0, 24)}…)`);
  const { raw, meta } = await fetchApiCatalog();
  console.log(`[live] catalog: ${raw.length} channels via ${(meta as any)?.via} (live=${meta?.live})`);
  const sample = raw[0];
  console.log(`[live] sample: content_id=${sample?.content_id} title=${JSON.stringify(sample?.title)} programs=${sample?.programs?.length ?? 0}`);
}

async function main(): Promise<void> {
  unitGate();
  if (process.argv.includes('--live')) await liveCheck();
}

main().catch((err) => {
  console.error(`tubi-sign-check: ${(err as Error).message}`);
  process.exit(1);
});
