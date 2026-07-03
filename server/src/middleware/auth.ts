import type { Request, Response, NextFunction } from 'express';
import { Session } from '../models/Session.js';
import { User, type UserDoc } from '../models/User.js';

export interface AuthRequest extends Request {
    user?: UserDoc & { _id: any };
    sessionToken?: string;
}

/**
 * Pull the auth token from a request with a fixed precedence: Authorization: Bearer header, then the
 * `?token=` / `?apiKey=` query params (media players / playlist downloads can't set headers). Returns ''
 * when none is present. Shared by `authenticate` (the request gate) and the HLS proxy (which re-embeds the
 * token into the child URLs it rewrites, so every variant/segment hop stays authenticated).
 */
export function extractToken(req: Request): string {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
        return authHeader.substring(7).trim();
    }
    if (typeof req.query.token === 'string' && req.query.token.trim()) {
        return req.query.token.trim();
    }
    if (typeof req.query.apiKey === 'string' && req.query.apiKey.trim()) {
        return req.query.apiKey.trim();
    }
    return '';
}

/**
 * Resolve a raw token to its user with the two-source precedence `authenticate` uses: a stateful Web-UI
 * session first (TTL-checked), then a permanent `streamToken` (IPTV players / stream clients). Returns the
 * user plus whether it was via a session, or null when the token matches neither. Extracted so the same
 * lookup is reused by `authenticate` (the request gate) AND the resolve-seam authorize step — the stream
 * gate that runs in Node even after Rust owns the public socket (EDGE-3). `viaSession` lets a caller set
 * `req.sessionToken` only for the session case.
 */
export async function userFromToken(
    token: string,
): Promise<{ user: UserDoc & { _id: any }; viaSession: boolean } | null> {
    if (!token) return null;

    // Stateful Web UI session first
    const sessionDoc = await Session.findOne({ token }).lean();
    if (sessionDoc) {
        // Check if session has expired (TTL index runs periodically, so we do an explicit check as well)
        if (sessionDoc.expiresAt.getTime() > Date.now()) {
            const userDoc = await User.findById(sessionDoc.userId);
            if (userDoc) return { user: userDoc, viaSession: true };
        }
    }

    // Permanent streamToken (IPTV players / stream clients)
    const userDoc = await User.findOne({ streamToken: token, streamTokenEnabled: true });
    if (userDoc) return { user: userDoc, viaSession: false };

    return null;
}

export async function authenticate(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
    try {
        const token = extractToken(req);
        if (!token) {
            return next();
        }

        const found = await userFromToken(token);
        if (found) {
            req.user = found.user;
            if (found.viaSession) req.sessionToken = token;
        }

        next();
    } catch (err) {
        next(err);
    }
}

export function requireUser(req: AuthRequest, res: Response, next: NextFunction): void {
    if (!req.user) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    next();
}

export function requireAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
    if (!req.user) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    if (req.user.role !== 'admin') {
        res.status(403).json({ error: 'forbidden' });
        return;
    }
    next();
}
