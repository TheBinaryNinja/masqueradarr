import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_LEN = 64;

export function hashPassword(password: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const salt = randomBytes(16).toString('hex');
        scrypt(password, salt, KEY_LEN, (err, derivedKey) => {
            if (err) return reject(err);
            resolve(`${salt}:${derivedKey.toString('hex')}`);
        });
    });
}

export function verifyPassword(password: string, storedHash: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const [salt, hash] = storedHash.split(':');
        if (!salt || !hash) return resolve(false);
        scrypt(password, salt, KEY_LEN, (err, derivedKey) => {
            if (err) return reject(err);
            const keyBuffer = Buffer.from(derivedKey.toString('hex'), 'hex');
            const hashBuffer = Buffer.from(hash, 'hex');
            if (keyBuffer.length !== hashBuffer.length) {
                return resolve(false);
            }
            resolve(timingSafeEqual(keyBuffer, hashBuffer));
        });
    });
}

export function generateToken(bytes: number = 32): string {
    return randomBytes(bytes).toString('hex');
}

// Lowercase-only alphabet: the slug becomes part of a playlist FILENAME, and macOS/Windows filesystems are
// case-insensitive — mixed case could collide on disk. Lowercase [a-z0-9] keeps every slug a distinct file.
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// A short, unguessable, filesystem-safe slug for per-user playlist filenames (<username>.<slug>.m3u). The
// slug is the bearer secret that makes a token-free playlist download safe, so it must stay random + stable.
export function generateSlug(length: number = 6): string {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) {
        out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
    }
    return out;
}
