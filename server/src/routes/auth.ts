import { Router } from 'express';
import { User, isValidUsername } from '../models/User.js';
import { Session } from '../models/Session.js';
import { hashPassword, verifyPassword, generateToken, generateSlug } from '../security/crypto.js';
import { requireUser, type AuthRequest } from '../middleware/auth.js';
import { composeUserFiles } from '../m3u/compose.js';
import { logger } from '../sources/core/logger.js';

export const authRouter = Router();

// ── Setup Check ─────────────────────────────────────────────────────────────
authRouter.get('/setup-status', async (_req, res, next) => {
    try {
        const count = await User.countDocuments();
        res.json({ needsSetup: count === 0 });
    } catch (err) {
        next(err);
    }
});

// ── Initial Setup ───────────────────────────────────────────────────────────
authRouter.post('/setup', async (req, res, next) => {
    try {
        const count = await User.countDocuments();
        if (count > 0) {
            res.status(403).json({ error: 'setup_already_completed' });
            return;
        }

        const { username, password } = req.body ?? {};
        if (typeof username !== 'string' || !username.trim()) {
            res.status(400).json({ error: 'username_required' });
            return;
        }
        if (typeof password !== 'string' || password.length < 6) {
            res.status(400).json({ error: 'password_min_length_6' });
            return;
        }

        const trimmedUser = username.trim().toLowerCase();
        if (!isValidUsername(trimmedUser)) {
            res.status(400).json({ error: 'username_invalid_chars' });
            return;
        }
        const passwordHash = await hashPassword(password);
        const streamToken = generateToken(16); // 32-character hex token

        const admin = await User.create({
            username: trimmedUser,
            passwordHash,
            role: 'admin',
            streamToken,
            streamTokenEnabled: true,
            slug: generateSlug(),
            allowedPlaylists: [],
            allowedCustomPlaylists: [],
        });

        // Auto-login the new admin
        const sessionToken = generateToken(32); // 64-character hex token
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await Session.create({
            token: sessionToken,
            userId: admin._id,
            expiresAt,
        });

        // Compose the admin's per-user playlist files now so their "Copy Playlist URL" resolves immediately
        // (header-only until the first sync populates channels). Best-effort — must not fail setup.
        await composeUserFiles(admin).catch((err) =>
            logger.error('auth', `composeUserFiles (setup) failed: ${(err as Error).message}`),
        );

        logger.info('auth', `initial admin created: ${admin.username}`);
        res.status(201).json({
            token: sessionToken,
            user: {
                username: admin.username,
                role: admin.role,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── User Login ──────────────────────────────────────────────────────────────
authRouter.post('/login', async (req, res, next) => {
    try {
        const { username, password } = req.body ?? {};
        if (typeof username !== 'string' || typeof password !== 'string') {
            res.status(400).json({ error: 'credentials_required' });
            return;
        }

        const user = await User.findOne({ username: username.trim().toLowerCase() });
        if (!user || !(await verifyPassword(password, user.passwordHash))) {
            logger.warn('auth', `failed login for "${username.trim().toLowerCase()}"`);
            res.status(401).json({ error: 'invalid_credentials' });
            return;
        }

        // Create browser session
        const sessionToken = generateToken(32);
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await Session.create({
            token: sessionToken,
            userId: user._id,
            expiresAt,
        });

        logger.info('auth', `login ok: ${user.username}`);
        res.json({
            token: sessionToken,
            user: {
                username: user.username,
                role: user.role,
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── User Logout ─────────────────────────────────────────────────────────────
authRouter.post('/logout', requireUser, async (req: AuthRequest, res, next) => {
    try {
        const token = req.sessionToken;
        if (token) {
            await Session.deleteOne({ token });
        }
        res.status(204).end();
    } catch (err) {
        next(err);
    }
});

// ── Profile / Verification ──────────────────────────────────────────────────
authRouter.get('/me', requireUser, (req: AuthRequest, res) => {
    const u = req.user!;
    res.json({
        username: u.username,
        role: u.role,
        streamToken: u.streamToken,
        streamTokenEnabled: u.streamTokenEnabled,
        slug: u.slug,
        allowedPlaylists: u.allowedPlaylists,
        allowedCustomPlaylists: u.allowedCustomPlaylists,
    });
});

// ── Regenerate streamToken ──────────────────────────────────────────────────
authRouter.post('/regenerate-token', requireUser, async (req: AuthRequest, res, next) => {
    try {
        const user = await User.findById(req.user!._id);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }

        const newToken = generateToken(16);
        user.streamToken = newToken;
        await user.save();

        // Rewrite this user's per-user playlist files with the new token (filename/slug unchanged, so their
        // saved playlist URL stays valid). Best-effort — token rotation must not fail on a compose hiccup.
        await composeUserFiles(user).catch((err) =>
            logger.error('auth', `composeUserFiles (regenerate-token) failed: ${(err as Error).message}`),
        );

        res.json({ streamToken: newToken });
    } catch (err) {
        next(err);
    }
});
