import { Router } from 'express';
import { User, isValidUsername } from '../models/User.js';
import { Session } from '../models/Session.js';
import { hashPassword, generateToken, generateSlug } from '../security/crypto.js';
import { requireAdmin, type AuthRequest } from '../middleware/auth.js';
import { composeUserFiles, pruneUserFiles } from '../m3u/compose.js';
import { logger } from '../sources/core/logger.js';

export const usersRouter = Router();

usersRouter.use(requireAdmin);

// ── List All Users ──────────────────────────────────────────────────────────
usersRouter.get('/', async (_req, res, next) => {
    try {
        const list = await User.find({}, { passwordHash: 0 }).sort({ username: 1 }).lean();
        res.json(list);
    } catch (err) {
        next(err);
    }
});

// ── Create User ─────────────────────────────────────────────────────────────
usersRouter.post('/', async (req, res, next) => {
    try {
        const { username, password, role, allowedPlaylists, allowedCustomPlaylists } = req.body ?? {};

        if (typeof username !== 'string' || !username.trim()) {
            res.status(400).json({ error: 'username_required' });
            return;
        }
        if (typeof password !== 'string' || password.length < 6) {
            res.status(400).json({ error: 'password_min_length_6' });
            return;
        }
        if (role !== 'admin' && role !== 'user') {
            res.status(400).json({ error: 'invalid_role' });
            return;
        }

        const normalizedUsername = username.trim().toLowerCase();
        if (!isValidUsername(normalizedUsername)) {
            res.status(400).json({ error: 'username_invalid_chars' });
            return;
        }
        const existingUser = await User.findOne({ username: normalizedUsername });
        if (existingUser) {
            res.status(400).json({ error: 'username_already_exists' });
            return;
        }

        const passwordHash = await hashPassword(password);
        const streamToken = generateToken(16);

        const newUser = await User.create({
            username: normalizedUsername,
            passwordHash,
            role,
            streamToken,
            streamTokenEnabled: true,
            slug: generateSlug(),
            allowedPlaylists: Array.isArray(allowedPlaylists) ? allowedPlaylists : [],
            allowedCustomPlaylists: Array.isArray(allowedCustomPlaylists) ? allowedCustomPlaylists : [],
        });

        // Compose this new user's per-user playlist files for every playlist they can see. Best-effort —
        // a compose hiccup must not fail user creation (the next compose/cron backfills them).
        await composeUserFiles(newUser).catch((err) =>
            logger.error('users', `composeUserFiles (create) failed: ${(err as Error).message}`),
        );

        const userObj = newUser.toObject();
        delete (userObj as any).passwordHash;
        res.status(201).json(userObj);
    } catch (err) {
        next(err);
    }
});

// ── Update User ─────────────────────────────────────────────────────────────
usersRouter.put('/:id', async (req, res, next) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }

        const { username, password, role, allowedPlaylists, allowedCustomPlaylists, streamTokenEnabled } = req.body ?? {};

        // Capture the pre-update identity so we can prune the old-named per-user files after a rename.
        const oldUsername = user.username;
        const oldSlug = user.slug;

        if (typeof username === 'string' && username.trim()) {
            const normalizedUsername = username.trim().toLowerCase();
            if (normalizedUsername !== user.username) {
                if (!isValidUsername(normalizedUsername)) {
                    res.status(400).json({ error: 'username_invalid_chars' });
                    return;
                }
                const existingUser = await User.findOne({ username: normalizedUsername });
                if (existingUser) {
                    res.status(400).json({ error: 'username_already_exists' });
                    return;
                }
                user.username = normalizedUsername;
            }
        }

        if (typeof password === 'string' && password.trim()) {
            if (password.length < 6) {
                res.status(400).json({ error: 'password_min_length_6' });
                return;
            }
            user.passwordHash = await hashPassword(password);
        }

        if (role === 'admin' || role === 'user') {
            user.role = role;
        }

        if (Array.isArray(allowedPlaylists)) {
            user.allowedPlaylists = allowedPlaylists;
        }

        if (Array.isArray(allowedCustomPlaylists)) {
            user.allowedCustomPlaylists = allowedCustomPlaylists;
        }

        if (typeof streamTokenEnabled === 'boolean') {
            user.streamTokenEnabled = streamTokenEnabled;
        }

        await user.save();

        // Re-sync this user's per-user files. Rename → prune the old-named files first; then (re)compose
        // writes the current set and prunes any now-disallowed playlists. Best-effort (non-fatal).
        try {
            if (oldSlug && oldUsername !== user.username) {
                await pruneUserFiles(oldUsername, oldSlug);
            }
            await composeUserFiles(user);
        } catch (err) {
            logger.error('users', `re-compose (update) failed: ${(err as Error).message}`);
        }

        const userObj = user.toObject();
        delete (userObj as any).passwordHash;
        res.json(userObj);
    } catch (err) {
        next(err);
    }
});

// ── Delete User ─────────────────────────────────────────────────────────────
usersRouter.delete('/:id', async (req: AuthRequest, res, next) => {
    try {
        const targetId = req.params.id;

        // Prevent self-deletion
        if (req.user!._id.toString() === targetId) {
            res.status(400).json({ error: 'cannot_delete_self' });
            return;
        }

        const user = await User.findByIdAndDelete(targetId);
        if (!user) {
            res.status(404).json({ error: 'user_not_found' });
            return;
        }

        // Clean up all active Web UI sessions for this user
        await Session.deleteMany({ userId: targetId });

        // Remove this user's per-user playlist files across every playlist. Best-effort (non-fatal).
        if (user.slug) {
            await pruneUserFiles(user.username, user.slug).catch((err) =>
                logger.error('users', `pruneUserFiles (delete) failed: ${(err as Error).message}`),
            );
        }

        res.status(204).end();
    } catch (err) {
        next(err);
    }
});
