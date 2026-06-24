// Regenerate a source's committed offline SNAPSHOT from a fresh upstream fetch, using the source's own
// adapter so the snapshot is byte-for-byte the raw payload listChannels() reads back when offline:
//   · <id>.snapshot.json — the raw { channels: [...] } upstream payload (listChannels()'s offline fallback)
//
// There is no longer a normalized <id>.source.json bundle: nothing is seeded at boot, and a source's
// channels are populated on the user's first "Sync now" (live fetch, with this snapshot as the offline
// fallback). This tool just refreshes that fallback.
//
// DB-free: only adapter.listChannels() runs — no Mongo connection, no auth. The dulo catalog is
// metadata-only (streams are minted lazily at play time), so no session is needed.
//
// Usage (from server/):  npm run rebuild:seed            (defaults to dulo)
//                        tsx scripts/rebuild-source-seed.ts <id>
//
// NOTE: only sources whose live listChannels() returns the raw upstream array verbatim (i.e. snapshot
// shape === { channels: raw }) round-trip cleanly here. dulo qualifies; revisit before reusing for a
// source whose snapshot diverges from its raw listing.

import { writeFileSync } from 'node:fs';
import { getSource } from '../src/sources/registry.js';
import { snapshotFile } from '../src/sources/paths.js';

async function main(): Promise<void> {
    const id = process.argv[2] || 'dulo';
    const adapter = getSource(id);
    if (!adapter) {
        console.error(`[${id}] unknown source — not in the registry`);
        process.exit(1);
    }

    const { raw, meta } = await adapter.listChannels();
    // Refuse to rebuild the offline fallback from stale data: if the live fetch fell back to the
    // committed snapshot, we'd just rewrite it onto itself. Re-run when upstream is reachable.
    if (meta?.live === false) {
        console.error(
            `[${id}] live fetch failed (fell back to ${String(meta.fallback ?? 'snapshot')}: ` +
                `${String(meta.reason ?? 'unknown')}). Refusing to rebuild from stale data.`,
        );
        process.exit(1);
    }

    // Snapshot: the raw upstream payload verbatim, in the { channels } shape listChannels() reads back.
    writeFileSync(snapshotFile(id), `${JSON.stringify({ channels: raw }, null, 2)}\n`);
    console.log(`[${id}] wrote snapshot: ${raw.length} raw channels (live=${meta?.live !== false})`);
}

main().catch((err) => {
    console.error(`[rebuild-source-seed] ${(err as Error).message}`);
    process.exit(1);
});
