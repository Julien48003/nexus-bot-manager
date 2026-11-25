'use strict';
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/db');

// Pinned so a future token signed with `alg: none` or an asymmetric
// algorithm using the public key as the HMAC secret cannot be accepted.
const JWT_ALGORITHMS = ['HS256'];
const JWT_ISSUER   = 'nexus-bot-manager';
const JWT_AUDIENCE = 'nexus-bot-manager-api';

/** Verify options shared by the HTTP and Socket.IO paths. */
const verifyOptions = { algorithms: JWT_ALGORITHMS, issuer: JWT_ISSUER, audience: JWT_AUDIENCE };

/** Claims we sign. Everything else in a token is ignored. */
function signToken(user) {
  const crypto = require('crypto');
  return jwt.sign(
    {
      id:       user.id,
      username: user.username,
      role:     user.role,
      // AUTH-14: a unique token id makes every session individually
      // traceable and revocable, and pins issuer/audience.
      jti:       crypto.randomUUID(),
      tv:        user.token_version || 0
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '24h', algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE }
  );
}

/**
 * Shared post-verification check: the user must still exist, still carry
 * the role the token claims, and still hold the current token version.
 *
 * Before this, `role` and the session's validity were taken from the
 * token alone (AUTH-03 / AUTH-04): deleting or demoting a user, or
 * changing their password, had no effect until the 24h token expired.
 */
function resolveSession(payload) {
  if (!payload || typeof payload.id !== 'number') return null;
  const user = getDb().getUser(payload.id);
  if (!user) return null;
  if (user.username !== payload.username) return null;
  // Role comes from the database, never from the token.
  if (user.role !== payload.role) return null;
  // Revocation: users created before this hardening have no token_version.
  const currentTv = Number(user.token_version || 0);
  const tokenTv   = Number(payload.tv === undefined ? 0 : payload.tv);
  if (currentTv !== tokenTv) return null;
  // Per-token revocation (logout).
  if (getDb().isTokenRevoked(payload.jti)) return null;
  return user;
}

function unauthorized(res, message) {
  return res.status(401).json({ error: message });
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return unauthorized(res, 'Authentification requise');
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, verifyOptions);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return unauthorized(res, 'Session expirée, veuillez vous reconnecter');
    }
    return unauthorized(res, 'Token invalide');
  }

  const user = resolveSession(payload);
  if (!user) {
    // Same message as an invalid signature: do not tell an attacker
    // whether the token was cryptographically valid but revoked.
    return unauthorized(res, 'Token invalide ou session révoquée');
  }

  req.user = { id: user.id, username: user.username, role: user.role, jti: payload.jti, tv: user.token_version || 0, exp: payload.exp };
  req.dbUser = user;
  next();
}

/**
 * requireAdmin was previously dead code: it existed but was mounted on
 * no route, so every authenticated user reached every endpoint. It is
 * now mounted on every write / execute / update route.
 */
function requireAdmin(req, res, next) {
  // A router-level requireAdmin may already have resolved the session; do
  // not pay for a second DB lookup on per-route guards.
  if (req.user) {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Accès administrateur requis' });
    }
    return next();
  }
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Accès administrateur requis' });
    }
    next();
  });
}

module.exports = { requireAuth, requireAdmin, signToken, verifyOptions, resolveSession, JWT_ALGORITHMS };
