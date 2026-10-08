/**
 * /api/rooms — REST helpers around the room-code system.
 *
 * The live path is the WebSocket (`room:create`, `room:join`); these endpoints
 * exist so the UI can show "Room K7X4P — waiting for a guest" on a plain page
 * load, and so a joiner can validate a code before opening the socket flow.
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import config from '../config.js';
import { requireAuth, wrap } from '../middleware.js';
import { dbx } from '../db/index.js';

const r = Router();

/** Generates a code that cannot be confused with an existing open room. */
export async function createRoomCode() {
  const A = config.rooms.codeAlphabet;
  for (let attempt = 0; attempt < 25; attempt++) {
    let code = '';
    const bytes = crypto.randomBytes(config.rooms.codeLength);
    for (let i = 0; i < config.rooms.codeLength; i++) code += A[bytes[i] % A.length];
    const busy = await dbx.one('SELECT room_code FROM rooms WHERE room_code = ?', [code]);
    if (!busy) return code;
  }
  throw new Error('Could not allocate a room code');
}

r.get('/:code', requireAuth, wrap(async (req, res) => {
  const code = String(req.params.code || '').toUpperCase().trim();
  const room = await dbx.one(
    `SELECT r.*, h.username AS host_name, g.username AS guest_name
       FROM rooms r
       JOIN players h ON h.id = r.host_id
       LEFT JOIN players g ON g.id = r.guest_id
      WHERE r.room_code = ?`,
    [code],
  );
  if (!room) return res.status(404).json({ error: 'No room with that code.' });
  const expired = room.status === 'open' && Number(room.expires_at) < Date.now();
  res.json({
    room: {
      code: room.room_code,
      host: room.host_name,
      guest: room.guest_name,
      status: expired ? 'expired' : room.status,
      isYou: room.host_id === req.player.id,
      isGuest: room.guest_id === req.player.id,
      canJoin: room.status === 'open' && !expired && room.host_id !== req.player.id,
      expiresAt: Number(room.expires_at),
    },
  });
}));

export default r;
