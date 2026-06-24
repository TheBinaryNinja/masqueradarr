import { Schema, model, type Types } from 'mongoose';

export interface SessionDoc {
    token: string;
    userId: Types.ObjectId;
    expiresAt: Date;
    createdAt: Date;
}

const SessionSchema = new Schema<SessionDoc>(
    {
        token: { type: String, required: true, unique: true, index: true },
        userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        expiresAt: { type: Date, required: true },
        createdAt: { type: Date, default: Date.now },
    },
    {
        versionKey: false,
    },
);

// TTL index to automatically remove expired session documents
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = model<SessionDoc>('Session', SessionSchema);
