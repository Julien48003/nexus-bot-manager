'use strict';
/**
 * Shared validation and serialization for user accounts.
 *
 * Accounts are deliberately small: a login name, a display name, an
 * optional avatar (data URL kept in the JSON database), a role and, for
 * regular users, the explicit list of bots they may manage.
 */

const MAX_DISPLAY_NAME = 80;
const MAX_AVATAR_LENGTH = 750000;

function normalizeDisplayName(value) {
  const clean = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!clean || clean.length > MAX_DISPLAY_NAME) return null;
  return clean;
}

function normalizeAvatar(value) {
  if (value === null || value === undefined || value === '') return { value: null };
  if (typeof value !== 'string') return { invalid: true };
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value)) {
    return { invalid: true };
  }
  if (value.length > MAX_AVATAR_LENGTH) return { invalid: true };
  return { value };
}

function normalizeAllowedBots(value, db) {
  if (value === undefined) return { value: undefined };
  if (!Array.isArray(value) || value.length > 500) return { invalid: true };
  const unique = [];
  for (const raw of value) {
    const name = String(raw || '').trim();
    if (!name || !db.getBot(name)) return { invalid: true };
    if (!unique.includes(name)) unique.push(name);
  }
  return { value: unique };
}

/** Never expose the password hash, token version or other internals. */
function publicUser(user) {
  if (!user) return null;
  return {
    id:           user.id,
    username:     user.username,
    role:         user.role,
    display_name: user.display_name || user.username,
    avatar:       user.avatar || null,
    allowed_bots: Array.isArray(user.allowed_bots) ? [...user.allowed_bots] : [],
    language:     user.language || 'en',
    created_at:   user.created_at || null,
    last_login:   user.last_login || null
  };
}

/** Admin sees every bot; a regular user only sees its explicit allowlist. */
function canAccessBot(user, botName) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role !== 'user') return false;
  return Array.isArray(user.allowed_bots) && user.allowed_bots.includes(botName);
}

module.exports = {
  MAX_DISPLAY_NAME,
  MAX_AVATAR_LENGTH,
  normalizeDisplayName,
  normalizeAvatar,
  normalizeAllowedBots,
  publicUser,
  canAccessBot
};
