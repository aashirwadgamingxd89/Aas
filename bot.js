'use strict';

/* ------------------------------------------------------------------------------------------
 * 0. NETWORK PRE-FLIGHT  (kills the classic voice "UDP / IP discovery" errors)
 *
 *    Discord's voice gateway returns an endpoint whose DNS name usually has both A and AAAA
 *    records. Node prefers IPv6 by default; on hosts / containers / VPSs without working
 *    IPv6 the UDP handshake then never completes and @discordjs/voice reports things like:
 *
 *        Error: Cannot perform IP discovery - socket closed
 *        Error: Socket timeout
 *        AbortError: The operation was aborted
 *        (and finally) "Could not establish the voice connection (timeout)"
 *
 *    Forcing IPv4 for DNS lookups fixes the gateway, the voice WebSocket and the UDP socket
 *    in one go. Set VOICE_IPV4=0 in .env if you really are on an IPv6-only host.
 * ---------------------------------------------------------------------------------------- */
if (String(process.env.VOICE_IPV4 || 'on').toLowerCase() !== 'off') {
  try {
    require('dns').setDefaultResultOrder('ipv4first');
  } catch (_) {
    /* Node < 14.18 / 16.4 — the API does not exist, nothing to do */
  }
}

/* ============================================================================================
 *  ULTIMATE ALL-IN-ONE DISCORD BOT  —  single file (bot.js)
 *  ------------------------------------------------------------------------------------------
 *  discord.js v14 + sqlite3
 *
 *  FEATURES
 *   • Live animated status bar for every command (spinner + 10 block bar)
 *   • Anti-nuke (audit-log based, counters, whitelist, ban/kick/strip/**timeout**)
 *   • Anti-spam (flood / duplicate / mass mention / invites / link spam) + user/role whitelist
 *   • Owner omnipotence (main owner + granted users bypass every permission check)
 *   • Music (yt-dlp + ffmpeg + @discordjs/voice, DAVE-ready, self-healing voice/UDP)
 *   • Blocked words (whole word, spoiler DM list)
 *   • Custom commands with variables + auto-replies
 *   • Moderation: kick / ban / unban / timeout / untimeout / purge + mod log
 *   • Warnings with automatic punishments
 *   • AFK, auto-role, role add/remove
 *   • Welcome system (banner, thumbnail, colors, ping, variables)
 *   • Professional ticket system (multi type, menu/buttons, transcript, claim)
 *   • Giveaways (buttons, animated emoji, banners, scheduler, persisting restarts)
 *   • Announcements (plain text, no embeds)
 *
 *  RUN:   npm i discord.js sqlite3
 *         DISCORD_TOKEN=xxxx node bot.js
 * ========================================================================================== */

const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
  AuditLogEvent,
} = require('discord.js');

/* ------------------------------------------------------------------------------------------
 * 0a. .env LOADER  (zero dependency — plain `node bot.js` works, no --env-file needed)
 *     Looks for, in order: $ENV_FILE, ./.env next to bot.js, ./.env in the current directory.
 *     Real environment variables always win over the file.
 * ---------------------------------------------------------------------------------------- */

/**
 * Minimal but tolerant .env parser.
 * Handles: BOM, CRLF, `export KEY=value`, `KEY = value`, quotes ("…" / '…'),
 * multi-line quoted values, inline `# comments`, \n / \t / \" / \\ escapes.
 */
function parseEnvFile(text) {
  const out = {};
  const lines = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;

    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;

    const key = m[1];
    let value = m[2];

    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      let rest = value.slice(1);
      // multi-line quoted value: keep reading until the closing quote appears
      while (!rest.includes(quote) && i + 1 < lines.length) {
        i += 1;
        rest += `\n${lines[i]}`;
      }
      const end = rest.lastIndexOf(quote);
      value = end >= 0 ? rest.slice(0, end) : rest;
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      value = value.replace(/\s+#.*$/, '').trim(); // strip inline comment
    }

    out[key] = value;
  }
  return out;
}

/** Files we actually loaded — used by the startup diagnostics below. */
const loadedEnvFiles = [];

function loadEnv() {
  const candidates = [
    process.env.ENV_FILE,
    path.join(__dirname, '.env'),
    path.join(process.cwd(), '.env'),
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    const abs = path.resolve(__dirname, candidate);
    if (seen.has(abs) || !fs.existsSync(abs)) continue;
    seen.add(abs);

    try {
      const parsed = parseEnvFile(fs.readFileSync(abs, 'utf8'));
      let applied = 0;
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
          applied += 1;
        }
      }
      loadedEnvFiles.push(abs);
      if (applied) console.log(`[ENV] loaded ${applied} variable(s) from ${abs}`);
    } catch (err) {
      console.warn(`[ENV] could not read ${abs}: ${err.message}`);
    }
  }
}

loadEnv();

// Friendly aliases so a slightly different name in .env still works.
if (!process.env.DISCORD_TOKEN) {
  const alias = process.env.BOT_TOKEN || process.env.TOKEN || process.env.DISCORD_BOT_TOKEN;
  if (alias) {
    process.env.DISCORD_TOKEN = alias;
    console.warn('[ENV] DISCORD_TOKEN was not set — falling back to BOT_TOKEN/TOKEN/DISCORD_BOT_TOKEN.');
  }
}


/* ------------------------------------------------------------------------------------------
 * 0b. DATABASE DRIVER  (sqlite3 package, with a built-in fallback on Node >= 22.5)
 *     The native `sqlite3` package needs its install script (node-gyp/prebuild) to run.
 *     If that was blocked (e.g. npm `allow-scripts`), or no prebuilt binary exists for your
 *     platform, we transparently fall back to Node's own `node:sqlite` module.
 *
 *     DB_DRIVER=auto   -> sqlite3 first, node:sqlite as fallback   (default)
 *     DB_DRIVER=sqlite3 -> require the sqlite3 package (fail loudly if missing)
 *     DB_DRIVER=node    -> use node:sqlite only (zero native dependencies, Node >= 22.5)
 * ---------------------------------------------------------------------------------------- */

/** Adapter that exposes the tiny slice of the `sqlite3` API this bot uses on top of node:sqlite. */
function createNodeSqliteDriver() {
  const { DatabaseSync } = require('node:sqlite');

  class NodeSqliteDatabase {
    constructor(filename) {
      this.filename = filename;
      this.db = new DatabaseSync(filename);
      this.closed = false;
      try {
        this.db.exec('PRAGMA busy_timeout = 5000;');
      } catch (_) {
        /* not fatal */
      }
    }

    /** sqlite3 configure() is a no-op here — PRAGMAs are applied in the constructor. */
    configure() {}

    run(sql, params = [], cb) {
      try {
        const info = this.db.prepare(sql).run(...params);
        const result = { lastID: Number(info.lastInsertRowid), changes: Number(info.changes) };
        if (typeof cb === 'function') cb.call(result, null);
        return this;
      } catch (err) {
        if (typeof cb === 'function') return cb.call({}, err);
        throw err;
      }
    }

    get(sql, params = [], cb) {
      try {
        const row = this.db.prepare(sql).get(...params);
        cb(null, row);
      } catch (err) {
        cb(err);
      }
    }

    all(sql, params = [], cb) {
      try {
        const rows = this.db.prepare(sql).all(...params);
        cb(null, rows);
      } catch (err) {
        cb(err);
      }
    }

    close(cb) {
      try {
        if (!this.closed) {
          this.db.close();
          this.closed = true;
        }
        if (typeof cb === 'function') cb(null);
      } catch (err) {
        if (typeof cb === 'function') cb(err);
      }
    }
  }

  return { Database: NodeSqliteDatabase };
}

/** Picks a driver; prints a single, actionable line about what was chosen. */
function selectDatabaseDriver() {
  const mode = (process.env.DB_DRIVER || 'auto').toLowerCase();
  const problems = [];

  const trySqlite3 = () => {
    try {
      const mod = require('sqlite3');
      return { driver: mod, name: 'sqlite3 (native)' };
    } catch (err) {
      problems.push(`sqlite3 package: ${String(err.message).split('\n')[0]}`);
      return null;
    }
  };

  const tryNode = () => {
    try {
      const nodeVer = process.versions.node;
      const [maj, min] = nodeVer.split('.').map(Number);
      if (maj < 22 || (maj === 22 && min < 5)) {
        problems.push(`node:sqlite needs Node >= 22.5 (you have ${nodeVer})`);
        return null;
      }
      const driver = createNodeSqliteDriver();
      require('node:sqlite'); // touch it so a broken build errors here, not later
      return { driver, name: `node:sqlite (built in, Node ${nodeVer})` };
    } catch (err) {
      problems.push(`node:sqlite: ${String(err.message).split('\n')[0]}`);
      return null;
    }
  };

  if (mode === 'node') {
    const node = tryNode();
    if (node) return { ...node, mode };
  } else if (mode === 'sqlite3') {
    const native = trySqlite3();
    if (native) return { ...native, mode };
  } else {
    const native = trySqlite3();
    if (native) return { ...native, mode };
    const node = tryNode();
    if (node) {
      console.warn('[DB] sqlite3 is not available on this machine — using the built-in node:sqlite driver instead.');
      return { ...node, mode };
    }
  }

  console.error('');
  console.error('[FATAL] No usable SQLite driver.');
  for (const problem of problems) console.error(`        • ${problem}`);
  console.error('');
  console.error('  Fix one of these:');
  console.error('    1. Allow the sqlite3 install script, then rebuild it:');
  console.error('         npm approve-scripts sqlite3        # npm >= 11.5 with script sandbox');
  console.error('         npm rebuild sqlite3 --foreground-scripts');
  console.error('    2. Or build it from source (needs python3, make, g++):');
  console.error('         npm install sqlite3 --build-from-source --foreground-scripts');
  console.error('    3. Or run on Node >= 22.5 and skip native modules entirely:');
  console.error('         DB_DRIVER=node node bot.js');
  console.error('');
  process.exit(1);
}

const { driver: sqlite3, name: DRIVER_NAME, mode: DRIVER_MODE } = selectDatabaseDriver();
console.log(`[DB] driver: ${DRIVER_NAME}`);

/* ------------------------------------------------------------------------------------------
 * 0. CONFIG
 * ---------------------------------------------------------------------------------------- */

const TOKEN = process.env.DISCORD_TOKEN;
// Relative DB_FILE values resolve next to bot.js so `npm start` and cron jobs agree.
const DB_FILE = process.env.DB_FILE
  ? path.resolve(__dirname, process.env.DB_FILE)
  : path.join(__dirname, 'bot.db');
const DEFAULT_PREFIX = '!';
const EPHEMERAL = (MessageFlags && MessageFlags.Ephemeral) || 64;

/** Consistent palette used by every embed in the bot. */
const COLORS = {
  main: 0x5865f2,
  success: 0x57f287,
  error: 0xed4245,
  warn: 0xfee75c,
  mod: 0xeb459e,
  info: 0x00b0f4,
  ticket: 0x2ecc71,
  giveaway: 0xff73fa,
  welcome: 0xf1c40f,
};

/* ------------------------------------------------------------------------------------------
 * 1. DATABASE LAYER  (sqlite3, promisified)
 * ---------------------------------------------------------------------------------------- */

const db = new sqlite3.Database(DB_FILE);
db.configure('busyTimeout', 5000);

/** run() -> resolves sqlite statement (has .lastID / .changes) */
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onDone(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
/** get() -> resolves a single row or undefined */
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
/** all() -> resolves an array of rows */
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

/** Schema. Every table is created on startup (safe for existing databases). */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
     guild_id       TEXT PRIMARY KEY,
     prefix         TEXT    DEFAULT '!',
     antispam       INTEGER DEFAULT 1,
     antinuke       INTEGER DEFAULT 0,
     nuke_limit     INTEGER DEFAULT 3,
     nuke_punish    TEXT    DEFAULT 'ban',
     nuke_timeout   INTEGER DEFAULT 60,
     autorole       TEXT,
     logchannel     TEXT,
     statusbar      INTEGER DEFAULT 1,
     warn_timeout_at INTEGER DEFAULT 3,
     warn_kick_at    INTEGER DEFAULT 5
   )`,
  `CREATE TABLE IF NOT EXISTS blockwords (guild_id TEXT, word TEXT, PRIMARY KEY (guild_id, word))`,
  `CREATE TABLE IF NOT EXISTS custom_commands (
     guild_id TEXT, name TEXT, response TEXT, created_by TEXT,
     PRIMARY KEY (guild_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS autoreplies (
     guild_id TEXT, trigger TEXT, response TEXT,
     PRIMARY KEY (guild_id, trigger)
   )`,
  `CREATE TABLE IF NOT EXISTS afk (
     guild_id TEXT, user_id TEXT, reason TEXT, since INTEGER,
     PRIMARY KEY (guild_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS warnings (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT, user_id TEXT, mod_id TEXT, reason TEXT, created_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS nuke_whitelist (
     guild_id TEXT, user_id TEXT,
     PRIMARY KEY (guild_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS spam_whitelist (
     guild_id TEXT, target_id TEXT, kind TEXT DEFAULT 'user', added_by TEXT, added_at INTEGER,
     PRIMARY KEY (guild_id, target_id)
   )`,
  `CREATE TABLE IF NOT EXISTS welcome (
     guild_id TEXT PRIMARY KEY,
     channel TEXT, title TEXT, message TEXT, footer TEXT,
     banner TEXT, color INTEGER, thumbnail INTEGER DEFAULT 1,
     ping INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS ticket_config (
     guild_id TEXT PRIMARY KEY,
     category TEXT, logchannel TEXT, support_role TEXT, max_open INTEGER DEFAULT 3,
     title TEXT, description TEXT, footer TEXT, welcome_msg TEXT,
     banner TEXT, color INTEGER, style TEXT DEFAULT 'menu'
   )`,
  `CREATE TABLE IF NOT EXISTS ticket_types (
     guild_id TEXT, key TEXT, emoji TEXT, label TEXT, description TEXT,
     PRIMARY KEY (guild_id, key)
   )`,
  `CREATE TABLE IF NOT EXISTS tickets (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT, channel_id TEXT, user_id TEXT, type TEXT,
     claimed_by TEXT, status TEXT DEFAULT 'open', created_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS giveaway_config (
     guild_id TEXT PRIMARY KEY,
     emoji TEXT, banner TEXT, color INTEGER, title TEXT, footer TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS giveaways (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     guild_id TEXT, channel_id TEXT, message_id TEXT, prize TEXT,
     winners INTEGER, host_id TEXT, ends_at INTEGER, ended INTEGER DEFAULT 0,
     role_required TEXT, banner TEXT, emoji TEXT, color INTEGER,
     title TEXT, footer TEXT, created_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS giveaway_entries (
     giveaway_id INTEGER, user_id TEXT, created_at INTEGER,
     PRIMARY KEY (giveaway_id, user_id)
   )`,

  /* ---- extended features ---- */
  `CREATE TABLE IF NOT EXISTS antispam_config (
     guild_id TEXT PRIMARY KEY,
     flood_count INTEGER DEFAULT 5, flood_window INTEGER DEFAULT 5,
     dup_count INTEGER DEFAULT 3, dup_window INTEGER DEFAULT 10,
     mention_count INTEGER DEFAULT 5, link_count INTEGER DEFAULT 4,
     invite_block INTEGER DEFAULT 1, timeout_secs INTEGER DEFAULT 300,
     enabled INTEGER DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS invite_joins (
     guild_id TEXT, member_id TEXT, inviter_id TEXT,
     PRIMARY KEY (guild_id, member_id)
   )`,
  `CREATE TABLE IF NOT EXISTS invites (
     guild_id TEXT, user_id TEXT, joins INTEGER DEFAULT 0, leaves INTEGER DEFAULT 0,
     PRIMARY KEY (guild_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS verify_config (
     guild_id TEXT PRIMARY KEY,
     title TEXT, message TEXT, button TEXT, emoji TEXT,
     color INTEGER, role TEXT, channel TEXT, logchannel TEXT,
     banner TEXT, enabled INTEGER DEFAULT 1
   )`,
  `CREATE TABLE IF NOT EXISTS bot_access (
     guild_id TEXT, user_id TEXT, granted_by TEXT, granted_at INTEGER,
     PRIMARY KEY (guild_id, user_id)
   )`,
  `CREATE TABLE IF NOT EXISTS main_owner (guild_id TEXT PRIMARY KEY, user_id TEXT)`,
  `CREATE TABLE IF NOT EXISTS dm_config (
     guild_id TEXT PRIMARY KEY, enabled INTEGER DEFAULT 0, channel TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS locked_channels (
     guild_id TEXT, channel_id TEXT, prev TEXT,
     PRIMARY KEY (guild_id, channel_id)
   )`,
  `CREATE TABLE IF NOT EXISTS antinuke_rules (
     guild_id TEXT, action TEXT, threshold INTEGER, window_ms INTEGER,
     PRIMARY KEY (guild_id, action)
   )`,
  `CREATE TABLE IF NOT EXISTS antinuke_filters (
     guild_id TEXT, word TEXT,
     PRIMARY KEY (guild_id, word)
   )`,
  `CREATE TABLE IF NOT EXISTS music_settings (
     guild_id TEXT PRIMARY KEY,
     dj_role TEXT, max_queue INTEGER DEFAULT 300, default_volume INTEGER DEFAULT 80,
     announce INTEGER DEFAULT 1, stay INTEGER DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS music_favorites (
     guild_id TEXT, user_id TEXT, name TEXT, url TEXT, title TEXT, duration INTEGER, created_at INTEGER,
     PRIMARY KEY (guild_id, user_id, name)
   )`,
  `CREATE TABLE IF NOT EXISTS antinuke_detect (
     guild_id TEXT, method TEXT, enabled INTEGER DEFAULT 1,
     PRIMARY KEY (guild_id, method)
   )`,
];

/**
 * Safe migration: adds a column only when it does not exist yet.
 * Errors (duplicate column) are swallowed on purpose.
 */
async function addColumn(table, definition) {
  try {
    await dbRun(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  } catch (_) {
    /* column already exists — expected on every start after the first */
  }
}

async function initDb() {
  for (const sql of SCHEMA) await dbRun(sql);

  // Safe ALTER migrations for databases created by older versions.
  await addColumn('settings', 'statusbar INTEGER DEFAULT 1');
  await addColumn('settings', 'antinuke INTEGER DEFAULT 0');
  await addColumn('settings', 'nuke_limit INTEGER DEFAULT 3');
  await addColumn('settings', 'nuke_punish TEXT DEFAULT "ban"');
  await addColumn('settings', 'nuke_timeout INTEGER DEFAULT 60');
  await addColumn('settings', 'warn_timeout_at INTEGER DEFAULT 3');
  await addColumn('settings', 'warn_kick_at INTEGER DEFAULT 5');
  await addColumn('welcome', 'thumbnail INTEGER DEFAULT 1');
  await addColumn('welcome', 'ping INTEGER DEFAULT 1');
  await addColumn('ticket_config', 'description TEXT');
  await addColumn('ticket_config', 'style TEXT DEFAULT "menu"');
  await addColumn('ticket_config', 'banner TEXT');
  await addColumn('giveaways', 'role_required TEXT');
  await addColumn('giveaways', 'emoji TEXT');
  await addColumn('settings', 'admin_only INTEGER DEFAULT 1');
  await addColumn('antispam_config', 'invite_block INTEGER DEFAULT 1');
  await addColumn('antispam_config', 'timeout_secs INTEGER DEFAULT 300');
  await addColumn('verify_config', 'logchannel TEXT');
  await addColumn('verify_config', 'banner TEXT');
  console.log('[DB] ready ->', DB_FILE);
}

/* ------------------------------------------------------------------------------------------
 * 2. LOGGING / GLOBAL ERROR HANDLING
 * ---------------------------------------------------------------------------------------- */

function logError(scope, err) {
  console.error(`[ERROR][${scope}]`, err && err.stack ? err.stack : err);
}

process.on('unhandledRejection', (reason) => logError('unhandledRejection', reason));
process.on('uncaughtException', (err) => logError('uncaughtException', err));

/* ------------------------------------------------------------------------------------------
 * 3. SMALL UTILITIES (validation, parsing, formatting)
 * ---------------------------------------------------------------------------------------- */

/** Escapes a string so it can be used inside a RegExp. */
const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Truncates to `max` characters (embed safety). */
const truncate = (str, max = 1024) => {
  const s = String(str == null ? '' : str);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** "<@123>", "<@!123>", "<@&123>", "<#123>", "123" -> "123" (null when invalid) */
function parseId(input) {
  if (!input) return null;
  const m = String(input).match(/^(?:<@!?|<@&|<#|#)?(\d{15,25})>?$/);
  return m ? m[1] : null;
}

/** Accepts only http(s) URLs. */
function isHttpUrl(input) {
  if (typeof input !== 'string') return false;
  if (!/^https?:\/\/\S+$/i.test(input.trim())) return false;
  try {
    const u = new URL(input.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** "#5865F2" / "5865F2" / "0x5865F2" -> 0x5865F2 | null */
function parseHexColor(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^#?([0-9a-f]{6})$/i);
  if (!m) return null;
  return parseInt(m[1], 16);
}

/** "10m", "1h30m", "2d", "45s" -> milliseconds | null (max 28d handled by caller) */
function parseDuration(input) {
  if (!input) return null;
  const str = String(input).trim().toLowerCase();
  if (/^\d+$/.test(str)) return parseInt(str, 10) * 1000; // bare number = seconds
  const re = /(\d+)\s*(d|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(str))) {
    matched = true;
    const n = parseInt(m[1], 10);
    total += n * { d: 86400000, h: 3600000, m: 60000, s: 1000 }[m[2]];
  }
  if (!matched) return null;
  return total || null;
}

/** Human readable duration: "1h 30m" */
function humanDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const parts = [];
  const units = [
    ['d', 86400000],
    ['h', 3600000],
    ['m', 60000],
    ['s', 1000],
  ];
  let rest = ms;
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    if (n) {
      parts.push(`${n}${label}`);
      rest -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ') || '0s';
}

/** Tokenizer that keeps quoted strings together: `a "b c" 'd e'` -> [a, b c, d e] */
function tokenize(input) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(input || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Extracts `--flag=value`, `--flag "value"` and bare `--flag` style options from raw text.
 * Only known keys are consumed, so message text is never eaten by accident.
 * Returns { flags, text } where text is the remaining raw text (newlines preserved).
 */
function extractFlags(raw, valueKeys = [], bareKeys = []) {
  let text = String(raw || '');
  const flags = {};

  for (const key of valueKeys) {
    const withEquals = new RegExp(`--${key}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s]+)`, 'i');
    let m = text.match(withEquals);
    if (m) {
      flags[key] = m[1].replace(/^["']|["']$/g, '');
      text = text.replace(withEquals, ' ');
      continue;
    }
    const withSpace = new RegExp(`--${key}\\s+("[^"]*"|'[^']*'|[^\\s]+)`, 'i');
    m = text.match(withSpace);
    if (m) {
      flags[key] = m[1].replace(/^["']|["']$/g, '');
      text = text.replace(withSpace, ' ');
    }
  }

  for (const key of bareKeys) {
    const re = new RegExp(`--${key}\\b`, 'i');
    if (re.test(text)) {
      flags[key] = true;
      text = text.replace(re, ' ');
    }
  }

  return { flags, text: text.replace(/[ \t]{2,}/g, ' ').trim() };
}

/**
 * Parses an emoji: unicode ("🎉") or custom/animated ("<:name:id>", "<a:name:id>").
 * Returns null when invalid.
 */
function parseEmoji(input) {
  if (!input) return null;
  const str = String(input).trim();
  const custom = str.match(/^<(a?):([a-zA-Z0-9_~]{2,32}):(\d{15,25})>$/);
  if (custom) return { animated: custom[1] === 'a', name: custom[2], id: custom[3] };
  // simple unicode check (single grapheme / emoji sequence, no plain words)
  if (/^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\u20e3]{1,12}$/u.test(str) && !/^[a-z0-9]+$/i.test(str)) {
    return str;
  }
  return null;
}

/** Emoji -> string used inside message content. */
function emojiToString(emoji) {
  if (!emoji) return '';
  if (typeof emoji === 'string') return emoji;
  return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

/** Emoji -> value accepted by setEmoji() */
function emojiForButton(emoji) {
  if (!emoji) return undefined;
  if (typeof emoji === 'string') return emoji;
  return { id: emoji.id, name: emoji.name, animated: !!emoji.animated };
}

/** Replaces the template variables used by custom commands / welcome / tickets. */
function applyTemplate(text, ctx = {}) {
  if (!text) return '';
  const { user, guild, channel } = ctx;
  return String(text)
    .replace(/\{user\}/g, user ? `<@${user.id}>` : '')
    .replace(/\{username\}/g, user ? user.username : '')
    .replace(/\{tag\}/g, user ? (user.tag || user.username) : '')
    .replace(/\{server\}/g, guild ? guild.name : '')
    .replace(/\{members\}/g, guild ? String(guild.memberCount) : '')
    .replace(/\{channel\}/g, channel ? `<#${channel.id}>` : '')
    .replace(/\\n/g, '\n');
}

/** Fetch a member from mention/ID (never throws). */
async function resolveMember(message, input) {
  const id = parseId(input);
  if (!id) return null;
  return message.guild.members.fetch(id).catch(() => null);
}

/** Fetch a user (works for users that left the guild). */
async function resolveUser(message, input) {
  const id = parseId(input);
  if (!id) return null;
  const users = (message.client && message.client.users) || client.users;
  return users.fetch(id).catch(() => null);
}

/** True when `mod` sits above `target` in the role hierarchy (and bot sits above target). */
function canActOn(guild, modMember, targetMember) {
  const me = guild.members.me;
  if (!targetMember) return false;
  if (targetMember.id === guild.ownerId) return false;
  if (targetMember.id === me.id) return false;
  if (modMember && modMember.id !== guild.ownerId && !actorPrivileged(modMember)) {
    if (modMember.roles.highest.position <= targetMember.roles.highest.position) return false;
  }
  if (me.roles.highest.position <= targetMember.roles.highest.position) return false;
  return true;
}

/* ------------------------------------------------------------------------------------------
 * 4. EMBED HELPERS
 * ---------------------------------------------------------------------------------------- */

function baseEmbed(color = COLORS.main, title, description) {
  const e = new EmbedBuilder().setColor(color).setTimestamp();
  if (title) e.setTitle(truncate(title, 256));
  if (description) e.setDescription(truncate(description, 4096));
  return e;
}
const okEmbed = (title, desc) => baseEmbed(COLORS.success, title, desc);
const errEmbed = (title, desc) => baseEmbed(COLORS.error, title, desc);
const warnEmbed = (title, desc) => baseEmbed(COLORS.warn, title, desc);
const infoEmbed = (title, desc) => baseEmbed(COLORS.info, title, desc);

/** Reply helper — never throws, never pings. */
async function reply(msg, embed, extra = {}) {
  return msg
    .reply({ embeds: Array.isArray(embed) ? embed : [embed], allowedMentions: { parse: [] }, ...extra })
    .catch(() => null);
}

/** Sends a message that deletes itself after `ms`. */
async function sendTemp(channel, payload, ms = 8000) {
  try {
    const m = await channel.send(payload);
    if (ms > 0) {
      const t = setTimeout(() => m.delete().catch(() => {}), ms);
      if (t.unref) t.unref();
    }
    return m;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------------------------
 * 5. PER-GUILD SETTINGS CACHE
 * ---------------------------------------------------------------------------------------- */

const settingsCache = new Map();
const SETTING_COLUMNS = new Set([
  'prefix',
  'antispam',
  'antinuke',
  'nuke_limit',
  'nuke_punish',
  'nuke_timeout',
  'autorole',
  'logchannel',
  'statusbar',
  'warn_timeout_at',
  'warn_kick_at',
  'admin_only',
]);

function normalizeSettings(row, guildId) {
  return {
    guild_id: guildId,
    prefix: row.prefix || DEFAULT_PREFIX,
    antispam: row.antispam === 1 || row.antispam === true,
    antinuke: row.antinuke === 1 || row.antinuke === true,
    nuke_limit: Number(row.nuke_limit) || 3,
    nuke_punish: row.nuke_punish || 'ban',
    nuke_timeout: (() => {
      const n = Number(row.nuke_timeout);
      return Number.isFinite(n) && n > 0 ? Math.min(40320, Math.floor(n)) : 60;
    })(),
    autorole: row.autorole || null,
    logchannel: row.logchannel || null,
    statusbar: row.statusbar === undefined || row.statusbar === null ? true : row.statusbar === 1,
    warn_timeout_at: row.warn_timeout_at === null || row.warn_timeout_at === undefined ? 3 : Number(row.warn_timeout_at),
    warn_kick_at: row.warn_kick_at === null || row.warn_kick_at === undefined ? 5 : Number(row.warn_kick_at),
    admin_only: row.admin_only === null || row.admin_only === undefined ? 1 : Number(row.admin_only),
  };
}

async function getSettings(guildId) {
  const cached = settingsCache.get(guildId);
  if (cached) return cached;

  let row = await dbGet('SELECT * FROM settings WHERE guild_id = ?', [guildId]);
  if (!row) {
    await dbRun('INSERT OR IGNORE INTO settings (guild_id) VALUES (?)', [guildId]);
    row = await dbGet('SELECT * FROM settings WHERE guild_id = ?', [guildId]);
  }
  const settings = normalizeSettings(row || {}, guildId);
  settingsCache.set(guildId, settings);
  return settings;
}

/** Whitelisted partial update of settings (column names can never be injected). */
async function updateSettings(guildId, patch) {
  const keys = Object.keys(patch).filter((k) => SETTING_COLUMNS.has(k));
  if (!keys.length) return getSettings(guildId);
  const sql = `UPDATE settings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE guild_id = ?`;
  await dbRun(sql, [...keys.map((k) => patch[k]), guildId]);
  settingsCache.delete(guildId);
  return getSettings(guildId);
}

/** Sends an embed to the guild's configured mod-log channel. */
async function modLog(guild, settings, embed) {
  try {
    if (!settings || !settings.logchannel) return;
    const channel =
      guild.channels.cache.get(settings.logchannel) ||
      (await guild.channels.fetch(settings.logchannel).catch(() => null));
    if (!channel || !channel.isTextBased()) return;
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    logError('modLog', err);
  }
}

/* ------------------------------------------------------------------------------------------
 * 6. LIVE ANIMATED STATUS BAR
 *    "⠹ warn ▰▰▰▰▱▱▱▱▱▱ 40%"  ->  "✅ warn ▰▰▰▰▰▰▰▰▰▰ 100%"  -> deleted after 1.2s
 * ---------------------------------------------------------------------------------------- */

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BAR_BLOCKS = 10;

/** Renders the 10 block bar with a right aligned percentage. */
function renderBar(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * BAR_BLOCKS);
  return `${'▰'.repeat(filled)}${'▱'.repeat(BAR_BLOCKS - filled)} ${String(Math.round(clamped)).padStart(3, ' ')}%`;
}

/**
 * Creates the animated status message.
 * Returns { finish(ok) } — finish() stops the animation, marks it done and deletes it.
 */
async function createStatusBar(channel, name) {
  const state = { pct: 6, frame: 0, msg: null, timer: null, done: false };

  const render = () => `${SPINNER[state.frame % SPINNER.length]} ${name} ${renderBar(state.pct)}`;

  try {
    state.msg = await channel.send({ content: render(), allowedMentions: { parse: [] } });
  } catch {
    // No permission to send — silently continue without a status bar.
    return { finish: async () => {} };
  }

  state.timer = setInterval(async () => {
    if (state.done) return;
    state.frame += 1;
    const step = Math.max(2, Math.round((92 - state.pct) / 6)) + Math.floor(Math.random() * 4);
    state.pct = Math.min(92, state.pct + step);
    try {
      await state.msg.edit({ content: render() });
    } catch {
      /* message deleted or rate limited — ignore */
    }
  }, 650);
  if (state.timer.unref) state.timer.unref();

  return {
    async finish(ok = true) {
      if (state.done) return;
      state.done = true;
      clearInterval(state.timer);
      const content = `${ok ? '✅' : '❌'} ${name} ${renderBar(100)}`;
      try {
        await state.msg.edit({ content });
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => state.msg.delete().catch(() => {}), 1200);
      if (t.unref) t.unref();
    },
  };
}

/** Runs `fn` while showing the animated status bar (per-guild toggle aware). */
async function withStatusBar(msg, settings, name, fn) {
  if (!settings.statusbar) return fn();
  const bar = await createStatusBar(msg.channel, name);
  try {
    const result = await fn();
    await bar.finish(true);
    return result;
  } catch (err) {
    await bar.finish(false);
    throw err;
  }
}

/* ------------------------------------------------------------------------------------------
 * 7. ANTI-NUKE  (audit-log driven, multiple detection methods, like Discord AutoMod)
 *    Detection methods (all individually switchable with !antinuke detect):
 *      count        – N destructive actions inside the window (default 3 / 10s)
 *      burst        – 5 actions inside 3 seconds (classic nuke speed)
 *      destructive  – 3 deletes (channel/role/emoji/webhook) inside 10 seconds
 *      sensitive    – 2 webhook / integration / bot-add / server-update actions inside 10s
 *      custom       – your own rules: !antinuke rule add <action> <threshold> <seconds>
 *      name-filter  – blocked-word filter for nicknames/usernames (!antinuke filter)
 * ---------------------------------------------------------------------------------------- */

/** Monitored audit log actions + their key, label and class. */
const NUKE_ACTION_META = new Map([
  [AuditLogEvent.ChannelCreate, { key: 'channel-create', label: 'Channel Create', kind: 'create' }],
  [AuditLogEvent.ChannelDelete, { key: 'channel-delete', label: 'Channel Delete', kind: 'delete' }],
  [AuditLogEvent.ChannelUpdate, { key: 'channel-update', label: 'Channel Update', kind: 'update' }],
  [AuditLogEvent.RoleCreate, { key: 'role-create', label: 'Role Create', kind: 'create' }],
  [AuditLogEvent.RoleDelete, { key: 'role-delete', label: 'Role Delete', kind: 'delete' }],
  [AuditLogEvent.RoleUpdate, { key: 'role-update', label: 'Role Update', kind: 'update' }],
  [AuditLogEvent.MemberBanAdd, { key: 'ban', label: 'Member Ban', kind: 'mod' }],
  [AuditLogEvent.MemberKick, { key: 'kick', label: 'Member Kick', kind: 'mod' }],
  [AuditLogEvent.MemberPrune, { key: 'prune', label: 'Member Prune', kind: 'mod' }],
  [AuditLogEvent.MemberRoleUpdate, { key: 'member-role-update', label: 'Member Role Update', kind: 'update' }],
  [AuditLogEvent.WebhookCreate, { key: 'webhook-create', label: 'Webhook Create', kind: 'sensitive' }],
  [AuditLogEvent.WebhookDelete, { key: 'webhook-delete', label: 'Webhook Delete', kind: 'sensitive' }],
  [AuditLogEvent.WebhookUpdate, { key: 'webhook-update', label: 'Webhook Update', kind: 'sensitive' }],
  [AuditLogEvent.BotAdd, { key: 'bot-add', label: 'Bot Add', kind: 'sensitive' }],
  [AuditLogEvent.EmojiCreate, { key: 'emoji-create', label: 'Emoji Create', kind: 'create' }],
  [AuditLogEvent.EmojiDelete, { key: 'emoji-delete', label: 'Emoji Delete', kind: 'delete' }],
  [AuditLogEvent.EmojiUpdate, { key: 'emoji-update', label: 'Emoji Update', kind: 'update' }],
  [AuditLogEvent.IntegrationCreate, { key: 'integration-create', label: 'Integration Create', kind: 'sensitive' }],
  [AuditLogEvent.IntegrationDelete, { key: 'integration-delete', label: 'Integration Delete', kind: 'sensitive' }],
  [AuditLogEvent.GuildUpdate, { key: 'guild-update', label: 'Server Update', kind: 'sensitive' }],
]);

/** Action keys used by custom rules (and shown in !antinuke rule list). */
const NUKE_ACTION_KEYS = [...NUKE_ACTION_META.values()].map((m) => m.key);

const NUKE_WINDOW_MS = 10000;

/** Detection methods and their defaults. */
const DETECT_METHODS = new Map([
  ['count', { label: 'Action count', desc: 'nuke_limit actions inside 10s (respects !antinuke limit)' }],
  ['burst', { label: 'Burst speed', desc: '5 actions inside 3s' }],
  ['destructive', { label: 'Mass delete', desc: '3 delete actions (channel/role/emoji/webhook) inside 10s' }],
  ['sensitive', { label: 'Sensitive actions', desc: '2 webhook/integration/bot-add/server-update actions inside 10s' }],
  ['custom', { label: 'Custom rules', desc: 'rules created with !antinuke rule add' }],
  ['name-filter', { label: 'Blocked names', desc: 'reverts nicknames/usernames containing filtered words' }],
]);

const detectCache = new Map(); // guildId -> Map(method -> enabled)

async function getDetectConfig(guildId) {
  const cached = detectCache.get(guildId);
  if (cached) return cached;
  const rows = await dbAll('SELECT * FROM antinuke_detect WHERE guild_id = ?', [guildId]);
  const map = new Map([...DETECT_METHODS.keys()].map((m) => [m, true])); // default: all on
  for (const row of rows) map.set(row.method, Number(row.enabled) === 1);
  detectCache.set(guildId, map);
  return map;
}

async function setDetectMethod(guildId, method, enabled) {
  await dbRun(
    `INSERT INTO antinuke_detect (guild_id, method, enabled) VALUES (?, ?, ?)
     ON CONFLICT(guild_id, method) DO UPDATE SET enabled = excluded.enabled`,
    [guildId, method, enabled ? 1 : 0]
  );
  detectCache.delete(guildId);
  return getDetectConfig(guildId);
}

const nukeCounters = new Map(); // `${guildId}:${userId}:${bucket}` -> [timestamps]
const nukeWhitelistCache = new Map(); // guildId -> Set(userId)
const nukeFilterCache = new Map(); // guildId -> Set(word)
const nukeRulesCache = new Map(); // guildId -> [rows]
const recentlyPunished = new Map(); // `${guildId}:${userId}` -> timestamp

async function getNukeWhitelist(guildId) {
  const cached = nukeWhitelistCache.get(guildId);
  if (cached) return cached;
  const rows = await dbAll('SELECT user_id FROM nuke_whitelist WHERE guild_id = ?', [guildId]);
  const set = new Set(rows.map((r) => r.user_id));
  nukeWhitelistCache.set(guildId, set);
  return set;
}

function invalidateNukeWhitelist(guildId) {
  nukeWhitelistCache.delete(guildId);
}

async function getNukeFilters(guildId) {
  const cached = nukeFilterCache.get(guildId);
  if (cached) return cached;
  const rows = await dbAll('SELECT word FROM antinuke_filters WHERE guild_id = ?', [guildId]);
  const set = new Set(rows.map((r) => String(r.word).toLowerCase()));
  nukeFilterCache.set(guildId, set);
  return set;
}

function invalidateNukeFilters(guildId) {
  nukeFilterCache.delete(guildId);
}

async function getNukeRules(guildId) {
  const cached = nukeRulesCache.get(guildId);
  if (cached) return cached;
  const rows = await dbAll('SELECT * FROM antinuke_rules WHERE guild_id = ? ORDER BY action ASC', [guildId]);
  nukeRulesCache.set(guildId, rows);
  return rows;
}

function invalidateNukeRules(guildId) {
  nukeRulesCache.delete(guildId);
}

/** Adds one timestamp to a bucket and returns the amount inside `windowMs`. */
function trackAction(guildId, userId, bucket, windowMs) {
  const key = `${guildId}:${userId}:${bucket}`;
  const now = Date.now();
  const list = (nukeCounters.get(key) || []).filter((t) => now - t < Math.max(windowMs, NUKE_WINDOW_MS));
  list.push(now);
  nukeCounters.set(key, list);
  return list.filter((t) => now - t < windowMs).length;
}

function resetNukeCounter(guildId, userId) {
  const prefix = `${guildId}:${userId}:`;
  for (const key of [...nukeCounters.keys()]) {
    if (key.startsWith(prefix)) nukeCounters.delete(key);
  }
}

/** Punishment modes accepted by `antinuke punish` (with a readable label each). */
const NUKE_PUNISHMENTS = new Map([
  ['ban', { label: 'Ban', desc: 'permanent ban (nothing is deleted)' }],
  ['kick', { label: 'Kick', desc: 'removed from the server, can rejoin with an invite' }],
  ['strip', { label: 'Strip roles', desc: 'every removable role is taken away' }],
  ['timeout', { label: 'Timeout', desc: 'muted with Discord\'s native timeout (1 min – 28 days)' }],
]);

/** Timeout length in ms from the guild setting (minutes, capped at Discord's 28 days). */
function nukeTimeoutMs(settings) {
  const minutes = Math.max(1, Math.min(40320, Number(settings && settings.nuke_timeout) || 60));
  return minutes * 60 * 1000;
}

/**
 * Applies the configured punishment with sensible fallbacks.
 * Order per mode (each step is tried only when the previous one is impossible):
 *   ban     -> kick -> strip
 *   kick    -> ban  -> strip
 *   strip   -> timeout -> kick -> ban
 *   timeout -> kick -> ban -> strip
 */
async function punishNuker(guild, member, mode, reason, settings = null) {
  const applied = [];
  const timeoutMs = nukeTimeoutMs(settings);
  const tryBan = async () => {
    if (!guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) return false;
    if (!member.bannable) return false;
    return member.ban({ reason, deleteMessageSeconds: 0 }).then(() => true).catch(() => false);
  };
  const tryKick = async () => {
    if (!guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) return false;
    if (!member.kickable) return false;
    return member.kick(reason).then(() => true).catch(() => false);
  };
  const tryStrip = async () => {
    const me = guild.members.me;
    const removable = member.roles.cache.filter(
      (r) => r.id !== guild.id && r.position < me.roles.highest.position && r.editable
    );
    if (!removable.size) return false;
    return member.roles
      .remove([...removable.keys()], reason)
      .then(() => true)
      .catch(() => false);
  };
  const tryTimeout = async () => {
    const me = guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ModerateMembers)) return false;
    if (!canActOn(guild, me, member)) return false;
    if (typeof member.timeout !== 'function') return false;
    return member
      .timeout(timeoutMs, reason)
      .then(() => ({ ok: true, label: `timeout ${humanDuration(timeoutMs)}` }))
      .catch(() => ({ ok: false }));
  };

  const ORDER = {
    ban: ['ban', 'kick', 'strip'],
    kick: ['kick', 'ban', 'strip'],
    strip: ['strip', 'timeout', 'kick', 'ban'],
    timeout: ['timeout', 'kick', 'ban', 'strip'],
  };
  const order = ORDER[mode] || ORDER.ban;

  for (const step of order) {
    let ok = false;
    if (step === 'ban') {
      ok = await tryBan();
      if (ok) applied.push('ban');
    } else if (step === 'kick') {
      ok = await tryKick();
      if (ok) applied.push('kick');
    } else if (step === 'timeout') {
      const res = await tryTimeout();
      if (res && res.ok) {
        ok = true;
        applied.push(res.label);
      }
    } else {
      ok = await tryStrip();
      if (ok) applied.push('roles stripped');
    }
    if (ok) break;
  }
  if (!applied.length) {
    const stripped = await tryStrip();
    if (stripped) applied.push('roles stripped');
  }
  return applied.join(' + ') || 'none (missing permissions)';
}

/**
 * Runs every enabled detection method for one audit log entry.
 * Returns { method, detail } when the executor looks like a nuker, otherwise null.
 */
async function evaluateDetections(guild, executorId, meta, settings) {
  const detect = await getDetectConfig(guild.id);

  // bucket bookkeeping
  const total = trackAction(guild.id, executorId, 'all', NUKE_WINDOW_MS);
  const burst = detect.get('burst') ? trackAction(guild.id, executorId, 'burst', 3000) : 0;
  const deletes = meta.kind === 'delete' ? trackAction(guild.id, executorId, 'delete', NUKE_WINDOW_MS) : 0;
  const sensitive = meta.kind === 'sensitive' ? trackAction(guild.id, executorId, 'sensitive', NUKE_WINDOW_MS) : 0;

  // 1) plain action count
  // trigger on the Nth action inside the window (limit 1 => the very first destructive action)
  if (detect.get('count') && total >= settings.nuke_limit) {
    return { method: 'count', detail: `${total} action(s) in ${NUKE_WINDOW_MS / 1000}s (limit ${settings.nuke_limit})` };
  }
  // 2) burst speed
  if (detect.get('burst') && burst >= 5) {
    return { method: 'burst', detail: `${burst} actions in 3s` };
  }
  // 3) mass deletes
  if (detect.get('destructive') && deletes >= 3) {
    return { method: 'destructive', detail: `${deletes} delete actions in ${NUKE_WINDOW_MS / 1000}s` };
  }
  // 4) sensitive action pairs
  if (detect.get('sensitive') && sensitive >= 2) {
    return { method: 'sensitive', detail: `${sensitive} sensitive actions (webhook/integration/bot/server) in 10s` };
  }
  // 5) custom rules
  if (detect.get('custom')) {
    const rules = await getNukeRules(guild.id);
    for (const rule of rules) {
      if (rule.action !== meta.key) continue;
      const hits = trackAction(guild.id, executorId, `rule:${rule.action}`, Number(rule.window_ms) || NUKE_WINDOW_MS);
      if (hits >= (Number(rule.threshold) || 1)) {
        return {
          method: 'custom',
          detail: `rule \`${rule.action}\` triggered (${hits}/${rule.threshold} in ${Math.round(rule.window_ms / 1000)}s)`,
        };
      }
    }
  }
  return null;
}

/** Core anti-nuke handler — called from Events.GuildAuditLogEntryCreate. */
async function handleAuditEntry(entry, guild) {
  try {
    if (!guild) return;
    const meta = NUKE_ACTION_META.get(entry.action);
    if (!meta) return;

    const settings = await getSettings(guild.id);
    if (!settings.antinuke) return;

    const executorId = entry.executorId || null;
    if (!executorId) return; // automatic action by Discord — nothing to punish
    if (executorId === guild.ownerId) return; // server owner is always exempt
    if (executorId === client.user?.id) return; // the bot itself
    if (executorId === entry.targetId) return;

    const whitelist = await getNukeWhitelist(guild.id);
    if (whitelist.has(executorId)) return; // whitelisted users are exempt

    const executor =
      guild.members.cache.get(executorId) || (await guild.members.fetch(executorId).catch(() => null));
    if (!executor) return;
    if (executor.id === client.user?.id) return;

    // ---- Unauthorized bot add: kick the bot, punish the adder immediately ----
    if (entry.action === AuditLogEvent.BotAdd) {
      const botId = entry.targetId;
      if (botId && botId !== client.user?.id) {
        const added = guild.members.cache.get(botId) || (await guild.members.fetch(botId).catch(() => null));
        if (added && added.kickable) await added.kick('Anti-nuke: unauthorized bot').catch(() => {});
      }
      resetNukeCounter(guild.id, executorId);
      recentlyPunished.set(`${guild.id}:${executorId}`, Date.now());
      const punishment = await punishNuker(guild, executor, settings.nuke_punish, 'Anti-nuke: unauthorized bot add', settings);
      const log = baseEmbed(COLORS.error, '🛡️ Anti-Nuke — Unauthorized Bot Add')
        .addFields(
          { name: 'Executor', value: `<@${executorId}> \`${executor.user.tag}\``, inline: true },
          { name: 'Bot', value: botId ? `<@${botId}>` : 'unknown', inline: true },
          { name: 'Detection', value: 'instant (bot-add)', inline: true },
          { name: 'Punishment', value: punishment, inline: true }
        );
      await modLog(guild, settings, log);
      return;
    }

    // ---- Guard against punishment spam ----
    const punishKey = `${guild.id}:${executorId}`;
    if (Date.now() - (recentlyPunished.get(punishKey) || 0) < 15000) return;

    // ---- Run all detection methods ----
    const violation = await evaluateDetections(guild, executorId, meta, settings);
    if (!violation) return;

    // ---- Threshold exceeded ----
    resetNukeCounter(guild.id, executorId);
    recentlyPunished.set(punishKey, Date.now());
    const punishment = await punishNuker(guild, executor, settings.nuke_punish, `Anti-nuke (${violation.method}): ${violation.detail}`, settings);

    const log = baseEmbed(COLORS.error, '🛡️ Anti-Nuke Triggered')
      .setDescription(`**${executor.user.tag}** (\`${executorId}\`) exceeded the anti-nuke limit.`)
      .addFields(
        { name: 'Last action', value: meta.label, inline: true },
        { name: 'Detection', value: `\`${violation.method}\` — ${violation.detail}`, inline: false },
        { name: 'Limit', value: `${settings.nuke_limit} / ${NUKE_WINDOW_MS / 1000}s`, inline: true },
        { name: 'Punishment', value: punishment, inline: true }
      );
    await modLog(guild, settings, log);
  } catch (err) {
    logError('handleAuditEntry', err);
  }
}

/**
 * Blocked-name filter (anti-nuke `name-filter` method).
 * Reverts nicknames (and logs usernames) that contain a filtered word.
 */
async function handleNameFilter(oldMember, newMember) {
  try {
    const guild = newMember.guild;
    if (!guild || !newMember) return;
    if (newMember.user.bot) return;
    if (newMember.id === guild.ownerId) return;
    if (newMember.id === client.user?.id) return;

    const settings = await getSettings(guild.id);
    if (!settings.antinuke) return;

    const detect = await getDetectConfig(guild.id);
    if (!detect.get('name-filter')) return;

    const whitelist = await getNukeWhitelist(guild.id);
    if (whitelist.has(newMember.id)) return;

    const words = await getNukeFilters(guild.id);
    if (!words.size) return;

    const changedNick = oldMember && oldMember.nickname !== newMember.nickname;
    const changedName = oldMember && oldMember.user.username !== newMember.user.username;
    if (!changedNick && !changedName) return;

    const haystacks = [
      newMember.nickname || '',
      newMember.user.username || '',
      newMember.user.globalName || '',
    ].join(' ').toLowerCase();

    let hit = null;
    for (const word of words) {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(word)}([^\\p{L}\\p{N}_]|$)`, 'iu');
      if (re.test(haystacks)) {
        hit = word;
        break;
      }
    }
    if (!hit) return;

    let reverted = false;
    if (changedNick) {
      const me = guild.members.me;
      if (me.permissions.has(PermissionFlagsBits.ManageNicknames) && newMember.manageable) {
        reverted = await newMember
          .setNickname(oldMember ? oldMember.nickname : null, `Anti-nuke name filter: "${hit}"`)
          .then(() => true)
          .catch(() => false);
      }
    }

    await modLog(
      guild,
      settings,
      baseEmbed(COLORS.warn, '🛡️ Anti-Nuke — Blocked name filter')
        .addFields(
          { name: 'Member', value: `<@${newMember.id}> \`${newMember.user.tag}\``, inline: true },
          { name: 'Filtered word', value: `||${hit}||`, inline: true },
          { name: 'Nickname', value: truncate(newMember.nickname || '—', 200), inline: true },
          { name: 'Reverted', value: reverted ? 'yes ✅' : 'no (missing Manage Nicknames / hierarchy)', inline: false }
        )
    );
  } catch (err) {
    logError('handleNameFilter', err);
  }
}

/* ------------------------------------------------------------------------------------------
 * 8. ANTI-SPAM  (flood / duplicates / mass mentions / invites / link spam)
 *    Every threshold is configurable per guild with !antispam config / !antispam set.
 * ---------------------------------------------------------------------------------------- */

const spamTracker = new Map(); // `${guildId}:${userId}` -> { times, contents }

function spamBucket(guildId, userId) {
  const key = `${guildId}:${userId}`;
  let bucket = spamTracker.get(key);
  if (!bucket) {
    bucket = { times: [], contents: [] };
    spamTracker.set(key, bucket);
  }
  return bucket;
}

// Periodic cleanup so the maps cannot grow forever.
const cleanInterval = setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [key, bucket] of spamTracker) {
    bucket.times = bucket.times.filter((t) => t > cutoff);
    if (!bucket.times.length) spamTracker.delete(key);
  }
  for (const [key, list] of nukeCounters) {
    const pruned = list.filter((t) => Date.now() - t < 300000);
    if (pruned.length) nukeCounters.set(key, pruned);
    else nukeCounters.delete(key);
  }
}, 60000);
if (cleanInterval.unref) cleanInterval.unref();

/* ---- anti-spam whitelist (users + roles that are never auto-moderated) ---- */

const spamWhitelistCache = new Map(); // guildId -> { users: Set, roles: Set }

async function getSpamWhitelist(guildId) {
  const cached = spamWhitelistCache.get(guildId);
  if (cached) return cached;
  const rows = await dbAll('SELECT target_id, kind FROM spam_whitelist WHERE guild_id = ?', [guildId]);
  const entry = { users: new Set(), roles: new Set() };
  for (const row of rows) {
    if (row.kind === 'role') entry.roles.add(row.target_id);
    else entry.users.add(row.target_id);
  }
  spamWhitelistCache.set(guildId, entry);
  return entry;
}

function invalidateSpamWhitelist(guildId) {
  spamWhitelistCache.delete(guildId);
}

/** True when the member (or one of their roles) is exempt from anti-spam + blocked words. */
async function isSpamWhitelisted(guildId, member) {
  const list = await getSpamWhitelist(guildId);
  if (!list.users.size && !list.roles.size) return false;
  if (list.users.has(member.id)) return true;
  if (list.roles.size && member.roles && member.roles.cache) {
    for (const roleId of list.roles) if (member.roles.cache.has(roleId)) return true;
  }
  return false;
}

const INVITE_RE = /(?:discord\.gg|discord\.com\/invite|discordapp\.com\/invite|dsc\.gg)\/[a-z0-9-]+/i;
const LINK_RE = /https?:\/\/\S+/gi;

/** Returns the reason string when the message looks like spam, otherwise null. */
function detectSpam(guildId, userId, message, cfg) {
  const bucket = spamBucket(guildId, userId);
  const now = Date.now();
  const dupWindow = cfg.dup_window * 1000;
  bucket.times = bucket.times.filter((t) => now - t < Math.max(dupWindow, cfg.flood_window * 1000));
  bucket.times.push(now);

  const flood = bucket.times.filter((t) => now - t < cfg.flood_window * 1000).length;
  if (flood >= cfg.flood_count) return `message flooding (${flood} msgs / ${cfg.flood_window}s)`;

  const normalized = message.content.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized.length > 2) {
    bucket.contents = bucket.contents.filter((c) => now - c.at < dupWindow);
    bucket.contents.push({ text: normalized, at: now });
    const dups = bucket.contents.filter((c) => c.text === normalized).length;
    if (dups >= cfg.dup_count) return `duplicate messages (${dups}× in ${cfg.dup_window}s)`;
  }

  const mentions = message.mentions.users.size + message.mentions.roles.size;
  if (mentions >= cfg.mention_count) return `mass mentions (${mentions})`;

  if (cfg.invite_block && INVITE_RE.test(message.content)) return 'discord invite link';

  const links = message.content.match(LINK_RE) || [];
  if (links.length >= cfg.link_count) return `link spam (${links.length} links)`;

  return null;
}

/** Deletes the offending messages, times the user out and warns them temporarily. */
async function punishSpammer(message, settings, reason, cfg) {
  const { guild, channel, member } = message;
  const me = guild.members.me;

  // 1. delete the triggering message
  await message.delete().catch(() => {});

  // 2. bulk delete every recent message of the user in this channel
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    const own = recent.filter(
      (m) => m.author.id === message.author.id && Date.now() - m.createdTimestamp < 1209600000
    );
    if (own.size) await channel.bulkDelete(own, true).catch(() => {});
  } catch {
    /* ignore */
  }

  // 3. timeout (configurable length)
  const timeoutMs = Math.min(cfg.timeout_secs * 1000, 28 * 24 * 60 * 60 * 1000);
  let timedOut = false;
  if (member && me.permissions.has(PermissionFlagsBits.ModerateMembers) && canActOn(guild, me, member)) {
    timedOut = await member
      .timeout(timeoutMs, `Auto-mod: ${reason}`)
      .then(() => true)
      .catch(() => false);
  }

  // 4. temporary warning notice
  await sendTemp(
    channel,
    {
      content: `<@${message.author.id}>`,
      embeds: [
        warnEmbed(
          '🚫 Slow down!',
          `Your messages were removed.\n**Reason:** ${reason}\n${timedOut ? `**You have been timed out for ${humanDuration(timeoutMs)}.**` : ''}`
        ),
      ],
      allowedMentions: { users: [message.author.id] },
    },
    8000
  );

  // 5. log entry
  const log = baseEmbed(COLORS.warn, '⚠️ Auto-Mod — Spam detected')
    .addFields(
      { name: 'User', value: `<@${message.author.id}> \`${message.author.tag}\``, inline: true },
      { name: 'Channel', value: `<#${channel.id}>`, inline: true },
      { name: 'Reason', value: reason, inline: false },
      { name: 'Timeout', value: timedOut ? humanDuration(timeoutMs) : 'not applied', inline: true }
    );
  await modLog(guild, settings, log);
}

/** Entry point used by the message handler. */
async function antiSpamCheck(message, settings) {
  const cfg = await getAntiSpamConfig(message.guild.id);
  if (!settings.antispam || !cfg.enabled) return false;
  const member = message.member;
  if (!member) return false;
  if (message.author.bot) return false;
  if (actorPrivileged(message)) return false; // main owner / granted users
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return false;
  if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

  // whitelisted users / roles are never auto-moderated
  if (await isSpamWhitelisted(message.guild.id, member)) return false;

  const reason = detectSpam(message.guild.id, message.author.id, message, cfg);
  if (!reason) return false;

  // reset the bucket to avoid re-triggering on every following message
  spamTracker.delete(`${message.guild.id}:${message.author.id}`);
  await punishSpammer(message, settings, reason, cfg);
  return true;
}

/* ------------------------------------------------------------------------------------------
 * 9. BLOCKED WORDS
 * ---------------------------------------------------------------------------------------- */

const blockwordCache = new Map(); // guildId -> Set(words)

async function getBlockwords(guildId) {
  const cached = blockwordCache.get(guildId);
  if (cached) return cached;
  const rows = await dbAll('SELECT word FROM blockwords WHERE guild_id = ?', [guildId]);
  const set = new Set(rows.map((r) => r.word.toLowerCase()));
  blockwordCache.set(guildId, set);
  return set;
}

function invalidateBlockwords(guildId) {
  blockwordCache.delete(guildId);
}

async function blockwordCheck(message, settings) {
  try {
    const member = message.member;
    if (!member) return false;
    if (actorPrivileged(message)) return false; // main owner / granted users
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return false;
    if (member.permissions.has(PermissionFlagsBits.ManageMessages)) return false;

    // whitelisted users / roles are never auto-moderated
    if (await isSpamWhitelisted(message.guild.id, member)) return false;

    const words = await getBlockwords(message.guild.id);
    if (!words.size) return false;

    const content = message.content.toLowerCase();
    let hit = null;
    for (const word of words) {
      // whole word, case-insensitive
      const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(word)}([^\\p{L}\\p{N}_]|$)`, 'iu');
      if (re.test(content)) {
        hit = word;
        break;
      }
    }
    if (!hit) return false;

    await message.delete().catch(() => {});
    // automatic warning
    const result = await addWarning(message.guild, message.author.id, client.user.id, `Blocked word: ${hit}`, {
      silent: true,
    });
    await sendTemp(
      message.channel,
      {
        content: `<@${message.author.id}>`,
        embeds: [
          warnEmbed('🚫 Blocked word', `Your message contained a blocked word and was removed.\nWarning **#${result.id}** was added automatically.`),
        ],
        allowedMentions: { users: [message.author.id] },
      },
      7000
    );
    await modLog(
      message.guild,
      settings,
      baseEmbed(COLORS.warn, '🚫 Blocked word removed')
        .addFields(
          { name: 'User', value: `<@${message.author.id}>`, inline: true },
          { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
          { name: 'Word', value: `||${hit}||`, inline: true }
        )
    );
    return true;
  } catch (err) {
    logError('blockwordCheck', err);
    return false;
  }
}

/* ------------------------------------------------------------------------------------------
 * 10. WARNINGS (+ automatic punishments)
 * ---------------------------------------------------------------------------------------- */

/**
 * Adds a warning and applies the automatic punishment thresholds.
 * opts.silent -> do not DM / do not post an in-channel notice (used by auto-mod)
 */
async function addWarning(guild, userId, modId, reason, opts = {}) {
  const settings = await getSettings(guild.id);
  const res = await dbRun(
    'INSERT INTO warnings (guild_id, user_id, mod_id, reason, created_at) VALUES (?, ?, ?, ?, ?)',
    [guild.id, userId, modId, reason || 'No reason provided', Date.now()]
  );
  const id = res.lastID;
  const { c: count } = await dbGet(
    'SELECT COUNT(*) AS c FROM warnings WHERE guild_id = ? AND user_id = ?',
    [guild.id, userId]
  );

  let action = null;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (member) {
    const kickAt = Number(settings.warn_kick_at) || 0;
    const timeoutAt = Number(settings.warn_timeout_at) || 0;

    if (kickAt > 0 && count >= kickAt && member.kickable) {
      action = `kicked (${count} warnings)`;
      await member.kick(`Automatic: reached ${count} warnings`).catch(() => (action = null));
      if (action) {
        await dbRun('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?', [guild.id, userId]);
      }
    } else if (timeoutAt > 0 && count >= timeoutAt && member.moderatable) {
      action = `1 hour timeout (${count} warnings)`;
      await member.timeout(60 * 60 * 1000, `Automatic: reached ${count} warnings`).catch(() => (action = null));
    }
  }

  if (!opts.silent) {
    const log = baseEmbed(COLORS.mod, '⚠️ Warning issued')
      .addFields(
        { name: 'User', value: `<@${userId}>`, inline: true },
        { name: 'Moderator', value: modId === client.user.id ? 'Auto-mod' : `<@${modId}>`, inline: true },
        { name: 'Warning ID', value: `#${id}`, inline: true },
        { name: 'Total warnings', value: String(count), inline: true },
        { name: 'Reason', value: truncate(reason || 'No reason provided', 1024), inline: false }
      );
    if (action) log.addFields({ name: 'Automatic action', value: action, inline: false });
    await modLog(guild, settings, log);
  }

  return { id, count, action };
}

/* ------------------------------------------------------------------------------------------
 * 11. AFK SYSTEM
 * ---------------------------------------------------------------------------------------- */

/** Shows AFK reasons when a user is mentioned, and clears AFK when the user talks. */
async function handleAfk(message) {
  try {
    const guildId = message.guild.id;

    // Clear own AFK status
    const own = await dbGet('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?', [guildId, message.author.id]);
    if (own) {
      await dbRun('DELETE FROM afk WHERE guild_id = ? AND user_id = ?', [guildId, message.author.id]);
      await sendTemp(
        message.channel,
        {
          embeds: [
            okEmbed('👋 Welcome back!', `<@${message.author.id}>, your AFK status has been removed.\n**Was:** ${own.reason || 'AFK'}`),
          ],
          allowedMentions: { users: [message.author.id] },
        },
        7000
      );
    }

    // Announce mentioned users that are AFK
    if (message.mentions.users.size) {
      for (const [userId, user] of message.mentions.users) {
        if (userId === message.author.id) continue;
        const row = await dbGet('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
        if (!row) continue;
        await message
          .reply({
            embeds: [
              infoEmbed('💤 User is AFK', `**${user.tag}** is AFK.\n**Reason:** ${row.reason || 'AFK'}\n**Since:** <t:${Math.floor(row.since / 1000)}:R>`),
            ],
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
    }
  } catch (err) {
    logError('handleAfk', err);
  }
}

/* ------------------------------------------------------------------------------------------
 * 12. WELCOME SYSTEM
 * ---------------------------------------------------------------------------------------- */

const WELCOME_DEFAULTS = {
  title: '👋 Welcome to {server}!',
  message: 'Hey {user}, welcome to **{server}**!\nYou are member **#{members}**.\nMake yourself at home 🎉',
  footer: 'Enjoy your stay!',
  banner: null,
  color: COLORS.welcome,
  thumbnail: 1,
  ping: 1,
  enabled: 1,
  channel: null,
};

async function getWelcome(guildId) {
  let row = await dbGet('SELECT * FROM welcome WHERE guild_id = ?', [guildId]);
  if (!row) {
    await dbRun(
      `INSERT OR IGNORE INTO welcome (guild_id, title, message, footer, color, thumbnail, ping, enabled)
       VALUES (?, ?, ?, ?, ?, 1, 1, 1)`,
      [guildId, WELCOME_DEFAULTS.title, WELCOME_DEFAULTS.message, WELCOME_DEFAULTS.footer, WELCOME_DEFAULTS.color]
    );
    row = await dbGet('SELECT * FROM welcome WHERE guild_id = ?', [guildId]);
  }
  const cfg = { ...WELCOME_DEFAULTS, ...row };
  cfg.color = cfg.color === null || cfg.color === undefined ? COLORS.welcome : Number(cfg.color);
  cfg.thumbnail = Number(cfg.thumbnail);
  cfg.ping = Number(cfg.ping);
  cfg.enabled = Number(cfg.enabled);
  return cfg;
}

/** Builds the welcome embed for a member (also used by !welcome test). */
function buildWelcomeEmbed(cfg, member) {
  const ctx = { user: member.user, guild: member.guild, channel: null };
  const embed = baseEmbed(cfg.color, cfg.title ? applyTemplate(cfg.title, ctx) : undefined);
  if (cfg.message) embed.setDescription(applyTemplate(cfg.message, ctx));
  if (cfg.footer && cfg.footer !== 'off') embed.setFooter({ text: truncate(applyTemplate(cfg.footer, ctx), 2048) });
  if (cfg.banner && isHttpUrl(cfg.banner)) embed.setImage(cfg.banner);
  if (cfg.thumbnail) embed.setThumbnail(member.user.displayAvatarURL({ size: 256, extension: 'png' }));
  return embed;
}

/** Sends the welcome message when a member joins. */
async function sendWelcome(member) {
  try {
    if (!member || member.user.bot) return;
    const cfg = await getWelcome(member.guild.id);
    if (!cfg.enabled || !cfg.channel) return;
    const channel =
      member.guild.channels.cache.get(cfg.channel) ||
      (await member.guild.channels.fetch(cfg.channel).catch(() => null));
    if (!channel || !channel.isTextBased()) return;

    await channel.send({
      content: cfg.ping ? `<@${member.id}>` : undefined,
      embeds: [buildWelcomeEmbed(cfg, member)],
      allowedMentions: cfg.ping ? { users: [member.id] } : { parse: [] },
    });
  } catch (err) {
    logError('sendWelcome', err);
  }
}

/* ------------------------------------------------------------------------------------------
 * 13. TICKET SYSTEM
 * ---------------------------------------------------------------------------------------- */

const TICKET_DEFAULTS = {
  title: '🎫 Support Tickets',
  description: 'Choose a category below to open a private ticket.\nOur staff team will be with you shortly.',
  footer: 'One ticket per issue, please.',
  welcome_msg: 'Hey {user}, thanks for opening a **{type}** ticket in **{server}**!\nStaff will be with you soon. Describe your issue below.',
  color: COLORS.ticket,
  style: 'menu',
  max_open: 3,
  category: null,
  logchannel: null,
  support_role: null,
  banner: null,
};

const DEFAULT_TICKET_TYPES = [
  { key: 'support', emoji: '🛠️', label: 'Support', description: 'Get help with a problem' },
  { key: 'report', emoji: '🚨', label: 'Report', description: 'Report a user or a bug' },
  { key: 'partnership', emoji: '🤝', label: 'Partnership', description: 'Partner with our server' },
];

async function getTicketConfig(guildId) {
  let row = await dbGet('SELECT * FROM ticket_config WHERE guild_id = ?', [guildId]);
  if (!row) {
    await dbRun(
      `INSERT OR IGNORE INTO ticket_config
        (guild_id, title, description, footer, welcome_msg, color, style, max_open)
       VALUES (?, ?, ?, ?, ?, ?, 'menu', 3)`,
      [guildId, TICKET_DEFAULTS.title, TICKET_DEFAULTS.description, TICKET_DEFAULTS.footer, TICKET_DEFAULTS.welcome_msg, TICKET_DEFAULTS.color]
    );
    row = await dbGet('SELECT * FROM ticket_config WHERE guild_id = ?', [guildId]);
  }
  const cfg = { ...TICKET_DEFAULTS, ...row };
  cfg.color = cfg.color === null || cfg.color === undefined ? COLORS.ticket : Number(cfg.color);
  cfg.max_open = Number(cfg.max_open) || 3;
  return cfg;
}

const TICKET_CONFIG_COLUMNS = new Set([
  'category',
  'logchannel',
  'support_role',
  'max_open',
  'title',
  'description',
  'footer',
  'welcome_msg',
  'banner',
  'color',
  'style',
]);

/** Whitelisted update of ticket_config. */
async function updateTicketConfig(guildId, patch) {
  const keys = Object.keys(patch).filter((k) => TICKET_CONFIG_COLUMNS.has(k));
  if (!keys.length) return getTicketConfig(guildId);
  const sql = `UPDATE ticket_config SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE guild_id = ?`;
  await dbRun(sql, [...keys.map((k) => patch[k]), guildId]);
  return getTicketConfig(guildId);
}

/** Returns the ticket types of a guild, seeding the defaults when none exist. */
async function getTicketTypes(guildId) {
  let rows = await dbAll('SELECT * FROM ticket_types WHERE guild_id = ? ORDER BY rowid ASC', [guildId]);
  if (!rows.length) {
    for (const t of DEFAULT_TICKET_TYPES) {
      await dbRun('INSERT OR IGNORE INTO ticket_types (guild_id, key, emoji, label, description) VALUES (?, ?, ?, ?, ?)', [
        guildId,
        t.key,
        t.emoji,
        t.label,
        t.description,
      ]);
    }
    rows = await dbAll('SELECT * FROM ticket_types WHERE guild_id = ? ORDER BY rowid ASC', [guildId]);
  }
  return rows;
}

/** Resolves a category from a mention, raw ID or name (accepts channels inside a category). */
async function resolveCategory(guild, input) {
  if (!input) return null;
  const id = parseId(input);
  if (id) {
    const direct = guild.channels.cache.get(id);
    if (direct) {
      if (direct.type === ChannelType.GuildCategory) return direct;
      if (direct.parentId) {
        const parent = guild.channels.cache.get(direct.parentId);
        if (parent && parent.type === ChannelType.GuildCategory) return parent;
      }
    }
  }
  const needle = String(input).replace(/^#/, '').toLowerCase();
  return (
    guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === needle
    ) || null
  );
}

/** Resolves a role from mention, ID or name. */
function resolveRole(guild, input) {
  if (!input) return null;
  const id = parseId(input);
  if (id && guild.roles.cache.has(id)) return guild.roles.cache.get(id);
  const needle = String(input).replace(/^@/, '').toLowerCase();
  return guild.roles.cache.find((r) => r.name.toLowerCase() === needle) || null;
}

/** Builds the panel payload (embed + select menu / buttons). */
function buildTicketPanel(cfg, types) {
  const embed = baseEmbed(cfg.color, cfg.title, cfg.description);
  if (cfg.footer && cfg.footer !== 'off') embed.setFooter({ text: truncate(cfg.footer, 2048) });
  if (cfg.banner && isHttpUrl(cfg.banner)) embed.setImage(cfg.banner);

  // Render the available types inside the embed for clarity.
  if (types.length) {
    embed.addFields({
      name: 'Available categories',
      value: truncate(types.map((t) => `${t.emoji} **${t.label}**${t.description ? ` — ${t.description}` : ''}`).join('\n'), 1024),
    });
  }

  const rows = [];
  if (cfg.style === 'buttons') {
    const chunk = types.slice(0, 25);
    for (let i = 0; i < chunk.length; i += 5) {
      const row = new ActionRowBuilder();
      for (const t of chunk.slice(i, i + 5)) {
        const btn = new ButtonBuilder()
          .setCustomId(`ticket:open:${t.key}`)
          .setLabel(truncate(t.label, 80))
          .setStyle(ButtonStyle.Primary);
        const emoji = parseEmoji(t.emoji);
        if (emoji) btn.setEmoji(emojiForButton(emoji));
        row.addComponents(btn);
      }
      rows.push(row);
    }
  } else {
    const menu = new StringSelectMenuBuilder()
      .setCustomId('ticket:select')
      .setPlaceholder('Select a ticket category…')
      .setMinValues(1)
      .setMaxValues(1);
    for (const t of types.slice(0, 25)) {
      const option = { label: truncate(t.label, 100), value: t.key };
      if (t.description) option.description = truncate(t.description, 100);
      const emoji = parseEmoji(t.emoji);
      if (emoji) option.emoji = emojiForButton(emoji);
      menu.addOptions(option);
    }
    if (types.length) rows.push(new ActionRowBuilder().addComponents(menu));
  }

  return { embeds: [embed], components: rows };
}

/** Generates a plain-text transcript of a channel (max ~1000 messages). */
async function buildTranscript(channel, limit = 1000) {
  const collected = [];
  let lastId = null;
  let guard = 0;
  while (collected.length < limit && guard < 12) {
    guard += 1;
    const batch = await channel.messages.fetch({ limit: Math.min(100, limit - collected.length), before: lastId }).catch(() => null);
    if (!batch || !batch.size) break;
    collected.push(...batch.values());
    lastId = batch.last()?.id;
    if (batch.size < 100) break;
  }
  collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  if (!collected.length) return { content: 'No messages were found in this ticket.', count: 0 };

  const lines = collected.map((m) => {
    const stamp = new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
    const attachments = m.attachments.size ? ` [attachments: ${[...m.attachments.values()].map((a) => a.url).join(', ')}]` : '';
    const embeds = m.embeds.length ? ' [embed]' : '';
    return `[${stamp}] ${m.author ? m.author.tag : 'unknown'} : ${m.content || ''}${attachments}${embeds}`;
  });
  const header = `Transcript of #${channel.name} (${channel.guild ? channel.guild.name : 'server'})\nMessages: ${collected.length}\n${'='.repeat(80)}\n`;
  return { content: header + lines.join('\n'), count: collected.length };
}

/** Creates a private ticket channel + welcome embed. Returns the created channel. */
async function openTicket(guild, user, typeKey) {
  const cfg = await getTicketConfig(guild.id);
  const types = await getTicketTypes(guild.id);
  const type = types.find((t) => t.key === typeKey) || types[0];
  if (!type) throw new Error('No ticket types configured.');

  // Per-user open limit
  const { c: openCount } = await dbGet(
    "SELECT COUNT(*) AS c FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open'",
    [guild.id, user.id]
  );
  if (openCount >= cfg.max_open) {
    throw new Error(`You already have **${openCount}** open ticket(s). The limit is **${cfg.max_open}**.`);
  }

  const category = cfg.category ? guild.channels.cache.get(cfg.category) : null;
  const me = guild.members.me;

  // Permission overwrites: user, support role, bot, @everyone (deny)
  const overwrites = [
    { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
    {
      id: me.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
      ],
    },
  ];
  if (cfg.support_role && guild.roles.cache.has(cfg.support_role)) {
    overwrites.push({
      id: cfg.support_role,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  // Sequential, collision free name: "<type>-0001"
  const { c: total } = await dbGet('SELECT COUNT(*) AS c FROM tickets WHERE guild_id = ?', [guild.id]);
  let number = total + 1;
  let channel = null;
  for (let attempt = 0; attempt < 25 && !channel; attempt += 1) {
    const name = `${type.key}-${String(number).padStart(4, '0')}`.toLowerCase().slice(0, 100);
    channel = await guild.channels
      .create({
        name,
        type: ChannelType.GuildText,
        parent: category ? category.id : null,
        topic: `Ticket for ${user.tag} • type: ${type.label} • opener: ${user.id}`,
        permissionOverwrites: overwrites,
        reason: `Ticket opened by ${user.tag}`,
      })
      .catch(() => null);
    number += 1;
  }
  if (!channel) throw new Error('Could not create the ticket channel. Check my **Manage Channels** permission.');

  await dbRun(
    'INSERT INTO tickets (guild_id, channel_id, user_id, type, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [guild.id, channel.id, user.id, type.key, 'open', Date.now()]
  );

  const welcomeEmbed = baseEmbed(cfg.color, `${type.emoji ? `${type.emoji} ` : ''}${type.label} ticket`)
    .setDescription(applyTemplate(cfg.welcome_msg, { user, guild, channel }))
    .addFields(
      { name: 'Opened by', value: `<@${user.id}>`, inline: true },
      { name: 'Type', value: truncate(type.label, 100), inline: true },
      { name: 'Ticket', value: `#${String(number - 1).padStart(4, '0')}`, inline: true }
    );
  if (cfg.banner && isHttpUrl(cfg.banner)) welcomeEmbed.setImage(cfg.banner);
  if (cfg.footer && cfg.footer !== 'off') welcomeEmbed.setFooter({ text: truncate(cfg.footer, 2048) });

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    new ButtonBuilder().setCustomId('ticket:claim').setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🙋'),
    new ButtonBuilder().setCustomId('ticket:transcript').setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('📄')
  );

  const mention = cfg.support_role ? `<@${user.id}> <@&${cfg.support_role}>` : `<@${user.id}>`;
  await channel
    .send({
      content: mention,
      embeds: [welcomeEmbed],
      components: [buttons],
      allowedMentions: { users: [user.id], roles: cfg.support_role ? [cfg.support_role] : [] },
    })
    .catch(() => {});

  // Log
  const settings = await getSettings(guild.id);
  const logChannelId = cfg.logchannel || settings.logchannel;
  if (logChannelId) {
    const logChannel = guild.channels.cache.get(logChannelId);
    if (logChannel && logChannel.isTextBased()) {
      await logChannel
        .send({
          embeds: [
            baseEmbed(COLORS.ticket, '🎫 Ticket opened')
              .addFields(
                { name: 'User', value: `<@${user.id}> \`${user.tag}\``, inline: true },
                { name: 'Type', value: type.label, inline: true },
                { name: 'Channel', value: `<#${channel.id}>`, inline: true }
              ),
          ],
          allowedMentions: { parse: [] },
        })
        .catch(() => {});
    }
  }

  return { channel, type };
}

const closingTickets = new Set(); // channel ids currently being closed (double-close guard)

/** Closes a ticket: transcript to log + DM, then delete after 5s. */
async function closeTicket(channel, closer, reason = 'No reason provided') {
  if (closingTickets.has(channel.id)) return { ok: false, message: 'This ticket is already being closed.' };
  closingTickets.add(channel.id);

  try {
    const guild = channel.guild;
    const row = await dbGet('SELECT * FROM tickets WHERE channel_id = ? AND status = ?', [channel.id, 'open']);
    const cfg = await getTicketConfig(guild.id);
    const settings = await getSettings(guild.id);

    await dbRun("UPDATE tickets SET status = 'closed' WHERE channel_id = ?", [channel.id]);

    // Remove the buttons & show a closing embed
    await channel
      .send({
        embeds: [
          baseEmbed(COLORS.error, '🔒 Ticket closing')
            .setDescription('This ticket is being closed and will be deleted in **5 seconds**.')
            .addFields(
              { name: 'Closed by', value: `<@${closer.id}>`, inline: true },
              { name: 'Reason', value: truncate(reason, 1024), inline: false }
            ),
        ],
        allowedMentions: { parse: [] },
      })
      .catch(() => {});

    // Transcript
    let transcriptFile = null;
    let transcriptText = '';
    try {
      const { content, count } = await buildTranscript(channel, 1000);
      transcriptText = content;
      transcriptFile = new AttachmentBuilder(Buffer.from(content, 'utf8'), {
        name: `transcript-${channel.name}-${Date.now()}.txt`,
      });
      if (!count) transcriptFile = null;
    } catch (err) {
      logError('buildTranscript', err);
    }

    const transcriptEmbed = baseEmbed(COLORS.info, '📄 Ticket transcript')
      .addFields(
        { name: 'Ticket', value: `#${channel.name}`, inline: true },
        { name: 'Opened by', value: row ? `<@${row.user_id}>` : 'unknown', inline: true },
        { name: 'Closed by', value: `<@${closer.id}>`, inline: true },
        { name: 'Reason', value: truncate(reason, 1024), inline: false }
      );

    // Send transcript to the log channel
    const logChannelId = cfg.logchannel || settings.logchannel;
    if (logChannelId) {
      const logChannel = guild.channels.cache.get(logChannelId);
      if (logChannel && logChannel.isTextBased()) {
        await logChannel
          .send({
            embeds: [transcriptEmbed],
            files: transcriptFile ? [transcriptFile] : [],
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
    }

    // DM the ticket owner
    if (row) {
      const owner = await (guild.client || client).users.fetch(row.user_id).catch(() => null);
      if (owner) {
        const dmEmbed = baseEmbed(COLORS.info, '🎫 Your ticket was closed')
          .setDescription(transcriptText ? 'The transcript is attached below.' : 'No messages were recorded.')
          .addFields(
            { name: 'Server', value: guild.name, inline: true },
            { name: 'Closed by', value: `${closer.tag}`, inline: true },
            { name: 'Reason', value: truncate(reason, 1024), inline: false }
          );
        await owner
          .send({
            embeds: [dmEmbed],
            files: transcriptFile
              ? [new AttachmentBuilder(Buffer.from(transcriptText, 'utf8'), { name: `transcript-${channel.name}.txt` })]
              : [],
          })
          .catch(() => {});
      }
    }

    // Close log
    if (logChannelId) {
      const logChannel = guild.channels.cache.get(logChannelId);
      if (logChannel && logChannel.isTextBased()) {
        await logChannel
          .send({
            embeds: [
              baseEmbed(COLORS.error, '🔒 Ticket closed')
                .addFields(
                  { name: 'Ticket', value: `#${channel.name}`, inline: true },
                  { name: 'User', value: row ? `<@${row.user_id}>` : 'unknown', inline: true },
                  { name: 'Closed by', value: `<@${closer.id}>`, inline: true }
                ),
            ],
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
    }

    setTimeout(() => {
      channel.delete(`Ticket closed by ${closer.tag}`).catch(() => {});
      closingTickets.delete(channel.id);
    }, 5000);

    return { ok: true };
  } catch (err) {
    closingTickets.delete(channel.id);
    logError('closeTicket', err);
    return { ok: false, message: 'Something went wrong while closing the ticket.' };
  } finally {
    // guard is released inside the timeout, but always allow a retry after 15s at worst
    const t = setTimeout(() => closingTickets.delete(channel.id), 15000);
    if (t.unref) t.unref();
  }
}

/* ------------------------------------------------------------------------------------------
 * 14. GIVEAWAY SYSTEM
 * ---------------------------------------------------------------------------------------- */

const GW_DEFAULTS = {
  emoji: '🎉',
  banner: null,
  color: COLORS.giveaway,
  title: '🎉 GIVEAWAY 🎉',
  footer: 'Good luck everyone!',
};

async function getGwConfig(guildId) {
  let row = await dbGet('SELECT * FROM giveaway_config WHERE guild_id = ?', [guildId]);
  if (!row) {
    await dbRun(
      `INSERT OR IGNORE INTO giveaway_config (guild_id, emoji, color, title, footer) VALUES (?, ?, ?, ?, ?)`,
      [guildId, GW_DEFAULTS.emoji, GW_DEFAULTS.color, GW_DEFAULTS.title, GW_DEFAULTS.footer]
    );
    row = await dbGet('SELECT * FROM giveaway_config WHERE guild_id = ?', [guildId]);
  }
  const cfg = { ...GW_DEFAULTS, ...row };
  cfg.color = cfg.color === null || cfg.color === undefined ? COLORS.giveaway : Number(cfg.color);
  return cfg;
}

const GW_CONFIG_COLUMNS = new Set(['emoji', 'banner', 'color', 'title', 'footer']);

async function updateGwConfig(guildId, patch) {
  const keys = Object.keys(patch).filter((k) => GW_CONFIG_COLUMNS.has(k));
  if (!keys.length) return getGwConfig(guildId);
  const sql = `UPDATE giveaway_config SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE guild_id = ?`;
  await dbRun(sql, [...keys.map((k) => patch[k]), guildId]);
  return getGwConfig(guildId);
}

/** Builds the giveaway embed (running or ended). */
async function buildGiveawayEmbed(gw, entryCount, winnerIds = []) {
  const ended = Number(gw.ended) === 1;
  const embed = baseEmbed(Number(gw.color) || COLORS.giveaway, gw.title || GW_DEFAULTS.title)
    .setDescription(`## ${gw.prize}\n\n${ended ? '**Giveaway ended**' : 'Click the button below to enter!'}`)
    .addFields(
      { name: 'Host', value: `<@${gw.host_id}>`, inline: true },
      { name: 'Winners', value: String(gw.winners), inline: true },
      { name: 'Entries', value: String(entryCount), inline: true }
    );

  if (ended) {
    embed.addFields({
      name: '🏆 Winners',
      value: winnerIds.length ? winnerIds.map((id) => `<@${id}>`).join(', ') : 'No valid entries',
      inline: false,
    });
    embed.addFields({ name: 'Ended', value: `<t:${Math.floor(Number(gw.ends_at) / 1000)}:R>`, inline: true });
  } else {
    embed.addFields({ name: 'Ends', value: `<t:${Math.floor(Number(gw.ends_at) / 1000)}:R>`, inline: false });
    embed.addFields({ name: 'Ends at', value: `<t:${Math.floor(Number(gw.ends_at) / 1000)}:f>`, inline: true });
  }

  if (gw.role_required) {
    embed.addFields({ name: 'Requirement', value: `<@&${gw.role_required}>`, inline: true });
  }
  if (gw.banner && isHttpUrl(gw.banner)) embed.setImage(gw.banner);
  if (gw.footer && gw.footer !== 'off') embed.setFooter({ text: truncate(gw.footer, 2048) });
  return embed;
}

/** Button row for a giveaway. */
function buildGiveawayRow(gw) {
  const emoji = parseEmoji(gw.emoji || GW_DEFAULTS.emoji) || '🎉';
  const ended = Number(gw.ended) === 1;
  const btn = new ButtonBuilder()
    .setCustomId(`gw:enter:${gw.id}`)
    .setLabel(ended ? 'Giveaway ended' : 'Enter giveaway')
    .setStyle(ended ? ButtonStyle.Secondary : ButtonStyle.Primary)
    .setDisabled(ended)
    .setEmoji(emojiForButton(emoji));
  return new ActionRowBuilder().addComponents(btn);
}

async function countEntries(giveawayId) {
  const { c } = await dbGet('SELECT COUNT(*) AS c FROM giveaway_entries WHERE giveaway_id = ?', [giveawayId]);
  return c;
}

/** Debounced embed refresh (used when users click the entry button). */
const gwUpdateTimers = new Map();
function scheduleGiveawayRefresh(client, giveawayId) {
  if (gwUpdateTimers.has(giveawayId)) return;
  const t = setTimeout(async () => {
    gwUpdateTimers.delete(giveawayId);
    try {
      const gw = await dbGet('SELECT * FROM giveaways WHERE id = ?', [giveawayId]);
      if (!gw || Number(gw.ended) === 1) return;
      const count = await countEntries(giveawayId);
      const channel = await client.channels.fetch(gw.channel_id).catch(() => null);
      if (!channel || !channel.isTextBased()) return;
      const message = await channel.messages.fetch(gw.message_id).catch(() => null);
      if (!message) return;
      await message.edit({ embeds: [await buildGiveawayEmbed(gw, count)], components: [buildGiveawayRow(gw)] }).catch(() => {});
    } catch (err) {
      logError('scheduleGiveawayRefresh', err);
    }
  }, 1500);
  if (t.unref) t.unref();
  gwUpdateTimers.set(giveawayId, t);
}

/** Picks random valid winners for a giveaway. */
async function pickWinners(client, gw) {
  const guild = await client.guilds.fetch(gw.guild_id).catch(() => null);
  if (!guild) return [];
  const rows = await dbAll('SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?', [gw.id]);
  const valid = [];
  for (const { user_id } of rows) {
    const member = await guild.members.fetch(user_id).catch(() => null);
    if (!member) continue;
    if (gw.role_required && !member.roles.cache.has(gw.role_required)) continue;
    valid.push(user_id);
  }
  // Fisher-Yates shuffle
  for (let i = valid.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [valid[i], valid[j]] = [valid[j], valid[i]];
  }
  return valid.slice(0, Math.max(1, Number(gw.winners) || 1));
}

/** Ends a giveaway, edits the message and announces winners. */
async function endGiveaway(client, giveawayId, opts = {}) {
  const gw = await dbGet('SELECT * FROM giveaways WHERE id = ?', [giveawayId]);
  if (!gw) return { ok: false, message: 'Giveaway not found.' };
  if (Number(gw.ended) === 1 && !opts.reroll) return { ok: false, message: 'This giveaway already ended.' };

  const winners = await pickWinners(client, gw);
  const entryCount = await countEntries(gw.id);

  await dbRun('UPDATE giveaways SET ended = 1 WHERE id = ?', [gw.id]);

  const channel = await client.channels.fetch(gw.channel_id).catch(() => null);
  let message = null;
  if (channel && channel.isTextBased()) {
    message = await channel.messages.fetch(gw.message_id).catch(() => null);
    if (message) {
      const updated = { ...gw, ended: 1 };
      await message
        .edit({ embeds: [await buildGiveawayEmbed(updated, entryCount, winners)], components: [buildGiveawayRow(updated)] })
        .catch(() => {});
    }
    // Announce
    const announce = winners.length
      ? `🎉 Congratulations ${winners.map((id) => `<@${id}>`).join(', ')}! You won **${gw.prize}**!`
      : `😢 No valid entries for **${gw.prize}** — no winners this time.`;
    await channel
      .send({
        content: announce,
        allowedMentions: { users: winners },
      })
      .catch(() => {});
  }
  return { ok: true, winners, entryCount };
}

/** Scheduler: ends giveaways whose time has come (survives restarts thanks to SQLite). */
async function giveawayScheduler(client) {
  try {
    const due = await dbAll('SELECT * FROM giveaways WHERE ended = 0 AND ends_at <= ?', [Date.now()]);
    for (const gw of due) await endGiveaway(client, gw.id).catch((err) => logError('endGiveaway', err));
  } catch (err) {
    logError('giveawayScheduler', err);
  }
}

/* ==========================================================================================
 * 14b. EXTENDED FEATURE HELPERS
 *      Access control · anti-spam config · invite tracking · verification · channel lock
 *      DM system · invite leaderboard
 * ======================================================================================== */

/* ------------------------------------------------------------------------------------------
 * 14b.1  MAIN OWNER + ADMIN ACCESS CONTROL
 *        "Only the main owner can hand out access to admin commands."
 *        Main owner = the server owner, or whoever the server owner set with !mainowner set.
 *        Granted users live in `bot_access`; strict mode is settings.admin_only (default on).
 * ---------------------------------------------------------------------------------------- */

async function getMainOwnerId(guildId) {
  const row = await dbGet('SELECT user_id FROM main_owner WHERE guild_id = ?', [guildId]);
  return row ? row.user_id : null;
}

async function setMainOwnerId(guildId, userId) {
  await dbRun(
    'INSERT INTO main_owner (guild_id, user_id) VALUES (?, ?) ON CONFLICT(guild_id) DO UPDATE SET user_id = excluded.user_id',
    [guildId, userId]
  );
}

/** True for the Discord server owner and for the configured main owner. */
async function isMainOwner(guild, userId) {
  if (!guild || !userId) return false;
  if (userId === guild.ownerId) return true;
  return (await getMainOwnerId(guild.id)) === userId;
}

const accessCache = new Map(); // guildId -> Map(userId -> row)

async function getAccessList(guildId) {
  const cached = accessCache.get(guildId);
  if (cached) return cached;
  const rows = await dbAll('SELECT * FROM bot_access WHERE guild_id = ? ORDER BY granted_at ASC', [guildId]);
  const map = new Map(rows.map((r) => [r.user_id, r]));
  accessCache.set(guildId, map);
  return map;
}

function invalidateAccess(guildId) {
  accessCache.delete(guildId);
}

async function grantAccess(guildId, userId, grantedBy) {
  await dbRun(
    `INSERT INTO bot_access (guild_id, user_id, granted_by, granted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET granted_by = excluded.granted_by, granted_at = excluded.granted_at`,
    [guildId, userId, grantedBy, Date.now()]
  );
  invalidateAccess(guildId);
}

async function revokeAccess(guildId, userId) {
  const res = await dbRun('DELETE FROM bot_access WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  invalidateAccess(guildId);
  return res.changes > 0;
}

/** Main owner always; otherwise only users on the granted list. */
async function hasAdminAccess(guild, userId) {
  if (await isMainOwner(guild, userId)) return true;
  const list = await getAccessList(guild.id);
  return list.has(userId);
}

/* ------------------------------------------------------------------------------------------
 * 14b.1a  OWNER OMNIPOTENCE
 *   The main owner (server owner or `!mainowner set`) and everybody the main owner granted
 *   access to (`!access add`) passes **every** command permission check, DJ/hierarchy check
 *   and anti-nuke gate. The flag is computed once per message / interaction and cached on
 *   the object, so all the checks below can stay synchronous.
 * ---------------------------------------------------------------------------------------- */

/** Resolves and stores the privilege flag on a message / interaction. */
async function markPrivileged(actor) {
  if (!actor || !actor.guild) return false;
  const userId = (actor.author && actor.author.id) || (actor.user && actor.user.id) || null;
  if (!userId) return false;
  const privileged = await hasAdminAccess(actor.guild, userId);
  actor.__privileged = privileged;
  if (actor.member) actor.member.__privileged = privileged;
  return privileged;
}

/** Synchronous read of the cached flag (cheap fallback for the server owner). */
function actorPrivileged(actor) {
  if (!actor) return false;
  if (actor.__privileged) return true;
  const member = actor.member || actor;
  if (member && member.__privileged) return true;
  const guild = actor.guild || (member && member.guild);
  const userId =
    (actor.author && actor.author.id) ||
    (actor.user && actor.user.id) ||
    (actor.id && !actor.permissions ? actor.id : null) ||
    (member && member.id) ||
    null;
  return !!(guild && guild.ownerId && userId && guild.ownerId === userId);
}

/**
 * Permission check used by every command / button / menu.
 * Main owner + granted users always pass; everyone else needs the real permission.
 */
function hasPerm(actor, flag) {
  if (flag === undefined || flag === null) return true;
  if (actorPrivileged(actor)) return true;
  const member = actor && actor.member ? actor.member : actor;
  return !!(member && member.permissions && member.permissions.has(flag));
}

/**
 * Gate for every command in ADMIN_COMMANDS.
 *  • main owner  -> always allowed
 *  • mainOwnerOnly command -> denied for everyone else
 *  • strict mode ON (default)  -> needs a granted access entry
 *  • strict mode OFF           -> normal Discord permission check is enough
 */
async function assertAdminAccess(message, settings, opts = {}) {
  const author = message.author.id;
  if (await isMainOwner(message.guild, author)) return true;

  if (opts.mainOwnerOnly) {
    await reply(
      message,
      errEmbed('❌ Main owner only', 'This command can only be used by the **main owner** of this server.')
    );
    return false;
  }

  if (Number(settings.admin_only) !== 1) return true;

  if (await hasAdminAccess(message.guild, author)) return true;

  await reply(
    message,
    errEmbed(
      '❌ Access denied',
      'Admin commands on this server are protected.\n' +
        'Only the **main owner** can grant access with `!access add @user`.\n' +
        '-# Main owner can also relax this with `!access strict off`.'
    )
  );
  return false;
}

/* Commands that require main-owner / granted access while strict mode is on. */
const ADMIN_COMMANDS = new Set([
  'antispam',
  'blockword',
  'botconfig',
  'roleall',
  'welcome',
  'ticket',
  'giveaway',
  'announce',
  'verify',
  'dmconfig',
  'logchannel',
  'setautorole',
  'removeautorole',
  'access',
  'mainowner',
  'emoji',
  'dm',
  'reply',
  'roleall',
]);

/* ------------------------------------------------------------------------------------------
 * 14b.2  ANTI-SPAM CONFIGURATION (per guild, validated keys + ranges)
 * ---------------------------------------------------------------------------------------- */

const ANTISPAM_DEFAULTS = {
  flood_count: 5,
  flood_window: 5,
  dup_count: 3,
  dup_window: 10,
  mention_count: 5,
  link_count: 4,
  invite_block: 1,
  timeout_secs: 300,
  enabled: 1,
};

/** key -> { min, max, label, unit } */
const ANTISPAM_KEYS = new Map([
  ['flood_count', { min: 2, max: 25, label: 'messages for flooding', unit: 'msgs' }],
  ['flood_window', { min: 1, max: 120, label: 'flood window', unit: 'seconds' }],
  ['dup_count', { min: 2, max: 20, label: 'identical messages', unit: 'msgs' }],
  ['dup_window', { min: 2, max: 300, label: 'duplicate window', unit: 'seconds' }],
  ['mention_count', { min: 2, max: 50, label: 'mentions in one message', unit: 'mentions' }],
  ['link_count', { min: 2, max: 25, label: 'links in one message', unit: 'links' }],
  ['invite_block', { min: 0, max: 1, label: 'delete discord invites', unit: '0/1' }],
  ['timeout_secs', { min: 10, max: 2419200, label: 'timeout length', unit: 'seconds' }],
  ['enabled', { min: 0, max: 1, label: 'anti-spam enabled', unit: '0/1' }],
]);

async function getAntiSpamConfig(guildId) {
  let row = await dbGet('SELECT * FROM antispam_config WHERE guild_id = ?', [guildId]);
  if (!row) {
    await dbRun('INSERT OR IGNORE INTO antispam_config (guild_id) VALUES (?)', [guildId]);
    row = await dbGet('SELECT * FROM antispam_config WHERE guild_id = ?', [guildId]);
  }
  const cfg = { ...ANTISPAM_DEFAULTS };
  for (const key of ANTISPAM_KEYS.keys()) {
    const value = row && row[key];
    cfg[key] = value === null || value === undefined ? ANTISPAM_DEFAULTS[key] : Number(value);
  }
  return cfg;
}

/** Whitelisted, range-checked update. Returns { config, errors }. */
async function updateAntiSpamConfig(guildId, patch) {
  const errors = [];
  const sets = [];
  const values = [];

  for (const [key, raw] of Object.entries(patch)) {
    const meta = ANTISPAM_KEYS.get(key);
    if (!meta) {
      errors.push(`unknown setting \`${key}\``);
      continue;
    }
    const num = Number(raw);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < meta.min || num > meta.max) {
      errors.push(`\`${key}\` must be a whole number between **${meta.min}** and **${meta.max}** (${meta.unit})`);
      continue;
    }
    sets.push(`${key} = ?`);
    values.push(num);
  }

  if (sets.length) {
    await dbRun('UPDATE antispam_config SET ' + sets.join(', ') + ' WHERE guild_id = ?', [...values, guildId]);
  }
  return { config: await getAntiSpamConfig(guildId), errors };
}

/* ------------------------------------------------------------------------------------------
 * 14b.3  INVITE TRACKING
 * ---------------------------------------------------------------------------------------- */

const inviteCache = new Map(); // guildId -> Map(code -> { uses, inviterId, code })

async function syncInvites(guild) {
  try {
    const invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return null;
    const map = new Map();
    for (const invite of invites.values()) {
      map.set(invite.code, { uses: invite.uses || 0, inviterId: invite.inviter ? invite.inviter.id : null, code: invite.code });
    }
    inviteCache.set(guild.id, map);
    return map;
  } catch (err) {
    logError('syncInvites', err);
    return null;
  }
}

function getCachedInvites(guildId) {
  return inviteCache.get(guildId) || new Map();
}

async function handleInviteCreate(invite) {
  try {
    if (!invite.guild) return;
    const map = getCachedInvites(invite.guild.id);
    map.set(invite.code, {
      uses: invite.uses || 0,
      inviterId: invite.inviter ? invite.inviter.id : null,
      code: invite.code,
    });
    inviteCache.set(invite.guild.id, map);
  } catch (err) {
    logError('handleInviteCreate', err);
  }
}

async function handleInviteDelete(invite) {
  try {
    if (!invite.guild) return;
    const map = getCachedInvites(invite.guild.id);
    map.delete(invite.code);
    inviteCache.set(invite.guild.id, map);
  } catch (err) {
    logError('handleInviteDelete', err);
  }
}

/**
 * Figures out who invited a new member by diffing the cached invite uses.
 * Falls back to a fresh fetch when the cache is cold (e.g. right after a restart).
 */
async function findInviter(guild, member) {
  try {
    let before = getCachedInvites(guild.id);
    if (!before.size) before = (await syncInvites(guild)) || new Map();

    let invites = await guild.invites.fetch().catch(() => null);
    if (!invites) return { inviterId: null, code: null };

    for (const invite of invites.values()) {
      const old = before.get(invite.code);
      const oldUses = old ? old.uses : 0;
      if ((invite.uses || 0) > oldUses) {
        const inviterId = invite.inviter ? invite.inviter.id : (old && old.inviterId) || null;
        // refresh the cache with the new state
        before.set(invite.code, { uses: invite.uses || 0, inviterId, code: invite.code });
        inviteCache.set(guild.id, before);
        return { inviterId, code: invite.code };
      }
    }

    // unknown source (vanity URL / one-time invite / cache miss) — still refresh
    await syncInvites(guild);
    return { inviterId: null, code: null };
  } catch (err) {
    logError('findInviter', err);
    return { inviterId: null, code: null };
  }
}

async function addInviteJoin(guildId, userId) {
  await dbRun(
    `INSERT INTO invites (guild_id, user_id, joins) VALUES (?, ?, 1)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET joins = joins + 1`,
    [guildId, userId]
  );
}

async function addInviteLeave(guildId, userId) {
  await dbRun(
    `INSERT INTO invites (guild_id, user_id, leaves) VALUES (?, ?, 1)
     ON CONFLICT(guild_id, user_id) DO UPDATE SET leaves = leaves + 1`,
    [guildId, userId]
  );
}

async function getInviteStats(guildId, userId) {
  const row = await dbGet('SELECT * FROM invites WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  const joins = row ? Number(row.joins) || 0 : 0;
  const leaves = row ? Number(row.leaves) || 0 : 0;
  return { joins, leaves, total: Math.max(0, joins - leaves) };
}

async function resetInvites(guildId, userId = null) {
  if (userId) {
    const res = await dbRun('DELETE FROM invites WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return res.changes;
  }
  const res = await dbRun('DELETE FROM invites WHERE guild_id = ?', [guildId]);
  return res.changes;
}

async function inviteLeaderboard(guildId, limit = 10) {
  const rows = await dbAll(
    `SELECT user_id, SUM(joins) AS joins, SUM(leaves) AS leaves FROM invites WHERE guild_id = ?
     GROUP BY user_id ORDER BY joins DESC LIMIT ?`,
    [guildId, limit]
  );
  return rows.map((r) => ({
    userId: r.user_id,
    joins: Number(r.joins) || 0,
    leaves: Number(r.leaves) || 0,
    total: Math.max(0, (Number(r.joins) || 0) - (Number(r.leaves) || 0)),
  }));
}

/* ------------------------------------------------------------------------------------------
 * 14b.4  VERIFICATION SYSTEM
 * ---------------------------------------------------------------------------------------- */

const VERIFY_DEFAULTS = {
  title: '✅ Server Verification',
  message:
    'Click the button below to verify yourself and unlock the server.\n\n' +
    'This proves you are human and keeps the raids out. It only takes one click.',
  button: 'Verify',
  emoji: '✅',
  color: 0x57f287,
  role: null,
  channel: null,
  logchannel: null,
  banner: null,
  enabled: 1,
};

const VERIFY_COLUMNS = new Set(['title', 'message', 'button', 'emoji', 'color', 'role', 'channel', 'logchannel', 'banner', 'enabled']);

async function getVerifyConfig(guildId) {
  let row = await dbGet('SELECT * FROM verify_config WHERE guild_id = ?', [guildId]);
  if (!row) {
    await dbRun(
      `INSERT OR IGNORE INTO verify_config (guild_id, title, message, button, emoji, color, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      [guildId, VERIFY_DEFAULTS.title, VERIFY_DEFAULTS.message, VERIFY_DEFAULTS.button, VERIFY_DEFAULTS.emoji, VERIFY_DEFAULTS.color]
    );
    row = await dbGet('SELECT * FROM verify_config WHERE guild_id = ?', [guildId]);
  }
  const cfg = { ...VERIFY_DEFAULTS, ...row };
  cfg.color = cfg.color === null || cfg.color === undefined ? VERIFY_DEFAULTS.color : Number(cfg.color);
  cfg.enabled = Number(cfg.enabled);
  return cfg;
}

async function updateVerifyConfig(guildId, patch) {
  const keys = Object.keys(patch).filter((k) => VERIFY_COLUMNS.has(k));
  if (!keys.length) return getVerifyConfig(guildId);
  await dbRun(
    'UPDATE verify_config SET ' + keys.map((k) => `${k} = ?`).join(', ') + ' WHERE guild_id = ?',
    [...keys.map((k) => patch[k]), guildId]
  );
  return getVerifyConfig(guildId);
}

/** Panel payload for !verify panel (embed + one button). */
function buildVerifyPanel(cfg) {
  const embed = baseEmbed(cfg.color, cfg.title, cfg.message);
  const emoji = parseEmoji(cfg.emoji);
  if (emoji) embed.setThumbnail(null) ;
  if (cfg.banner && isHttpUrl(cfg.banner)) embed.setImage(cfg.banner);
  embed.setFooter({ text: 'Click the button to verify' });

  const button = new ButtonBuilder()
    .setCustomId('verify:grant')
    .setLabel(truncate(cfg.button || 'Verify', 80))
    .setStyle(ButtonStyle.Success);
  if (emoji) button.setEmoji(emojiForButton(emoji));

  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(button)] };
}

/* ------------------------------------------------------------------------------------------
 * 14b.5  CHANNEL LOCK / UNLOCK (previous state is remembered so unlock can restore it)
 * ---------------------------------------------------------------------------------------- */

/* Named pairs (name + bit) — discord.js needs the names when editing overwrites. */
const LOCK_BITS = [
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['SendMessagesInThreads', PermissionFlagsBits.SendMessagesInThreads],
  ['CreatePublicThreads', PermissionFlagsBits.CreatePublicThreads],
  ['CreatePrivateThreads', PermissionFlagsBits.CreatePrivateThreads],
  ['AddReactions', PermissionFlagsBits.AddReactions],
];

async function lockChannel(channel, moderator, reason = 'Channel locked') {
  const guild = channel.guild;
  const everyone = guild.roles.everyone;

  // remember the previous @everyone overwrite for these bits
  const current = channel.permissionOverwrites.cache.get(guild.id);
  const prev = {
    allow: current ? current.allow.bitfield.toString() : null,
    deny: current ? current.deny.bitfield.toString() : null,
  };
  await dbRun(
    'INSERT INTO locked_channels (guild_id, channel_id, prev) VALUES (?, ?, ?) ON CONFLICT(guild_id, channel_id) DO UPDATE SET prev = excluded.prev',
    [guild.id, channel.id, JSON.stringify(prev)]
  );

  await channel.permissionOverwrites.edit(
    everyone.id,
    {
      SendMessages: false,
      SendMessagesInThreads: false,
      CreatePublicThreads: false,
      CreatePrivateThreads: false,
      AddReactions: false,
    },
    { reason: `${reason} • by ${moderator.tag}` }
  );

  return prev;
}

async function unlockChannel(channel, moderator, reason = 'Channel unlocked') {
  const guild = channel.guild;
  const row = await dbGet('SELECT * FROM locked_channels WHERE guild_id = ? AND channel_id = ?', [guild.id, channel.id]);
  let restored = false;

  if (row) {
    try {
      const prev = JSON.parse(row.prev);
      const allow = prev.allow ? BigInt(prev.allow) : 0n;
      const deny = prev.deny ? BigInt(prev.deny) : 0n;
      const patch = {};
      for (const [name, bit] of LOCK_BITS) {
        const wasAllowed = (allow & bit) === bit;
        const wasDenied = (deny & bit) === bit;
        patch[name] = wasAllowed ? true : wasDenied ? false : null;
      }
      await channel.permissionOverwrites.edit(guild.roles.everyone.id, patch, { reason: `${reason} • by ${moderator.tag}` });
      restored = true;
    } catch (err) {
      logError('unlockChannel:restore', err);
    }
  }

  if (!restored) {
    // no saved state — just re-allow sending for @everyone
    await channel.permissionOverwrites.edit(
      guild.roles.everyone.id,
      { SendMessages: null, SendMessagesInThreads: null, CreatePublicThreads: null, CreatePrivateThreads: null, AddReactions: null },
      { reason: `${reason} • by ${moderator.tag}` }
    );
  }

  await dbRun('DELETE FROM locked_channels WHERE guild_id = ? AND channel_id = ?', [guild.id, channel.id]);
  return restored;
}

/* ------------------------------------------------------------------------------------------
 * 14b.6  DM SYSTEM (staff → user DMs + optional DM relay inbox)
 * ---------------------------------------------------------------------------------------- */

async function getDmConfig(guildId) {
  let row = await dbGet('SELECT * FROM dm_config WHERE guild_id = ?', [guildId]);
  if (!row) {
    await dbRun('INSERT OR IGNORE INTO dm_config (guild_id, enabled) VALUES (?, 0)', [guildId]);
    row = await dbGet('SELECT * FROM dm_config WHERE guild_id = ?', [guildId]);
  }
  return { enabled: Number(row.enabled) || 0, channel: row.channel || null };
}

async function updateDmConfig(guildId, patch) {
  const sets = [];
  const values = [];
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(Number(patch.enabled) ? 1 : 0);
  }
  if (patch.channel !== undefined) {
    sets.push('channel = ?');
    values.push(patch.channel);
  }
  if (sets.length) await dbRun('UPDATE dm_config SET ' + sets.join(', ') + ' WHERE guild_id = ?', [...values, guildId]);
  return getDmConfig(guildId);
}

/** Sends a nicely formatted DM to a user (never throws). */
async function sendUserDm(client, userId, { title, description, color = COLORS.info, guildName = null, files = [] }) {
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return { ok: false, reason: 'user not found' };
    const embed = baseEmbed(color, title, description);
    if (guildName) embed.setFooter({ text: `From ${guildName}` });
    await user.send({ embeds: [embed], files });
    return { ok: true, user };
  } catch (err) {
    return { ok: false, reason: 'DMs closed or blocked' };
  }
}

/** Relays a DM sent to the bot into the configured inbox channel. */
async function relayDirectMessage(client, message) {
  try {
    const guilds = [...client.guilds.cache.values()];
    for (const guild of guilds) {
      const cfg = await getDmConfig(guild.id);
      if (!cfg.enabled || !cfg.channel) continue;
      const channel = guild.channels.cache.get(cfg.channel) || (await guild.channels.fetch(cfg.channel).catch(() => null));
      if (!channel || !channel.isTextBased()) continue;

      const embed = baseEmbed(COLORS.info, '📨 New direct message')
        .setAuthor({
          name: message.author.tag || message.author.username || 'unknown',
          iconURL: message.author.displayAvatarURL ? message.author.displayAvatarURL({ size: 128 }) : undefined,
        })
        .setDescription(truncate(message.content || '*(no text)*', 4000))
        .addFields(
          { name: 'User', value: `<@${message.author.id}>`, inline: true },
          { name: 'User ID', value: `\`${message.author.id}\``, inline: true },
          { name: 'Server', value: guild.name, inline: true }
        )
        .setFooter({ text: `Reply with: !reply ${message.author.id} <message>` });

      const files = [];
      for (const att of [...message.attachments.values()].slice(0, 10)) {
        const buffer = await fetch(att.url).then((r) => (r.ok ? r.arrayBuffer() : null)).then((ab) => (ab ? Buffer.from(ab) : null)).catch(() => null);
        if (buffer) files.push(new AttachmentBuilder(buffer, { name: att.name || 'attachment' }));
      }

      await channel.send({ embeds: [embed], files, allowedMentions: { parse: [] } }).catch(() => {});
      return true;
    }
    return false;
  } catch (err) {
    logError('relayDirectMessage', err);
    return false;
  }
}

/* ------------------------------------------------------------------------------------------
 * 14b.7  HELP CATEGORIES (dropdown driven)
 * ---------------------------------------------------------------------------------------- */

/** Unique command definitions, keyed by primary name. */
function uniqueCommands() {
  const map = new Map();
  for (const cmd of commands.values()) {
    if (!map.has(cmd.name)) map.set(cmd.name, cmd);
  }
  return map;
}

const CATEGORY_ORDER = [
  'General',
  'Anti-Nuke',
  'Anti-Spam',
  'Automation',
  'Moderation',
  'Warnings',
  'Roles & AFK',
  'Info',
  'Verification',
  'DM System',
  'Music',
  'Access Control',
  'Welcome',
  'Tickets',
  'Giveaways',
  'Announcements',
];

const CATEGORY_EMOJI = {
  General: '⚙️',
  'Anti-Nuke': '🛡️',
  'Anti-Spam': '🚫',
  Automation: '🤖',
  Moderation: '🔨',
  Warnings: '⚠️',
  'Roles & AFK': '🎭',
  Info: '📊',
  Verification: '✅',
  'DM System': '📨',
  Music: '🎵',
  'Access Control': '🔑',
  Welcome: '👋',
  Tickets: '🎫',
  Giveaways: '🎉',
  Announcements: '📢',
};

/** Groups commands by category, in CATEGORY_ORDER. */
function groupCommands() {
  const groups = new Map();
  for (const cmd of uniqueCommands().values()) {
    const cat = CATEGORY_ORDER.includes(cmd.category) ? cmd.category : 'General';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(cmd);
  }
  for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const ordered = new Map();
  for (const cat of CATEGORY_ORDER) if (groups.has(cat)) ordered.set(cat, groups.get(cat));
  return ordered;
}

const BOT_AUTHOR = 'Made by AashirwadGamerzz';

/** Help dropdown (select menu) shared by the overview and the per-category pages. */
function buildHelpSelect(current = 'overview') {
  const groups = groupCommands();
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help:cat')
    .setPlaceholder('Choose a category…')
    .setMinValues(1)
    .setMaxValues(1);

  menu.addOptions({
    label: 'Overview — all categories',
    value: 'overview',
    emoji: '🏠',
    default: current === 'overview',
  });

  for (const [cat, list] of groups) {
    if (menu.options.length >= 25) break;
    menu.addOptions({
      label: `${cat} (${list.length} ${list.length === 1 ? 'command' : 'commands'})`.slice(0, 100),
      value: cat,
      emoji: CATEGORY_EMOJI[cat] || '📁',
      default: current === cat ? true : undefined,
    });
  }
  return new ActionRowBuilder().addComponents(menu);
}

/** Front page: header · About · prefix · category list with counts. */
function buildHelpOverview(msg, settings) {
  const p = settings.prefix;
  const groups = groupCommands();
  const total = [...groups.values()].reduce((sum, list) => sum + list.length, 0);
  const clientRef = (msg.client && msg.client.user) || client.user;
  const me = clientRef;

  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setAuthor({ name: `${me.username} — Help`, iconURL: me.displayAvatarURL({ size: 128 }) })
    .setTitle('📖 Command Help')
    .setDescription(
      [
        '**About**',
        `An all-in-one moderation, security and community bot: anti-nuke, anti-spam, tickets, giveaways, verification, invite tracking and more.`,
        '',
        `**Prefix:** \`${p}\`  •  **Commands:** ${total}  •  **Ping:** ${Math.max(0, Math.round(((msg.client && msg.client.ws) || client.ws || {}).ping || 0))}ms`,
        `Use \`${p}help <command>\` for details, or pick a category in the menu below.`,
      ].join('\n')
    )
    .setThumbnail(me.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${BOT_AUTHOR}  •  ${msg.guild.name}` })
    .setTimestamp();

  const lines = [];
  for (const [cat, list] of groups) {
    lines.push(`${CATEGORY_EMOJI[cat] || '📁'} **${cat}** — ${list.length} ${list.length === 1 ? 'command' : 'commands'}`);
  }
  embed.addFields({ name: '📂 Categories', value: truncate(lines.join('\n'), 1024) || '—' });

  return { embeds: [embed], components: [buildHelpSelect('overview')] };
}

/** One category page (shown after picking from the dropdown). */
function buildHelpCategory(msg, settings, category) {
  const p = settings.prefix;
  const groups = groupCommands();
  const list = groups.get(category);
  const me = (msg.client && msg.client.user) || client.user;

  if (!list) return buildHelpOverview(msg, settings);

  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setAuthor({ name: `${me.username} — Help`, iconURL: me.displayAvatarURL({ size: 128 }) })
    .setTitle(`${CATEGORY_EMOJI[category] || '📁'} ${category} — ${list.length} ${list.length === 1 ? 'command' : 'commands'}`)
    .setDescription(`**Prefix:** \`${p}\`\n${list.map((c) => `\`${p}${c.usage}\`\n-# ${c.description}`).join('\n\n')}`)
    .setThumbnail(me.displayAvatarURL({ size: 256 }))
    .setFooter({ text: `${BOT_AUTHOR}  •  ${msg.guild.name}` })
    .setTimestamp();

  return { embeds: [embed], components: [buildHelpSelect(category)] };
}

/** Single command page: !help <command> */
function buildHelpCommand(msg, settings, cmd) {
  const p = settings.prefix;
  const me = (msg.client && msg.client.user) || client.user;
  const flags = [];
  if (cmd.permission) flags.push('requires a Discord permission');
  if (cmd.admin) flags.push('admin command (main owner / granted access)');
  if (cmd.mainOwnerOnly) flags.push('main owner only');
  if (cmd.aliases && cmd.aliases.length) flags.push(`aliases: ${cmd.aliases.map((a) => `\`${p}${a}\``).join(', ')}`);

  const embed = new EmbedBuilder()
    .setColor(COLORS.main)
    .setAuthor({ name: `${me.username} — Help`, iconURL: me.displayAvatarURL({ size: 128 }) })
    .setTitle(`${CATEGORY_EMOJI[cmd.category] || '📁'} ${p}${cmd.name}`)
    .setDescription(`${cmd.description}\n\n**Usage**\n\`${p}${cmd.usage}\`\n\n**Category**\n${cmd.category}${flags.length ? `\n\n**Notes**\n${flags.map((f) => `• ${f}`).join('\n')}` : ''}`)
    .setFooter({ text: `${BOT_AUTHOR}  •  ${msg.guild.name}` })
    .setTimestamp();

  return { embeds: [embed], components: [buildHelpSelect(cmd.category)] };
}

/* ==========================================================================================
 * 14c. MUSIC ENGINE  (ported from bot.py — yt-dlp CLI + ffmpeg + @discordjs/voice)
 *
 *     Node equivalents of the Python requirements:
 *       PyNaCl              -> libsodium-wrappers        (npm, voice encryption)
 *       discord.py[voice]   -> @discordjs/voice          (npm)
 *       yt-dlp[default]     -> yt-dlp CLI                (pip install -U "yt-dlp[default]" / binary)
 *       pydub               -> not needed (ffmpeg decodes)
 *       imageio-ffmpeg      -> ffmpeg binary             (system / FFMPEG_PATH / ffmpeg-static)
 *       python-dotenv       -> built-in .env loader      (section 0a)
 *       audioop-lts         -> not needed (no audioop in Node)
 *
 *     Audio is never downloaded to disk:  yt-dlp stdout -> ffmpeg -> Discord voice.
 *     MUSIC_STREAM=opus (default, low CPU) | pcm (raw PCM + inlineVolume)
 * ======================================================================================== */

const MUSIC_COLORS = {
  playing: 0x1db954,
  queued: 0x5865f2,
  paused: 0xfaa61a,
  error: 0xed4245,
  skip: 0xeb459e,
  stop: 0x99aab5,
  radio: 0xff6b6b,
  filter: 0x9b59b6,
};

/** Filter presets (same list as bot.py). */
const MUSIC_FILTERS = new Map([
  ['off', { label: 'Off', speed: 1.0, bass: 0, desc: 'No filter' }],
  ['bassboost', { label: 'Bass Boost', speed: 1.0, bass: 12, desc: 'Enhanced bass' }],
  ['nightcore', { label: 'Nightcore', speed: 1.25, bass: 0, desc: 'Faster + higher pitch' }],
  ['vaporwave', { label: 'Vaporwave', speed: 0.85, bass: 3, desc: 'Slow + dreamy' }],
  ['8d', { label: '8D Audio', speed: 1.0, bass: 0, desc: 'Rotating audio', spatial: true }],
  ['lofi', { label: 'Lo-Fi', speed: 0.9, bass: 5, desc: 'Chill vibes', lowpass: 3200 }],
  ['treble', { label: 'Treble Boost', speed: 1.0, bass: -8, desc: 'Crisp highs' }],
]);

const EQ_FRAMES = ['▁▃▅▇', '▃▅▇▅', '▅▇▅▃', '▇▅▃▁', '▅▃▁▃', '▃▁▃▅'];
const musicEqFrame = (sec) => EQ_FRAMES[Math.floor(sec * 4) % EQ_FRAMES.length];

/** ▬▬▬🔘▬▬▬ progress bar, or LIVE for streams. */
function musicProgressBar(elapsed, total, length = 16) {
  if (!total || total <= 0) return '🔴 `LIVE`';
  const ratio = Math.max(0, Math.min(1, elapsed / total));
  const filled = Math.round(length * ratio);
  return `${'▬'.repeat(Math.max(0, filled))}🔘${'▬'.repeat(Math.max(0, length - filled - 1))}`;
}

/** 3725 -> "1:02:05" */
function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------------------------------
 * 14c.1  BINARY DETECTION (yt-dlp + ffmpeg) with version probe + actionable errors
 * ---------------------------------------------------------------------------------------- */

const musicBinCache = { at: 0, result: null };

/** Runs `<cmd> <args>` and returns { ok, stdout, stderr }. Never throws. */
function runBinary(cmd, args, timeoutMs = 20000) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, stdout: '', stderr: String(err.message || err) });
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
      done({ ok: false, stdout, stderr: `${cmd} timed out` });
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      if (stdout.length > 8000000) {
        try {
          child.kill('SIGKILL');
        } catch (_) {
          /* ignore */
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(0, 4000);
    });
    child.on('error', (err) =>
      done({ ok: false, stdout, stderr: err.code === 'ENOENT' ? `${cmd} not found` : String(err.message || err) })
    );
    child.on('close', (code) => done({ ok: code === 0, stdout, stderr }));
  });
}

/**
 * Finds yt-dlp and ffmpeg. Cached for 60s.
 * Returns { ytdlp, ffmpeg, ffmpegVersion, errors, ok }
 */
async function detectMusicBinaries(force = false) {
  if (!force && musicBinCache.result && Date.now() - musicBinCache.at < 60000) return musicBinCache.result;

  const errors = [];
  let ffmpeg = null;

  // ---- ffmpeg ----
  for (const candidate of [process.env.FFMPEG_PATH, 'ffmpeg', 'ffmpeg.exe'].filter(Boolean)) {
    const res = await runBinary(candidate, ['-version'], 8000);
    if (res.ok && /ffmpeg version/i.test(res.stdout)) {
      ffmpeg = candidate;
      break;
    }
  }
  if (!ffmpeg) {
    try {
      const staticPath = require('ffmpeg-static'); // optional npm package
      if (staticPath) {
        const res = await runBinary(staticPath, ['-version'], 8000);
        if (res.ok) ffmpeg = staticPath;
      }
    } catch (_) {
      /* not installed */
    }
  }
  if (!ffmpeg) {
    errors.push('ffmpeg not found — `apt install ffmpeg` / `brew install ffmpeg`, or set FFMPEG_PATH, or `npm i ffmpeg-static`');
  }

  // ---- yt-dlp ----
  let ytdlp = null;
  const candidates = [
    process.env.YTDLP_PATH ? { cmd: process.env.YTDLP_PATH, baseArgs: [] } : null,
    { cmd: 'yt-dlp', baseArgs: [] },
    { cmd: 'yt-dlp.exe', baseArgs: [] },
    { cmd: 'youtube-dl', baseArgs: [] },
    { cmd: process.env.PYTHON_PATH || 'python3', baseArgs: ['-m', 'yt_dlp'] },
    { cmd: 'python', baseArgs: ['-m', 'yt_dlp'] },
  ].filter(Boolean);

  for (const candidate of candidates) {
    const res = await runBinary(candidate.cmd, [...candidate.baseArgs, '--version'], 15000);
    const version = res.stdout.trim().split('\n')[0];
    if (res.ok && version) {
      ytdlp = { cmd: candidate.cmd, baseArgs: candidate.baseArgs, version };
      break;
    }
  }
  if (!ytdlp) {
    errors.push('yt-dlp not found — `pip install -U "yt-dlp[default]"` (or a standalone binary), or set YTDLP_PATH');
  }

  let ffmpegVersion = null;
  if (ffmpeg) {
    const res = await runBinary(ffmpeg, ['-version'], 8000);
    const m = res.stdout.match(/ffmpeg version (\S+)/i);
    ffmpegVersion = m ? m[1] : 'unknown';
  }

  const result = { ytdlp, ffmpeg, ffmpegVersion, errors, ok: !!(ytdlp && ffmpeg) };
  musicBinCache.at = Date.now();
  musicBinCache.result = result;
  return result;
}

/* ------------------------------------------------------------------------------------------
 * 14c.2  VOICE LIBRARY (lazy) — the rest of the bot keeps working without it
 * ---------------------------------------------------------------------------------------- */

let voiceLib = null;
let voiceLibError = null;

function loadVoiceLib() {
  if (voiceLib) return voiceLib;
  if (voiceLibError) return null;
  try {
    voiceLib = require('@discordjs/voice');
    try {
      require('libsodium-wrappers'); // encryption (PyNaCl equivalent)
    } catch (_) {
      try {
        require('tweetnacl');
      } catch (_) {
        /* @discordjs/voice picks its own default where possible */
      }
    }
    return voiceLib;
  } catch (err) {
    voiceLibError = err;
    return null;
  }
}

const MUSIC_INSTALL_HELP = [
  '```bash',
  'npm i @discordjs/voice libsodium-wrappers',
  'pip install -U "yt-dlp[default]"     # or: npm i -g yt-dlp-exec',
  'sudo apt install ffmpeg              # or: npm i ffmpeg-static',
  '```',
].join('\n');

/** Version of the installed @discordjs/voice package (null when missing). */
function voiceLibVersion() {
  try {
    return require('@discordjs/voice/package.json').version;
  } catch (_) {
    try {
      const v = require('@discordjs/voice').version;
      return typeof v === 'string' ? v : null;
    } catch (_) {
      return null;
    }
  }
}

/**
 * Discord made the DAVE (end-to-end voice encryption) protocol mandatory on 2026-03-02.
 * Without a DAVE-capable client the voice WebSocket / UDP handshake is rejected, which is
 * what most "voice connects but no audio" and "IP discovery failed" reports really are.
 * DAVE support landed in @discordjs/voice 0.19.0 (0.19.1 bundles the `davey` binding).
 */
function voiceSupportsDave() {
  const version = voiceLibVersion();
  if (!version) {
    // package.json unreadable (odd layout) — fall back to the DAVE binding being present
    try {
      require.resolve('@snazzah/davey');
      return true;
    } catch (_) {
      return false;
    }
  }
  const [major, minor] = version.split('.').map((n) => parseInt(n, 10) || 0);
  return major > 0 || minor >= 19;
}

/** True when voice encryption (DAVE) is enabled in this process. */
function daveEnabled() {
  return String(process.env.DAVE_ENCRYPTION || 'on').toLowerCase() !== 'off';
}

/**
 * Options shared by joinVoiceChannel() and connection.rejoin().
 *  • daveEncryption           – required by Discord since 2026-03; disable only to debug
 *  • decryptionFailureTolerance – how many bad frames before the connection is dropped
 *  • selfDeaf/selfMute        – the bot never listens, never speaks into the mic
 */
function musicVoiceOptions() {
  const tolerance = parseInt(process.env.DECRYPTION_TOLERANCE, 10);
  return {
    selfDeaf: true,
    selfMute: false,
    daveEncryption: daveEnabled(),
    decryptionFailureTolerance: Number.isInteger(tolerance) ? Math.max(0, Math.min(60, tolerance)) : 24,
  };
}

/** Turns a raw voice/connection error into something readable. */
function describeMusicVoiceError(err) {
  const text = String((err && (err.message || err)) || 'unknown error');
  if (/ip discovery/i.test(text)) return 'UDP handshake failed (IP discovery) — IPv6 or blocked UDP';
  if (/socket timeout|socket closed/i.test(text)) return 'UDP socket closed — blocked UDP or NAT timeout';
  if (/abort/i.test(text)) return 'voice handshake aborted';
  if (/dave|decrypt|passthrough/i.test(text)) return 'DAVE encryption failure — upgrade @discordjs/voice';
  if (/40(13|14|15)/.test(text)) return 'voice authentication rejected (session expired)';
  if (/timeout|timed out/i.test(text)) return 'voice connection timed out';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(text)) return `DNS/network error (${text.slice(0, 80)})`;
  return text.slice(0, 120);
}

/** Multi-line diagnosis shown when every join attempt failed. */
function musicVoiceFailureMessage(notes, lastErr) {
  const version = voiceLibVersion() || 'not installed';
  const lines = [
    '**Could not connect to the voice channel.**',
    ...notes.map((n) => `• ${n}`),
  ];
  const hints = [];
  if (!voiceSupportsDave()) {
    hints.push('`@discordjs/voice` is **too old** — Discord requires DAVE (0.19.1+). Run `npm i @discordjs/voice@latest` and use Node **22.12+**.');
  }
  if (!daveEnabled()) hints.push('DAVE encryption is disabled (`DAVE_ENCRYPTION=off`) — turn it back on unless you are debugging.');
  if (/ip discovery|udp|socket/i.test(String((lastErr && lastErr.message) || ''))) {
    hints.push('UDP looks blocked or broken: allow outbound **UDP 50000–65535**, disable a VPN, and make sure IPv6 is either working or disabled (the bot already forces `ipv4first`).');
  }
  hints.push('Last error: `' + describeMusicVoiceError(lastErr) + '`');
  lines.push('', '**Diagnosis**', ...hints.map((h) => `• ${h}`));
  lines.push('', `-# voice ${version} • node ${process.versions.node} • DAVE ${daveEnabled() ? 'on' : 'off'} • ${BOT_AUTHOR}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------------------------------
 * 14c.3  PER-GUILD MUSIC SETTINGS (SQLite)
 * ---------------------------------------------------------------------------------------- */

const MUSIC_DEFAULTS = { dj_role: null, max_queue: 300, default_volume: 80, announce: 1, stay: 0 };
const MUSIC_COLUMNS = new Set(Object.keys(MUSIC_DEFAULTS));
const musicSettingsCache = new Map();

async function getMusicSettings(guildId) {
  const cached = musicSettingsCache.get(guildId);
  if (cached) return cached;
  let row = await dbGet('SELECT * FROM music_settings WHERE guild_id = ?', [guildId]);
  if (!row) {
    await dbRun(
      'INSERT OR IGNORE INTO music_settings (guild_id, max_queue, default_volume, announce, stay) VALUES (?, ?, ?, 1, 0)',
      [guildId, MUSIC_DEFAULTS.max_queue, MUSIC_DEFAULTS.default_volume]
    );
    row = await dbGet('SELECT * FROM music_settings WHERE guild_id = ?', [guildId]);
  }
  const cfg = { ...MUSIC_DEFAULTS, ...row };
  cfg.max_queue = Number(cfg.max_queue) || MUSIC_DEFAULTS.max_queue;
  cfg.default_volume = Number.isFinite(Number(cfg.default_volume)) ? Number(cfg.default_volume) : MUSIC_DEFAULTS.default_volume;
  cfg.announce = Number(cfg.announce);
  cfg.stay = Number(cfg.stay);
  musicSettingsCache.set(guildId, cfg);
  return cfg;
}

async function updateMusicSettings(guildId, patch) {
  const keys = Object.keys(patch).filter((k) => MUSIC_COLUMNS.has(k));
  if (!keys.length) return getMusicSettings(guildId);
  await dbRun('UPDATE music_settings SET ' + keys.map((k) => `${k} = ?`).join(', ') + ' WHERE guild_id = ?', [
    ...keys.map((k) => patch[k]),
    guildId,
  ]);
  musicSettingsCache.delete(guildId);
  return getMusicSettings(guildId);
}

/* ------------------------------------------------------------------------------------------
 * 14c.4  RUNTIME STATE
 * ---------------------------------------------------------------------------------------- */

const musicStates = new Map(); // guildId -> state

function musicState(guildId) {
  let state = musicStates.get(guildId);
  if (state) return state;
  state = {
    queue: [],
    history: [],
    current: null,
    loop: 'off', // off | track | queue
    filter: 'off',
    volume: null,
    autoplay: false,
    player: null,
    connection: null,
    resource: null,
    procs: [],
    textChannel: null,
    startedAt: 0,
    pausedAt: 0,
    pausedTotal: 0,
    stopped: false,
    advancing: false,
    suppressAdvance: false,
    idleTimer: null,
    controlsMsg: null,
    rejoinTimer: null,   // pending automatic voice reconnect
    lastYtdlpError: null, // last yt-dlp stderr, surfaced in the error embed
  };
  musicStates.set(guildId, state);
  return state;
}

function musicElapsed(state) {
  if (!state.current || !state.startedAt) return 0;
  const base = state.pausedAt ? state.pausedAt : Date.now();
  return Math.max(0, (base - state.startedAt - state.pausedTotal) / 1000);
}

/**
 * Stops the player without letting the idle event advance the queue.
 * Needed for self-inflicted restarts (volume / filter / seek / skip).
 */
function stopPlayerQuietly(state) {
  state.suppressAdvance = true;
  try {
    state.player?.stop(true);
  } catch (_) {
    /* ignore */
  }
  const timer = setTimeout(() => {
    state.suppressAdvance = false;
  }, 120);
  if (timer.unref) timer.unref();
}

/** Kills every child process belonging to the current track. */
function killMusicProcs(state) {
  for (const child of state.procs.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch (_) {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------------------------------
 * 14c.5  yt-dlp METADATA (search / url / playlist / radio)
 * ---------------------------------------------------------------------------------------- */

/** Base yt-dlp args (mirrors bot.py's _YTDL_BASE). */
function ytdlpBaseArgs() {
  const args = [
    '--no-warnings',
    '--no-playlist',
    '--ignore-config',
    '--no-check-certificates',
    '--retries', '5',
    '--socket-timeout', '15',
  ];
  if (process.env.YTDLP_COOKIES) args.push('--cookies', process.env.YTDLP_COOKIES);
  if (process.env.YTDLP_PROXY) args.push('--proxy', process.env.YTDLP_PROXY);
  // IPv6 without working connectivity breaks both voice UDP *and* yt-dlp's TLS downloads.
  if (String(process.env.VOICE_IPV4 || 'on').toLowerCase() !== 'off' && String(process.env.YTDLP_IPV4 || 'auto').toLowerCase() !== 'off') {
    args.push('--force-ipv4');
  }
  args.push('--extractor-args', `youtube:player_client=${process.env.YTDLP_PLAYER_CLIENT || 'android,web'}`);
  return args;
}

const isUrlLike = (str) => /^https?:\/\//i.test(String(str || '').trim());

/** Runs yt-dlp -J and returns parsed info (throws a friendly error). */
async function ytdlpInfo(target, extraArgs = []) {
  const bins = await detectMusicBinaries();
  if (!bins.ytdlp) throw new Error(bins.errors.find((e) => /yt-dlp/i.test(e)) || 'yt-dlp is not installed.');
  const args = [...bins.ytdlp.baseArgs, ...ytdlpBaseArgs(), ...extraArgs, '-J', target];
  const res = await runBinary(bins.ytdlp.cmd, args, 45000);
  if (!res.ok || !res.stdout.trim()) {
    const reason = (res.stderr || '').split('\n').filter(Boolean).slice(-2).join(' ') || 'yt-dlp failed';
    throw new Error(`Could not resolve **${truncate(target, 120)}**\n\`\`\`${truncate(reason, 300)}\`\`\``);
  }
  try {
    return JSON.parse(res.stdout);
  } catch (_) {
    throw new Error('yt-dlp returned invalid data.');
  }
}

function trackFromInfo(info, requester) {
  const thumbs = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  return {
    title: info.title || info.fulltitle || 'Unknown title',
    url: info.webpage_url || info.original_url || info.url || '',
    duration: Number(info.duration) || 0,
    uploader: info.uploader || info.channel || info.artist || 'Unknown artist',
    thumbnail: info.thumbnail || (thumbs.length ? thumbs[thumbs.length - 1].url : null),
    isLive: !!info.is_live,
    requesterId: requester.id,
    requesterName: requester.username || requester.tag || 'unknown',
  };
}

/** Resolves a URL or search query into a single track. */
async function resolveMusicTrack(query, requester) {
  const trimmed = String(query || '').trim();
  const target = isUrlLike(trimmed) ? trimmed : `ytsearch1:${trimmed}`;
  const info = await ytdlpInfo(target);
  if (info._type === 'playlist' && Array.isArray(info.entries)) {
    const first = info.entries.filter(Boolean)[0];
    if (!first) throw new Error('That playlist is empty.');
    return trackFromInfo(first, requester);
  }
  return trackFromInfo(info, requester);
}

/** Resolves a playlist / mix URL into up to `limit` tracks. */
async function resolveMusicPlaylist(url, requester, limit = 50) {
  const info = await ytdlpInfo(url, ['--flat-playlist', '--playlist-end', String(Math.max(1, Math.min(limit, 100)))]);
  const entries = Array.isArray(info.entries) ? info.entries.filter(Boolean) : [];
  return entries.slice(0, limit).map((entry) => {
    const isYt = /youtu/i.test(String(entry.ie_key || entry.extractor || '')) || /youtu/i.test(String(entry.url || ''));
    const url2 = entry.webpage_url || (isYt && entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : entry.url);
    return trackFromInfo({ ...entry, webpage_url: url2 }, requester);
  });
}

/** "Related" tracks for autoplay/radio (bot.py builds a YouTube RD mix). */
async function resolveMusicRadio(seedTrack, count = 5) {
  try {
    const match = String(seedTrack.url || '').match(/[?&]v=([\w-]{6,})/);
    const target = match
      ? `https://www.youtube.com/watch?v=${match[1]}&list=RD${match[1]}`
      : `ytsearch${count}:${seedTrack.title} ${seedTrack.uploader}`;
    const tracks = await resolveMusicPlaylist(target, { id: seedTrack.requesterId, username: seedTrack.requesterName }, count + 3);
    return tracks
      .filter((t) => t.url && t.url !== seedTrack.url)
      .slice(0, count)
      .map((t) => ({ ...t, isRadio: true }));
  } catch (err) {
    logError('resolveMusicRadio', err);
    return [];
  }
}

/* ------------------------------------------------------------------------------------------
 * 14c.6  AUDIO PIPELINE  yt-dlp stdout -> ffmpeg -> voice
 * ---------------------------------------------------------------------------------------- */

/** Builds the ffmpeg filter chain for the active preset + volume. */
function buildMusicFilterChain(state) {
  const preset = MUSIC_FILTERS.get(state.filter) || MUSIC_FILTERS.get('off');
  const filters = [];
  const speed = Number(preset.speed) || 1;

  if (speed !== 1) {
    // pitch + tempo change (same behaviour as the Python bot resampling PCM)
    filters.push(`asetrate=48000*${speed.toFixed(3)}`);
    filters.push('aresample=48000');
  }
  if (preset.bass) filters.push(`equalizer=f=110:width_type=o:width=2:g=${preset.bass}`);
  if (preset.lowpass) filters.push(`lowpass=f=${preset.lowpass}`);
  if (preset.spatial) filters.push('apulsator=hz=0.08');
  const volume = Math.max(0, Math.min(200, Number(state.volume) || 0)) / 100;
  filters.push(`volume=${volume.toFixed(2)}`);
  return filters.join(',');
}

/** Stream mode: opus (default) or raw PCM. */
function musicStreamMode() {
  return String(process.env.MUSIC_STREAM || 'opus').toLowerCase() === 'pcm' ? 'pcm' : 'opus';
}

/** Spawns yt-dlp + ffmpeg for `track` and returns an AudioResource. */
async function createMusicStream(state, track, seek = 0) {
  const { spawn } = require('child_process');
  const voice = loadVoiceLib();
  const bins = await detectMusicBinaries();
  if (!voice) throw new Error(`Voice support is not installed.\n${MUSIC_INSTALL_HELP}`);
  if (!bins.ok) throw new Error(bins.errors.join('\n'));

  const mode = musicStreamMode();
  state.lastYtdlpError = null;

  // ---- yt-dlp: best audio to stdout ----
  const ytdlpProc = spawn(
    bins.ytdlp.cmd,
    [
      ...bins.ytdlp.baseArgs,
      ...ytdlpBaseArgs(),
      '-f', 'bestaudio/best',
      '-o', '-',
      '--no-part',
      '--quiet',
      '--retries', '5',
      '--fragment-retries', '5',
      '--socket-timeout', '15',
      track.url,
    ],
    { windowsHide: true }
  );
  ytdlpProc.on('error', (err) => logError('music:ytdlp', err));
  // Keep the last stderr lines: yt-dlp's own message is far more useful than "stream error".
  const ytdlpErrLines = [];
  ytdlpProc.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (!text) return;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      ytdlpErrLines.push(line.trim());
      if (ytdlpErrLines.length > 6) ytdlpErrLines.shift();
    }
    state.lastYtdlpError = ytdlpErrLines.join('\n');
  });

  // ---- ffmpeg: decode + filters + volume -> opus or pcm ----
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn'];
  if (seek > 0) args.push('-ss', String(Math.max(0, Math.floor(seek))));
  args.push('-af', buildMusicFilterChain(state), '-ar', '48000', '-ac', '2');
  if (mode === 'pcm') args.push('-f', 's16le', 'pipe:1');
  else args.push('-c:a', 'libopus', '-b:a', '128k', '-f', 'ogg', 'pipe:1');

  const ffmpegProc = spawn(bins.ffmpeg, args, { windowsHide: true });
  ffmpegProc.on('error', (err) => logError('music:ffmpeg', err));
  ffmpegProc.stderr.on('data', (d) => {
    const text = d.toString().trim();
    if (text) console.warn('[music:ffmpeg]', truncate(text, 300));
  });

  ytdlpProc.stdout.pipe(ffmpegProc.stdin);
  ytdlpProc.on('close', () => {
    try {
      ffmpegProc.stdin.end();
    } catch (_) {
      /* ignore */
    }
  });
  ffmpegProc.on('close', () => {
    try {
      ytdlpProc.kill('SIGKILL');
    } catch (_) {
      /* ignore */
    }
  });
  state.procs.push(ytdlpProc, ffmpegProc);

  // Meter the decoded bytes without consuming them, so we can tell "silent dead stream"
  // apart from "ffmpeg is just slow to start".
  const { PassThrough } = require('stream');
  const meter = new PassThrough();
  let bytesOut = 0;
  // Count on the *source* (a piped readable may have several 'data' listeners), never on the
  // stream that AudioResource consumes — a flowing-mode listener there would eat the audio.
  ffmpegProc.stdout.on('data', (chunk) => {
    bytesOut += chunk.length;
  });
  ffmpegProc.stdout.pipe(meter);

  const resource = voice.createAudioResource(meter, {
    inputType: mode === 'pcm' ? voice.StreamType.Raw : voice.StreamType.OggOpus,
    inlineVolume: mode === 'pcm',
    metadata: { track },
  });
  if (mode === 'pcm' && resource.volume) resource.volume.setVolume(1); // volume already in the filter chain

  // ---- start-up watchdog: never leave the bot "playing" silence forever ----
  const timeoutMs = Math.max(5000, Math.min(60000, parseInt(process.env.MUSIC_START_TIMEOUT, 10) || 20000));
  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `No audio received within ${Math.round(timeoutMs / 1000)}s.\n${describeYtdlpError(state.lastYtdlpError) || 'The stream never started.'}\n-# yt-dlp / ffmpeg may be blocked by your network.`
        )
      );
    }, timeoutMs);
    if (timer.unref) timer.unref();
    const poll = setInterval(() => {
      if (bytesOut > 0) finish(null);
    }, 100);
    if (poll.unref) poll.unref();
    meter.once('close', () => finish(null));
    meter.once('error', (err) => finish(err));
    ffmpegProc.once('error', (err) => finish(new Error(`ffmpeg could not start: ${err.message}`)));
    if (bytesOut > 0) finish(null);
  }).catch((err) => {
    try {
      ytdlpProc.kill('SIGKILL');
    } catch (_) {
      /* ignore */
    }
    try {
      ffmpegProc.kill('SIGKILL');
    } catch (_) {
      /* ignore */
    }
    throw err;
  });

  return resource;
}

/**
 * Turns yt-dlp's stderr into an actionable hint (the top causes of "music does not play").
 * Returns '' when there is nothing useful to say.
 */
function describeYtdlpError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const last = text.split('\n').filter(Boolean).slice(-2).join(' ');
  if (/sign in to confirm|confirm you.{0,3}re not a bot|429|too many requests/i.test(text)) {
    return 'YouTube is blocking anonymous requests. Set `YTDLP_COOKIES=/path/cookies.txt` (or `YTDLP_PLAYER_CLIENT=web_safari`) and restart.';
  }
  if (/video unavailable|private video|removed by the uploader|does not exist/i.test(text)) {
    return 'That video is unavailable / private / removed.';
  }
  if (/age.?restrict|confirm your age/i.test(text)) {
    return 'The video is age-restricted — a `YTDLP_COOKIES` file is required.';
  }
  if (/not available in your country|geo.?restrict/i.test(text)) {
    return 'The video is geo-blocked for this server region.';
  }
  if (/live event will begin|premieres in/i.test(text)) {
    return 'That is an upcoming stream — it is not playable yet.';
  }
  if (/unable to download|HTTP Error 403|HTTP Error 410/i.test(text)) {
    return 'yt-dlp could not download the stream (403/410). Update yt-dlp: `pip install -U "yt-dlp[default]"`.';
  }
  if (/ffmpeg|No such file/i.test(text)) {
    return 'yt-dlp could not find ffmpeg — install it (`apt install ffmpeg`) or set `FFMPEG_PATH`.';
  }
  return '`' + truncate(last, 300) + '`';
}

/* ------------------------------------------------------------------------------------------
 * 14c.7  PLAYER LIFECYCLE
 * ---------------------------------------------------------------------------------------- */

/** Creates the player once and wires it to the queue. */
function ensureMusicPlayer(guild, state) {
  const voice = loadVoiceLib();
  if (!voice) throw new Error(`Voice support is not installed.\n${MUSIC_INSTALL_HELP}`);

  if (!state.player) {
    state.player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause } });

    state.player.on('stateChange', (oldState, newState) => {
      if (oldState.status === newState.status) return;
      const becameIdle = newState.status === voice.AudioPlayerStatus.Idle && oldState.status !== voice.AudioPlayerStatus.Idle;
      if (becameIdle && !state.advancing && !state.suppressAdvance) {
        queueMicrotask(() => musicAdvance(guild, state).catch((err) => logError('musicAdvance', err)));
      }
    });

    state.player.on('error', (err) => {
      logError('musicPlayer', err);
      if (state.textChannel) {
        sendTemp(
          state.textChannel,
          { embeds: [errEmbed('🎵 Playback error', `\`${truncate(err.message || err, 300)}\`\n-# Skipping to the next track.`)] },
          8000
        ).catch(() => {});
      }
      musicAdvance(guild, state).catch((e) => logError('musicAdvanceAfterError', e));
    });
  }
  return state.player;
}

/** True when an existing connection can be reused (Ready, or status unknown in tests). */
function musicConnectionReady(connection) {
  const voice = loadVoiceLib();
  if (!connection || !voice) return false;
  const status = connection.state && connection.state.status;
  return !status || status === voice.VoiceConnectionStatus.Ready;
}

/** How many join attempts before we give up on the UDP handshake. */
function musicJoinAttempts() {
  const n = parseInt(process.env.MUSIC_JOIN_ATTEMPTS, 10);
  return Number.isInteger(n) ? Math.max(1, Math.min(5, n)) : 3;
}

/** Notifies the text channel about a voice problem (never throws). */
function musicNotify(state, title, body) {
  if (!state || !state.textChannel) return;
  sendTemp(state.textChannel, { embeds: [errEmbed(title, truncate(body, 1500))] }, 12000).catch(() => {});
}

/**
 * Silent auto-rejoin after a dropped connection (region change, network blip, UDP timeout).
 * Gives up after 3 attempts so we never spam Discord.
 */
function scheduleMusicRejoin(guild, state, channelId, attempt = 1) {
  if (!channelId || !musicStates.has(guild.id)) return;
  if (state.rejoinTimer) return;
  if (attempt > 3) {
    musicNotify(state, '🎵 Voice connection lost', 'I could not reconnect after 3 attempts, so I left the channel.\n-# Join again with `play`.');
    musicDestroy(guild.id, 'Reconnect failed').catch(() => {});
    return;
  }
  state.rejoinTimer = setTimeout(async () => {
    state.rejoinTimer = null;
    if (!musicStates.has(guild.id)) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return;
    try {
      await musicConnect(guild, channel, state.textChannel);
      console.log(`[music] reconnected to voice (attempt ${attempt})`);
      // resume whatever was playing before the drop
      if (state.current) {
        const resource = await createMusicStream(state, state.current, musicElapsed(state));
        state.resource = resource;
        ensureMusicPlayer(guild, state).play(resource);
      }
    } catch (err) {
      console.warn('[music] reconnect failed:', describeMusicVoiceError(err));
      scheduleMusicRejoin(guild, state, channelId, attempt + 1);
    }
  }, 1500 * attempt);
  if (state.rejoinTimer.unref) state.rejoinTimer.unref();
}

/**
 * Watches a voice connection so a dropped UDP socket heals itself instead of leaving the
 * player silent forever (the "bot is in the channel but nothing plays" bug).
 */
function wireMusicConnection(guild, state, connection) {
  const voice = loadVoiceLib();
  if (!voice || !connection || typeof connection.on !== 'function') return;

  connection.on('error', (err) => {
    const reason = describeMusicVoiceError(err);
    console.warn('[music:voice]', reason);
    // One automatic repair for the classic UDP / IP-discovery failures.
    if (/udp|ip discovery|socket|abort/i.test(reason)) {
      const channelId = connection.joinConfig && connection.joinConfig.channelId;
      try {
        connection.destroy();
      } catch (_) {
        /* ignore */
      }
      if (state.connection === connection) state.connection = null;
      scheduleMusicRejoin(guild, state, channelId, 1);
    }
  });

  connection.on('stateChange', (oldState, newState) => {
    if (!newState || !newState.status) return;
    if (newState.status === voice.VoiceConnectionStatus.Disconnected) {
      const channelId = connection.joinConfig && connection.joinConfig.channelId;
      const recover = async () => {
        // Discord moved us to another region / channel: wait for it to come back by itself.
        if (voice.VoiceConnectionStatus.Signalling && voice.VoiceConnectionStatus.Connecting) {
          await Promise.race([
            voice.entersState(connection, voice.VoiceConnectionStatus.Signalling, 5000),
            voice.entersState(connection, voice.VoiceConnectionStatus.Connecting, 5000),
          ]);
        } else {
          throw new Error('disconnected');
        }
      };
      recover().catch(() => {
        console.warn('[music] voice disconnected — trying to reconnect');
        try {
          connection.destroy();
        } catch (_) {
          /* ignore */
        }
        if (state.connection === connection) state.connection = null;
        scheduleMusicRejoin(guild, state, channelId, 1);
      });
      return;
    }
    if (newState.status === voice.VoiceConnectionStatus.Destroyed) {
      if (state.connection === connection) state.connection = null;
      if (state.rejoinTimer) {
        clearTimeout(state.rejoinTimer);
        state.rejoinTimer = null;
      }
    }
  });

  if (typeof connection.setMaxListeners === 'function') connection.setMaxListeners(20);
}

/**
 * Joins (or moves to) the user's voice channel.
 * Retries the whole handshake (fresh socket each time) because a half-open UDP socket can
 * never be revived — that is what produces the IP-discovery / socket-closed errors.
 */
async function musicConnect(guild, voiceChannel, textChannel) {
  const voice = loadVoiceLib();
  if (!voice) throw new Error(`Voice support is not installed.\n${MUSIC_INSTALL_HELP}`);

  const perms = voiceChannel.permissionsFor(guild.members.me);
  if (!perms || !perms.has(PermissionFlagsBits.Connect)) throw new Error(`I cannot join **${voiceChannel.name}** (missing **Connect**).`);
  if (!perms.has(PermissionFlagsBits.Speak)) throw new Error(`I cannot speak in **${voiceChannel.name}** (missing **Speak**).`);

  const state = musicState(guild.id);
  const existing = voice.getVoiceConnection(guild.id);

  if (existing && existing.joinConfig.channelId === voiceChannel.id && musicConnectionReady(existing)) {
    state.connection = existing; // already there and healthy — never interrupt playback
  } else {
    const attempts = musicJoinAttempts();
    const notes = [];
    let lastErr = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const stale = voice.getVoiceConnection(guild.id);
      if (stale) {
        try {
          stale.destroy(); // a dead UDP socket cannot be reused, so start clean
        } catch (_) {
          /* ignore */
        }
      }

      const connection = voice.joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        ...musicVoiceOptions(),
      });
      state.connection = connection;
      wireMusicConnection(guild, state, connection);

      try {
        await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 20000);
        lastErr = null;
        if (attempt > 1) console.log(`[music] voice ready on attempt ${attempt}/${attempts}`);
        break;
      } catch (err) {
        lastErr = err;
        notes.push(`attempt ${attempt}/${attempts}: ${describeMusicVoiceError(err)}`);
        console.warn(`[music] join attempt ${attempt}/${attempts} failed:`, describeMusicVoiceError(err));
        try {
          connection.destroy();
        } catch (_) {
          /* ignore */
        }
        if (state.connection === connection) state.connection = null;
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
      }
    }

    if (lastErr) throw new Error(musicVoiceFailureMessage(notes, lastErr));
  }

  const player = ensureMusicPlayer(guild, state);
  state.connection.subscribe(player);
  state.textChannel = textChannel;
  return state.connection;
}

/** Full teardown (leaves the channel, clears the queue). */
async function musicDestroy(guildId, reason = 'Stopped') {
  const state = musicStates.get(guildId);
  if (!state) return reason;
  const voice = loadVoiceLib();
  killMusicProcs(state);
  try {
    state.player?.stop(true);
  } catch (_) {
    /* ignore */
  }
  try {
    const connection = voice && voice.getVoiceConnection(guildId);
    if (connection) connection.destroy();
  } catch (_) {
    /* ignore */
  }
  if (state.idleTimer) clearTimeout(state.idleTimer);
  if (state.rejoinTimer) clearTimeout(state.rejoinTimer);
  musicStates.delete(guildId);
  return reason;
}

/**
 * Advances the queue: handles loop modes, autoplay/radio, history and the idle state.
 */
async function musicAdvance(guild, state) {
  if (state.advancing) return;
  state.advancing = true;
  try {
    killMusicProcs(state);

    const finished = state.current;

    // bookkeeping for the finished track
    if (finished) {
      if (state.loop === 'queue') state.queue.push({ ...finished });
      if (state.loop !== 'track') {
        state.history.push(finished);
        if (state.history.length > 100) state.history.shift();
        state.current = null;
      }
    }

    if (!state.current && state.loop === 'track' && finished) {
      state.current = finished; // replay
    } else if (!state.current) {
      if (!state.queue.length && state.autoplay && finished) {
        const related = await resolveMusicRadio(finished, 5);
        if (related.length) {
          state.queue.push(...related);
          if (state.textChannel) {
            sendTemp(
              state.textChannel,
              { embeds: [baseEmbed(MUSIC_COLORS.radio, '📻 Autoplay', `Added **${related.length}** related track(s).`)] },
              7000
            ).catch(() => {});
          }
        }
      }
      state.current = state.queue.shift() || null;
    }

    if (!state.current) {
      state.startedAt = 0;
      state.pausedAt = 0;
      state.pausedTotal = 0;
      const cfg = await getMusicSettings(guild.id);
      if (!cfg.stay && state.connection) {
        state.idleTimer = setTimeout(() => musicDestroy(guild.id, 'Queue finished'), 60000);
        if (state.idleTimer.unref) state.idleTimer.unref();
      }
      if (state.textChannel) {
        sendTemp(
          state.textChannel,
          { embeds: [baseEmbed(MUSIC_COLORS.stop, '⏹️ Queue finished', 'Nothing left to play — use `play` to add more.')] },
          10000
        ).catch(() => {});
      }
      return;
    }

    const resource = await createMusicStream(state, state.current, 0);
    state.resource = resource;
    state.startedAt = Date.now();
    state.pausedAt = 0;
    state.pausedTotal = 0;
    ensureMusicPlayer(guild, state).play(resource);
    await announceNowPlaying(guild, state, state.current);
  } catch (err) {
    logError('musicAdvance', err);
    if (state.textChannel) {
      await sendTemp(
        state.textChannel,
        {
          embeds: [
            errEmbed(
              '🎵 Could not play that track',
              truncate(`${err.message || err}${state.lastYtdlpError ? `\n${describeYtdlpError(state.lastYtdlpError)}` : ''}`, 1200) + '\n-# Skipping…'
            ),
          ],
        },
        10000
      ).catch(() => {});
    }
    state.current = null;
    state.advancing = false;
    if (state.queue.length) setTimeout(() => musicAdvance(guild, state).catch(() => {}), 1200);
    return;
  } finally {
    state.advancing = false;
  }
}

/** Posts (and remembers) the now-playing embed + control buttons. */
async function announceNowPlaying(guild, state, track) {
  const cfg = await getMusicSettings(guild.id).catch(() => MUSIC_DEFAULTS);
  if (state.volume === null) state.volume = cfg.default_volume;
  if (!state.textChannel || !cfg.announce) return;
  const sent = await state.textChannel.send(buildNowPlayingPayload(state, track)).catch(() => null);
  if (sent) state.controlsMsg = sent;
}

/* ------------------------------------------------------------------------------------------
 * 14c.8  EMBEDS + CONTROL BUTTONS
 * ---------------------------------------------------------------------------------------- */

function buildNowPlayingEmbed(state, track) {
  const elapsed = musicElapsed(state);
  const paused = !!state.pausedAt;
  const total = track.isLive ? 0 : Math.max(0, track.duration || 0);
  const preset = MUSIC_FILTERS.get(state.filter) || MUSIC_FILTERS.get('off');
  const eta = !paused && total ? ` (${formatTime(Math.max(0, total - elapsed))} left)` : '';

  return baseEmbed(paused ? MUSIC_COLORS.paused : MUSIC_COLORS.playing, `${paused ? '⏸️' : '🎶'} ${musicEqFrame(elapsed)} Now playing`)
    .setDescription(
      `## [${truncate(track.title, 200)}](${track.url || 'https://discord.com'})\n` +
        `\`${musicProgressBar(elapsed, total)}\`\n` +
        `\`${formatTime(elapsed)} / ${track.isLive ? 'LIVE' : formatTime(total)}\`${eta}`
    )
    .addFields(
      { name: 'Artist', value: truncate(track.uploader || '—', 100), inline: true },
      { name: 'Requested by', value: `<@${track.requesterId}>`, inline: true },
      { name: 'Volume', value: `${state.volume}%`, inline: true },
      { name: 'Loop', value: state.loop, inline: true },
      { name: 'Filter', value: preset.label, inline: true },
      { name: 'Queue', value: `${state.queue.length} track(s)`, inline: true }
    )
    .setThumbnail(track.thumbnail && isHttpUrl(track.thumbnail) ? track.thumbnail : null)
    .setFooter({ text: `${BOT_AUTHOR} • ${track.isRadio ? 'autoplay' : 'requested'}` });
}

function buildMusicControls(state) {
  const paused = !!state.pausedAt;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(paused ? 'music:resume' : 'music:pause')
      .setLabel(paused ? 'Resume' : 'Pause')
      .setStyle(paused ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setEmoji(paused ? '▶️' : '⏸️'),
    new ButtonBuilder().setCustomId('music:skip').setLabel('Skip').setStyle(ButtonStyle.Primary).setEmoji('⏭️'),
    new ButtonBuilder().setCustomId('music:stop').setLabel('Stop').setStyle(ButtonStyle.Danger).setEmoji('⏹️'),
    new ButtonBuilder().setCustomId('music:shuffle').setLabel('Shuffle').setStyle(ButtonStyle.Secondary).setEmoji('🔀'),
    new ButtonBuilder().setCustomId('music:loop').setLabel('Loop').setStyle(ButtonStyle.Secondary).setEmoji('🔁')
  );
}

function buildNowPlayingPayload(state, track) {
  return { embeds: [buildNowPlayingEmbed(state, track)], components: [buildMusicControls(state)] };
}

function buildQueueEmbed(state, page = 1) {
  const perPage = 10;
  const pages = Math.max(1, Math.ceil(state.queue.length / perPage));
  const current = Math.min(Math.max(1, page), pages);
  const slice = state.queue.slice((current - 1) * perPage, current * perPage);
  const totalDuration = state.queue.reduce((sum, t) => sum + (t.duration || 0), 0);

  return baseEmbed(MUSIC_COLORS.queued, '📜 Queue')
    .setDescription(
      [
        state.current
          ? `**Now:** [${truncate(state.current.title, 80)}](${state.current.url}) \`${formatTime(musicElapsed(state))}/${state.current.isLive ? 'LIVE' : formatTime(state.current.duration)}\``
          : '**Now:** nothing',
        '',
        slice.length
          ? slice
              .map(
                (t, i) =>
                  `\`${(current - 1) * perPage + i + 1}.\` [${truncate(t.title, 60)}](${t.url}) \`${t.isLive ? 'LIVE' : formatTime(t.duration)}\` — <@${t.requesterId}>`
              )
              .join('\n')
          : '*Nothing queued.*',
      ].join('\n')
    )
    .addFields(
      { name: 'Tracks', value: `${state.queue.length}`, inline: true },
      { name: 'Total length', value: formatTime(totalDuration), inline: true },
      { name: 'Loop', value: state.loop, inline: true },
      { name: 'Page', value: `${current}/${pages}`, inline: true },
      { name: 'Volume', value: `${state.volume}%`, inline: true },
      { name: 'Filter', value: (MUSIC_FILTERS.get(state.filter) || { label: 'Off' }).label, inline: true }
    )
    .setFooter({ text: `${BOT_AUTHOR} • ${state.queue.length ? `!queue ${current + 1} for the next page` : 'Empty queue'}` });
}

/* ------------------------------------------------------------------------------------------
 * 14c.9  PERMISSION HELPERS
 * ---------------------------------------------------------------------------------------- */

/** Resolves the member's voice channel (throws a friendly message). */
function requireVoiceChannel(msg) {
  const voiceChannel = msg.member && msg.member.voice ? msg.member.voice.channel : null;
  if (!voiceChannel) throw new Error('You need to be in a **voice channel** first.');
  const me = msg.guild.members.me;
  if (me.voice && me.voice.channel && me.voice.channel.id !== voiceChannel.id) {
    if (!hasPerm(msg, PermissionFlagsBits.ManageGuild)) {
      throw new Error(`I am already playing in **${me.voice.channel.name}**. Join me there or ask a moderator.`);
    }
  }
  return voiceChannel;
}

/** DJ / control check: same voice channel, DJ role, or Manage Server. */
async function assertMusicControl(msg) {
  const settings = await getMusicSettings(msg.guild.id);
  const member = msg.member;
  if (hasPerm(msg, PermissionFlagsBits.ManageGuild)) return true; // owner / granted users always pass
  if (settings.dj_role && member.roles.cache.has(settings.dj_role)) return true;
  const me = msg.guild.members.me;
  if (!me.voice || !me.voice.channel) return true; // nothing playing
  if (!member.voice || !member.voice.channel || member.voice.channel.id !== me.voice.channel.id) {
    await reply(
      msg,
      errEmbed(
        '🎧 Join the voice channel',
        `You must be in <#${me.voice.channel.id}> to control the music${settings.dj_role ? ` (or have <@&${settings.dj_role}>)` : ''}.`
      )
    );
    return false;
  }
  return true;
}

/** Adds tracks to the queue with the per-guild cap. */
async function musicEnqueue(guild, tracks, textChannel, settings) {
  const state = musicState(guild.id);
  const cfg = settings || (await getMusicSettings(guild.id));
  const list = Array.isArray(tracks) ? tracks : [tracks];
  let added = 0;
  for (const track of list) {
    if (state.queue.length >= cfg.max_queue) break;
    state.queue.push(track);
    added += 1;
  }
  state.textChannel = textChannel;
  if (state.volume === null) state.volume = cfg.default_volume;
  return { added, skipped: list.length - added, state };
}

/**
 * Joins voice and reports the full diagnosis on failure (instead of a generic
 * "command failed"). Returns the connection, or null after replying with the error.
 */
async function musicConnectOrReport(msg, voiceChannel) {
  try {
    return await musicConnect(msg.guild, voiceChannel, msg.channel);
  } catch (err) {
    logError('musicConnect', err);
    await reply(msg, errEmbed('🎵 Could not join voice', truncate(err.message || String(err), 1800)));
    return null;
  }
}

/** Joins + starts playback when nothing is playing. */
async function musicEnsurePlaying(guild, voiceChannel, textChannel) {
  const state = musicState(guild.id);
  if (!state.current && !state.advancing) {
    await musicConnect(guild, voiceChannel, textChannel);
    await musicAdvance(guild, state);
  } else {
    state.textChannel = textChannel;
  }
  return state;
}

/* ------------------------------------------------------------------------------------------
 * 14c.10  FAVORITES (SQLite instead of the Python JSON file)
 * ---------------------------------------------------------------------------------------- */

async function listFavorites(guildId, userId) {
  return dbAll('SELECT * FROM music_favorites WHERE guild_id = ? AND user_id = ? ORDER BY name ASC', [guildId, userId]);
}

async function addFavorite(guildId, userId, track, name) {
  await dbRun(
    `INSERT INTO music_favorites (guild_id, user_id, name, url, title, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id, name) DO UPDATE SET url = excluded.url, title = excluded.title, duration = excluded.duration`,
    [guildId, userId, name.toLowerCase(), track.url, track.title, track.duration || 0, Date.now()]
  );
}

async function removeFavorite(guildId, userId, name) {
  const res = await dbRun('DELETE FROM music_favorites WHERE guild_id = ? AND user_id = ? AND name = ?', [
    guildId,
    userId,
    name.toLowerCase(),
  ]);
  return res.changes > 0;
}

/* ------------------------------------------------------------------------------------------
 * 15. COMMAND REGISTRY
 *     Every command receives (msg, args, settings, raw)
 *       args -> tokenized arguments (quotes respected)
 *       raw  -> the untouched argument string (new lines preserved)
 * ---------------------------------------------------------------------------------------- */

const commands = new Map();

/**
 * Registers a command.
 * def = { name, aliases, category, usage, description, permission, ownerOnly, nukeAdmin, run }
 */
function defineCommand(def) {
  commands.set(def.name, def);
  for (const alias of def.aliases || []) commands.set(alias, def);
}

/* ===================== GENERAL / CORE ===================== */

defineCommand({
  name: 'help',
  aliases: ['h', 'commands'],
  category: 'General',
  usage: 'help [command]',
  description: 'Interactive command list with category dropdown.',
  async run(msg, args, settings) {
    const p = settings.prefix;
    if (args[0]) {
      const name = String(args[0]).toLowerCase().replace(/^[^\w-]+/, '');
      const cmd = commands.get(name);
      if (!cmd) {
        return reply(msg, errEmbed('Command not found', `No command called \`${name}\`.\nTry \`${p}help\` for the full list.`));
      }
      const payload = buildHelpCommand(msg, settings, cmd);
      return msg.reply({ ...payload, allowedMentions: { parse: [] } }).catch(() => null);
    }
    const payload = buildHelpOverview(msg, settings);
    return msg.reply({ ...payload, allowedMentions: { parse: [] } }).catch(() => null);
  },
});

defineCommand({
  name: 'statusbar',
  category: 'General',
  usage: 'statusbar <on|off>',
  description: 'Toggle the animated status bar.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings) {
    const value = (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(value)) return reply(msg, errEmbed('Invalid option', `Usage: \`${settings.prefix}statusbar on|off\``));
    await updateSettings(msg.guild.id, { statusbar: value === 'on' ? 1 : 0 });
    return reply(msg, okEmbed('Status bar updated', `The animated status bar is now **${value}**.`));
  },
});

defineCommand({
  name: 'prefix',
  category: 'General',
  usage: 'prefix <new prefix>',
  description: 'Change the command prefix for this server.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings) {
    const next = (args[0] || '').trim();
    if (!next || next.length > 3) return reply(msg, errEmbed('Invalid prefix', 'The prefix must be 1–3 characters long.'));
    await updateSettings(msg.guild.id, { prefix: next });
    return reply(msg, okEmbed('Prefix updated', `Commands now start with \`${next}\` — try \`${next}help\`.`));
  },
});

/* ===================== ANTI-NUKE ===================== */

/** Only the guild owner or a whitelisted user may manage anti-nuke. */
async function assertNukeAdmin(msg, action) {
  const whitelist = await getNukeWhitelist(msg.guild.id);
  const allowed =
    msg.author.id === msg.guild.ownerId ||
    whitelist.has(msg.author.id) ||
    actorPrivileged(msg) || // main owner / granted users
    (await hasAdminAccess(msg.guild, msg.author.id));
  if (!allowed) {
    await reply(
      msg,
      errEmbed('❌ Not allowed', `Only the **main owner**, a **granted user** or an **anti-nuke whitelisted user** can ${action}.`)
    );
    return false;
  }
  return true;
}

defineCommand({
  name: 'antinuke',
  aliases: ['an'],
  category: 'Anti-Nuke',
  usage: 'antinuke <on|off|limit|punish|timeout|whitelist|detect|rule|filter|status>',
  description: 'Configure anti-nuke: limits, punishments, detection methods, rules and name filters.',
  async run(msg, args, settings, raw) {
    if (!(await assertNukeAdmin(msg, 'manage anti-nuke'))) return;
    const p = settings.prefix;
    const sub = (args[0] || 'status').toLowerCase();
    const rest = raw.replace(/^\s*\S+\s*/, '').trim();

    const statusEmbed = async () => {
      const whitelist = await getNukeWhitelist(msg.guild.id);
      const detect = await getDetectConfig(msg.guild.id);
      const rules = await getNukeRules(msg.guild.id);
      const filters = await getNukeFilters(msg.guild.id);
      return baseEmbed(settings.antinuke ? COLORS.success : COLORS.error, '🛡️ Anti-nuke status')
        .addFields(
          { name: 'State', value: settings.antinuke ? 'Enabled ✅' : 'Disabled ❌', inline: true },
          { name: 'Limit', value: settings.nuke_limit === 1 ? '1st action / 10s (instant)' : `${settings.nuke_limit}th action / 10s`, inline: true },
          {
            name: 'Punishment',
            value: settings.nuke_punish === 'timeout' ? `timeout ${humanDuration(nukeTimeoutMs(settings))}` : settings.nuke_punish,
            inline: true,
          },
          {
            name: 'Detection methods',
            value: truncate([...DETECT_METHODS.entries()].map(([key, m]) => `${detect.get(key) ? '✅' : '❌'} \`${key}\` — ${m.desc}`).join('\n'), 1024),
            inline: false,
          },
          { name: 'Custom rules', value: rules.length ? truncate(rules.map((r) => `\`${r.action}\` ≥ ${r.threshold} / ${Math.round(r.window_ms / 1000)}s`).join('\n'), 1024) : 'none', inline: false },
          { name: 'Name filters', value: filters.size ? [...filters].map((w) => `||${w}||`).join(', ') : 'none', inline: false },
          { name: 'Whitelisted', value: whitelist.size ? [...whitelist].map((id) => `<@${id}>`).join(', ') : 'none', inline: false },
          {
            name: 'Commands',
            value: [
              `\`${p}antinuke on|off\` · \`${p}antinuke limit <1-20>\` · \`${p}antinuke punish ban|kick|strip|timeout [minutes]\``,
              `\`${p}antinuke timeout <1-40320>\` (timeout length in minutes)`,
              `\`${p}antinuke whitelist add|remove|list\``,
              `\`${p}antinuke detect <on|off> <method>\``,
              `\`${p}antinuke rule add <action> <threshold> <seconds>\` · \`rule remove <action>\` · \`rule list\``,
              `\`${p}antinuke filter add|remove|list <word>\``,
            ].join('\n'),
            inline: false,
          }
        )
        .setFooter({ text: `Exempt: server owner, bot itself, whitelisted users • ${BOT_AUTHOR}` });
    };

    if (sub === 'on' || sub === 'off') {
      const enabled = sub === 'on';
      const updated = await updateSettings(msg.guild.id, { antinuke: enabled ? 1 : 0 });
      const whitelist = await getNukeWhitelist(msg.guild.id);
      const detect = await getDetectConfig(msg.guild.id);
      return reply(msg, okEmbed(`🛡️ Anti-nuke ${sub}`, enabled
        ? `Watching **${NUKE_ACTION_META.size} action types** with **${[...detect.values()].filter(Boolean).length} detection methods**.\nLimit: **${updated.nuke_limit === 1 ? 'first action' : `${updated.nuke_limit}th action`} / 10s**\nPunishment: **${updated.nuke_punish}**\nWhitelisted users: **${whitelist.size}**`
        : 'Destructive-action protection is now off.'));
    }

    if (sub === 'limit') {
      const n = parseInt(args[1], 10);
      if (!Number.isInteger(n) || n < 1 || n > 20) {
        return reply(msg, errEmbed('Invalid limit', `Usage: \`${p}antinuke limit <1-20>\``));
      }
      await updateSettings(msg.guild.id, { nuke_limit: n });
      return reply(
        msg,
        okEmbed(
          'Limit updated',
          n === 1
            ? 'Anti-nuke now triggers on the **very first** destructive action (maximum security).\n-# Use `!antinuke rule` if you only want *specific* actions to be instant.'
            : `Anti-nuke triggers on the **${n}th** destructive action inside **10 seconds**.`
        )
      );
    }

    if (sub === 'punish' || sub === 'punishment') {
      const mode = (args[1] || '').toLowerCase();
      if (!NUKE_PUNISHMENTS.has(mode)) {
        return reply(
          msg,
          errEmbed(
            'Invalid punishment',
            `Usage: \`${p}antinuke punish <mode>\`\n` +
              [...NUKE_PUNISHMENTS.entries()].map(([key, m]) => `\`${key}\` — ${m.desc}`).join('\n')
          )
        );
      }

      // `punish timeout 60` also sets the timeout length in minutes.
      const patch = { nuke_punish: mode };
      if (mode === 'timeout' && args[2] !== undefined) {
        const minutes = parseInt(args[2], 10);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320) {
          return reply(msg, errEmbed('Invalid timeout length', `Usage: \`${p}antinuke punish timeout <1-40320 minutes>\``));
        }
        patch.nuke_timeout = minutes;
      }
      const updated = await updateSettings(msg.guild.id, patch);
      const extra =
        mode === 'timeout'
          ? `Nukers get a **${humanDuration(nukeTimeoutMs(updated))} timeout** (change it with \`${p}antinuke timeout <minutes>\`).`
          : mode === 'strip'
          ? 'Nukers lose **every removable role**.'
          : `Nukers are **${mode}ned**.`;
      return reply(
        msg,
        okEmbed(
          '⚖️ Punishment updated',
          `${extra}\n**Fallbacks (if impossible):** ${
            mode === 'timeout' ? 'kick → ban → strip' : mode === 'strip' ? 'timeout → kick → ban' : mode === 'kick' ? 'ban → strip' : 'kick → strip'
          }\n-# Timeout + strip need the bot to be above the nuker with **Moderate Members** / **Manage Roles**.`
        )
      );
    }

    if (sub === 'timeout' || sub === 'duration') {
      const minutes = parseInt(args[1], 10);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320) {
        return reply(msg, errEmbed('Invalid length', `Usage: \`${p}antinuke timeout <1-40320 minutes>\``));
      }
      const updated = await updateSettings(msg.guild.id, { nuke_timeout: minutes });
      return reply(
        msg,
        okEmbed(
          '⏱️ Timeout length updated',
          `Anti-nuke timeouts now last **${humanDuration(nukeTimeoutMs(updated))}**.\n` +
            (updated.nuke_punish === 'timeout'
              ? '-# The punishment mode is already `timeout`.'
              : `-# The current punishment is \`${updated.nuke_punish}\` — switch with \`${p}antinuke punish timeout\`.`)
        )
      );
    }

    if (sub === 'whitelist' || sub === 'wl') {
      const action = (args[1] || '').toLowerCase();
      if (action === 'add' || action === 'remove') {
        const targetId = parseId(args[2]);
        if (!targetId) return reply(msg, errEmbed('User not found', `Usage: \`${p}antinuke whitelist ${action} @user\``));
        if (action === 'add') {
          await dbRun('INSERT OR IGNORE INTO nuke_whitelist (guild_id, user_id) VALUES (?, ?)', [msg.guild.id, targetId]);
        } else {
          await dbRun('DELETE FROM nuke_whitelist WHERE guild_id = ? AND user_id = ?', [msg.guild.id, targetId]);
        }
        invalidateNukeWhitelist(msg.guild.id);
        return reply(msg, okEmbed('Whitelist updated', `<@${targetId}> was **${action === 'add' ? 'added to' : 'removed from'}** the anti-nuke whitelist.`));
      }
      if (action === 'list' || action === 'show') {
        const whitelist = await getNukeWhitelist(msg.guild.id);
        if (!whitelist.size) return reply(msg, infoEmbed('Whitelist', 'Nobody is whitelisted yet.'));
        return reply(msg, infoEmbed('🛡️ Anti-nuke whitelist', [...whitelist].map((id) => `<@${id}> (\`${id}\`)`).join('\n')));
      }
      return reply(msg, errEmbed('Invalid usage', `\`${p}antinuke whitelist add|remove|list\``));
    }

    /* ---- detection methods ---- */
    if (sub === 'detect' || sub === 'detection') {
      const action = (args[1] || '').toLowerCase();
      const method = (args[2] || '').toLowerCase();

      if (!action || action === 'list' || action === 'show') {
        const detect = await getDetectConfig(msg.guild.id);
        return reply(msg, infoEmbed('🛡️ Detection methods', truncate(
          [...DETECT_METHODS.entries()].map(([key, m]) => `${detect.get(key) ? '✅ enabled' : '❌ disabled'} — \`${key}\`\n> ${m.label}: ${m.desc}`).join('\n'),
          4000
        )).setFooter({ text: `Use ${p}antinuke detect on|off <method>` }));
      }

      if (!['on', 'off'].includes(action)) {
        return reply(msg, errEmbed('Invalid usage', `\`${p}antinuke detect <on|off> <method>\`\nMethods: ${[...DETECT_METHODS.keys()].map((m) => `\`${m}\``).join(', ')}`));
      }
      if (!DETECT_METHODS.has(method)) {
        return reply(msg, errEmbed('Unknown method', `Valid methods: ${[...DETECT_METHODS.keys()].map((m) => `\`${m}\``).join(', ')}`));
      }
      await setDetectMethod(msg.guild.id, method, action === 'on');
      return reply(msg, okEmbed('Detection updated', `Method \`${method}\` is now **${action}**.`));
    }

    /* ---- custom rules ---- */
    if (sub === 'rule' || sub === 'rules') {
      const action = (args[1] || 'list').toLowerCase();

      if (action === 'list') {
        const rules = await getNukeRules(msg.guild.id);
        if (!rules.length) return reply(msg, infoEmbed('🛡️ Custom rules', `No custom rules.\nAdd one: \`${p}antinuke rule add channel-delete 1 5\``));
        return reply(msg, infoEmbed('🛡️ Custom rules', truncate(rules.map((r) => `\`${r.action}\` ≥ **${r.threshold}** in **${Math.round(r.window_ms / 1000)}s**`).join('\n'), 4000))
          .setFooter({ text: `Remove: ${p}antinuke rule remove <action>` }));
      }

      if (action === 'add') {
        const actionKey = (args[2] || '').toLowerCase();
        const threshold = parseInt(args[3], 10);
        const seconds = parseInt(args[4], 10);
        if (!NUKE_ACTION_KEYS.includes(actionKey)) {
          return reply(msg, errEmbed('Unknown action', `Valid actions:\n${NUKE_ACTION_KEYS.map((k) => `\`${k}\``).join(', ')}`));
        }
        if (!Number.isInteger(threshold) || threshold < 1 || threshold > 50) {
          return reply(msg, errEmbed('Invalid threshold', `Usage: \`${p}antinuke rule add <action> <1-50> <1-600 seconds>\``));
        }
        if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
          return reply(msg, errEmbed('Invalid window', `Usage: \`${p}antinuke rule add <action> <1-50> <1-600 seconds>\``));
        }
        await dbRun(
          `INSERT INTO antinuke_rules (guild_id, action, threshold, window_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT(guild_id, action) DO UPDATE SET threshold = excluded.threshold, window_ms = excluded.window_ms`,
          [msg.guild.id, actionKey, threshold, seconds * 1000]
        );
        invalidateNukeRules(msg.guild.id);
        return reply(msg, okEmbed('Rule saved', `**${actionKey}** ≥ ${threshold} action(s) in ${seconds}s now triggers the punishment.`));
      }

      if (action === 'remove' || action === 'delete') {
        const actionKey = (args[2] || '').toLowerCase();
        if (!actionKey) return reply(msg, errEmbed('Missing action', `Usage: \`${p}antinuke rule remove <action>\``));
        const res = await dbRun('DELETE FROM antinuke_rules WHERE guild_id = ? AND action = ?', [msg.guild.id, actionKey]);
        invalidateNukeRules(msg.guild.id);
        return reply(msg, res.changes ? okEmbed('Rule removed', `\`${actionKey}\` rule deleted.`) : errEmbed('Not found', 'No rule for that action.'));
      }

      return reply(msg, errEmbed('Invalid usage', `\`${p}antinuke rule add|remove|list\``));
    }

    /* ---- blocked-word / custom-name filter ---- */
    if (sub === 'filter' || sub === 'word' || sub === 'blockword') {
      const action = (args[1] || 'list').toLowerCase();

      if (action === 'list') {
        const filters = await getNukeFilters(msg.guild.id);
        if (!filters.size) return reply(msg, infoEmbed('🛡️ Name filter', `No filtered words.\nAdd one: \`${p}antinuke filter add badword\``));
        return reply(msg, infoEmbed(`🛡️ Name filter (${filters.size})`, [...filters].map((w) => `||${w}||`).join(', ')));
      }

      if (action === 'add' || action === 'remove') {
        const word = rest.replace(/^\s*\S+\s+(?:add|remove)\s+/i, '').replace(/^\s*(?:add|remove)\s+/i, '').trim().toLowerCase();
        if (!word || word.length < 2 || word.length > 60) {
          return reply(msg, errEmbed('Invalid word', `Usage: \`${p}antinuke filter ${action} <word>\` (2–60 characters)`));
        }
        if (action === 'add') {
          await dbRun('INSERT OR IGNORE INTO antinuke_filters (guild_id, word) VALUES (?, ?)', [msg.guild.id, word]);
          invalidateNukeFilters(msg.guild.id);
          await setDetectMethod(msg.guild.id, 'name-filter', true);
          return reply(msg, okEmbed('Filter added', `Nicknames/usernames containing \`\`${word}\`\` will be reverted.\n-# The \`name-filter\` detection method was enabled automatically.`));
        }
        const res = await dbRun('DELETE FROM antinuke_filters WHERE guild_id = ? AND word = ?', [msg.guild.id, word]);
        invalidateNukeFilters(msg.guild.id);
        return reply(msg, res.changes ? okEmbed('Filter removed', `\`\`${word}\`\` is no longer filtered.`) : errEmbed('Not found', 'That word is not in the filter list.'));
      }

      return reply(msg, errEmbed('Invalid usage', `\`${p}antinuke filter add|remove|list <word>\``));
    }

    return reply(msg, await statusEmbed());
  },
});

defineCommand({
  name: 'antispam',
  aliases: ['as'],
  category: 'Anti-Spam',
  usage: 'antispam <on|off|config|set|reset|whitelist|status>',
  description: 'Toggle and configure anti-spam detection, plus the user/role whitelist.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || 'status').toLowerCase();
    const cfg = await getAntiSpamConfig(msg.guild.id);

    const render = (c, title = '🚫 Anti-spam configuration', wl = null) =>
      baseEmbed(settings.antispam && c.enabled ? COLORS.success : COLORS.error, title)
        .setDescription(
          [
            `**State:** ${settings.antispam ? 'enabled' : 'disabled'} ${settings.antispam && c.enabled ? '✅' : '❌'}`,
            `**Action:** delete messages + bulk-delete + ${humanDuration(c.timeout_secs * 1000)} timeout`,
            `**Exempt:** Administrator · Manage Messages · bots · **whitelisted users/roles**`,
          ].join('\n')
        )
        .addFields(
          { name: 'Flooding', value: `\`${c.flood_count}\` msgs / \`${c.flood_window}s\``, inline: true },
          { name: 'Duplicates', value: `\`${c.dup_count}\` msgs / \`${c.dup_window}s\``, inline: true },
          { name: 'Mass mentions', value: `\`${c.mention_count}\`+ in one message`, inline: true },
          { name: 'Link spam', value: `\`${c.link_count}\`+ links`, inline: true },
          { name: 'Discord invites', value: c.invite_block ? 'blocked' : 'allowed', inline: true },
          { name: 'Timeout', value: humanDuration(c.timeout_secs * 1000), inline: true },
          {
            name: 'Whitelist',
            value: wl && (wl.users.size || wl.roles.size)
              ? [
                  wl.users.size ? `**Users (${wl.users.size}):** ${[...wl.users].slice(0, 10).map((id) => `<@${id}>`).join(', ')}` : null,
                  wl.roles.size ? `**Roles (${wl.roles.size}):** ${[...wl.roles].slice(0, 10).map((id) => `<@&${id}>`).join(', ')}` : null,
                  wl.users.size + wl.roles.size > 20 ? `-# … and ${wl.users.size + wl.roles.size - 20} more` : null,
                ].filter(Boolean).join('\n')
              : `empty — \`${p}antispam whitelist add @user\` / \`@role\``,
            inline: false,
          },
          {
            name: 'Change a value',
            value: [
              `\`${p}antispam set <key> <value>\``,
              [...ANTISPAM_KEYS.entries()].map(([k, m]) => `\`${k}\` (${m.min}–${m.max})`).join(' · '),
              `\`${p}antispam reset\` restores the defaults`,
            ].join('\n'),
            inline: false,
          }
        )
        .setFooter({ text: BOT_AUTHOR });

    if (sub === 'on' || sub === 'off') {
      const enabled = sub === 'on';
      const result = await updateAntiSpamConfig(msg.guild.id, { enabled: enabled ? 1 : 0 });
      await updateSettings(msg.guild.id, { antispam: enabled ? 1 : 0 });
      return reply(msg, render(result.config, `Anti-spam ${sub}`, await getSpamWhitelist(msg.guild.id)));
    }

    if (sub === 'config' || sub === 'show' || sub === 'status') {
      return reply(msg, render(cfg, '🚫 Anti-spam configuration', await getSpamWhitelist(msg.guild.id)));
    }

    /* ---- whitelist: users and roles that are never auto-moderated ---- */
    if (sub === 'whitelist' || sub === 'wl' || sub === 'exempt') {
      const action = (args[1] || 'list').toLowerCase();
      const wl = await getSpamWhitelist(msg.guild.id);

      if (action === 'list' || action === 'show') {
        if (!wl.users.size && !wl.roles.size) {
          return reply(
            msg,
            infoEmbed(
              '🙈 Anti-spam whitelist',
              `Nobody is whitelisted.\\n\`${p}antispam whitelist add @user\` · \`${p}antispam whitelist add @role\`\\n-# Whitelisted members skip flood/duplicate/mention/link/invite detection **and** blocked words.`
            )
          );
        }
        return reply(
          msg,
          infoEmbed(
            `🙈 Anti-spam whitelist (${wl.users.size + wl.roles.size})`,
            truncate(
              [
                wl.users.size ? `**Users (${wl.users.size})**\\n${[...wl.users].map((id) => `<@${id}> \`${id}\``).join('\\n')}` : '',
                wl.roles.size ? `**Roles (${wl.roles.size})**\\n${[...wl.roles].map((id) => `<@&${id}> \`${id}\``).join('\\n')}` : '',
              ]
                .filter(Boolean)
                .join('\\n\\n'),
              4000
            )
          ).setFooter({ text: `Remove: ${p}antispam whitelist remove @user • ${BOT_AUTHOR}` })
        );
      }

      if (action === 'clear' || action === 'reset') {
        const res = await dbRun('DELETE FROM spam_whitelist WHERE guild_id = ?', [msg.guild.id]);
        invalidateSpamWhitelist(msg.guild.id);
        return reply(msg, okEmbed('🙈 Whitelist cleared', `Removed **${res.changes || 0}** entr${res.changes === 1 ? 'y' : 'ies'}.`));
      }

      if (action === 'add' || action === 'remove') {
        // roles first (a mention row can hold both, so check roles explicitly), then users
        const role = (msg.mentions.roles && msg.mentions.roles.first()) || resolveRole(msg.guild, args[2] || '');
        const user = (msg.mentions.users && msg.mentions.users.first()) || null;
        const rawId = parseId(args[2]);

        let kind = null;
        let targetId = null;
        if (role && !user) {
          kind = 'role';
          targetId = role.id;
        } else if (user) {
          kind = 'user';
          targetId = user.id;
        } else if (rawId) {
          // bare ID: work out whether it is a role or a user that is still in the server
          if (msg.guild.roles.cache.has(rawId)) {
            kind = 'role';
            targetId = rawId;
          } else if (msg.guild.members.cache.has(rawId) || (await msg.guild.members.fetch(rawId).catch(() => null))) {
            kind = 'user';
            targetId = rawId;
          } else {
            kind = 'user'; // left the server — keep the ID so re-joining is still exempt
            targetId = rawId;
          }
        }

        if (!targetId) {
          return reply(msg, errEmbed('Target not found', `Usage: \`${p}antispam whitelist ${action} @user|@role|id\``));
        }
        if (kind === 'user' && (targetId === msg.guild.ownerId || targetId === client.user.id)) {
          return reply(msg, infoEmbed('Already exempt', 'The server owner and the bot itself are always exempt.'));
        }

        if (action === 'add') {
          await dbRun(
            `INSERT INTO spam_whitelist (guild_id, target_id, kind, added_by, added_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(guild_id, target_id) DO UPDATE SET kind = excluded.kind, added_by = excluded.added_by`,
            [msg.guild.id, targetId, kind, msg.author.id, Date.now()]
          );
          invalidateSpamWhitelist(msg.guild.id);
          return reply(
            msg,
            okEmbed(
              '🙈 Whitelisted',
              `${kind === 'role' ? `<@&${targetId}>` : `<@${targetId}>`} will **never** be auto-moderated by anti-spam or blocked words.\\n-# Members with Administrator / Manage Messages were already exempt.`
            )
          );
        }

        const res = await dbRun('DELETE FROM spam_whitelist WHERE guild_id = ? AND target_id = ?', [msg.guild.id, targetId]);
        invalidateSpamWhitelist(msg.guild.id);
        return reply(
          msg,
          res.changes
            ? okEmbed('Whitelist updated', `${kind === 'role' ? `<@&${targetId}>` : `<@${targetId}>`} is auto-moderated again.`)
            : errEmbed('Not found', 'That user/role is not on the whitelist.')
        );
      }

      return reply(
        msg,
        errEmbed('Invalid usage', `\`${p}antispam whitelist add|remove <@user|@role>\` · \`whitelist list\` · \`whitelist clear\``)
      );
    }

    if (sub === 'set') {
      const key = (args[1] || '').toLowerCase();
      const value = args[2];
      const meta = ANTISPAM_KEYS.get(key);
      if (!meta) {
        return reply(msg, errEmbed('Unknown setting', `Valid keys:\n${[...ANTISPAM_KEYS.entries()].map(([k, m]) => `\`${k}\` — ${m.label} (${m.min}–${m.max})`).join('\n')}`));
      }
      if (value === undefined) return reply(msg, errEmbed('Missing value', `Usage: \`${p}antispam set ${key} <${meta.min}–${meta.max}>\``));
      const result = await updateAntiSpamConfig(msg.guild.id, { [key]: value });
      if (result.errors.length) return reply(msg, errEmbed('Invalid value', result.errors.join('\n')));
      return reply(msg, render(result.config, `✅ ${key} → ${value}`, await getSpamWhitelist(msg.guild.id)));
    }

    if (sub === 'reset') {
      const patch = {};
      for (const [key, value] of Object.entries(ANTISPAM_DEFAULTS)) patch[key] = value;
      const result = await updateAntiSpamConfig(msg.guild.id, patch);
      return reply(msg, render(result.config, 'Anti-spam reset to defaults', await getSpamWhitelist(msg.guild.id)));
    }

    return reply(msg, render(cfg, '🚫 Anti-spam configuration', await getSpamWhitelist(msg.guild.id)));
  },
});

defineCommand({
  name: 'blockword',
  aliases: ['bw'],
  category: 'Anti-Spam',
  usage: 'blockword <add|remove|list> [word]',
  description: 'Manage blocked words (list is DM\'d, spoiler-wrapped).',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'add') {
      const word = raw.replace(/^\s*add\s+/i, '').trim();
      if (!word || word.length < 2 || word.length > 60) {
        return reply(msg, errEmbed('Invalid word', `Usage: \`${p}blockword add <word>\` (2–60 characters)`));
      }
      await dbRun('INSERT OR IGNORE INTO blockwords (guild_id, word) VALUES (?, ?)', [msg.guild.id, word.toLowerCase()]);
      invalidateBlockwords(msg.guild.id);
      return reply(msg, okEmbed('Blocked word added', `\`\`${word}\`\` will now be removed (whole word, case-insensitive) and give an automatic warning.`));
    }

    if (sub === 'remove') {
      const word = raw.replace(/^\s*remove\s+/i, '').trim().toLowerCase();
      if (!word) return reply(msg, errEmbed('Invalid usage', `Usage: \`${p}blockword remove <word>\``));
      const res = await dbRun('DELETE FROM blockwords WHERE guild_id = ? AND word = ?', [msg.guild.id, word]);
      invalidateBlockwords(msg.guild.id);
      return reply(
        msg,
        res.changes ? okEmbed('Blocked word removed', `\`\`${word}\`\` is no longer blocked.`) : errEmbed('Not found', 'That word is not blocked.')
      );
    }

    if (sub === 'list') {
      const words = [...(await getBlockwords(msg.guild.id))].sort();
      if (!words.length) return reply(msg, infoEmbed('Blocked words', 'No blocked words configured.'));
      const chunks = [];
      for (let i = 0; i < words.length; i += 40) {
        chunks.push(words.slice(i, i + 40).map((w) => `||${w}||`).join(', '));
      }
      const sent = await msg.author
        .send({
          embeds: [baseEmbed(COLORS.warn, `🚫 Blocked words (${words.length})`, truncate(chunks[0] || '', 4000))],
        })
        .catch(() => null);
      if (!sent) return reply(msg, errEmbed('DMs closed', 'I could not DM you the list. Please enable direct messages.'));
      for (const chunk of chunks.slice(1, 6)) {
        await sent.channel.send({ embeds: [baseEmbed(COLORS.warn, 'Blocked words (cont.)', truncate(chunk, 4000))] }).catch(() => {});
      }
      return reply(msg, okEmbed('Sent by DM', 'The blocked words list was sent to your direct messages (spoiler-wrapped).'));
    }

    const words = await getBlockwords(msg.guild.id);
    return reply(
      msg,
      infoEmbed('Blocked words', `**${words.size}** word(s) blocked.\nUsage: \`${p}blockword add|remove|list\``)
    );
  },
});

/* ===================== CUSTOM COMMANDS + AUTO REPLY ===================== */

const CMD_NAME_RE = /^[a-z0-9_-]{1,32}$/;

defineCommand({
  name: 'addcmd',
  category: 'Automation',
  usage: 'addcmd <name> <response>',
  description: 'Create a custom command ({user} {username} {server} {members} {channel}).',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const name = (args[0] || '').toLowerCase();
    const response = raw.replace(/^\s*\S+\s+/, '').trim();
    if (!CMD_NAME_RE.test(name)) {
      return reply(msg, errEmbed('Invalid name', 'Command names may only contain letters, numbers, `-` and `_` (max 32 characters).'));
    }
    if (commands.has(name)) return reply(msg, errEmbed('Reserved name', `\`${name}\` is a built-in command.`));
    if (!response) return reply(msg, errEmbed('Missing response', `Usage: \`${p}addcmd <name> <response>\``));
    if (response.length > 1900) return reply(msg, errEmbed('Too long', 'The response must be under 1900 characters.'));

    const existing = await dbGet('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?', [msg.guild.id, name]);
    await dbRun(
      'INSERT INTO custom_commands (guild_id, name, response, created_by) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET response = excluded.response',
      [msg.guild.id, name, response, msg.author.id]
    );
    return reply(msg, okEmbed(existing ? 'Custom command updated' : 'Custom command created', `\`${p}${name}\` → ${truncate(response.replace(/\n/g, ' '), 300)}`));
  },
});

defineCommand({
  name: 'delcmd',
  category: 'Automation',
  usage: 'delcmd <name>',
  description: 'Delete a custom command.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings) {
    const name = (args[0] || '').toLowerCase();
    if (!name) return reply(msg, errEmbed('Invalid usage', `Usage: \`${settings.prefix}delcmd <name>\``));
    const res = await dbRun('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?', [msg.guild.id, name]);
    return reply(msg, res.changes ? okEmbed('Deleted', `Custom command \`${name}\` was removed.`) : errEmbed('Not found', 'No such custom command.'));
  },
});

defineCommand({
  name: 'cmds',
  aliases: ['customcommands'],
  category: 'Automation',
  usage: 'cmds',
  description: 'List custom commands.',
  async run(msg, args, settings) {
    const rows = await dbAll('SELECT name FROM custom_commands WHERE guild_id = ? ORDER BY name ASC', [msg.guild.id]);
    if (!rows.length) return reply(msg, infoEmbed('Custom commands', `None yet. Create one with \`${settings.prefix}addcmd <name> <response>\`.`));
    return reply(
      msg,
      infoEmbed(
        `Custom commands (${rows.length})`,
        truncate(rows.map((r) => `\`${settings.prefix}${r.name}\``).join(' · '), 4000)
      )
    );
  },
});

defineCommand({
  name: 'autoreply',
  aliases: ['ar'],
  category: 'Automation',
  usage: 'autoreply <add|remove|list>',
  description: 'Manage auto replies (trigger matches anywhere in a message).',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'add') {
      const rest = raw.replace(/^\s*add\s+/i, '');
      const split = rest.split('|');
      if (split.length < 2) {
        return reply(msg, errEmbed('Invalid usage', `Usage: \`${p}autoreply add <trigger> | <response>\``));
      }
      const trigger = split[0].trim().toLowerCase();
      const response = split.slice(1).join('|').trim();
      if (!trigger || trigger.length > 100) return reply(msg, errEmbed('Invalid trigger', 'The trigger must be 1–100 characters.'));
      if (!response || response.length > 1900) return reply(msg, errEmbed('Invalid response', 'The response must be 1–1900 characters.'));
      await dbRun(
        'INSERT INTO autoreplies (guild_id, trigger, response) VALUES (?, ?, ?) ON CONFLICT(guild_id, trigger) DO UPDATE SET response = excluded.response',
        [msg.guild.id, trigger, response]
      );
      return reply(msg, okEmbed('Auto reply saved', `When a message contains \`${trigger}\` I will reply with:\n>>> ${truncate(response, 900)}`));
    }

    if (sub === 'remove') {
      const trigger = raw.replace(/^\s*remove\s+/i, '').trim().toLowerCase();
      if (!trigger) return reply(msg, errEmbed('Invalid usage', `Usage: \`${p}autoreply remove <trigger>\``));
      const res = await dbRun('DELETE FROM autoreplies WHERE guild_id = ? AND trigger = ?', [msg.guild.id, trigger]);
      return reply(msg, res.changes ? okEmbed('Removed', `Auto reply \`${trigger}\` deleted.`) : errEmbed('Not found', 'No such auto reply.'));
    }

    if (sub === 'list') {
      const rows = await dbAll('SELECT * FROM autoreplies WHERE guild_id = ? ORDER BY trigger ASC', [msg.guild.id]);
      if (!rows.length) return reply(msg, infoEmbed('Auto replies', 'None configured.'));
      const lines = rows.slice(0, 20).map((r) => `**\`${truncate(r.trigger, 40)}\`** → ${truncate(r.response.replace(/\n/g, ' '), 70)}`);
      return reply(msg, infoEmbed(`Auto replies (${rows.length})`, truncate(lines.join('\n'), 4000)));
    }

    return reply(msg, errEmbed('Unknown subcommand', `\`${p}autoreply add <trigger> | <response>\` · \`${p}autoreply remove <trigger>\` · \`${p}autoreply list\``));
  },
});

/* ===================== MODERATION ===================== */

/** Shared permission + hierarchy gate for member-targeted moderation commands. */
async function requireTarget(msg, input, opts = {}) {
  const p = (await getSettings(msg.guild.id)).prefix;
  if (!input) {
    await reply(msg, errEmbed('Missing target', `Usage: \`${p}${opts.usage || 'command @user'}\``));
    return null;
  }
  const member = await resolveMember(msg, input);
  if (!member) {
    await reply(msg, errEmbed('Member not found', 'Mention a member or provide a valid user ID.'));
    return null;
  }
  if (member.id === msg.author.id) {
    await reply(msg, errEmbed('Nope', 'You cannot use this on yourself.'));
    return null;
  }
  if (member.id === msg.client.user.id) {
    await reply(msg, errEmbed('Nope', 'I cannot do that to myself.'));
    return null;
  }
  if (!canActOn(msg.guild, msg.member, member)) {
    await reply(
      msg,
      errEmbed('Hierarchy error', `I cannot act on **${member.user.tag}**.\nBoth of us need a role **higher** than theirs, and the server owner is untouchable.`)
    );
    return null;
  }
  if (opts.check && !opts.check(member)) {
    await reply(msg, errEmbed('Not possible', opts.checkMessage || 'That action is not possible for this member.'));
    return null;
  }
  return member;
}

defineCommand({
  name: 'kick',
  category: 'Moderation',
  usage: 'kick @user [reason]',
  description: 'Kick a member.',
  permission: PermissionFlagsBits.KickMembers,
  async run(msg, args, settings, raw) {
    const target = await requireTarget(msg, args[0], {
      usage: 'kick @user [reason]',
      check: (m) => m.kickable,
      checkMessage: 'That member is not kickable (check my role position and permissions).',
    });
    if (!target) return;
    const reason = raw.replace(/^\s*\S+\s*/, '').trim() || 'No reason provided';
    const dm = await target
      .send({ embeds: [warnEmbed(`You were kicked from ${msg.guild.name}`, `**Reason:** ${truncate(reason, 1024)}`)] })
      .catch(() => null);
    const kicked = await target.kick(`${reason} • by ${msg.author.tag}`).then(() => true).catch(() => false);
    if (!kicked) return reply(msg, errEmbed('Kick failed', 'Discord rejected the action. Check my permissions and role position.'));
    await modLog(
      msg.guild,
      settings,
      baseEmbed(COLORS.mod, '👢 Member kicked')
        .addFields(
          { name: 'User', value: `<@${target.id}> \`${target.user.tag}\``, inline: true },
          { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true },
          { name: 'Reason', value: truncate(reason, 1024), inline: false }
        )
    );
    return reply(msg, okEmbed('👢 Member kicked', `**${target.user.tag}** was kicked.\n**Reason:** ${truncate(reason, 900)}${dm ? '' : '\n*(DM could not be delivered)*'}`));
  },
});

defineCommand({
  name: 'ban',
  category: 'Moderation',
  usage: 'ban @user|id [reason]',
  description: 'Ban a member or a user ID.',
  permission: PermissionFlagsBits.BanMembers,
  async run(msg, args, settings, raw) {
    const id = parseId(args[0]);
    if (!id) return reply(msg, errEmbed('Missing target', `Usage: \`${settings.prefix}ban @user|id [reason]\``));
    if (id === msg.author.id) return reply(msg, errEmbed('Nope', 'You cannot ban yourself.'));
    if (id === msg.client.user.id) return reply(msg, errEmbed('Nope', 'I cannot ban myself.'));
    if (id === msg.guild.ownerId) return reply(msg, errEmbed('Nope', 'The server owner cannot be banned.'));

    const reason = raw.replace(/^\s*\S+\s*/, '').trim() || 'No reason provided';
    const member = await msg.guild.members.fetch(id).catch(() => null);

    if (member && !canActOn(msg.guild, msg.member, member)) {
      return reply(msg, errEmbed('Hierarchy error', `I cannot ban **${member.user.tag}** — check our role positions.`));
    }
    if (member) {
      await member
        .send({ embeds: [warnEmbed(`You were banned from ${msg.guild.name}`, `**Reason:** ${truncate(reason, 1024)}`)] })
        .catch(() => {});
    }
    const banned = await msg.guild.bans
      .create(id, { reason: `${reason} • by ${msg.author.tag}`, deleteMessageSeconds: 0 })
      .then(() => true)
      .catch(() => false);
    if (!banned) return reply(msg, errEmbed('Ban failed', 'Discord rejected the action. Check my **Ban Members** permission and role position.'));

    await modLog(
      msg.guild,
      settings,
      baseEmbed(COLORS.mod, '🔨 Member banned')
        .addFields(
          { name: 'User', value: `<@${id}> \`${id}\``, inline: true },
          { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true },
          { name: 'Reason', value: truncate(reason, 1024), inline: false }
        )
    );
    return reply(msg, okEmbed('🔨 Member banned', `**${member ? member.user.tag : id}** was banned.\n**Reason:** ${truncate(reason, 900)}`));
  },
});

defineCommand({
  name: 'unban',
  category: 'Moderation',
  usage: 'unban <user id> [reason]',
  description: 'Unban a user by ID.',
  permission: PermissionFlagsBits.BanMembers,
  async run(msg, args, settings, raw) {
    const id = parseId(args[0]);
    if (!id) return reply(msg, errEmbed('Missing ID', `Usage: \`${settings.prefix}unban <user id> [reason]\``));
    const reason = raw.replace(/^\s*\S+\s*/, '').trim() || 'No reason provided';
    const removed = await msg.guild.bans
      .remove(id, `${reason} • by ${msg.author.tag}`)
      .then(() => true)
      .catch(() => false);
    if (!removed) return reply(msg, errEmbed('Unban failed', 'That user is not banned or I lack the **Ban Members** permission.'));
    await modLog(
      msg.guild,
      settings,
      baseEmbed(COLORS.success, '🔓 Member unbanned').addFields(
        { name: 'User', value: `<@${id}> \`${id}\``, inline: true },
        { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true },
        { name: 'Reason', value: truncate(reason, 1024), inline: false }
      )
    );
    return reply(msg, okEmbed('🔓 Member unbanned', `<@${id}> is no longer banned.`));
  },
});

defineCommand({
  name: 'timeout',
  aliases: ['mute'],
  category: 'Moderation',
  usage: 'timeout @user <duration> [reason]',
  description: 'Timeout a member (s/m/h/d, max 28 days).',
  permission: PermissionFlagsBits.ModerateMembers,
  async run(msg, args, settings, raw) {
    const durationMs = parseDuration(args[1]);
    if (!durationMs) {
      return reply(msg, errEmbed('Invalid duration', `Usage: \`${settings.prefix}timeout @user 10m [reason]\`\nUnits: \`s\`, \`m\`, \`h\`, \`d\` (max 28 days).`));
    }
    const MAX = 28 * 24 * 60 * 60 * 1000;
    if (durationMs > MAX) return reply(msg, errEmbed('Too long', 'Discord allows a maximum timeout of **28 days**.'));
    if (durationMs < 1000) return reply(msg, errEmbed('Too short', 'The minimum timeout is **1 second**.'));

    const target = await requireTarget(msg, args[0], {
      usage: 'timeout @user <duration> [reason]',
      check: (m) => m.moderatable,
      checkMessage: 'That member cannot be timed out (check my **Moderate Members** permission and role position).',
    });
    if (!target) return;

    const reason = raw.replace(/^\s*\S+\s+\S+\s*/, '').trim() || 'No reason provided';
    const done = await target.timeout(durationMs, `${reason} • by ${msg.author.tag}`).then(() => true).catch(() => false);
    if (!done) return reply(msg, errEmbed('Timeout failed', 'Discord rejected the action.'));

    await target
      .send({
        embeds: [warnEmbed(`You were timed out in ${msg.guild.name}`, `**Duration:** ${humanDuration(durationMs)}\n**Reason:** ${truncate(reason, 900)}`)],
      })
      .catch(() => {});
    await modLog(
      msg.guild,
      settings,
      baseEmbed(COLORS.mod, '🔇 Member timed out').addFields(
        { name: 'User', value: `<@${target.id}> \`${target.user.tag}\``, inline: true },
        { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true },
        { name: 'Duration', value: humanDuration(durationMs), inline: true },
        { name: 'Reason', value: truncate(reason, 1024), inline: false }
      )
    );
    return reply(msg, okEmbed('🔇 Member timed out', `**${target.user.tag}** is timed out for **${humanDuration(durationMs)}**.\n**Reason:** ${truncate(reason, 900)}`));
  },
});

defineCommand({
  name: 'untimeout',
  aliases: ['unmute'],
  category: 'Moderation',
  usage: 'untimeout @user [reason]',
  description: 'Remove a timeout.',
  permission: PermissionFlagsBits.ModerateMembers,
  async run(msg, args, settings, raw) {
    const target = await requireTarget(msg, args[0], {
      usage: 'untimeout @user [reason]',
      check: (m) => m.moderatable,
      checkMessage: 'That member cannot be modified.',
    });
    if (!target) return;
    const reason = raw.replace(/^\s*\S+\s*/, '').trim() || 'No reason provided';
    const done = await target.timeout(null, `${reason} • by ${msg.author.tag}`).then(() => true).catch(() => false);
    if (!done) return reply(msg, errEmbed('Failed', 'Discord rejected the action.'));
    await modLog(
      msg.guild,
      settings,
      baseEmbed(COLORS.success, '🔊 Timeout removed').addFields(
        { name: 'User', value: `<@${target.id}>`, inline: true },
        { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true },
        { name: 'Reason', value: truncate(reason, 1024), inline: false }
      )
    );
    return reply(msg, okEmbed('🔊 Timeout removed', `**${target.user.tag}** can talk again.`));
  },
});

defineCommand({
  name: 'purge',
  aliases: ['clear'],
  category: 'Moderation',
  usage: 'purge <1-98> [@user]',
  description: 'Bulk delete messages (max 98 to leave room for the status bar).',
  permission: PermissionFlagsBits.ManageMessages,
  async run(msg, args, settings) {
    const p = settings.prefix;
    const amount = parseInt(args[0], 10);
    if (!Number.isInteger(amount) || amount < 1 || amount > 98) {
      return reply(msg, errEmbed('Invalid amount', `Usage: \`${p}purge <1-98> [@user]\`\nThe maximum is **98** so the status bar and your command message still fit in Discord's 100 message bulk-delete limit.`));
    }
    const filterId = parseId(args[1]);

    let deleted = 0;
    try {
      const fetched = await msg.channel.messages.fetch({ limit: amount });
      let targets = fetched;
      if (filterId) targets = fetched.filter((m) => m.author.id === filterId);

      // bulkDelete only accepts messages younger than 14 days
      const fresh = targets.filter((m) => Date.now() - m.createdTimestamp < 1209600000);
      if (!fresh.size) {
        await msg.delete().catch(() => {});
        return reply(msg, warnEmbed('Nothing to delete', 'No recent messages matched (messages older than 14 days cannot be bulk deleted).'));
      }
      const result = await msg.channel.bulkDelete(fresh, true);
      deleted = result.size;
    } catch (err) {
      logError('purge', err);
      return reply(msg, errEmbed('Purge failed', 'I could not delete those messages. Check my **Manage Messages** permission.'));
    }

    await sendTemp(
      msg.channel,
      { embeds: [okEmbed('🧹 Messages purged', `Deleted **${deleted}** message(s)${filterId ? ` from <@${filterId}>` : ''}.`)] },
      5000
    );
    await modLog(
      msg.guild,
      settings,
      baseEmbed(COLORS.mod, '🧹 Purge').addFields(
        { name: 'Channel', value: `<#${msg.channel.id}>`, inline: true },
        { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true },
        { name: 'Deleted', value: String(deleted), inline: true },
        { name: 'Filter', value: filterId ? `<@${filterId}>` : 'all messages', inline: true }
      )
    );
  },
});

defineCommand({
  name: 'logchannel',
  aliases: ['setlog', 'modlog'],
  category: 'Moderation',
  usage: 'logchannel <#channel|off>',
  description: 'Set or disable the moderation log channel.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings) {
    const p = settings.prefix;
    const input = args[0];
    if (!input) {
      return reply(msg, infoEmbed('Mod log', settings.logchannel ? `Current channel: <#${settings.logchannel}>` : `No log channel set. Usage: \`${p}logchannel #channel\``));
    }
    if (input.toLowerCase() === 'off') {
      await updateSettings(msg.guild.id, { logchannel: null });
      return reply(msg, okEmbed('Mod log disabled', 'Moderation actions will no longer be logged.'));
    }
    const channel = msg.mentions.channels.first() || msg.guild.channels.cache.get(parseId(input) || '');
    if (!channel || !channel.isTextBased()) return reply(msg, errEmbed('Invalid channel', `Usage: \`${p}logchannel #channel|off\``));
    const perms = channel.permissionsFor(msg.guild.members.me);
    if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      return reply(msg, errEmbed('Missing permissions', `I need **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`));
    }
    await updateSettings(msg.guild.id, { logchannel: channel.id });
    return reply(msg, okEmbed('Mod log set', `Moderation actions will be logged in ${channel}.`));
  },
});

/* ===================== WARNINGS ===================== */

defineCommand({
  name: 'warn',
  category: 'Warnings',
  usage: 'warn @user [reason]',
  description: 'Warn a member (they receive a DM).',
  permission: PermissionFlagsBits.ModerateMembers,
  async run(msg, args, settings, raw) {
    const target = await requireTarget(msg, args[0], { usage: 'warn @user [reason]' });
    if (!target) return;
    const reason = raw.replace(/^\s*\S+\s*/, '').trim() || 'No reason provided';

    const { id, count, action } = await addWarning(msg.guild, target.id, msg.author.id, reason);
    await target
      .send({
        embeds: [
          warnEmbed(`⚠️ Warning in ${msg.guild.name}`, `**Reason:** ${truncate(reason, 900)}\n**Warning ID:** #${id}\n**Total warnings:** ${count}${action ? `\n**Action taken:** ${action}` : ''}`),
        ],
      })
      .catch(() => {});

    const thresholds = `3 → 1h timeout · ${settings.warn_kick_at} → kick`;
    return reply(
      msg,
      okEmbed('⚠️ Warning issued', `**${target.user.tag}** now has **${count}** warning(s).\n**Reason:** ${truncate(reason, 800)}${action ? `\n**Automatic action:** ${action}` : ''}\n-# Auto punishments: ${thresholds}`)
    );
  },
});

defineCommand({
  name: 'warnings',
  aliases: ['warns'],
  category: 'Warnings',
  usage: 'warnings [@user]',
  description: 'List warnings for a user (or yourself).',
  async run(msg, args) {
    const targetId = parseId(args[0]) || msg.author.id;
    const member = await msg.guild.members.fetch(targetId).catch(() => null);
    const rows = await dbAll(
      'SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 25',
      [msg.guild.id, targetId]
    );
    const embed = baseEmbed(COLORS.warn, `⚠️ Warnings — ${member ? member.user.tag : targetId}`)
      .setDescription(rows.length ? `Total warnings: **${rows.length}**` : 'This user has no warnings. 🎉');
    if (rows.length) {
      embed.addFields({
        name: 'History',
        value: truncate(
          rows
            .map(
              (r) =>
                `**#${r.id}** • <t:${Math.floor(r.created_at / 1000)}:R> • by ${r.mod_id === msg.client.user.id ? 'Auto-mod' : `<@${r.mod_id}>`}\n> ${truncate(r.reason, 180)}`
            )
            .join('\n'),
          4000
        ),
      });
    }
    return reply(msg, embed, { allowedMentions: { parse: [] } });
  },
});

defineCommand({
  name: 'clearwarn',
  aliases: ['delwarn'],
  category: 'Warnings',
  usage: 'clearwarn @user [warning id|all]',
  description: 'Remove one warning (or all) from a user.',
  permission: PermissionFlagsBits.ModerateMembers,
  async run(msg, args, settings) {
    const p = settings.prefix;
    const targetId = parseId(args[0]);
    if (!targetId) return reply(msg, errEmbed('Missing target', `Usage: \`${p}clearwarn @user [warning id|all]\``));

    if ((args[1] || '').toLowerCase() === 'all') {
      const res = await dbRun('DELETE FROM warnings WHERE guild_id = ? AND user_id = ?', [msg.guild.id, targetId]);
      return reply(msg, okEmbed('Warnings cleared', `Removed **${res.changes}** warning(s) from <@${targetId}>.`));
    }

    const warnId = parseInt(args[1], 10);
    if (args[1] && !Number.isInteger(warnId)) {
      return reply(msg, errEmbed('Invalid ID', `Usage: \`${p}clearwarn @user [warning id|all]\``));
    }

    if (Number.isInteger(warnId)) {
      const res = await dbRun('DELETE FROM warnings WHERE guild_id = ? AND user_id = ? AND id = ?', [msg.guild.id, targetId, warnId]);
      return reply(
        msg,
        res.changes ? okEmbed('Warning removed', `Warning **#${warnId}** was deleted.`) : errEmbed('Not found', 'No warning with that ID for this user.')
      );
    }

    // no ID given -> show their warnings to pick from
    const rows = await dbAll('SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 15', [msg.guild.id, targetId]);
    if (!rows.length) return reply(msg, infoEmbed('Warnings', 'This user has no warnings.'));
    return reply(
      msg,
      infoEmbed(
        'Pick a warning to remove',
        truncate(rows.map((r) => `**#${r.id}** — ${truncate(r.reason, 100)}`).join('\n'), 4000) + `\n\nUsage: \`${p}clearwarn <@user> <id>\``
      )
    );
  },
});

/* ===================== ROLES & AFK ===================== */

defineCommand({
  name: 'afk',
  category: 'Roles & AFK',
  usage: 'afk [reason]',
  description: 'Set an AFK status with an optional reason.',
  async run(msg, args, settings, raw) {
    const reason = raw.trim() || 'AFK';
    if (reason.length > 200) return reply(msg, errEmbed('Too long', 'Keep the AFK reason under 200 characters.'));
    await dbRun(
      'INSERT INTO afk (guild_id, user_id, reason, since) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason, since = excluded.since',
      [msg.guild.id, msg.author.id, reason, Date.now()]
    );
    return reply(
      msg,
      infoEmbed('💤 AFK status set', `**${msg.author.username}** is now AFK.\n**Reason:** ${truncate(reason, 900)}\n**Since:** <t:${Math.floor(Date.now() / 1000)}:R>\n-# Mentioning you will show this reason. It clears automatically when you talk.`)
    );
  },
});

defineCommand({
  name: 'setautorole',
  category: 'Roles & AFK',
  usage: 'setautorole @role',
  description: 'Role given to every new member.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings) {
    const p = settings.prefix;
    const role = msg.mentions.roles.first() || resolveRole(msg.guild, args[0]);
    if (!role) return reply(msg, errEmbed('Role not found', `Usage: \`${p}setautorole @role\``));
    if (role.managed) return reply(msg, errEmbed('Not possible', 'That role is managed by an integration and cannot be assigned.'));
    const me = msg.guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return reply(msg, errEmbed('Missing permission', 'I need the **Manage Roles** permission.'));
    }
    if (role.position >= me.roles.highest.position) {
      return reply(msg, errEmbed('Hierarchy error', `**${role.name}** is above or equal to my highest role (**${me.roles.highest.name}**). Move my role higher.`));
    }
    await updateSettings(msg.guild.id, { autorole: role.id });
    return reply(msg, okEmbed('Auto role set', `New members will receive **${role.name}**.`));
  },
});

defineCommand({
  name: 'removeautorole',
  category: 'Roles & AFK',
  usage: 'removeautorole',
  description: 'Remove the auto role.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings) {
    if (!settings.autorole) return reply(msg, infoEmbed('Auto role', 'No auto role is configured.'));
    const old = settings.autorole;
    await updateSettings(msg.guild.id, { autorole: null });
    return reply(msg, okEmbed('Auto role removed', `Members will no longer receive <@&${old}>.`));
  },
});

defineCommand({
  name: 'role',
  category: 'Roles & AFK',
  usage: 'role <add|remove> @user @role',
  description: 'Add or remove a role from a member.',
  permission: PermissionFlagsBits.ManageRoles,
  async run(msg, args, settings) {
    const p = settings.prefix;
    const action = (args[0] || '').toLowerCase();
    if (!['add', 'remove'].includes(action)) {
      return reply(msg, errEmbed('Invalid usage', `Usage: \`${p}role add|remove @user @role\``));
    }
    const member = await resolveMember(msg, args[1]);
    if (!member) return reply(msg, errEmbed('Member not found', `Usage: \`${p}role ${action} @user @role\``));

    const roleInput = args.slice(2).join(' ');
    const role =
      msg.mentions.roles.first() ||
      resolveRole(msg.guild, roleInput) ||
      (parseId(roleInput) ? msg.guild.roles.cache.get(parseId(roleInput)) : null);
    if (!role) return reply(msg, errEmbed('Role not found', `Usage: \`${p}role ${action} @user @role\``));

    if (role.managed) return reply(msg, errEmbed('Not possible', 'That role is managed by an integration.'));
    if (role.id === msg.guild.id) return reply(msg, errEmbed('Not possible', 'The @everyone role cannot be assigned.'));
    if (!canActOn(msg.guild, msg.member, member)) {
      return reply(msg, errEmbed('Hierarchy error', 'The target member has an equal or higher role than you (or me).'));
    }
    const me = msg.guild.members.me;
    if (role.position >= me.roles.highest.position) {
      return reply(msg, errEmbed('Hierarchy error', `**${role.name}** is above my highest role (**${me.roles.highest.name}**).`));
    }
    if (msg.member.id !== msg.guild.ownerId && role.position >= msg.member.roles.highest.position) {
      return reply(msg, errEmbed('Hierarchy error', `**${role.name}** is above your highest role.`));
    }

    const done =
      action === 'add'
        ? await member.roles.add(role, `by ${msg.author.tag}`).then(() => true).catch(() => false)
        : await member.roles.remove(role, `by ${msg.author.tag}`).then(() => true).catch(() => false);

    if (!done) return reply(msg, errEmbed('Failed', 'Discord rejected the role change. Check my permissions.'));
    await modLog(
      msg.guild,
      settings,
      baseEmbed(COLORS.info, action === 'add' ? '➕ Role added' : '➖ Role removed').addFields(
        { name: 'Member', value: `<@${member.id}>`, inline: true },
        { name: 'Role', value: `<@&${role.id}>`, inline: true },
        { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true }
      )
    );
    return reply(msg, okEmbed(action === 'add' ? '➕ Role added' : '➖ Role removed', `**${role.name}** was ${action === 'add' ? 'added to' : 'removed from'} **${member.user.tag}**.`));
  },
});

/* ===================== WELCOME ===================== */

defineCommand({
  name: 'welcome',
  category: 'Welcome',
  usage: 'welcome <setup|title|message|footer|banner|color|thumbnail|ping|on|off|test|show|reset>',
  description: 'Configure the welcome system.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || '').toLowerCase();
    const rest = raw.replace(/^\s*\S+\s*/, '').trim();
    const cfg = await getWelcome(msg.guild.id);
    const usage = [
      `\`${p}welcome setup #channel\` — welcome channel`,
      `\`${p}welcome title <text>\``,
      `\`${p}welcome message <text>\` (\`\\n\` for new lines)`,
      `\`${p}welcome footer <text|off>\``,
      `\`${p}welcome banner <url|off>\``,
      `\`${p}welcome color <#hex>\``,
      `\`${p}welcome thumbnail <on|off>\``,
      `\`${p}welcome ping <on|off>\``,
      `\`${p}welcome on|off\` — enable/disable`,
      `\`${p}welcome test\` · \`${p}welcome show\` · \`${p}welcome reset\``,
      '',
      '**Variables:** `{user}` `{username}` `{tag}` `{server}` `{members}`',
    ].join('\n');

    if (sub === 'setup' || sub === 'channel') {
      const channel = msg.mentions.channels.first();
      if (!channel) {
        return reply(msg, errEmbed('Invalid channel', `Usage: \`${p}welcome setup #channel\``));
      }
      if (!channel.isTextBased()) return reply(msg, errEmbed('Invalid channel', 'Pick a text channel.'));
      const perms = channel.permissionsFor(msg.guild.members.me);
      if (!perms || !perms.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
        return reply(msg, errEmbed('Missing permissions', `I need **View Channel**, **Send Messages** and **Embed Links** in ${channel}.`));
      }
      const updated = await dbRun('UPDATE welcome SET channel = ? WHERE guild_id = ?', [channel.id, msg.guild.id]);
      if (!updated.changes) await dbRun('INSERT INTO welcome (guild_id, channel) VALUES (?, ?)', [msg.guild.id, channel.id]);
      return reply(msg, okEmbed('Welcome channel set', `New members will be welcomed in ${channel}.\n-# Make sure it is enabled with \`${p}welcome on\`.`));
    }

    if (sub === 'title') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}welcome title <text>\``));
      await dbRun('UPDATE welcome SET title = ? WHERE guild_id = ?', [truncate(rest, 256), msg.guild.id]);
      return reply(msg, okEmbed('Title updated', truncate(applyTemplate(rest, { user: msg.author, guild: msg.guild, channel: msg.channel }), 900)));
    }

    if (sub === 'message' || sub === 'msg' || sub === 'desc') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}welcome message <text>\``));
      await dbRun('UPDATE welcome SET message = ? WHERE guild_id = ?', [truncate(rest, 4000), msg.guild.id]);
      return reply(msg, okEmbed('Message updated', applyTemplate(rest, { user: msg.author, guild: msg.guild, channel: msg.channel })));
    }

    if (sub === 'footer') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}welcome footer <text|off>\``));
      const value = rest.toLowerCase() === 'off' ? null : truncate(rest, 2048);
      await dbRun('UPDATE welcome SET footer = ? WHERE guild_id = ?', [value, msg.guild.id]);
      return reply(msg, okEmbed('Footer updated', value ? value : 'Footer disabled.'));
    }

    if (sub === 'banner' || sub === 'image') {
      if (!rest) return reply(msg, errEmbed('Missing URL', `Usage: \`${p}welcome banner <url|off>\``));
      if (rest.toLowerCase() === 'off') {
        await dbRun('UPDATE welcome SET banner = NULL WHERE guild_id = ?', [msg.guild.id]);
        return reply(msg, okEmbed('Banner removed', 'The welcome embed no longer has a banner.'));
      }
      if (!isHttpUrl(rest)) return reply(msg, errEmbed('Invalid URL', 'Provide a valid `http(s)://` image URL, or `off`.'));
      await dbRun('UPDATE welcome SET banner = ? WHERE guild_id = ?', [rest, msg.guild.id]);
      return reply(msg, okEmbed('Banner updated', rest).setImage(isHttpUrl(rest) ? rest : null));
    }

    if (sub === 'color' || sub === 'colour') {
      const color = parseHexColor(args[1]);
      if (color === null) return reply(msg, errEmbed('Invalid color', `Usage: \`${p}welcome color #5865F2\``));
      await dbRun('UPDATE welcome SET color = ? WHERE guild_id = ?', [color, msg.guild.id]);
      return reply(msg, baseEmbed(color, '🎨 Color updated', `The welcome embed color is now \`#${color.toString(16).padStart(6, '0').toUpperCase()}\`.`));
    }

    if (sub === 'thumbnail' || sub === 'thumb') {
      const value = (args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) return reply(msg, errEmbed('Invalid option', `Usage: \`${p}welcome thumbnail on|off\``));
      await dbRun('UPDATE welcome SET thumbnail = ? WHERE guild_id = ?', [value === 'on' ? 1 : 0, msg.guild.id]);
      return reply(msg, okEmbed('Thumbnail updated', `Member avatars are now **${value}**.`));
    }

    if (sub === 'ping') {
      const value = (args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) return reply(msg, errEmbed('Invalid option', `Usage: \`${p}welcome ping on|off\``));
      await dbRun('UPDATE welcome SET ping = ? WHERE guild_id = ?', [value === 'on' ? 1 : 0, msg.guild.id]);
      return reply(msg, okEmbed('Ping updated', `Mentioning new members is now **${value}**.`));
    }

    if (sub === 'on' || sub === 'off') {
      const enabled = sub === 'on';
      await dbRun('UPDATE welcome SET enabled = ? WHERE guild_id = ?', [enabled ? 1 : 0, msg.guild.id]);
      if (enabled && !cfg.channel) {
        return reply(msg, warnEmbed('Welcome enabled', `Just one more step: set the channel with \`${p}welcome setup #channel\`.`));
      }
      return reply(msg, okEmbed(`Welcome ${sub}`, enabled ? 'New members will receive a welcome message.' : 'Welcome messages are disabled.'));
    }

    if (sub === 'test') {
      const channel = cfg.channel ? msg.guild.channels.cache.get(cfg.channel) : msg.channel;
      if (!channel || !channel.isTextBased()) return reply(msg, errEmbed('No channel', `Set one first: \`${p}welcome setup #channel\``));
      await channel.send({
        content: cfg.ping ? `<@${msg.author.id}>` : undefined,
        embeds: [buildWelcomeEmbed(cfg, msg.member)],
        allowedMentions: cfg.ping ? { users: [msg.author.id] } : { parse: [] },
      });
      return reply(msg, okEmbed('Test sent', `Preview posted in ${channel}.`));
    }

    if (sub === 'show' || sub === 'settings' || !sub) {
      const embed = baseEmbed(cfg.color, '👋 Welcome settings')
        .addFields(
          { name: 'State', value: cfg.enabled ? 'Enabled ✅' : 'Disabled ❌', inline: true },
          { name: 'Channel', value: cfg.channel ? `<#${cfg.channel}>` : 'not set', inline: true },
          { name: 'Ping', value: cfg.ping ? 'on' : 'off', inline: true },
          { name: 'Thumbnail', value: cfg.thumbnail ? 'on' : 'off', inline: true },
          { name: 'Color', value: `#${Number(cfg.color).toString(16).padStart(6, '0').toUpperCase()}`, inline: true },
          { name: 'Banner', value: cfg.banner ? `[link](${cfg.banner})` : 'off', inline: true },
          { name: 'Title', value: truncate(cfg.title || '—', 512), inline: false },
          { name: 'Message', value: truncate((cfg.message || '—').replace(/\\n/g, ' ⏎ '), 1024), inline: false },
          { name: 'Footer', value: truncate(cfg.footer || '—', 512), inline: false }
        )
        .setDescription(`Variables: \`{user}\` \`{username}\` \`{tag}\` \`{server}\` \`{members}\` — use \`\\n\` for a line break.\n\n**Commands**\n${usage}`);
      return reply(msg, embed);
    }

    if (sub === 'reset') {
      await dbRun(
        `UPDATE welcome SET title = ?, message = ?, footer = ?, banner = NULL, color = ?, thumbnail = 1, ping = 1
         WHERE guild_id = ?`,
        [WELCOME_DEFAULTS.title, WELCOME_DEFAULTS.message, WELCOME_DEFAULTS.footer, WELCOME_DEFAULTS.color, msg.guild.id]
      );
      return reply(msg, okEmbed('Welcome reset', 'All welcome settings (except the channel) were restored to default.'));
    }

    return reply(msg, errEmbed('Unknown subcommand', usage));
  },
});

/* ===================== TICKETS ===================== */

/** Returns the ticket row of the current channel (or null). */
async function ticketOfChannel(channelId) {
  return dbGet('SELECT * FROM tickets WHERE channel_id = ? ORDER BY id DESC LIMIT 1', [channelId]);
}

defineCommand({
  name: 'ticket',
  aliases: ['tickets'],
  category: 'Tickets',
  usage: 'ticket <setup|panel|addtype|types|settings|add|remove|rename|close>',
  description: 'Full ticket system (config, panel, in-ticket commands).',
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || '').toLowerCase();
    const cfg = await getTicketConfig(msg.guild.id);
    const isStaff = hasPerm(msg, PermissionFlagsBits.ManageGuild);
    const ticket = await ticketOfChannel(msg.channel.id);

    /* ---------- in-ticket commands (staff or ticket owner) ---------- */
    if (['add', 'remove', 'rename', 'close'].includes(sub)) {
      if (!ticket) return reply(msg, errEmbed('Not a ticket', 'This command only works inside a ticket channel.'));
      const isOwner = ticket.user_id === msg.author.id;
      const isSupport = cfg.support_role && msg.member.roles.cache.has(cfg.support_role);
      if (!isOwner && !isSupport && !hasPerm(msg, PermissionFlagsBits.ManageChannels)) {
        return reply(msg, errEmbed('Not allowed', 'Only the ticket owner or staff can do that.'));
      }

      if (sub === 'add' || sub === 'remove') {
        const target = await resolveMember(msg, args[1]);
        if (!target) return reply(msg, errEmbed('Member not found', `Usage: \`${p}ticket ${sub} @user\``));
        const overwrite = {
          ViewChannel: true,
          SendMessages: sub === 'add',
          ReadMessageHistory: true,
          AttachFiles: sub === 'add',
        };
        const done = await msg.channel.permissionOverwrites
          .edit(target.id, overwrite, { reason: `${sub} by ${msg.author.tag}` })
          .then(() => true)
          .catch(() => false);
        if (!done) return reply(msg, errEmbed('Failed', 'I could not update the channel permissions.'));
        return reply(msg, okEmbed(sub === 'add' ? '➕ User added' : '➖ User removed', `<@${target.id}> was ${sub === 'add' ? 'added to' : 'removed from'} this ticket.`));
      }

      if (sub === 'rename') {
        const name = raw.replace(/^\s*rename\s+/i, '').trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').slice(0, 90);
        if (!name) return reply(msg, errEmbed('Invalid name', `Usage: \`${p}ticket rename <name>\``));
        const done = await msg.channel.setName(name, `Renamed by ${msg.author.tag}`).then(() => true).catch(() => false);
        return reply(msg, done ? okEmbed('Renamed', `This ticket is now **#${name}**.`) : errEmbed('Failed', 'I could not rename the channel.'));
      }

      if (sub === 'close') {
        const reason = raw.replace(/^\s*close\s*/i, '').trim() || 'No reason provided';
        const result = await closeTicket(msg.channel, msg.author, reason);
        if (!result.ok) return reply(msg, errEmbed('Could not close', result.message));
        return;
      }
    }

    /* ---------- configuration ---------- */
    const rest = raw.replace(/^\s*\S+\s*/, '').trim();

    if (!sub || sub === 'settings' || sub === 'show' || sub === 'config') {
      const types = await getTicketTypes(msg.guild.id);
      const openCount = (await dbGet("SELECT COUNT(*) AS c FROM tickets WHERE guild_id = ? AND status = 'open'", [msg.guild.id])).c;
      return reply(
        msg,
        baseEmbed(cfg.color, '🎫 Ticket settings')
          .addFields(
            { name: 'Category', value: cfg.category ? `<#${cfg.category}>` : '⚠️ not set', inline: true },
            { name: 'Support role', value: cfg.support_role ? `<@&${cfg.support_role}>` : 'not set', inline: true },
            { name: 'Log channel', value: cfg.logchannel ? `<#${cfg.logchannel}>` : 'not set', inline: true },
            { name: 'Max open / user', value: String(cfg.max_open), inline: true },
            { name: 'Panel style', value: cfg.style, inline: true },
            { name: 'Color', value: `#${Number(cfg.color).toString(16).padStart(6, '0').toUpperCase()}`, inline: true },
            { name: 'Banner', value: cfg.banner ? `[link](${cfg.banner})` : 'off', inline: true },
            { name: 'Open tickets', value: String(openCount), inline: true },
            { name: 'Types', value: truncate(types.map((t) => `${t.emoji} \`${t.key}\` ${t.label}`).join('\n'), 1024), inline: false },
            {
              name: 'Commands',
              value: [
                `\`${p}ticket category <#category|id|name>\``,
                `\`${p}ticket logs #channel\` · \`${p}ticket role @role\` · \`${p}ticket max <n>\``,
                `\`${p}ticket title <text>\` · \`${p}ticket desc <text>\``,
                `\`${p}ticket welcome <text>\` · \`${p}ticket footer <text|off>\``,
                `\`${p}ticket banner <url|off>\` · \`${p}ticket color #hex\``,
                `\`${p}ticket style menu|buttons\``,
                `\`${p}ticket addtype <key> <emoji> <label> [--desc="..."]\``,
                `\`${p}ticket deltype <key>\` · \`${p}ticket types\``,
                `\`${p}ticket panel [#channel]\``,
                `Inside a ticket: \`${p}ticket add|remove|rename|close\``,
              ].join('\n'),
              inline: false,
            }
          )
          .addFields({ name: 'Welcome message', value: truncate(cfg.welcome_msg || '—', 1024) })
      );
    }

    // everything below requires Manage Server
    if (!isStaff) return reply(msg, errEmbed('Not allowed', 'You need the **Manage Server** permission to configure tickets.'));

    if (sub === 'category' || sub === 'setup') {
      const category = await resolveCategory(msg.guild, args[1]);
      if (!category) {
        return reply(
          msg,
          errEmbed('Category not found', `Usage: \`${p}ticket category <#category|id|name>\`\n-# Tip: you can also mention a channel inside the category.`)
        );
      }
      await updateTicketConfig(msg.guild.id, { category: category.id });
      return reply(msg, okEmbed('Category set', `New tickets will be created inside **${category.name}**.`));
    }

    if (sub === 'logs' || sub === 'log' || sub === 'logchannel') {
      const channel = msg.mentions.channels.first() || msg.guild.channels.cache.get(parseId(args[1]) || '');
      if (!channel || !channel.isTextBased()) return reply(msg, errEmbed('Invalid channel', `Usage: \`${p}ticket logs #channel\``));
      await updateTicketConfig(msg.guild.id, { logchannel: channel.id });
      return reply(msg, okEmbed('Log channel set', `Ticket logs and transcripts go to ${channel}.`));
    }

    if (sub === 'role') {
      const role = msg.mentions.roles.first() || resolveRole(msg.guild, args[1]);
      if (!role) return reply(msg, errEmbed('Role not found', `Usage: \`${p}ticket role @role\``));
      await updateTicketConfig(msg.guild.id, { support_role: role.id });
      return reply(msg, okEmbed('Support role set', `**${role.name}** can see and manage tickets.`));
    }

    if (sub === 'max') {
      const n = parseInt(args[1], 10);
      if (!Number.isInteger(n) || n < 1 || n > 10) return reply(msg, errEmbed('Invalid number', `Usage: \`${p}ticket max <1-10>\``));
      await updateTicketConfig(msg.guild.id, { max_open: n });
      return reply(msg, okEmbed('Limit updated', `Each user can now have **${n}** open ticket(s) at once.`));
    }

    if (sub === 'title') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}ticket title <text>\``));
      await updateTicketConfig(msg.guild.id, { title: truncate(rest, 256) });
      return reply(msg, okEmbed('Panel title updated', truncate(rest, 900)));
    }

    if (sub === 'desc' || sub === 'description') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}ticket desc <text>\``));
      await updateTicketConfig(msg.guild.id, { description: truncate(rest, 4000) });
      return reply(msg, okEmbed('Panel description updated', truncate(rest, 900)));
    }

    if (sub === 'welcome' || sub === 'welcome_msg') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}ticket welcome <text>\``));
      await updateTicketConfig(msg.guild.id, { welcome_msg: truncate(rest, 4000) });
      return reply(msg, okEmbed('Welcome message updated', `${truncate(rest, 900)}\n\n-# Variables: \`{user}\` \`{type}\` \`{server}\``));
    }

    if (sub === 'footer') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}ticket footer <text|off>\``));
      await updateTicketConfig(msg.guild.id, { footer: rest.toLowerCase() === 'off' ? null : truncate(rest, 2048) });
      return reply(msg, okEmbed('Footer updated', rest.toLowerCase() === 'off' ? 'Footer disabled.' : truncate(rest, 900)));
    }

    if (sub === 'banner') {
      if (!rest) return reply(msg, errEmbed('Missing URL', `Usage: \`${p}ticket banner <url|off>\``));
      if (rest.toLowerCase() === 'off') {
        await updateTicketConfig(msg.guild.id, { banner: null });
        return reply(msg, okEmbed('Banner removed', 'Panel and ticket embeds have no banner now.'));
      }
      if (!isHttpUrl(rest)) return reply(msg, errEmbed('Invalid URL', 'Provide a valid `http(s)://` image URL, or `off`.'));
      await updateTicketConfig(msg.guild.id, { banner: rest });
      return reply(msg, okEmbed('Banner updated', rest).setImage(rest));
    }

    if (sub === 'color' || sub === 'colour') {
      const color = parseHexColor(args[1]);
      if (color === null) return reply(msg, errEmbed('Invalid color', `Usage: \`${p}ticket color #5865F2\``));
      await updateTicketConfig(msg.guild.id, { color });
      return reply(msg, baseEmbed(color, '🎨 Color updated', 'Ticket embeds use the new color.'));
    }

    if (sub === 'style') {
      const style = (args[1] || '').toLowerCase();
      if (!['menu', 'buttons'].includes(style)) return reply(msg, errEmbed('Invalid style', `Usage: \`${p}ticket style menu|buttons\``));
      await updateTicketConfig(msg.guild.id, { style });
      return reply(msg, okEmbed('Style updated', `The panel will use **${style === 'menu' ? 'a select menu' : 'buttons'}**.`));
    }

    if (sub === 'addtype') {
      const typeRaw = raw.replace(/^\s*addtype\s+/i, '');
      const { flags, text } = extractFlags(typeRaw, ['desc', 'description']);
      const parts = tokenize(text);
      const key = (parts[0] || '').toLowerCase();
      const emojiRaw = parts[1] || '';
      const label = parts.slice(2).join(' ').trim();
      const emoji = parseEmoji(emojiRaw);

      if (!CMD_NAME_RE.test(key) || !emoji || !label) {
        return reply(
          msg,
          errEmbed(
            'Invalid type',
            `Usage: \`${p}ticket addtype <key> <emoji> <label> [--desc="..."]\`\nExample: \`${p}ticket addtype vip 🎁 VIP Support --desc="For VIP members"\``
          )
        );
      }
      const { c: count } = await dbGet('SELECT COUNT(*) AS c FROM ticket_types WHERE guild_id = ?', [msg.guild.id]);
      const existing = await dbGet('SELECT * FROM ticket_types WHERE guild_id = ? AND key = ?', [msg.guild.id, key]);
      if (!existing && count >= 25) return reply(msg, errEmbed('Limit reached', 'A maximum of **25** ticket types is allowed.'));
      await dbRun(
        `INSERT INTO ticket_types (guild_id, key, emoji, label, description) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, key) DO UPDATE SET emoji = excluded.emoji, label = excluded.label, description = excluded.description`,
        [msg.guild.id, key, emojiToString(emoji), truncate(label, 90), flags.desc || flags.description || null]
      );
      return reply(
        msg,
        okEmbed(existing ? 'Ticket type updated' : 'Ticket type added', `${emojiToString(emoji)} **${truncate(label, 80)}** → \`${key}\`${flags.desc ? `\n> ${truncate(flags.desc, 300)}` : ''}`)
      );
    }

    if (sub === 'deltype') {
      const key = (args[1] || '').toLowerCase();
      if (!key) return reply(msg, errEmbed('Missing key', `Usage: \`${p}ticket deltype <key>\``));
      const res = await dbRun('DELETE FROM ticket_types WHERE guild_id = ? AND key = ?', [msg.guild.id, key]);
      return reply(msg, res.changes ? okEmbed('Type deleted', `Ticket type \`${key}\` was removed.`) : errEmbed('Not found', 'No such ticket type.'));
    }

    if (sub === 'types') {
      const types = await getTicketTypes(msg.guild.id);
      return reply(
        msg,
        infoEmbed(
          `🎫 Ticket types (${types.length}/25)`,
          truncate(types.map((t) => `${t.emoji} **${t.label}** — key: \`${t.key}\`${t.description ? `\n> ${t.description}` : ''}`).join('\n'), 4000)
        )
      );
    }

    if (sub === 'panel' || sub === 'send' || sub === 'publish') {
      if (!cfg.category) return reply(msg, errEmbed('Setup incomplete', `Set a category first: \`${p}ticket category <name>\``));
      const channel = msg.mentions.channels.first() || msg.channel;
      const types = await getTicketTypes(msg.guild.id);
      if (!types.length) return reply(msg, errEmbed('No types', `Add one with \`${p}ticket addtype <key> <emoji> <label>\`.`));
      const payload = buildTicketPanel(cfg, types);
      const sent = await channel.send(payload).catch(() => null);
      if (!sent) return reply(msg, errEmbed('Failed', `I could not post the panel in ${channel}. Check my permissions.`));
      return reply(msg, okEmbed('Panel sent', `The ticket panel is now live in ${channel}.`));
    }

    return reply(
      msg,
      errEmbed(
        'Unknown subcommand',
        `\`${p}ticket settings\` shows the configuration.\n\`${p}ticket category|logs|role|max|title|desc|welcome|footer|banner|color|style|addtype|deltype|types|panel\``
      )
    );
  },
});

/* ===================== GIVEAWAYS ===================== */

defineCommand({
  name: 'giveaway',
  aliases: ['gw'],
  category: 'Giveaways',
  usage: 'giveaway <start|end|reroll|cancel|list|emoji|banner|color|title|footer>',
  description: 'Full giveaway system with buttons, banners and animated emoji.',
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || '').toLowerCase();
    const cfg = await getGwConfig(msg.guild.id);
    const canManage = hasPerm(msg, PermissionFlagsBits.ManageGuild);

    if (sub === 'start' || sub === 'create') {
      if (!canManage) return reply(msg, errEmbed('Not allowed', 'You need the **Manage Server** permission.'));
      const body = raw.replace(/^\s*\S+\s*/, '');
      const { flags, text } = extractFlags(body, ['role', 'banner'], []);
      const parts = tokenize(text);
      const durationMs = parseDuration(parts[0]);
      const winners = parseInt(parts[1], 10);

      if (!durationMs) return reply(msg, errEmbed('Invalid duration', `Usage: \`${p}giveaway start 10m 1 Nitro\` (s/m/h/d)`));
      if (!Number.isInteger(winners) || winners < 1 || winners > 50) {
        return reply(msg, errEmbed('Invalid winners', 'Winner count must be between **1** and **50**.'));
      }

      // Optional trailing channel + prize text
      let prizeParts = parts.slice(2);
      let channel = msg.channel;
      if (prizeParts.length > 1) {
        const last = prizeParts[prizeParts.length - 1];
        const candidate = msg.mentions.channels.first() || msg.guild.channels.cache.get(parseId(last) || '');
        if (candidate && candidate.isTextBased()) {
          channel = candidate;
          prizeParts = prizeParts.slice(0, -1);
        }
      }
      const prize = prizeParts.join(' ').trim();
      if (!prize) return reply(msg, errEmbed('Missing prize', `Usage: \`${p}giveaway start <duration> <winners> <prize> [#channel] [--role=@role] [--banner=url]\``));
      if (prize.length > 200) return reply(msg, errEmbed('Prize too long', 'Keep the prize under 200 characters.'));

      let roleRequired = null;
      if (flags.role) {
        const role = msg.mentions.roles.first() || resolveRole(msg.guild, flags.role);
        if (!role) return reply(msg, errEmbed('Role not found', `The requirement role \`${flags.role}\` does not exist.`));
        roleRequired = role.id;
      }
      let banner = cfg.banner || null;
      if (flags.banner) {
        if (!isHttpUrl(flags.banner)) return reply(msg, errEmbed('Invalid banner', 'Provide a valid `http(s)://` image URL.'));
        banner = flags.banner;
      }

      const endsAt = Date.now() + durationMs;
      const res = await dbRun(
        `INSERT INTO giveaways
          (guild_id, channel_id, message_id, prize, winners, host_id, ends_at, ended, role_required, banner, emoji, color, title, footer, created_at)
         VALUES (?, ?, '', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        [
          msg.guild.id,
          channel.id,
          prize,
          winners,
          msg.author.id,
          endsAt,
          roleRequired,
          banner,
          cfg.emoji,
          cfg.color,
          cfg.title,
          cfg.footer,
          Date.now(),
        ]
      );
      const gw = await dbGet('SELECT * FROM giveaways WHERE id = ?', [res.lastID]);
      const message = await channel
        .send({ embeds: [await buildGiveawayEmbed(gw, 0)], components: [buildGiveawayRow(gw)] })
        .catch(() => null);
      if (!message) {
        await dbRun('DELETE FROM giveaways WHERE id = ?', [gw.id]);
        return reply(msg, errEmbed('Failed', `I cannot post in ${channel}. Check my permissions.`));
      }
      await dbRun('UPDATE giveaways SET message_id = ? WHERE id = ?', [message.id, gw.id]);
      return reply(
        msg,
        okEmbed('🎉 Giveaway started', `**${prize}**\n**Ends:** <t:${Math.floor(endsAt / 1000)}:R> (<t:${Math.floor(endsAt / 1000)}:f>)\n**Winners:** ${winners}\n**Channel:** ${channel}\n**ID:** \`${gw.id}\``)
      );
    }

    if (sub === 'end' || sub === 'reroll' || sub === 'cancel') {
      if (!canManage) return reply(msg, errEmbed('Not allowed', 'You need the **Manage Server** permission.'));
      const id = parseInt(args[1], 10);
      if (!Number.isInteger(id)) return reply(msg, errEmbed('Missing ID', `Usage: \`${p}giveaway ${sub} <id>\``));
      const gw = await dbGet('SELECT * FROM giveaways WHERE id = ? AND guild_id = ?', [id, msg.guild.id]);
      if (!gw) return reply(msg, errEmbed('Not found', `No giveaway with ID \`${id}\`. See \`${p}giveaway list\`.`));

      if (sub === 'cancel') {
        await dbRun('UPDATE giveaways SET ended = 1 WHERE id = ?', [gw.id]);
        const channel = await msg.guild.channels.fetch(gw.channel_id).catch(() => null);
        if (channel && channel.isTextBased()) {
          const message = await channel.messages.fetch(gw.message_id).catch(() => null);
          if (message) {
            await message
              .edit({ embeds: [baseEmbed(COLORS.error, gw.title || 'Giveaway', `## ${gw.prize}\n\n**❌ This giveaway was cancelled.**`)], components: [] })
              .catch(() => {});
          }
        }
        return reply(msg, okEmbed('Giveaway cancelled', `Giveaway \`${id}\` was cancelled.`));
      }

      if (sub === 'reroll') {
        const result = await endGiveaway(msg.client, gw.id, { reroll: true });
        if (!result.ok) return reply(msg, errEmbed('Could not reroll', result.message));
        return reply(msg, okEmbed('🎲 Rerolled', result.winners.length ? `New winner(s): ${result.winners.map((w) => `<@${w}>`).join(', ')}` : 'No valid entries left to pick from.'));
      }

      const result = await endGiveaway(msg.client, gw.id);
      if (!result.ok) return reply(msg, errEmbed('Could not end', result.message));
      return reply(msg, okEmbed('Giveaway ended', result.winners.length ? `Winner(s): ${result.winners.map((w) => `<@${w}>`).join(', ')}` : 'No valid entries.'));
    }

    if (sub === 'list') {
      const rows = await dbAll('SELECT * FROM giveaways WHERE guild_id = ? ORDER BY id DESC LIMIT 15', [msg.guild.id]);
      if (!rows.length) return reply(msg, infoEmbed('Giveaways', 'No giveaways yet.'));
      const lines = rows.map((g) => {
        const state = Number(g.ended) ? 'ended' : `<t:${Math.floor(g.ends_at / 1000)}:R>`;
        return `\`#${g.id}\` **${truncate(g.prize, 60)}** — ${state} • ${g.winners} winner(s) • <#${g.channel_id}>`;
      });
      return reply(msg, infoEmbed('🎉 Giveaways', truncate(lines.join('\n'), 4000)));
    }

    // ---- customization (Manage Server) ----
    if (!canManage) return reply(msg, errEmbed('Not allowed', 'You need the **Manage Server** permission to customize giveaways.'));
    const rest = raw.replace(/^\s*\S+\s*/, '').trim();

    if (sub === 'emoji') {
      const emoji = parseEmoji(args[1]);
      if (!emoji) return reply(msg, errEmbed('Invalid emoji', `Usage: \`${p}giveaway emoji 🎉\` — unicode or \`<:name:id>\` / \`<a:name:id>\``));
      await updateGwConfig(msg.guild.id, { emoji: emojiToString(emoji) });
      return reply(msg, okEmbed('Emoji updated', `The entry button now uses ${emojiToString(emoji)}.`));
    }

    if (sub === 'banner') {
      if (!rest) return reply(msg, errEmbed('Missing URL', `Usage: \`${p}giveaway banner <url|off>\``));
      if (rest.toLowerCase() === 'off') {
        await updateGwConfig(msg.guild.id, { banner: null });
        return reply(msg, okEmbed('Banner removed', 'Giveaways no longer show a banner.'));
      }
      if (!isHttpUrl(rest)) return reply(msg, errEmbed('Invalid URL', 'Provide a valid `http(s)://` image URL, or `off`.'));
      await updateGwConfig(msg.guild.id, { banner: rest });
      return reply(msg, okEmbed('Banner updated', rest).setImage(rest));
    }

    if (sub === 'color' || sub === 'colour') {
      const color = parseHexColor(args[1]);
      if (color === null) return reply(msg, errEmbed('Invalid color', `Usage: \`${p}giveaway color #FF73FA\``));
      await updateGwConfig(msg.guild.id, { color });
      return reply(msg, baseEmbed(color, '🎨 Color updated', 'New giveaways use this color.'));
    }

    if (sub === 'title') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}giveaway title <text>\``));
      await updateGwConfig(msg.guild.id, { title: truncate(rest, 256) });
      return reply(msg, okEmbed('Title updated', truncate(rest, 900)));
    }

    if (sub === 'footer') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}giveaway footer <text|off>\``));
      await updateGwConfig(msg.guild.id, { footer: rest.toLowerCase() === 'off' ? null : truncate(rest, 2048) });
      return reply(msg, okEmbed('Footer updated', rest.toLowerCase() === 'off' ? 'Footer disabled.' : truncate(rest, 900)));
    }

    if (sub === 'settings' || sub === 'config' || !sub) {
      return reply(
        msg,
        baseEmbed(cfg.color, '🎉 Giveaway settings')
          .addFields(
            { name: 'Button emoji', value: cfg.emoji || '🎉', inline: true },
            { name: 'Color', value: `#${Number(cfg.color).toString(16).padStart(6, '0').toUpperCase()}`, inline: true },
            { name: 'Banner', value: cfg.banner ? `[link](${cfg.banner})` : 'off', inline: true },
            { name: 'Title', value: truncate(cfg.title || '—', 512), inline: false },
            { name: 'Footer', value: truncate(cfg.footer || '—', 512), inline: false },
            {
              name: 'Commands',
              value: [
                `\`${p}giveaway start 10m 1 Nitro #channel --role=@role --banner=url\``,
                `\`${p}giveaway end|reroll|cancel <id>\` · \`${p}giveaway list\``,
                `\`${p}giveaway emoji|banner|color|title|footer\``,
              ].join('\n'),
            }
          )
      );
    }

    return reply(msg, errEmbed('Unknown subcommand', `\`${p}giveaway start|end|reroll|cancel|list|emoji|banner|color|title|footer|settings\``));
  },
});

/* ===================== BOT CONFIGURATION (main owner / granted access) ===================== */

/** Validators for !botconfig set */
const BOTCONFIG_KEYS = new Map([
  ['prefix', { parse: (v) => (v && v.length <= 3 ? v : null), hint: '1–3 characters' }],
  ['statusbar', { parse: (v) => (['on', 'off'].includes(v.toLowerCase()) ? (v.toLowerCase() === 'on' ? 1 : 0) : null), hint: 'on|off' }],
  ['antispam', { parse: (v) => (['on', 'off'].includes(v.toLowerCase()) ? (v.toLowerCase() === 'on' ? 1 : 0) : null), hint: 'on|off' }],
  ['antinuke', { parse: (v) => (['on', 'off'].includes(v.toLowerCase()) ? (v.toLowerCase() === 'on' ? 1 : 0) : null), hint: 'on|off' }],
  ['nuke_limit', { parse: (v) => (Number.isInteger(+v) && +v >= 1 && +v <= 20 ? +v : null), hint: '1–20' }],
  ['nuke_punish', { parse: (v) => (NUKE_PUNISHMENTS.has(v.toLowerCase()) ? v.toLowerCase() : null), hint: 'ban|kick|strip|timeout' }],
  ['nuke_timeout', { parse: (v) => (Number.isInteger(+v) && +v >= 1 && +v <= 40320 ? +v : null), hint: '1–40320 (timeout minutes)' }],
  ['warn_timeout_at', { parse: (v) => (Number.isInteger(+v) && +v >= 0 && +v <= 50 ? +v : null), hint: '0–50 (0 = off)' }],
  ['warn_kick_at', { parse: (v) => (Number.isInteger(+v) && +v >= 0 && +v <= 50 ? +v : null), hint: '0–50 (0 = off)' }],
  ['admin_only', { parse: (v) => (['on', 'off'].includes(v.toLowerCase()) ? (v.toLowerCase() === 'on' ? 1 : 0) : null), hint: 'on|off (strict admin access)' }],
  ['logchannel', {
    parse: (v, msg) => {
      if (v.toLowerCase() === 'off') return null;
      const ch = msg.mentions.channels.first() || msg.guild.channels.cache.get(parseId(v) || '');
      return ch && ch.isTextBased() ? ch.id : null;
    },
    hint: '#channel|off',
  }],
  ['autorole', {
    parse: (v, msg) => {
      if (v.toLowerCase() === 'off') return null;
      const role = msg.mentions.roles.first() || resolveRole(msg.guild, v);
      return role && !role.managed ? role.id : null;
    },
    hint: '@role|off',
  }],
]);

defineCommand({
  name: 'botconfig',
  aliases: ['config', 'settings'],
  category: 'General',
  usage: 'botconfig [show|set <key> <value>|reset [key]]',
  description: 'View or change every bot setting for this server.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || 'show').toLowerCase();

    const show = async () => {
      const antiSpamCfg = await getAntiSpamConfig(msg.guild.id);
      const access = await getAccessList(msg.guild.id);
      const mainOwnerId = (await getMainOwnerId(msg.guild.id)) || msg.guild.ownerId;
      const embed = baseEmbed(COLORS.main, '⚙️ Bot configuration')
        .addFields(
          { name: 'Core', value: [
              `**Prefix** · \`${settings.prefix}\``,
              `**Status bar** · ${settings.statusbar ? 'on' : 'off'}`,
              `**Mod log** · ${settings.logchannel ? `<#${settings.logchannel}>` : 'not set'}`,
              `**Auto role** · ${settings.autorole ? `<@&${settings.autorole}>` : 'not set'}`,
            ].join('\n'), inline: true },
          { name: 'Security', value: [
              `**Anti-spam** · ${settings.antispam ? 'on' : 'off'}`,
              `**Anti-nuke** · ${settings.antinuke ? 'on' : 'off'}`,
              `**Nuke limit** · ${settings.nuke_limit === 1 ? 'first action' : `${settings.nuke_limit}th action`} / 10s`,
              `**Nuke punish** · ${settings.nuke_punish}`,
            ].join('\n'), inline: true },
          { name: 'Warnings & access', value: [
              `**Timeout at** · ${settings.warn_timeout_at} warns`,
              `**Kick at** · ${settings.warn_kick_at} warns`,
              `**Strict admin** · ${settings.admin_only ? 'on' : 'off'}`,
              `**Main owner** · <@${mainOwnerId}>`,
              `**Granted users** · ${access.size}`,
            ].join('\n'), inline: true },
          { name: 'Anti-spam thresholds', value: truncate(
              `flood ${antiSpamCfg.flood_count}/${antiSpamCfg.flood_window}s · dup ${antiSpamCfg.dup_count}/${antiSpamCfg.dup_window}s · mentions ${antiSpamCfg.mention_count} · links ${antiSpamCfg.link_count} · invites ${antiSpamCfg.invite_block ? 'blocked' : 'allowed'} · timeout ${humanDuration(antiSpamCfg.timeout_secs * 1000)}`,
              1024), inline: false },
          { name: 'Usage', value: [
              `\`${p}botconfig set <key> <value>\``,
              `\`${p}botconfig reset [key]\``,
              `Keys: ${[...BOTCONFIG_KEYS.keys()].map((k) => `\`${k}\``).join(', ')}`,
              `-# Anti-spam thresholds: \`${p}antispam config\``,
            ].join('\n'), inline: false }
        )
        .setFooter({ text: `Prefix: ${p} • ${BOT_AUTHOR}` });
      return reply(msg, embed);
    };

    if (sub === 'show' || sub === 'view' || !args[0]) return show();

    if (sub === 'set') {
      const key = (args[1] || '').toLowerCase();
      const valueRaw = raw.replace(/^\s*set\s+\S+\s*/i, '').trim();
      const meta = BOTCONFIG_KEYS.get(key);
      if (!meta) {
        return reply(msg, errEmbed('Unknown key', `Valid keys: ${[...BOTCONFIG_KEYS.keys()].map((k) => `\`${k}\``).join(', ')}`));
      }
      if (!valueRaw) return reply(msg, errEmbed('Missing value', `Usage: \`${p}botconfig set ${key} <${meta.hint}>\``));
      const parsed = meta.parse(valueRaw, msg);
      if (parsed === null && !['logchannel', 'autorole'].includes(key)) {
        return reply(msg, errEmbed('Invalid value', `\`${key}\` expects: **${meta.hint}**`));
      }
      await updateSettings(msg.guild.id, { [key]: parsed });
      const shown = key === 'logchannel' ? (parsed ? `<#${parsed}>` : 'off') : key === 'autorole' ? (parsed ? `<@&${parsed}>` : 'off') : String(parsed ?? 'off');
      return reply(msg, okEmbed('Setting updated', `**${key}** → ${shown}`));
    }

    if (sub === 'reset') {
      const key = (args[1] || '').toLowerCase();
      const defaults = {
        prefix: DEFAULT_PREFIX,
        statusbar: 1,
        antispam: 1,
        antinuke: 0,
        nuke_limit: 3,
        nuke_punish: 'ban',
        warn_timeout_at: 3,
        warn_kick_at: 5,
        admin_only: 1,
        logchannel: null,
        autorole: null,
      };
      if (!key) {
        await updateSettings(msg.guild.id, defaults);
        return reply(msg, okEmbed('Configuration reset', 'Every setting (except the prefix-independent data) is back to default.'));
      }
      if (!BOTCONFIG_KEYS.has(key)) return reply(msg, errEmbed('Unknown key', 'Run `!botconfig` to see valid keys.'));
      await updateSettings(msg.guild.id, { [key]: defaults[key] });
      return reply(msg, okEmbed('Setting reset', `**${key}** → \`${defaults[key]}\``));
    }

    return reply(msg, errEmbed('Unknown subcommand', `\`${p}botconfig [show|set <key> <value>|reset [key]]\``));
  },
});

/* ===================== CUSTOM EMOJI MANAGER ===================== */

/** <:name:id> | <a:name:id> | :name: | raw guild emoji */
function describeEmoji(emoji) {
  if (!emoji) return null;
  return {
    name: emoji.name,
    id: emoji.id,
    animated: !!emoji.animated,
    mention: `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`,
    url: emoji.imageURL ? emoji.imageURL({ size: 128 }) : null,
  };
}

defineCommand({
  name: 'emoji',
  aliases: ['emojis', 'emote'],
  category: 'General',
  usage: 'emoji <list|add <name> <url>|delete <name|id>|info <emoji>>',
  description: 'Manage the bot’s own (application) emojis and inspect any custom emoji.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || 'list').toLowerCase();
    const app = msg.client.application;

    const noSupport = () =>
      reply(
        msg,
        errEmbed(
          'Not supported',
          'This discord.js version does not expose application emojis.\nUpgrade with `npm i discord.js@latest` (v14.20+).'
        )
      );

    /* ---------- list ---------- */
    if (sub === 'list') {
      let appEmojis = [];
      if (app && app.emojis) {
        const fetched = await app.emojis.fetch().catch(() => null);
        if (fetched) appEmojis = [...fetched.values()];
      }
      const guildEmojis = [...msg.guild.emojis.cache.values()];

      const embed = baseEmbed(COLORS.main, '😀 Custom emojis')
        .setDescription(
          [
            '**How to use one** — type it, or paste its code:',
            '`<:name:id>` for static, `<a:name:id>` for animated (right-click → *Copy Emoji ID*).',
            '',
            '**Bot (application) emojis** work in *every* server the bot is in — even in buttons and select menus.',
            '**Server emojis** only work where that server shares them with the bot.',
          ].join('\n')
        )
        .addFields({
          name: `🤖 Bot emojis (${appEmojis.length})`,
          value: appEmojis.length
            ? truncate(appEmojis.slice(0, 20).map((e) => `${e} \`${describeEmoji(e).mention}\``).join('\n'), 1024)
            : 'None yet — `' + p + 'emoji add wave https://i.imgur.com/xxxx.png`',
          inline: false,
        })
        .addFields({
          name: `🏠 Server emojis (${guildEmojis.length})`,
          value: guildEmojis.length
            ? truncate(guildEmojis.slice(0, 15).map((e) => `${e} \`<${e.animated ? 'a' : ''}:${e.name}:${e.id}>\``).join('\n'), 1024)
            : 'No custom emojis in this server.',
          inline: false,
        })
        .addFields({
          name: 'Commands',
          value: [
            `\`${p}emoji add <name> <image-url>\` — upload an emoji to the bot`,
            `\`${p}emoji delete <name|id>\` — remove a bot emoji`,
            `\`${p}emoji info <emoji|id>\` — details + the exact code to paste`,
          ].join('\n'),
          inline: false,
        })
        .setFooter({ text: `Emoji uploads: PNG/JPG/GIF ≤ 256 KB • ${BOT_AUTHOR}` });
      return reply(msg, embed);
    }

    /* ---------- add ---------- */
    if (sub === 'add') {
      if (!app || !app.emojis) return noSupport();
      const name = (args[1] || '').toLowerCase();
      const url = (args[2] || '').replace(/^<|>$/g, '');
      if (!/^[a-z0-9_]{2,32}$/.test(name)) {
        return reply(msg, errEmbed('Invalid name', 'Emoji names: 2–32 characters, lowercase letters, numbers and `_`.\nExample: `wave_hello`'));
      }
      if (!isHttpUrl(url)) {
        return reply(msg, errEmbed('Invalid image', `Usage: \`${p}emoji add <name> <image-url>\`\nAttach the image somewhere and copy its link (PNG/JPG/GIF, ≤ 256 KB).`));
      }
      const existing = [...(await app.emojis.fetch().catch(() => new Map())).values()].find((e) => e.name === name);
      if (existing) {
        return reply(msg, errEmbed('Name taken', `The bot already has an emoji called \`${name}\`. Delete it first with \`${p}emoji delete ${name}\`.`));
      }
      const created = await app.emojis.create({ attachment: url, name }).catch((err) => err);
      if (!created || created instanceof Error) {
        return reply(msg, errEmbed('Upload failed', truncate((created && created.message) || 'Discord rejected the image (size, format or URL?).', 400)));
      }
      const info = describeEmoji(created);
      await modLog(msg.guild, settings, baseEmbed(COLORS.success, '😀 Bot emoji added').addFields(
        { name: 'Emoji', value: `${created} \`${info.mention}\``, inline: true },
        { name: 'By', value: `<@${msg.author.id}>`, inline: true }
      ));
      return reply(msg, okEmbed('😀 Emoji added to the bot', `${created} **${info.name}**\n**Copy-paste code:** \`${info.mention}\`\n-# Animated: ${info.animated ? 'yes' : 'no'} • works in every server the bot is in`));
    }

    /* ---------- delete ---------- */
    if (sub === 'delete' || sub === 'remove' || sub === 'del') {
      if (!app || !app.emojis) return noSupport();
      const target = (args[1] || '').replace(/[<>]/g, '');
      if (!target) return reply(msg, errEmbed('Missing emoji', `Usage: \`${p}emoji delete <name|id>\``));
      const id = parseId(target);
      const list = [...(await app.emojis.fetch().catch(() => new Map())).values()];
      const found = list.find((e) => (id && e.id === id) || e.name === target.toLowerCase());
      if (!found) return reply(msg, errEmbed('Not found', `The bot has no emoji called \`${truncate(target, 60)}\`.`));
      const done = await found.delete().then(() => true).catch(() => false);
      if (!done) return reply(msg, errEmbed('Delete failed', 'Discord rejected the request.'));
      return reply(msg, okEmbed('🗑️ Emoji deleted', `**${found.name}** was removed from the bot.`));
    }

    /* ---------- info ---------- */
    if (sub === 'info' || sub === 'show') {
      const target = (args[1] || '').replace(/[<>]/g, '');
      if (!target) return reply(msg, errEmbed('Missing emoji', `Usage: \`${p}emoji info <emoji|id>\``));

      let emoji = null;
      let source = 'unknown';
      if (app && app.emojis) {
        const appList = [...(await app.emojis.fetch().catch(() => new Map())).values()];
        emoji = appList.find((e) => e.id === target || e.name === target.toLowerCase()) || null;
        if (emoji) source = 'bot (application) emoji';
      }
      if (!emoji) {
        const parsed = parseEmoji(args[1]);
        const guildEmoji =
          msg.guild.emojis.cache.get(target) ||
          (parsed && parsed.id ? msg.guild.emojis.cache.get(parsed.id) : null) ||
          (parsed && parsed.name ? msg.guild.emojis.cache.find((e) => e.name === parsed.name) : null);
        if (guildEmoji) {
          emoji = guildEmoji;
          source = 'server emoji';
        }
      }
      if (!emoji) {
        const parsed = parseEmoji(args[1]);
        if (parsed && typeof parsed === 'string') {
          return reply(msg, infoEmbed('😀 Unicode emoji', `**${parsed}** is a standard emoji — it can be used anywhere without an ID.`));
        }
        return reply(msg, errEmbed('Emoji not found', 'Give me the emoji itself, an ID, or a `<:name:id>` code.\n-# Tip: enable Developer Mode, then right-click the emoji → *Copy Emoji ID*.'));
      }

      const info = describeEmoji(emoji);
      const embed = baseEmbed(COLORS.main, `😀 ${info.name}`)
        .addFields(
          { name: 'Source', value: source, inline: true },
          { name: 'Animated', value: info.animated ? 'yes' : 'no', inline: true },
          { name: 'Emoji ID', value: `\`${info.id}\``, inline: true },
          { name: 'Code to paste', value: `\`${info.mention}\``, inline: false },
          { name: 'Where it works', value: source === 'bot (application) emoji' ? 'Every server the bot is in (messages, embeds, buttons, menus)' : 'Only in this server (and where it is shared)', inline: false }
        )
        .setFooter({ text: `Use it in commands like ${p}giveaway emoji ${info.mention} • ${BOT_AUTHOR}` });
      if (info.url && isHttpUrl(info.url)) embed.setThumbnail(info.url);
      return reply(msg, embed);
    }

    return reply(msg, errEmbed('Unknown subcommand', `\`${p}emoji list|add <name> <url>|delete <name|id>|info <emoji>\``));
  },
});

/* ===================== DEVELOPER ===================== */

defineCommand({
  name: 'developer',
  aliases: ['dev', 'credits', 'about'],
  category: 'General',
  usage: 'developer',
  description: 'About the developer and this bot.',
  async run(msg, args, settings) {
    const uptimeMs = msg.client.uptime || 0;
    const guilds = msg.client.guilds.cache.size;
    const users = msg.client.guilds.cache.reduce((sum, g) => sum + (g.memberCount || 0), 0);
    const embed = baseEmbed(COLORS.main, '👨‍💻 Developer & Credits')
      .setDescription(
        [
          '**Made by AashirwadGamerzz**',
          '',
          'An all-in-one Discord bot: anti-nuke, anti-spam, tickets, giveaways, verification,',
          'invite tracking, moderation, welcome system and much more — all in one file.',
        ].join('\n')
      )
      .addFields(
        { name: 'Developer', value: '**AashirwadGamerzz**', inline: true },
        { name: 'Stack', value: 'Node.js · discord.js v14 · SQLite', inline: true },
        { name: 'Commands', value: `${uniqueCommands().size}`, inline: true },
        { name: 'Servers', value: `${guilds}`, inline: true },
        { name: 'Users reached', value: `${users}`, inline: true },
        { name: 'Uptime', value: humanDuration(uptimeMs), inline: true },
        { name: 'Prefix here', value: `\`${settings.prefix}\``, inline: true },
        { name: 'Help', value: `\`${settings.prefix}help\``, inline: true }
      )
      .setFooter({ text: BOT_AUTHOR })
      .setThumbnail(msg.client.user.displayAvatarURL({ size: 256 }));
    return reply(msg, embed);
  },
});

/* ===================== ACCESS CONTROL (main owner only) ===================== */

defineCommand({
  name: 'access',
  category: 'Access Control',
  usage: 'access <add|remove|list|check|strict> [@user|on|off]',
  description: 'Main owner only: hand out access to admin commands.',
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || 'list').toLowerCase();
    const mainOwner = await isMainOwner(msg.guild, msg.author.id);

    const deny = () =>
      reply(
        msg,
        errEmbed('🔑 Main owner only', 'Only the **main owner** can grant or revoke admin access.\n-# The main owner is the server owner, or whoever they set with `!mainowner set @user`.')
      );

    if (['add', 'remove', 'strict'].includes(sub) && !mainOwner) return deny();

    if (sub === 'add' || sub === 'remove') {
      const target = parseId(args[1]);
      const user = await resolveUser(msg, args[1]);
      const userId = target || (user && user.id);
      if (!userId) return reply(msg, errEmbed('User not found', `Usage: \`${p}access ${sub} @user\``));
      if (userId === msg.client.user.id) return reply(msg, errEmbed('Nope', 'I already have access to everything 🙂'));
      if (sub === 'add') {
        await grantAccess(msg.guild.id, userId, msg.author.id);
        await modLog(msg.guild, settings, baseEmbed(COLORS.success, '🔑 Admin access granted')
          .addFields({ name: 'User', value: `<@${userId}>`, inline: true }, { name: 'Granted by', value: `<@${msg.author.id}>`, inline: true }));
        return reply(msg, okEmbed('🔑 Access granted', `<@${userId}> can now use admin commands.\n-# Revoke with \`${p}access remove @user\``));
      }
      const removed = await revokeAccess(msg.guild.id, userId);
      await modLog(msg.guild, settings, baseEmbed(COLORS.warn, '🔑 Admin access revoked')
        .addFields({ name: 'User', value: `<@${userId}>`, inline: true }, { name: 'Revoked by', value: `<@${msg.author.id}>`, inline: true }));
      return reply(msg, removed ? okEmbed('🔑 Access revoked', `<@${userId}> can no longer use admin commands.`) : errEmbed('Not found', 'That user had no granted access.'));
    }

    if (sub === 'strict') {
      const value = (args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) {
        return reply(msg, errEmbed('Invalid option', `Usage: \`${p}access strict on|off\`\n**on** = admin commands need main-owner/granted access (default)\n**off** = normal Discord permissions are enough`));
      }
      await updateSettings(msg.guild.id, { admin_only: value === 'on' ? 1 : 0 });
      return reply(msg, okEmbed('Strict mode ' + value, value === 'on'
        ? 'Admin commands now require the main owner or a granted user.'
        : 'Admin commands now only require the normal Discord permissions.'));
    }

    if (sub === 'check') {
      const targetId = parseId(args[1]) || msg.author.id;
      const ok = await hasAdminAccess(msg.guild, targetId);
      const owner = await isMainOwner(msg.guild, targetId);
      return reply(msg, infoEmbed('🔑 Access check', [
        `**User:** <@${targetId}>`,
        `**Main owner:** ${owner ? 'yes' : 'no'}`,
        `**Admin access:** ${ok ? 'yes ✅' : 'no ❌'}`,
        `**Strict mode:** ${settings.admin_only ? 'on' : 'off'}`,
      ].join('\n')));
    }

    // list
    const list = await getAccessList(msg.guild.id);
    const mainOwnerId = (await getMainOwnerId(msg.guild.id)) || msg.guild.ownerId;
    const embed = baseEmbed(COLORS.main, '🔑 Admin access')
      .setDescription(
        list.size
          ? [...list.values()].map((r) => `<@${r.user_id}> — granted by <@${r.granted_by}> <t:${Math.floor((r.granted_at || 0) / 1000)}:R>`).join('\n')
          : 'Nobody has been granted access yet.'
      )
      .addFields(
        { name: 'Main owner', value: `<@${mainOwnerId}>`, inline: true },
        { name: 'Strict mode', value: settings.admin_only ? 'on' : 'off', inline: true },
        { name: 'Granted', value: String(list.size), inline: true }
      )
      .setFooter({ text: `${p}access add|remove @user • ${BOT_AUTHOR}` });
    return reply(msg, embed);
  },
});

defineCommand({
  name: 'mainowner',
  category: 'Access Control',
  usage: 'mainowner <set @user|show|clear>',
  description: 'Server owner only: choose who the main owner is.',
  async run(msg, args, settings) {
    const p = settings.prefix;
    const sub = (args[0] || 'show').toLowerCase();
    const currentConfigured = await getMainOwnerId(msg.guild.id);

    if (sub === 'show' || !args[0]) {
      return reply(msg, baseEmbed(COLORS.main, '🔑 Main owner')
        .addFields(
          { name: 'Server owner', value: `<@${msg.guild.ownerId}>`, inline: true },
          { name: 'Configured main owner', value: currentConfigured ? `<@${currentConfigured}>` : 'not set (server owner)', inline: true },
          { name: 'Effective', value: `<@${currentConfigured || msg.guild.ownerId}>`, inline: true }
        )
        .setFooter({ text: `${p}mainowner set @user • ${BOT_AUTHOR}` }));
    }

    if (msg.author.id !== msg.guild.ownerId) {
      return reply(msg, errEmbed('❌ Server owner only', 'Only the **Discord server owner** can change the main owner.'));
    }

    if (sub === 'clear') {
      await dbRun('DELETE FROM main_owner WHERE guild_id = ?', [msg.guild.id]);
      return reply(msg, okEmbed('Main owner cleared', 'The server owner is the main owner again.'));
    }

    if (sub === 'set') {
      const userId = parseId(args[1]);
      if (!userId) return reply(msg, errEmbed('User not found', `Usage: \`${p}mainowner set @user\``));
      if (userId === msg.client.user.id) return reply(msg, errEmbed('Nope', 'I cannot be the main owner.'));
      await setMainOwnerId(msg.guild.id, userId);
      await modLog(msg.guild, settings, baseEmbed(COLORS.main, '🔑 Main owner changed')
        .addFields({ name: 'New main owner', value: `<@${userId}>`, inline: true }, { name: 'Set by', value: `<@${msg.author.id}>`, inline: true }));
      return reply(msg, okEmbed('Main owner updated', `<@${userId}> is now the main owner and can grant admin access.`));
    }

    return reply(msg, errEmbed('Unknown subcommand', `\`${p}mainowner set @user | show | clear\``));
  },
});

/* ===================== ROLE MANAGEMENT ===================== */

defineCommand({
  name: 'roleall',
  aliases: ['massrole', 'allroles'],
  category: 'Roles & AFK',
  usage: 'roleall <add|remove> @role [--humans|--bots] [--dry]',
  description: 'Add or remove a role for every member (or just humans/bots).',
  permission: PermissionFlagsBits.ManageRoles,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const action = (args[0] || '').toLowerCase();
    if (!['add', 'remove'].includes(action)) {
      return reply(msg, errEmbed('Invalid usage', `Usage: \`${p}roleall add|remove @role [--humans|--bots] [--dry]\``));
    }
    const { flags, text } = extractFlags(raw.replace(/^\s*\S+\s*/, ''), [], ['humans', 'bots', 'dry']);
    const role = msg.mentions.roles.first() || resolveRole(msg.guild, tokenize(text)[0] || '');
    if (!role) return reply(msg, errEmbed('Role not found', `Usage: \`${p}roleall ${action} @role\``));
    if (role.managed) return reply(msg, errEmbed('Not possible', 'That role is managed by an integration.'));
    if (role.id === msg.guild.id) return reply(msg, errEmbed('Not possible', 'The @everyone role cannot be assigned manually.'));

    const me = msg.guild.members.me;
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return reply(msg, errEmbed('Missing permission', 'I need the **Manage Roles** permission.'));
    }
    if (role.position >= me.roles.highest.position) {
      return reply(msg, errEmbed('Hierarchy error', `**${role.name}** is above my highest role (**${me.roles.highest.name}**).`));
    }
    if (msg.author.id !== msg.guild.ownerId && role.position >= msg.member.roles.highest.position) {
      return reply(msg, errEmbed('Hierarchy error', `**${role.name}** is above your highest role.`));
    }

    const everyone = await msg.guild.members.fetch().catch(() => null);
    if (!everyone) return reply(msg, errEmbed('Failed', 'I could not fetch the member list (missing **Server Members** intent?).'));

    let targets = [...everyone.values()].filter((m) => {
      if (m.user.bot && flags.humans) return false;
      if (!m.user.bot && flags.bots) return false;
      if (m.id === msg.client.user.id) return false;
      if (m.id === msg.guild.ownerId) return false;
      if (role.position >= me.roles.highest.position) return false;
      return action === 'add' ? !m.roles.cache.has(role.id) : m.roles.cache.has(role.id);
    });

    if (!targets.length) {
      return reply(msg, infoEmbed('Nothing to do', `No member needs **${role.name}** ${action === 'add' ? 'added' : 'removed'}.`));
    }

    if (flags.dry) {
      return reply(msg, infoEmbed('🧪 Dry run', `Would ${action} **${role.name}** for **${targets.length}** member(s):\n${truncate(targets.slice(0, 20).map((m) => `<@${m.id}>`).join(', ') + (targets.length > 20 ? ` …and ${targets.length - 20} more` : ''), 1500)}`));
    }

    const progress = await msg.channel.send({
      embeds: [infoEmbed('🎭 Role update running', `**${action === 'add' ? 'Adding' : 'Removing'}** ${role} — 0/${targets.length}`)],
      allowedMentions: { parse: [] },
    }).catch(() => null);

    let done = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i += 1) {
      const member = targets[i];
      const ok = action === 'add'
        ? await member.roles.add(role, `roleall by ${msg.author.tag}`).then(() => true).catch(() => false)
        : await member.roles.remove(role, `roleall by ${msg.author.tag}`).then(() => true).catch(() => false);
      if (ok) done += 1;
      else failed += 1;

      if (progress && (i + 1) % 25 === 0) {
        await progress.edit({ embeds: [infoEmbed('🎭 Role update running', `**${action === 'add' ? 'Adding' : 'Removing'}** ${role} — ${i + 1}/${targets.length}\n✅ ${done} · ❌ ${failed}`)] }).catch(() => {});
      }
      // gentle pacing to stay far away from rate limits
      if ((i + 1) % 10 === 0) await new Promise((r) => setTimeout(r, 250));
    }

    const summary = okEmbed('🎭 Role update finished', [
      `**Role:** ${role}`,
      `**Action:** ${action}`,
      `**Updated:** ${done}`,
      `**Failed:** ${failed}`,
    ].join('\n'));

    if (progress) await progress.edit({ embeds: [summary] }).catch(() => {});
    else await reply(msg, summary);

    await modLog(msg.guild, settings, baseEmbed(COLORS.mod, '🎭 Mass role update')
      .addFields(
        { name: 'Role', value: `<@&${role.id}>`, inline: true },
        { name: 'Action', value: action, inline: true },
        { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true },
        { name: 'Updated', value: String(done), inline: true },
        { name: 'Failed', value: String(failed), inline: true }
      ));
  },
});

/* ===================== LOCK / UNLOCK ===================== */

defineCommand({
  name: 'lock',
  aliases: ['lockchannel'],
  category: 'Moderation',
  usage: 'lock [#channel] [reason]',
  description: 'Lock a channel so @everyone cannot talk.',
  permission: PermissionFlagsBits.ManageChannels,
  async run(msg, args, settings, raw) {
    const channel = msg.mentions.channels.first() || msg.channel;
    if (!channel.isTextBased() || channel.type === ChannelType.GuildCategory) {
      return reply(msg, errEmbed('Invalid channel', 'Pick a text channel.'));
    }
    const existing = await dbGet('SELECT * FROM locked_channels WHERE guild_id = ? AND channel_id = ?', [msg.guild.id, channel.id]);
    if (existing) return reply(msg, warnEmbed('Already locked', `${channel} is already locked. Use \`${settings.prefix}unlock\`.`));

    const reason = raw.replace(/^\s*<#\d+>\s*/, '').trim() || 'No reason provided';
    const done = await lockChannel(channel, msg.author, reason).then(() => true).catch(() => false);
    if (!done) return reply(msg, errEmbed('Lock failed', 'I need **Manage Channel** / **Manage Permissions** in that channel.'));

    await channel.send({ embeds: [warnEmbed('🔒 Channel locked', `This channel was locked by <@${msg.author.id}>.\n**Reason:** ${truncate(reason, 900)}`)] }).catch(() => {});
    await modLog(msg.guild, settings, baseEmbed(COLORS.warn, '🔒 Channel locked').addFields(
      { name: 'Channel', value: `<#${channel.id}>`, inline: true },
      { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true },
      { name: 'Reason', value: truncate(reason, 1024), inline: false }
    ));
    return reply(msg, okEmbed('🔒 Channel locked', `${channel} is locked for @everyone.`));
  },
});

defineCommand({
  name: 'unlock',
  aliases: ['unlockchannel'],
  category: 'Moderation',
  usage: 'unlock [#channel] [reason]',
  description: 'Unlock a previously locked channel.',
  permission: PermissionFlagsBits.ManageChannels,
  async run(msg, args, settings, raw) {
    const channel = msg.mentions.channels.first() || msg.channel;
    if (!channel.isTextBased() || channel.type === ChannelType.GuildCategory) {
      return reply(msg, errEmbed('Invalid channel', 'Pick a text channel.'));
    }
    const reason = raw.replace(/^\s*<#\d+>\s*/, '').trim() || 'No reason provided';
    const restored = await unlockChannel(channel, msg.author, reason).catch(() => null);
    if (restored === null) return reply(msg, errEmbed('Unlock failed', 'I need **Manage Channel** / **Manage Permissions** in that channel.'));

    await channel.send({ embeds: [okEmbed('🔓 Channel unlocked', `This channel was unlocked by <@${msg.author.id}>.\n**Reason:** ${truncate(reason, 900)}`)] }).catch(() => {});
    await modLog(msg.guild, settings, baseEmbed(COLORS.success, '🔓 Channel unlocked').addFields(
      { name: 'Channel', value: `<#${channel.id}>`, inline: true },
      { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true },
      { name: 'Restored previous state', value: restored ? 'yes' : 'no (defaults applied)', inline: true },
      { name: 'Reason', value: truncate(reason, 1024), inline: false }
    ));
    return reply(msg, okEmbed('🔓 Channel unlocked', `${channel} is open again for @everyone.`));
  },
});

/* ===================== INFO COMMANDS ===================== */

/** Formats a permission bitfield into a short comma list. */
function formatPermissions(perms, limit = 12) {
  if (!perms) return '—';
  const names = perms.toArray();
  if (!names.length) return 'none';
  return names.slice(0, limit).join(', ') + (names.length > limit ? ` …+${names.length - limit}` : '');
}

defineCommand({
  name: 'userinfo',
  aliases: ['whois', 'ui'],
  category: 'Info',
  usage: 'userinfo [@user|id]',
  description: 'Detailed information about a user.',
  async run(msg, args, settings) {
    const targetId = parseId(args[0]) || msg.author.id;
    const member = await msg.guild.members.fetch(targetId, { force: true }).catch(() => null);
    const user = member ? member.user : await resolveUser(msg, args[0]);
    if (!user) return reply(msg, errEmbed('User not found', 'Mention a member or give a valid user ID.'));

    const stats = await getInviteStats(msg.guild.id, user.id);
    const { c: warns } = await dbGet('SELECT COUNT(*) AS c FROM warnings WHERE guild_id = ? AND user_id = ?', [msg.guild.id, user.id]);
    const afkRow = await dbGet('SELECT * FROM afk WHERE guild_id = ? AND user_id = ?', [msg.guild.id, user.id]);

    const embed = baseEmbed(COLORS.info, `👤 ${user.tag}`)
      .setThumbnail(user.displayAvatarURL({ size: 256, extension: 'png' }))
      .addFields(
        { name: 'User', value: `<@${user.id}>`, inline: true },
        { name: 'User ID', value: `\`${user.id}\``, inline: true },
        { name: 'Bot', value: user.bot ? 'yes' : 'no', inline: true },
        { name: 'Account created', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:f>\n(<t:${Math.floor(user.createdTimestamp / 1000)}:R>)`, inline: true }
      );

    if (member) {
      embed.addFields(
        { name: 'Joined server', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:f>\n(<t:${Math.floor(member.joinedTimestamp / 1000)}:R>)`, inline: true },
        { name: 'Highest role', value: `<@&${member.roles.highest.id}>`, inline: true },
        { name: 'Nickname', value: truncate(member.nickname || '—', 100), inline: true }
      );
      const roles = member.roles.cache.filter((r) => r.id !== msg.guild.id).sort((a, b) => b.position - a.position);
      embed.addFields({ name: `Roles (${roles.size})`, value: truncate(roles.size ? roles.map((r) => `<@&${r.id}>`).join(' ') : 'none', 1024), inline: false });
      embed.addFields({ name: 'Key permissions', value: truncate(formatPermissions(member.permissionsIn(msg.channel), 10), 1024), inline: false });
      if (member.premiumSince) {
        embed.addFields({ name: 'Boosting since', value: `<t:${Math.floor(member.premiumSinceTimestamp / 1000)}:R>`, inline: true });
      }
    } else {
      embed.addFields({ name: 'Member', value: 'not in this server', inline: true });
    }

    embed.addFields(
      { name: 'Invites', value: `${stats.joins} joins · ${stats.leaves} leaves · **${stats.total}** net`, inline: true },
      { name: 'Warnings', value: String(warns), inline: true },
      { name: 'AFK', value: afkRow ? `yes — ${truncate(afkRow.reason || 'AFK', 60)}` : 'no', inline: true }
    );
    embed.setFooter({ text: `Requested by ${msg.author.tag}` }).setTimestamp();

    return reply(msg, embed, { allowedMentions: { parse: [] } });
  },
});

defineCommand({
  name: 'serverinfo',
  aliases: ['guildinfo', 'si'],
  category: 'Info',
  usage: 'serverinfo',
  description: 'Detailed information about this server.',
  async run(msg, args, settings) {
    const guild = msg.guild;
    const owner = await guild.members.fetch(guild.ownerId).catch(() => null);
    const humans = guild.members.cache.filter((m) => !m.user.bot).size;
    const bots = guild.members.cache.filter((m) => m.user.bot).size;
    const channels = guild.channels.cache;
    const verification = ['None', 'Low', 'Medium', 'High', 'Highest'][guild.verificationLevel] || 'unknown';

    const embed = baseEmbed(COLORS.info, `🏰 ${guild.name}`)
      .setThumbnail(guild.iconURL({ size: 256, extension: 'png' }))
      .addFields(
        { name: 'Owner', value: owner ? `<@${owner.id}>` : `<@${guild.ownerId}>`, inline: true },
        { name: 'Server ID', value: `\`${guild.id}\``, inline: true },
        { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Members', value: `${guild.memberCount} total\n${humans} humans · ${bots} bots`, inline: true },
        { name: 'Channels', value: `${channels.filter((c) => c.type === ChannelType.GuildText).size} text · ${channels.filter((c) => c.type === ChannelType.GuildVoice).size} voice · ${channels.filter((c) => c.type === ChannelType.GuildCategory).size} categories`, inline: true },
        { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
        { name: 'Boosts', value: `level ${guild.premiumTier} · ${guild.premiumSubscriptionCount || 0} boost(s)`, inline: true },
        { name: 'Emojis', value: `${guild.emojis.cache.size} (${guild.emojis.cache.filter((e) => e.animated).size} animated)`, inline: true },
        { name: 'Verification', value: verification, inline: true },
        { name: 'Prefix', value: `\`${settings.prefix}\``, inline: true },
        { name: 'Security', value: `anti-nuke ${settings.antinuke ? 'on' : 'off'} · anti-spam ${settings.antispam ? 'on' : 'off'}`, inline: true },
        { name: 'Features', value: truncate(guild.features.length ? guild.features.join(', ').toLowerCase() : 'none', 1024), inline: false }
      )
      .setFooter({ text: BOT_AUTHOR })
      .setTimestamp();

    if (guild.bannerURL()) embed.setImage(guild.bannerURL({ size: 1024 }));
    return reply(msg, embed);
  },
});

defineCommand({
  name: 'roleinfo',
  aliases: ['ri'],
  category: 'Info',
  usage: 'roleinfo <@role|name|id>',
  description: 'Detailed information about a role.',
  async run(msg, args, settings, raw) {
    const input = raw.trim();
    const role =
      msg.mentions.roles.first() ||
      resolveRole(msg.guild, input) ||
      (parseId(input) ? msg.guild.roles.cache.get(parseId(input)) : null);
    if (!role) return reply(msg, errEmbed('Role not found', `Usage: \`${settings.prefix}roleinfo @role\``));

    const members = msg.guild.members.cache.filter((m) => m.roles.cache.has(role.id)).size;
    const embed = baseEmbed(role.hexColor !== '#000000' ? role.color : COLORS.info, `🎭 ${role.name}`)
      .addFields(
        { name: 'Role', value: `<@&${role.id}>`, inline: true },
        { name: 'Role ID', value: `\`${role.id}\``, inline: true },
        { name: 'Color', value: String(role.hexColor || '#000000').toUpperCase(), inline: true },
        { name: 'Position', value: `${role.position}`, inline: true },
        { name: 'Members', value: `${members}`, inline: true },
        { name: 'Created', value: `<t:${Math.floor(role.createdTimestamp / 1000)}:R>`, inline: true },
        { name: 'Hoisted', value: role.hoist ? 'yes' : 'no', inline: true },
        { name: 'Mentionable', value: role.mentionable ? 'yes' : 'no', inline: true },
        { name: 'Managed', value: role.managed ? 'yes (integration)' : 'no', inline: true },
        { name: 'Permissions', value: truncate(formatPermissions(role.permissions, 15), 1024), inline: false }
      )
      .setFooter({ text: BOT_AUTHOR })
      .setTimestamp();
    if (role.iconURL && role.iconURL()) embed.setThumbnail(role.iconURL({ size: 128 }));
    return reply(msg, embed, { allowedMentions: { parse: [] } });
  },
});

/* ===================== INVITE TRACKING ===================== */

defineCommand({
  name: 'invites',
  aliases: ['inv', 'invitecount'],
  category: 'Info',
  usage: 'invites [@user] | top | reset [@user|all]',
  description: 'Invite counts, leaderboard and reset.',
  async run(msg, args, settings) {
    const p = settings.prefix;
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'top' || sub === 'leaderboard') {
      const rows = await inviteLeaderboard(msg.guild.id, 10);
      if (!rows.length) return reply(msg, infoEmbed('🏆 Invite leaderboard', 'No invites tracked yet.'));
      const medals = ['🥇', '🥈', '🥉'];
      const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.userId}> — **${r.total}** (${r.joins} joins, ${r.leaves} leaves)`);
      return reply(msg, infoEmbed('🏆 Invite leaderboard', truncate(lines.join('\n'), 4000)).setFooter({ text: `Page 1 • ${BOT_AUTHOR}` }), { allowedMentions: { parse: [] } });
    }

    if (sub === 'reset') {
      const targetId = parseId(args[1]);
      const all = (args[1] || '').toLowerCase() === 'all';
      if (!targetId && !all) {
        return reply(msg, errEmbed('Invalid usage', `Usage: \`${p}invites reset @user\` or \`${p}invites reset all\``));
      }
      const cleared = await resetInvites(msg.guild.id, all ? null : targetId);
      await modLog(msg.guild, settings, baseEmbed(COLORS.warn, '📊 Invites reset').addFields(
        { name: 'Target', value: all ? 'everyone' : `<@${targetId}>`, inline: true },
        { name: 'Moderator', value: `<@${msg.author.id}>`, inline: true }
      ));
      return reply(msg, okEmbed('📊 Invites reset', all ? `Cleared invite counts for **all** members (${cleared} record(s)).` : `Cleared invite count for <@${targetId}> (${cleared} record(s)).`));
    }

    const targetId = parseId(args[0]) || msg.author.id;
    const member = await msg.guild.members.fetch(targetId).catch(() => null);
    const stats = await getInviteStats(msg.guild.id, targetId);
    const rankRows = await inviteLeaderboard(msg.guild.id, 100);
    const rank = rankRows.findIndex((r) => r.userId === targetId);

    return reply(msg, baseEmbed(COLORS.info, `📊 Invites — ${member ? member.user.tag : targetId}`)
      .setThumbnail(member ? member.user.displayAvatarURL({ size: 256 }) : null)
      .addFields(
        { name: 'Joins', value: String(stats.joins), inline: true },
        { name: 'Leaves', value: String(stats.leaves), inline: true },
        { name: 'Net invites', value: String(stats.total), inline: true },
        { name: 'Rank', value: rank >= 0 ? `#${rank + 1}` : 'not ranked', inline: true },
        { name: 'User', value: `<@${targetId}>`, inline: true }
      )
      .setFooter({ text: `${p}invites top • ${BOT_AUTHOR}` }), { allowedMentions: { parse: [] } });
  },
});

/* ===================== VERIFICATION ===================== */

defineCommand({
  name: 'verify',
  aliases: ['verification'],
  category: 'Verification',
  usage: 'verify <setup|panel|role|channel|message|title|button|emoji|color|banner|log|on|off|show|reset>',
  description: 'Configure and send the verification panel.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || 'show').toLowerCase();
    const rest = raw.replace(/^\s*\S+\s*/, '').trim();
    const cfg = await getVerifyConfig(msg.guild.id);

    const usage = [
      `\`${p}verify setup @role [#channel]\` — role to give + where the panel goes`,
      `\`${p}verify role @role\` · \`${p}verify channel #channel\``,
      `\`${p}verify message <text>\` · \`${p}verify title <text>\``,
      `\`${p}verify button <label>\` · \`${p}verify emoji <emoji>\``,
      `\`${p}verify color #57F287\` · \`${p}verify banner <url|off>\``,
      `\`${p}verify log #channel\` — log verified members`,
      `\`${p}verify on|off\` · \`${p}verify panel [#channel]\``,
      `\`${p}verify show\` · \`${p}verify reset\``,
    ].join('\n');

    if (sub === 'setup') {
      const role = msg.mentions.roles.first() || resolveRole(msg.guild, args[1] || '');
      if (!role) return reply(msg, errEmbed('Role not found', `Usage: \`${p}verify setup @role [#channel]\``));
      const me = msg.guild.members.me;
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return reply(msg, errEmbed('Missing permission', 'I need **Manage Roles**.'));
      if (role.managed) return reply(msg, errEmbed('Not possible', 'That role is managed by an integration.'));
      if (role.position >= me.roles.highest.position) {
        return reply(msg, errEmbed('Hierarchy error', `**${role.name}** is above my highest role (**${me.roles.highest.name}**).`));
      }
      const channel = msg.mentions.channels.first() || msg.channel;
      await updateVerifyConfig(msg.guild.id, { role: role.id, channel: channel.id, enabled: 1 });
      return reply(msg, okEmbed('✅ Verification configured', `Members who verify get **${role.name}**.\nPanel channel: ${channel}\n-# Send the panel with \`${p}verify panel\``));
    }

    if (sub === 'role') {
      const role = msg.mentions.roles.first() || resolveRole(msg.guild, args[1] || '');
      if (!role) return reply(msg, errEmbed('Role not found', `Usage: \`${p}verify role @role\``));
      const me = msg.guild.members.me;
      if (role.position >= me.roles.highest.position) return reply(msg, errEmbed('Hierarchy error', 'That role is above my highest role.'));
      await updateVerifyConfig(msg.guild.id, { role: role.id });
      return reply(msg, okEmbed('Role updated', `Verified members will receive **${role.name}**.`));
    }

    if (sub === 'channel') {
      const channel = msg.mentions.channels.first();
      if (!channel || !channel.isTextBased()) return reply(msg, errEmbed('Invalid channel', `Usage: \`${p}verify channel #channel\``));
      await updateVerifyConfig(msg.guild.id, { channel: channel.id });
      return reply(msg, okEmbed('Channel updated', `The verification panel belongs in ${channel}.`));
    }

    if (sub === 'log' || sub === 'logs' || sub === 'logchannel') {
      const channel = msg.mentions.channels.first();
      if (!channel || !channel.isTextBased()) return reply(msg, errEmbed('Invalid channel', `Usage: \`${p}verify log #channel\``));
      await updateVerifyConfig(msg.guild.id, { logchannel: channel.id });
      return reply(msg, okEmbed('Log channel set', `Verified members are logged in ${channel}.`));
    }

    if (sub === 'title') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}verify title <text>\``));
      await updateVerifyConfig(msg.guild.id, { title: truncate(rest, 256) });
      return reply(msg, okEmbed('Title updated', truncate(rest, 900)));
    }

    if (sub === 'message' || sub === 'desc' || sub === 'description') {
      if (!rest) return reply(msg, errEmbed('Missing text', `Usage: \`${p}verify message <text>\``));
      await updateVerifyConfig(msg.guild.id, { message: truncate(rest, 4000) });
      return reply(msg, okEmbed('Message updated', truncate(rest, 900)));
    }

    if (sub === 'button') {
      if (!rest) return reply(msg, errEmbed('Missing label', `Usage: \`${p}verify button <label>\``));
      await updateVerifyConfig(msg.guild.id, { button: truncate(rest, 80) });
      return reply(msg, okEmbed('Button updated', `The button now says **${truncate(rest, 80)}**.`));
    }

    if (sub === 'emoji') {
      const emoji = parseEmoji(args[1]);
      if (!emoji) return reply(msg, errEmbed('Invalid emoji', `Usage: \`${p}verify emoji ✅\` (unicode or \`<:name:id>\`)`));
      await updateVerifyConfig(msg.guild.id, { emoji: emojiToString(emoji) });
      return reply(msg, okEmbed('Emoji updated', `The button now uses ${emojiToString(emoji)}.`));
    }

    if (sub === 'color' || sub === 'colour') {
      const color = parseHexColor(args[1]);
      if (color === null) return reply(msg, errEmbed('Invalid color', `Usage: \`${p}verify color #57F287\``));
      await updateVerifyConfig(msg.guild.id, { color });
      return reply(msg, baseEmbed(color, '🎨 Color updated', 'The verification panel uses the new color.'));
    }

    if (sub === 'banner') {
      if (!rest) return reply(msg, errEmbed('Missing URL', `Usage: \`${p}verify banner <url|off>\``));
      if (rest.toLowerCase() === 'off') {
        await updateVerifyConfig(msg.guild.id, { banner: null });
        return reply(msg, okEmbed('Banner removed', 'The panel has no banner now.'));
      }
      if (!isHttpUrl(rest)) return reply(msg, errEmbed('Invalid URL', 'Provide a valid `http(s)://` image URL, or `off`.'));
      await updateVerifyConfig(msg.guild.id, { banner: rest });
      return reply(msg, okEmbed('Banner updated', rest).setImage(rest));
    }

    if (sub === 'on' || sub === 'off') {
      await updateVerifyConfig(msg.guild.id, { enabled: sub === 'on' ? 1 : 0 });
      return reply(msg, okEmbed(`Verification ${sub}`, sub === 'on' ? 'The verify button works again.' : 'The verify button is disabled.'));
    }

    if (sub === 'panel') {
      if (!cfg.role) return reply(msg, errEmbed('Setup incomplete', `Choose the role first: \`${p}verify setup @role #channel\``));
      const channel = msg.mentions.channels.first() || msg.channel;
      const sent = await channel.send(buildVerifyPanel(cfg)).catch(() => null);
      if (!sent) return reply(msg, errEmbed('Failed', `I could not post the panel in ${channel}.`));
      await updateVerifyConfig(msg.guild.id, { channel: channel.id });
      return reply(msg, okEmbed('✅ Panel sent', `The verification panel is live in ${channel}.`));
    }

    if (sub === 'reset') {
      await updateVerifyConfig(msg.guild.id, {
        title: VERIFY_DEFAULTS.title,
        message: VERIFY_DEFAULTS.message,
        button: VERIFY_DEFAULTS.button,
        emoji: VERIFY_DEFAULTS.emoji,
        color: VERIFY_DEFAULTS.color,
        banner: null,
        enabled: 1,
      });
      return reply(msg, okEmbed('Verification reset', 'Panel texts are back to default (role and channel kept).'));
    }

    // show
    return reply(msg, baseEmbed(cfg.color, '✅ Verification settings')
      .addFields(
        { name: 'State', value: cfg.enabled ? 'Enabled ✅' : 'Disabled ❌', inline: true },
        { name: 'Role', value: cfg.role ? `<@&${cfg.role}>` : '⚠️ not set', inline: true },
        { name: 'Panel channel', value: cfg.channel ? `<#${cfg.channel}>` : 'not set', inline: true },
        { name: 'Log channel', value: cfg.logchannel ? `<#${cfg.logchannel}>` : 'not set', inline: true },
        { name: 'Button', value: `${cfg.emoji || ''} ${truncate(cfg.button || 'Verify', 60)}`, inline: true },
        { name: 'Color', value: `#${Number(cfg.color).toString(16).padStart(6, '0').toUpperCase()}`, inline: true },
        { name: 'Banner', value: cfg.banner ? `[link](${cfg.banner})` : 'off', inline: true },
        { name: 'Title', value: truncate(cfg.title || '—', 512), inline: false },
        { name: 'Message', value: truncate(cfg.message || '—', 1024), inline: false },
        { name: 'Commands', value: usage, inline: false }
      ));
  },
});

/* ===================== DM SYSTEM ===================== */

defineCommand({
  name: 'dm',
  category: 'DM System',
  usage: 'dm <@user|id> <message> | dm setup #channel | dm on|off | dm settings',
  description: 'DM any user, or turn on the DM relay inbox.',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || '').toLowerCase();
    const cfg = await getDmConfig(msg.guild.id);

    if (sub === 'setup' || sub === 'channel') {
      const channel = msg.mentions.channels.first();
      if (!channel || !channel.isTextBased()) return reply(msg, errEmbed('Invalid channel', `Usage: \`${p}dm setup #channel\``));
      const updated = await updateDmConfig(msg.guild.id, { channel: channel.id, enabled: 1 });
      return reply(msg, okEmbed('📨 DM inbox set', `Direct messages sent to me are now relayed to ${channel}.\nStaff can answer with \`${p}reply <user id> <message>\`.\n-# Enabled: ${updated.enabled ? 'yes' : 'no'}`));
    }

    if (sub === 'on' || sub === 'off') {
      if (sub === 'on' && !cfg.channel) return reply(msg, errEmbed('No inbox channel', `Set one first: \`${p}dm setup #channel\``));
      await updateDmConfig(msg.guild.id, { enabled: sub === 'on' ? 1 : 0 });
      return reply(msg, okEmbed(`DM relay ${sub}`, sub === 'on' ? 'Incoming DMs are relayed to your inbox channel.' : 'DM relay is off.'));
    }

    if (sub === 'settings' || sub === 'config') {
      return reply(msg, baseEmbed(COLORS.info, '📨 DM system')
        .addFields(
          { name: 'Relay', value: cfg.enabled ? 'Enabled ✅' : 'Disabled ❌', inline: true },
          { name: 'Inbox channel', value: cfg.channel ? `<#${cfg.channel}>` : 'not set', inline: true },
          { name: 'Commands', value: [
            `\`${p}dm @user <message>\` — send a DM`,
            `\`${p}dm setup #channel\` — set the inbox`,
            `\`${p}dm on|off\` — toggle the relay`,
            `\`${p}reply <user id> <message>\` — answer a relayed DM`,
          ].join('\n'), inline: false }
        ));
    }

    // default: send a DM
    const targetId = parseId(args[0]);
    if (!targetId) return reply(msg, errEmbed('Missing target', `Usage: \`${p}dm @user <message>\`\nOr: \`${p}dm setup #channel\` / \`${p}dm on|off\` / \`${p}dm settings\``));
    const content = raw
      .replace(/^\s*<@!?\d+>\s*/i, '')
      .replace(/^\s*\d{15,25}\s*/i, '')
      .trim();
    if (!content) return reply(msg, errEmbed('Missing message', `Usage: \`${p}dm @user <message>\``));
    if (content.length > 1800) return reply(msg, errEmbed('Too long', 'Keep the DM under 1800 characters.'));

    const result = await sendUserDm(msg.client, targetId, {
      title: `📨 Message from ${msg.guild.name}`,
      description: content,
      color: COLORS.info,
      guildName: msg.guild.name,
    });
    if (!result.ok) {
      return reply(msg, errEmbed('DM not delivered', `**Reason:** ${result.reason}\n-# The user may have DMs disabled.`));
    }
    await modLog(msg.guild, settings, baseEmbed(COLORS.info, '📨 DM sent').addFields(
      { name: 'To', value: `<@${targetId}> \`${result.user.tag}\``, inline: true },
      { name: 'Staff', value: `<@${msg.author.id}>`, inline: true },
      { name: 'Message', value: truncate(content, 1024), inline: false }
    ));
    return reply(msg, okEmbed('📨 DM sent', `Delivered to **${result.user.tag}**.`));
  },
});

defineCommand({
  name: 'reply',
  aliases: ['dmreply'],
  category: 'DM System',
  usage: 'reply <user id> <message>',
  description: 'Answer a relayed DM (or DM any user by ID).',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const targetId = parseId(args[0]);
    const content = raw.replace(/^\s*\S+\s*/, '').trim();
    if (!targetId || !content) {
      return reply(msg, errEmbed('Invalid usage', `Usage: \`${p}reply <user id> <message>\``));
    }
    if (content.length > 1800) return reply(msg, errEmbed('Too long', 'Keep the message under 1800 characters.'));

    const result = await sendUserDm(msg.client, targetId, {
      title: `📨 Reply from ${msg.guild.name}`,
      description: content,
      color: COLORS.success,
      guildName: msg.guild.name,
    });
    if (!result.ok) return reply(msg, errEmbed('DM not delivered', `**Reason:** ${result.reason}`));

    const cfg = await getDmConfig(msg.guild.id);
    if (cfg.enabled && cfg.channel) {
      const channel = msg.guild.channels.cache.get(cfg.channel);
      if (channel && channel.isTextBased()) {
        await channel.send({ embeds: [baseEmbed(COLORS.success, '📤 Reply sent')
          .setDescription(truncate(content, 3000))
          .addFields({ name: 'To', value: `<@${targetId}>`, inline: true }, { name: 'Staff', value: `<@${msg.author.id}>`, inline: true })],
          allowedMentions: { parse: [] } }).catch(() => {});
      }
    }
    return reply(msg, okEmbed('📤 Reply sent', `Delivered to **${result.user.tag}**.`));
  },
});

/* ===================== MUSIC ===================== */

/** Shared guard: music available? returns bins or replies and returns null. */
async function musicReady(msg) {
  if (!loadVoiceLib()) {
    await reply(msg, errEmbed('🎵 Music is not installed', `Install the voice library, then restart:\n${MUSIC_INSTALL_HELP}`));
    return null;
  }
  const bins = await detectMusicBinaries();
  if (!bins.ok) {
    await reply(msg, errEmbed('🎵 Player dependencies missing', `${bins.errors.map((e) => `• ${e}`).join('\n')}\n\n${MUSIC_INSTALL_HELP}`));
    return null;
  }
  return bins;
}

defineCommand({
  name: 'play',
  aliases: ['p', 'add'],
  category: 'Music',
  usage: 'play <song name | url | playlist>',
  description: 'Play a song, playlist or search result in your voice channel.',
  async run(msg, args, settings, raw) {
    const query = raw.trim();
    if (!query) return reply(msg, warnEmbed('🎵 Nothing to play', `Usage: \`${settings.prefix}play <song name or URL>\``));
    if (!(await musicReady(msg))) return;

    const voiceChannel = requireVoiceChannel(msg);
    const cfg = await getMusicSettings(msg.guild.id);

    // Playlist / mix URL -> up to 50 tracks
    const isPlaylistUrl = isUrlLike(query) && /(\/playlist|[?&]list=)/i.test(query);
    if (isPlaylistUrl) {
      const tracks = await resolveMusicPlaylist(query, msg.author, 50);
      if (!tracks.length) return reply(msg, errEmbed('Empty playlist', 'That playlist has no readable tracks.'));
      if (!(await musicConnectOrReport(msg, voiceChannel))) return;
      const { added, skipped } = await musicEnqueue(msg.guild, tracks, msg.channel, cfg);
      await musicEnsurePlaying(msg.guild, voiceChannel, msg.channel);
      return reply(
        msg,
        baseEmbed(MUSIC_COLORS.queued, '📋 Playlist queued', `Added **${added}** track(s)${skipped ? ` (**${skipped}** skipped — queue limit \`${cfg.max_queue}\`)` : ''}.\n**Channel:** <#${voiceChannel.id}>`)
      );
    }

    const track = await resolveMusicTrack(query, msg.author);
    if (!(await musicConnectOrReport(msg, voiceChannel))) return;
    const { added, state } = await musicEnqueue(msg.guild, track, msg.channel, cfg);
    if (!added) return reply(msg, errEmbed('Queue full', `The queue limit is **${cfg.max_queue}** tracks. Clear it with \`${settings.prefix}clear\`.`));

    const wasIdle = !state.current;
    await musicEnsurePlaying(msg.guild, voiceChannel, msg.channel);

    if (!wasIdle) {
      return reply(
        msg,
        baseEmbed(MUSIC_COLORS.queued, '➕ Added to queue', `**[${truncate(track.title, 100)}](${track.url})**\n**Position:** ${state.queue.length}  •  **Length:** ${track.isLive ? 'LIVE' : formatTime(track.duration)}  •  **Requested by:** <@${msg.author.id}>`)
          .setThumbnail(track.thumbnail && isHttpUrl(track.thumbnail) ? track.thumbnail : null)
          .setFooter({ text: `${BOT_AUTHOR} • ${state.queue.length} in queue` })
      );
    }
  },
});

defineCommand({
  name: 'search',
  category: 'Music',
  usage: 'search <query>',
  description: 'Search YouTube and pick a track from a dropdown.',
  async run(msg, args, settings, raw) {
    const query = raw.trim();
    if (!query) return reply(msg, warnEmbed('🔎 Nothing to search', `Usage: \`${settings.prefix}search <query>\``));
    if (!(await musicReady(msg))) return;
    requireVoiceChannel(msg);

    const info = await ytdlpInfo(`ytsearch6:${query}`, ['--flat-playlist']);
    const entries = (Array.isArray(info.entries) ? info.entries : []).filter(Boolean).slice(0, 6);
    if (!entries.length) return reply(msg, errEmbed('No results', `Nothing found for **${truncate(query, 100)}**.`));

    const tracks = entries.map((entry) =>
      trackFromInfo(
        { ...entry, webpage_url: entry.url || (entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : `ytsearch1:${entry.title}`) },
        msg.author
      )
    );

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`music:pick:${msg.id}`)
      .setPlaceholder('Choose a track to queue…')
      .setMinValues(1)
      .setMaxValues(1);
    tracks.forEach((track, i) => {
      menu.addOptions({
        label: truncate(track.title, 100),
        value: String(i),
        description: truncate(`${track.uploader} • ${track.isLive ? 'LIVE' : formatTime(track.duration)}`, 100),
      });
    });

    // remember the results so the interaction handler can queue them
    musicSearchCache.set(msg.id, { tracks, guildId: msg.guild.id, channelId: msg.channel.id, userId: msg.author.id, at: Date.now() });

    const embed = baseEmbed(MUSIC_COLORS.queued, '🔎 Search results')
      .setDescription(tracks.map((t, i) => `**${i + 1}.** [${truncate(t.title, 80)}](${t.url})\n-# ${truncate(t.uploader, 50)} • ${t.isLive ? 'LIVE' : formatTime(t.duration)}`).join('\n'))
      .setFooter({ text: `Pick from the menu • ${BOT_AUTHOR}` });

    return msg.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)], allowedMentions: { parse: [] } }).catch(() => null);
  },
});

/** Search results awaiting a menu choice (kept for 10 minutes). */
const musicSearchCache = new Map();
const musicSearchCleanup = setInterval(() => {
  const cutoff = Date.now() - 600000;
  for (const [key, value] of musicSearchCache) if (value.at < cutoff) musicSearchCache.delete(key);
}, 120000);
if (musicSearchCleanup.unref) musicSearchCleanup.unref();

defineCommand({
  name: 'radio',
  category: 'Music',
  usage: 'radio <seed song | url>',
  description: 'Start an endless mix from a seed track (YouTube RD / related).',
  async run(msg, args, settings, raw) {
    const query = raw.trim();
    if (!query) return reply(msg, warnEmbed('📻 Missing seed', `Usage: \`${settings.prefix}radio <song name or URL>\``));
    if (!(await musicReady(msg))) return;
    const voiceChannel = requireVoiceChannel(msg);
    const cfg = await getMusicSettings(msg.guild.id);

    const seed = await resolveMusicTrack(query, msg.author);
    if (!(await musicConnectOrReport(msg, voiceChannel))) return;
    await musicEnqueue(msg.guild, seed, msg.channel, cfg);

    const state = musicState(msg.guild.id);
    state.autoplay = true;
    const related = await resolveMusicRadio(seed, 5);
    if (related.length) await musicEnqueue(msg.guild, related, msg.channel, cfg);
    await musicEnsurePlaying(msg.guild, voiceChannel, msg.channel);

    return reply(
      msg,
      baseEmbed(MUSIC_COLORS.radio, '📻 Radio started', [
        `**Seed:** [${truncate(seed.title, 90)}](${seed.url})`,
        `**Related tracks queued:** ${related.length}`,
        `**Autoplay:** on (keeps adding related tracks)`,
        `-# Turn autoplay off with \`${settings.prefix}autoplay off\``,
      ].join('\n'))
    );
  },
});

defineCommand({
  name: 'autoplay',
  aliases: ['ap'],
  category: 'Music',
  usage: 'autoplay <on|off>',
  description: 'Keep adding related tracks when the queue runs dry.',
  async run(msg, args, settings) {
    const state = musicState(msg.guild.id);
    const value = (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(value)) {
      return reply(msg, infoEmbed('📻 Autoplay', `Currently **${state.autoplay ? 'on' : 'off'}**.\nUsage: \`${settings.prefix}autoplay on|off\``));
    }
    state.autoplay = value === 'on';
    return reply(msg, okEmbed(`📻 Autoplay ${value}`, value === 'on' ? 'Related tracks will be queued automatically.' : 'The queue will end when it runs out.'));
  },
});

defineCommand({
  name: 'pause',
  category: 'Music',
  usage: 'pause',
  description: 'Pause playback.',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicStates.get(msg.guild.id);
    if (!state || !state.current) return reply(msg, errEmbed('Nothing playing', 'There is no track to pause.'));
    if (state.pausedAt) return reply(msg, warnEmbed('Already paused', 'Use `resume` to continue.'));
    state.player?.pause();
    state.pausedAt = Date.now();
    return reply(msg, baseEmbed(MUSIC_COLORS.paused, '⏸️ Paused', `**[${truncate(state.current.title, 90)}](${state.current.url})**`));
  },
});

defineCommand({
  name: 'resume',
  aliases: ['unpause'],
  category: 'Music',
  usage: 'resume',
  description: 'Resume playback.',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicStates.get(msg.guild.id);
    if (!state || !state.current) return reply(msg, errEmbed('Nothing playing', 'There is no track to resume.'));
    if (!state.pausedAt) return reply(msg, warnEmbed('Not paused', 'Playback is already running.'));
    state.player?.unpause();
    state.pausedTotal += Date.now() - state.pausedAt;
    state.pausedAt = 0;
    return reply(msg, baseEmbed(MUSIC_COLORS.playing, '▶️ Resumed', `**[${truncate(state.current.title, 90)}](${state.current.url})**`));
  },
});

defineCommand({
  name: 'skip',
  aliases: ['s', 'next'],
  category: 'Music',
  usage: 'skip [count]',
  description: 'Skip the current track (or several).',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicStates.get(msg.guild.id);
    if (!state || !state.current) return reply(msg, errEmbed('Nothing playing', 'The queue is empty.'));

    const count = Math.max(1, Math.min(parseInt(args[0], 10) || 1, 50));
    const skipped = state.current;
    for (let i = 1; i < count && state.queue.length; i += 1) state.queue.shift();

    // loop=track must not replay a skipped track; musicAdvance moves it to history
    const loopBefore = state.loop;
    state.loop = 'off';
    stopPlayerQuietly(state);
    await musicAdvance(msg.guild, state);
    state.loop = loopBefore;

    return reply(
      msg,
      baseEmbed(MUSIC_COLORS.skip, '⏭️ Skipped', `**[${truncate(skipped.title, 90)}](${skipped.url})**${count > 1 ? `\n-# ${count} track(s) skipped` : ''}${state.current ? `\n**Now:** ${truncate(state.current.title, 80)}` : ''}`)
    );
  },
});

defineCommand({
  name: 'replay',
  aliases: ['previous', 'prev'],
  category: 'Music',
  usage: 'replay',
  description: 'Replay the previous track.',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicStates.get(msg.guild.id);
    if (!state || !state.history.length) return reply(msg, errEmbed('No history', 'Nothing to replay yet.'));
    const track = state.history.pop();
    state.queue.unshift(track);
    stopPlayerQuietly(state);
    state.current = null;
    await musicAdvance(msg.guild, state);
    return reply(msg, baseEmbed(MUSIC_COLORS.playing, '🔂 Replaying', `**[${truncate(track.title, 90)}](${track.url})**`));
  },
});

defineCommand({
  name: 'stop',
  aliases: ['leave', 'dc', 'disconnect'],
  category: 'Music',
  usage: 'stop',
  description: 'Stop playback, clear the queue and leave the voice channel.',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicStates.get(msg.guild.id);
    if (!state || (!state.current && !state.queue.length)) return reply(msg, errEmbed('Nothing playing', 'I am not playing anything.'));
    await musicDestroy(msg.guild.id, 'Stopped by user');
    return reply(msg, baseEmbed(MUSIC_COLORS.stop, '⏹️ Stopped', 'Queue cleared and left the voice channel.'));
  },
});

defineCommand({
  name: 'nowplaying',
  aliases: ['np', 'current'],
  category: 'Music',
  usage: 'nowplaying',
  description: 'Show the current track with live progress and controls.',
  async run(msg, args, settings) {
    const state = musicStates.get(msg.guild.id);
    if (!state || !state.current) return reply(msg, errEmbed('Nothing playing', `Queue something with \`${settings.prefix}play\`.`));
    return msg.reply({ ...buildNowPlayingPayload(state, state.current), allowedMentions: { parse: [] } }).catch(() => null);
  },
});

defineCommand({
  name: 'queue',
  aliases: ['q'],
  category: 'Music',
  usage: 'queue [page]',
  description: 'Show the music queue.',
  async run(msg, args, settings) {
    const state = musicStates.get(msg.guild.id);
    if (!state || (!state.current && !state.queue.length)) return reply(msg, errEmbed('Queue empty', 'Nothing is queued right now.'));
    const page = parseInt(args[0], 10) || 1;
    return reply(msg, buildQueueEmbed(state, page));
  },
});

defineCommand({
  name: 'volume',
  aliases: ['vol'],
  category: 'Music',
  usage: 'volume [0-200]',
  description: 'Show or set the volume.',
  async run(msg, args, settings) {
    const state = musicState(msg.guild.id);
    if (args[0] === undefined) {
      return reply(msg, infoEmbed('🔊 Volume', `Current volume: **${state.volume === null ? (await getMusicSettings(msg.guild.id)).default_volume : state.volume}%**\nUsage: \`${settings.prefix}volume <0-200>\``));
    }
    if (!(await assertMusicControl(msg))) return;
    const value = parseInt(args[0], 10);
    if (!Number.isInteger(value) || value < 0 || value > 200) {
      return reply(msg, errEmbed('Invalid volume', `Usage: \`${settings.prefix}volume <0-200>\``));
    }
    state.volume = value;
    // volume lives in the ffmpeg filter chain -> restart the current track at the same position
    if (state.current && state.player) {
      const elapsed = musicElapsed(state);
      killMusicProcs(state);
      stopPlayerQuietly(state);
      const track = state.current;
      const resource = await createMusicStream(state, track, elapsed).catch((err) => {
        logError('volumeRestart', err);
        return null;
      });
      if (resource) {
        state.resource = resource;
        state.startedAt = Date.now() - elapsed * 1000;
        state.pausedTotal = 0;
        state.pausedAt = 0;
        state.player.play(resource);
      }
    }
    return reply(msg, baseEmbed(MUSIC_COLORS.playing, '🔊 Volume', `Set to **${value}%**`));
  },
});

defineCommand({
  name: 'loop',
  category: 'Music',
  usage: 'loop <off|track|queue>',
  description: 'Set the loop mode.',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicState(msg.guild.id);
    const mode = (args[0] || '').toLowerCase();
    if (!['off', 'track', 'queue'].includes(mode)) {
      return reply(msg, infoEmbed('🔁 Loop', `Current mode: **${state.loop}**\nUsage: \`${settings.prefix}loop off|track|queue\``));
    }
    state.loop = mode;
    const desc = { off: 'Looping disabled.', track: 'The current track repeats.', queue: 'The whole queue repeats.' }[mode];
    return reply(msg, baseEmbed(MUSIC_COLORS.playing, `🔁 Loop ${mode}`, desc));
  },
});

defineCommand({
  name: 'shuffle',
  category: 'Music',
  usage: 'shuffle',
  description: 'Shuffle the queue.',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicStates.get(msg.guild.id);
    if (!state || state.queue.length < 2) return reply(msg, errEmbed('Nothing to shuffle', 'The queue needs at least 2 tracks.'));
    for (let i = state.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
    return reply(msg, baseEmbed(MUSIC_COLORS.playing, '🔀 Shuffled', `Randomised **${state.queue.length}** track(s).`));
  },
});

defineCommand({
  name: 'remove',
  category: 'Music',
  usage: 'remove <position>',
  description: 'Remove one track from the queue by position.',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicStates.get(msg.guild.id);
    const pos = parseInt(args[0], 10);
    if (!state || !state.queue.length) return reply(msg, errEmbed('Queue empty', 'Nothing to remove.'));
    if (!Number.isInteger(pos) || pos < 1 || pos > state.queue.length) {
      return reply(msg, errEmbed('Invalid position', `Usage: \`${settings.prefix}remove <1-${state.queue.length}>\``));
    }
    const [removed] = state.queue.splice(pos - 1, 1);
    return reply(msg, baseEmbed(MUSIC_COLORS.skip, '🗑️ Removed', `**[${truncate(removed.title, 90)}](${removed.url})**\n-# ${state.queue.length} track(s) left`));
  },
});

defineCommand({
  name: 'clear',
  aliases: ['clearqueue'],
  category: 'Music',
  usage: 'clear',
  description: 'Clear the queue (keeps the current track playing).',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicStates.get(msg.guild.id);
    if (!state || !state.queue.length) return reply(msg, errEmbed('Queue empty', 'Nothing to clear.'));
    const count = state.queue.length;
    state.queue = [];
    return reply(msg, baseEmbed(MUSIC_COLORS.stop, '🧹 Queue cleared', `Removed **${count}** track(s). The current track keeps playing.`));
  },
});

defineCommand({
  name: 'jump',
  category: 'Music',
  usage: 'jump <position>',
  description: 'Jump straight to a queue position.',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicStates.get(msg.guild.id);
    const pos = parseInt(args[0], 10);
    if (!state || !state.queue.length) return reply(msg, errEmbed('Queue empty', 'Nothing to jump to.'));
    if (!Number.isInteger(pos) || pos < 1 || pos > state.queue.length) {
      return reply(msg, errEmbed('Invalid position', `Usage: \`${settings.prefix}jump <1-${state.queue.length}>\``));
    }
    const skipped = state.queue.splice(0, pos - 1);
    if (skipped.length && state.current) state.history.push(state.current);
    stopPlayerQuietly(state);
    state.current = null;
    await musicAdvance(msg.guild, state);
    return reply(msg, baseEmbed(MUSIC_COLORS.skip, '⤵️ Jumped', `${skipped.length ? `Skipped **${skipped.length}** track(s).\n` : ''}**Now:** ${truncate(state.current ? state.current.title : '—', 90)}`));
  },
});

defineCommand({
  name: 'seek',
  category: 'Music',
  usage: 'seek <seconds|mm:ss>',
  description: 'Seek inside the current track.',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicStates.get(msg.guild.id);
    if (!state || !state.current) return reply(msg, errEmbed('Nothing playing', 'There is no track to seek in.'));

    let seconds;
    if (/^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(args[0] || '')) {
      seconds = String(args[0]).split(':').reverse().reduce((acc, part, i) => acc + Number(part) * 60 ** i, 0);
    } else {
      seconds = parseInt(args[0], 10);
    }
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) {
      return reply(msg, errEmbed('Invalid position', `Usage: \`${settings.prefix}seek 90\` or \`${settings.prefix}seek 1:30\``));
    }
    if (!state.current.isLive && state.current.duration && seconds > state.current.duration) {
      return reply(msg, errEmbed('Out of range', `This track is only **${formatTime(state.current.duration)}** long.`));
    }

    killMusicProcs(state);
    stopPlayerQuietly(state);
    const track = state.current;
    const resource = await createMusicStream(state, track, seconds);
    state.resource = resource;
    state.startedAt = Date.now() - seconds * 1000;
    state.pausedAt = 0;
    state.pausedTotal = 0;
    state.player.play(resource);
    return reply(msg, baseEmbed(MUSIC_COLORS.playing, '⏩ Seeked', `Jumped to **${formatTime(seconds)}** in **[${truncate(track.title, 80)}](${track.url})**`));
  },
});

defineCommand({
  name: 'filter',
  aliases: ['filters', 'effect'],
  category: 'Music',
  usage: 'filter <off|bassboost|nightcore|vaporwave|8d|lofi|treble>',
  description: 'Apply an audio filter preset.',
  async run(msg, args, settings) {
    if (!(await assertMusicControl(msg))) return;
    const state = musicState(msg.guild.id);
    const key = (args[0] || '').toLowerCase();
    if (!key) {
      return reply(msg, baseEmbed(MUSIC_COLORS.filter, '🎛️ Filters', [...MUSIC_FILTERS.entries()].map(([k, v]) => `**\`${k}\`** — ${v.label}\n-# ${v.desc}`).join('\n')).setFooter({ text: `${settings.prefix}filter <name>` }));
    }
    if (!MUSIC_FILTERS.has(key)) {
      return reply(msg, errEmbed('Unknown filter', `Available: ${[...MUSIC_FILTERS.keys()].map((k) => `\`${k}\``).join(', ')}`));
    }
    state.filter = key;
    const preset = MUSIC_FILTERS.get(key);

    // re-apply live so it is heard immediately
    if (state.current && state.player) {
      const elapsed = musicElapsed(state);
      killMusicProcs(state);
      stopPlayerQuietly(state);
      const track = state.current;
      const resource = await createMusicStream(state, track, elapsed).catch(() => null);
      if (resource) {
        state.resource = resource;
        state.startedAt = Date.now() - elapsed * 1000;
        state.pausedTotal = 0;
        state.pausedAt = 0;
        state.player.play(resource);
      }
    }
    return reply(msg, baseEmbed(MUSIC_COLORS.filter, '🎛️ Filter applied', `**${preset.label}**\n*${preset.desc}*`));
  },
});

defineCommand({
  name: 'favorite',
  aliases: ['fav', 'favourites'],
  category: 'Music',
  usage: 'favorite <add [name]|remove <name>|play <name>|list>',
  description: 'Save and replay your favourite tracks.',
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const sub = (args[0] || 'list').toLowerCase();
    const rest = raw.replace(/^\s*\S+\s*/, '').trim();

    if (sub === 'list') {
      const rows = await listFavorites(msg.guild.id, msg.author.id);
      if (!rows.length) return reply(msg, infoEmbed('⭐ Favorites', `No favorites yet.\nSave the current track with \`${p}favorite add chill\`.`));
      return reply(msg, infoEmbed(`⭐ Your favorites (${rows.length})`, truncate(rows.map((r) => `**\`${r.name}\`** — [${truncate(r.title, 60)}](${r.url})`).join('\n'), 4000)));
    }

    if (sub === 'add') {
      const state = musicStates.get(msg.guild.id);
      if (!state || !state.current) return reply(msg, errEmbed('Nothing playing', 'Play something first, then save it.'));
      const name = (rest || state.current.title).slice(0, 32).toLowerCase().replace(/[^\w\s-]/g, '').trim() || 'favorite';
      await addFavorite(msg.guild.id, msg.author.id, state.current, name);
      return reply(msg, okEmbed('⭐ Saved', `**[${truncate(state.current.title, 90)}](${state.current.url})**\nSaved as \`${name}\`.`));
    }

    if (sub === 'remove' || sub === 'delete') {
      if (!rest) return reply(msg, errEmbed('Missing name', `Usage: \`${p}favorite remove <name>\``));
      const done = await removeFavorite(msg.guild.id, msg.author.id, rest);
      return reply(msg, done ? okEmbed('⭐ Removed', `\`${rest}\` was removed.`) : errEmbed('Not found', 'No favorite with that name.'));
    }

    if (sub === 'play') {
      if (!rest) return reply(msg, errEmbed('Missing name', `Usage: \`${p}favorite play <name>\``));
      if (!(await musicReady(msg))) return;
      const voiceChannel = requireVoiceChannel(msg);
      const rows = await listFavorites(msg.guild.id, msg.author.id);
      const found = rows.find((r) => r.name === rest.toLowerCase());
      if (!found) return reply(msg, errEmbed('Not found', `You have no favorite called \`${rest}\`. See \`${p}favorite list\`.`));
      const track = { title: found.title, url: found.url, duration: found.duration, uploader: 'favorite', thumbnail: null, isLive: false, requesterId: msg.author.id, requesterName: msg.author.username };
      if (!(await musicConnectOrReport(msg, voiceChannel))) return;
      const cfg = await getMusicSettings(msg.guild.id);
      await musicEnqueue(msg.guild, track, msg.channel, cfg);
      await musicEnsurePlaying(msg.guild, voiceChannel, msg.channel);
      return reply(msg, baseEmbed(MUSIC_COLORS.queued, '⭐ Favorite queued', `**[${truncate(track.title, 90)}](${track.url})**`));
    }

    return reply(msg, errEmbed('Invalid usage', `\`${p}favorite add [name]\` · \`remove <name>\` · \`play <name>\` · \`list\``));
  },
});

defineCommand({
  name: 'history',
  aliases: ['played'],
  category: 'Music',
  usage: 'history',
  description: 'Show recently played tracks.',
  async run(msg, args, settings) {
    const state = musicStates.get(msg.guild.id);
    if (!state || !state.history.length) return reply(msg, errEmbed('No history', 'Nothing has been played yet.'));
    const rows = state.history.slice(-10).reverse();
    return reply(msg, infoEmbed(`🕘 History (${state.history.length})`, truncate(rows.map((t, i) => `**${i + 1}.** [${truncate(t.title, 70)}](${t.url})`).join('\n'), 4000)));
  },
});

defineCommand({
  name: 'join',
  aliases: ['summon'],
  category: 'Music',
  usage: 'join',
  description: 'Make the bot join your voice channel.',
  async run(msg, args, settings) {
    if (!(await musicReady(msg))) return;
    const voiceChannel = requireVoiceChannel(msg);
    if (!(await musicConnectOrReport(msg, voiceChannel))) return;
    musicState(msg.guild.id).volume = musicState(msg.guild.id).volume ?? (await getMusicSettings(msg.guild.id)).default_volume;
    return reply(msg, okEmbed('🔊 Joined', `Connected to **${voiceChannel.name}**.`));
  },
});

defineCommand({
  name: 'music',
  aliases: ['musicconfig'],
  category: 'Music',
  usage: 'music <settings|doctor|stats|dj|maxqueue|volume|announce|stay>',
  description: 'Music settings, dependency doctor and statistics.',
  async run(msg, args, settings) {
    const p = settings.prefix;
    const sub = (args[0] || 'settings').toLowerCase();
    const cfg = await getMusicSettings(msg.guild.id);
    const state = musicStates.get(msg.guild.id);
    const isManager = hasPerm(msg, PermissionFlagsBits.ManageGuild);

    if (sub === 'doctor' || sub === 'check') {
      const bins = await detectMusicBinaries(true);
      const voice = loadVoiceLib();
      const encoder = (() => {
        try {
          require('libsodium-wrappers');
          return 'libsodium-wrappers ✅';
        } catch (_) {
          try {
            require('tweetnacl');
            return 'tweetnacl ✅';
          } catch (_) {
            return 'not found ⚠️';
          }
        }
      })();
      const voiceVersion = voiceLibVersion();
      const daveOk = voiceSupportsDave();
      const dnsOrder = (() => {
        try {
          const dns = require('dns');
          return typeof dns.getDefaultResultOrder === 'function' ? dns.getDefaultResultOrder() : 'default';
        } catch (_) {
          return 'unknown';
        }
      })();
      const conn = (() => {
        try {
          const v = loadVoiceLib();
          const c = v && v.getVoiceConnection(msg.guild.id);
          return c && c.state && c.state.status ? c.state.status : 'not connected';
        } catch (_) {
          return 'unknown';
        }
      })();
      const voiceProblems = [];
      if (voice && !daveOk) voiceProblems.push(`**@discordjs/voice ${voiceVersion}** is too old — Discord requires **DAVE** encryption since 2026-03. Run \`npm i @discordjs/voice@latest\` with **Node 22.12+**.`);
      if (!daveEnabled()) voiceProblems.push('DAVE encryption is disabled (`DAVE_ENCRYPTION=off`).');
      if (dnsOrder !== 'ipv4first' && dnsOrder !== 'ipv6first') voiceProblems.push(`DNS result order is \`${dnsOrder}\` — set \`VOICE_IPV4=on\` if voice keeps timing out (UDP).`);
      return reply(
        msg,
        baseEmbed(bins.ok && voice && daveOk ? COLORS.success : COLORS.error, '🩺 Music doctor')
          .addFields(
            {
              name: '@discordjs/voice',
              value: voice ? `${voiceVersion || 'installed'} ${daveOk ? '✅' : '⚠️ no DAVE'}` : 'missing ❌ (`npm i @discordjs/voice`)',
              inline: true,
            },
            { name: 'Encryption', value: `${encoder}${daveEnabled() ? ' · DAVE on' : ' · DAVE off'}`, inline: true },
            { name: 'Stream mode', value: `\`${musicStreamMode()}\` (\`MUSIC_STREAM\`)`, inline: true },
            { name: 'Node / DNS', value: `v${process.versions.node} · \`${dnsOrder}\``, inline: true },
            { name: 'Voice link', value: `\`${conn}\``, inline: true },
            { name: 'yt-dlp', value: bins.ytdlp ? `✅ \`${bins.ytdlp.cmd}\` v${truncate(bins.ytdlp.version, 40)}` : '❌ not found', inline: true },
            { name: 'ffmpeg', value: bins.ffmpeg ? `✅ \`${truncate(bins.ffmpeg, 60)}\` v${bins.ffmpegVersion}` : '❌ not found', inline: true },
            { name: 'Queue', value: `${state ? state.queue.length : 0} track(s)`, inline: true },
            ...(bins.errors.length ? [{ name: 'Problems', value: truncate(bins.errors.map((e) => `• ${e}`).join('\n'), 1024), inline: false }] : []),
            ...(voiceProblems.length ? [{ name: '⚠️ Voice / UDP', value: truncate(voiceProblems.map((e) => `• ${e}`).join('\n'), 1024), inline: false }] : []),
            { name: 'Install (if something is missing)', value: MUSIC_INSTALL_HELP, inline: false }
          )
          .setFooter({ text: 'Voice troubleshooting: VOICE_IPV4=on (default) · DAVE_ENCRYPTION=on · MUSIC_JOIN_ATTEMPTS=3' })
      );
    }

    if (sub === 'stats') {
      const bins = await detectMusicBinaries();
      return reply(
        msg,
        baseEmbed(MUSIC_COLORS.playing, '📊 Music stats')
          .addFields(
            { name: 'Now playing', value: state && state.current ? truncate(state.current.title, 200) : 'nothing', inline: false },
            { name: 'Queue', value: `${state ? state.queue.length : 0} track(s)`, inline: true },
            { name: 'History', value: `${state ? state.history.length : 0}`, inline: true },
            { name: 'Loop / Filter', value: `${state ? state.loop : 'off'} / ${state ? state.filter : 'off'}`, inline: true },
            { name: 'Volume', value: `${state && state.volume !== null ? state.volume : cfg.default_volume}%`, inline: true },
            { name: 'Autoplay', value: state && state.autoplay ? 'on' : 'off', inline: true },
            { name: 'Voice', value: msg.guild.members.me.voice && msg.guild.members.me.voice.channel ? `<#${msg.guild.members.me.voice.channel.id}>` : 'not connected', inline: true },
            { name: 'yt-dlp', value: bins.ytdlp ? `v${truncate(bins.ytdlp.version, 30)}` : 'missing', inline: true },
            { name: 'ffmpeg', value: bins.ffmpeg ? `v${bins.ffmpegVersion}` : 'missing', inline: true }
          )
      );
    }

    if (sub === 'dj') {
      if (!isManager) return reply(msg, errEmbed('Not allowed', 'You need **Manage Server** to change the DJ role.'));
      if ((args[1] || '').toLowerCase() === 'off' || (args[1] || '').toLowerCase() === 'none') {
        await updateMusicSettings(msg.guild.id, { dj_role: null });
        return reply(msg, okEmbed('🎧 DJ role removed', 'Everyone in the voice channel can control the music again.'));
      }
      const role = msg.mentions.roles.first() || resolveRole(msg.guild, args[1] || '');
      if (!role) return reply(msg, errEmbed('Role not found', `Usage: \`${p}music dj @role\` or \`${p}music dj off\``));
      await updateMusicSettings(msg.guild.id, { dj_role: role.id });
      return reply(msg, okEmbed('🎧 DJ role set', `**${role.name}** can always control the music.`));
    }

    if (sub === 'maxqueue') {
      if (!isManager) return reply(msg, errEmbed('Not allowed', 'You need **Manage Server**.'));
      const n = parseInt(args[1], 10);
      if (!Number.isInteger(n) || n < 10 || n > 1000) return reply(msg, errEmbed('Invalid number', `Usage: \`${p}music maxqueue <10-1000>\``));
      await updateMusicSettings(msg.guild.id, { max_queue: n });
      return reply(msg, okEmbed('📜 Queue limit updated', `Up to **${n}** tracks can be queued.`));
    }

    if (sub === 'volume') {
      if (!isManager) return reply(msg, errEmbed('Not allowed', 'You need **Manage Server**.'));
      const n = parseInt(args[1], 10);
      if (!Number.isInteger(n) || n < 0 || n > 200) return reply(msg, errEmbed('Invalid volume', `Usage: \`${p}music volume <0-200>\``));
      await updateMusicSettings(msg.guild.id, { default_volume: n });
      return reply(msg, okEmbed('🔊 Default volume updated', `New tracks start at **${n}%**.`));
    }

    if (sub === 'announce' || sub === 'stay') {
      if (!isManager) return reply(msg, errEmbed('Not allowed', 'You need **Manage Server**.'));
      const value = (args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) return reply(msg, errEmbed('Invalid value', `Usage: \`${p}music ${sub} on|off\``));
      await updateMusicSettings(msg.guild.id, { [sub]: value === 'on' ? 1 : 0 });
      return reply(msg, okEmbed(`Updated`, sub === 'announce'
        ? `Now-playing messages are **${value}**.`
        : `Staying in voice after the queue ends is **${value}**.`));
    }

    return reply(
      msg,
      baseEmbed(MUSIC_COLORS.playing, '🎵 Music settings')
        .addFields(
          { name: 'DJ role', value: cfg.dj_role ? `<@&${cfg.dj_role}>` : 'not set', inline: true },
          { name: 'Max queue', value: `${cfg.max_queue}`, inline: true },
          { name: 'Default volume', value: `${cfg.default_volume}%`, inline: true },
          { name: 'Announce tracks', value: cfg.announce ? 'on' : 'off', inline: true },
          { name: 'Stay in voice', value: cfg.stay ? 'on' : 'off', inline: true },
          { name: 'Stream mode', value: `\`${musicStreamMode()}\``, inline: true },
          {
            name: 'Commands',
            value: [
              `\`${p}play <query|url>\` · \`${p}search <query>\` · \`${p}radio <seed>\` · \`${p}autoplay on|off\``,
              `\`${p}pause\` · \`${p}resume\` · \`${p}skip [n]\` · \`${p}replay\` · \`${p}stop\``,
              `\`${p}nowplaying\` · \`${p}queue [page]\` · \`${p}history\` · \`${p}seek <sec|mm:ss>\``,
              `\`${p}volume <0-200>\` · \`${p}loop off|track|queue\` · \`${p}filter <preset>\``,
              `\`${p}shuffle\` · \`${p}remove <pos>\` · \`${p}clear\` · \`${p}jump <pos>\``,
              `\`${p}favorite add|play|remove|list\` · \`${p}join\` · \`${p}music doctor|stats\``,
            ].join('\n'),
            inline: false,
          }
        )
        .setFooter({ text: `Music from yt-dlp + ffmpeg • ${BOT_AUTHOR}` })
    );
  },
});

/* ===================== ANNOUNCEMENTS (PLAIN TEXT) ===================== */

defineCommand({
  name: 'announce',
  aliases: ['ann'],
  category: 'Announcements',
  usage: 'announce [#channel] <message> [--title=..] [--emoji=..] [--ping=everyone|here|@role] [--footer=..] [--sign] [--pin] [--publish]',
  description: 'Send a plain-text announcement (no embed).',
  permission: PermissionFlagsBits.ManageGuild,
  async run(msg, args, settings, raw) {
    const p = settings.prefix;
    const { flags, text } = extractFlags(raw, ['title', 'emoji', 'ping', 'footer'], ['sign', 'pin', 'publish']);

    // Optional leading channel
    let target = msg.channel;
    let body = text;
    const leading = text.match(/^(?:<#(\d{15,25})>|(\d{15,25}))\s*/);
    if (leading) {
      const id = leading[1] || leading[2];
      const channel = msg.guild.channels.cache.get(id) || (await msg.guild.channels.fetch(id).catch(() => null));
      if (channel && channel.isTextBased()) {
        target = channel;
        body = text.slice(leading[0].length).trim();
      }
    }
    if (!body) {
      return reply(msg, errEmbed('Missing message', `Usage: \`${p}announce [#channel] <message> [--title="..."] [--ping=everyone]\``));
    }

    // Ping target validation
    let pingContent = '';
    let allowedMentions = { parse: [] };
    if (flags.ping) {
      const pingRaw = String(flags.ping).toLowerCase();
      if (['everyone', 'here'].includes(pingRaw)) {
        if (!hasPerm(msg, PermissionFlagsBits.MentionEveryone)) {
          return reply(msg, errEmbed('Missing permission', `You need **Mention @everyone** to use \`--ping=${pingRaw}\`.`));
        }
        pingContent = `@${pingRaw}`;
        allowedMentions = { parse: ['everyone'] };
      } else {
        const role = msg.mentions.roles.first() || resolveRole(msg.guild, flags.ping);
        if (!role) return reply(msg, errEmbed('Role not found', `\`--ping=${flags.ping}\` is not a role I can find.`));
        const me = msg.guild.members.me;
        if (!role.mentionable && !me.permissions.has(PermissionFlagsBits.MentionEveryone)) {
          return reply(msg, errEmbed('Cannot ping role', `**${role.name}** is not mentionable and I lack **Mention @everyone**.`));
        }
        pingContent = `<@&${role.id}>`;
        allowedMentions = { roles: [role.id] };
      }
    }

    // Compose plain text
    const lines = [];
    if (flags.title) {
      let heading = '# ';
      if (flags.emoji) heading += `${flags.emoji} `;
      heading += flags.title;
      lines.push(heading);
    } else if (flags.emoji) {
      lines.push(flags.emoji);
    }
    lines.push(body);
    if (flags.footer) lines.push(`-# ${flags.footer}`);
    if (flags.sign) lines.push(`-# — ${msg.author.tag}`);
    if (pingContent) lines.unshift(pingContent);

    let content = lines.join('\n');
    if (content.length > 2000) {
      return reply(msg, errEmbed('Message too long', `The announcement is **${content.length}** characters — Discord allows **2000**.`));
    }

    // Re-upload attachments
    const files = [];
    if (msg.attachments.size) {
      const collected = [...msg.attachments.values()].slice(0, 10);
      for (const att of collected) {
        const buffer = await fetch(att.url)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((ab) => (ab ? Buffer.from(ab) : null))
          .catch(() => null);
        if (buffer) files.push(new AttachmentBuilder(buffer, { name: att.name || 'attachment' }));
      }
    }

    const sent = await target
      .send({ content, files, allowedMentions })
      .catch((err) => {
        logError('announce', err);
        return null;
      });
    if (!sent) return reply(msg, errEmbed('Failed', `I could not send the announcement in ${target}. Check my permissions.`));

    const results = [];
    if (flags.pin) {
      const pinned = await sent.pin().then(() => true).catch(() => false);
      results.push(pinned ? 'pinned' : 'could not pin');
    }
    if (flags.publish) {
      if (target.type !== ChannelType.GuildAnnouncement) {
        results.push('publish skipped (not an announcement channel)');
      } else {
        const published = await sent.crosspost().then(() => true).catch(() => false);
        results.push(published ? 'published' : 'could not publish');
      }
    }

    const jump = sent.url ? `\n-# [jump to message](${sent.url})` : '';
    return reply(
      msg,
      okEmbed('📢 Announcement sent', `Posted in <#${target.id}>${results.length ? `\n-# ${results.join(' · ')}` : ''}${jump}`)
    );
  },
});

/* ------------------------------------------------------------------------------------------
 * 16. CLIENT
 * ---------------------------------------------------------------------------------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildWebhooks,
    GatewayIntentBits.DirectMessages, // DM system (relay + !dm)
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.Message, Partials.User],
});

client.on('error', (err) => logError('client', err));
client.on('warn', (msg) => console.warn('[WARN]', msg));

/* ------------------------------------------------------------------------------------------
 * 17. MESSAGE HANDLER (prefix commands + automation)
 * ---------------------------------------------------------------------------------------- */

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || message.system) return;

    // Direct messages -> optional relay inbox (DM system)
    if (!message.guild) {
      await relayDirectMessage(client, message);
      return;
    }
    if (!message.member) return;

    const settings = await getSettings(message.guild.id);
    const prefix = settings.prefix;

    // main owner + granted users -> bypass every permission check below
    await markPrivileged(message);

    /* ---------- 17a. Prefix command path ---------- */
    if (message.content.toLowerCase().startsWith(prefix.toLowerCase())) {
      const withoutPrefix = message.content.slice(prefix.length);
      const nameMatch = withoutPrefix.match(/^(\S+)/);
      if (!nameMatch) return;
      const invoked = nameMatch[1].toLowerCase();
      const raw = withoutPrefix.slice(nameMatch[1].length).replace(/^\s+/, '');
      const args = tokenize(raw);

      const builtin = commands.get(invoked);
      if (builtin) {
        await withStatusBar(message, settings, builtin.name, async () => {
          // main-owner / granted-access gate for admin commands
          if (ADMIN_COMMANDS.has(builtin.name)) {
            const allowed = await assertAdminAccess(message, settings, { mainOwnerOnly: builtin.mainOwnerOnly });
            if (!allowed) return;
          }
          // permission gate
          if (builtin.permission && !hasPerm(message, builtin.permission)) {
            await reply(
              message,
              errEmbed('Missing permissions', `You need the **${Object.keys(PermissionFlagsBits).find((k) => PermissionFlagsBits[k] === builtin.permission)}** permission to use \`${prefix}${builtin.name}\`.`)
            );
            return;
          }
          await builtin.run(message, args, settings, raw);
        }).catch(async (err) => {
          logError(`command:${builtin.name}`, err);
          await reply(message, errEmbed('Command failed', `Something went wrong: \`${truncate(err.message || err, 300)}\``));
        });
        return;
      }

      // Custom command
      const custom = await dbGet('SELECT * FROM custom_commands WHERE guild_id = ? AND name = ?', [message.guild.id, invoked]);
      if (custom) {
        await withStatusBar(message, settings, invoked, async () => {
          const output = applyTemplate(custom.response, {
            user: message.author,
            guild: message.guild,
            channel: message.channel,
          });
          const embed = baseEmbed(COLORS.main).setDescription(truncate(output, 4000));
          await message
            .reply({ embeds: [embed], allowedMentions: { parse: [] } })
            .catch(() => {});
        }).catch((err) => logError(`custom:${invoked}`, err));
      }
      return;
    }

    /* ---------- 17b. Automation path (non-command messages) ---------- */

    // AFK (handles both "welcome back" and "user is AFK" notices)
    await handleAfk(message);

    // Blocked words
    const blocked = await blockwordCheck(message, settings);
    if (blocked) return;

    // Anti-spam
    const spammed = await antiSpamCheck(message, settings);
    if (spammed) return;

    // Auto replies (first match only, to avoid reply storms)
    const replies = await dbAll('SELECT * FROM autoreplies WHERE guild_id = ?', [message.guild.id]);
    if (replies.length) {
      const content = message.content.toLowerCase();
      const hit = replies.find((r) => content.includes(r.trigger));
      if (hit) {
        const output = applyTemplate(hit.response, {
          user: message.author,
          guild: message.guild,
          channel: message.channel,
        });
        await message
          .reply({
            embeds: [baseEmbed(COLORS.info).setDescription(truncate(output, 4000))],
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
      }
    }
  } catch (err) {
    logError('messageCreate', err);
  }
});

/* ------------------------------------------------------------------------------------------
 * 18. INTERACTION HANDLER (tickets + giveaways)
 * ---------------------------------------------------------------------------------------- */

/** Safe ephemeral reply for interactions. */
async function iReply(interaction, embed, flags = EPHEMERAL, extra = {}) {
  const payload = Array.isArray(embed) ? { embeds: embed } : embed ? { embeds: [embed] } : {};
  const body = { ...payload, flags, ...extra };
  try {
    if (interaction.deferred || interaction.replied) return await interaction.followUp(body);
    return await interaction.reply(body);
  } catch (err) {
    logError('iReply', err);
    return null;
  }
}

/** Rebuilds the ticket control row (claim can be disabled after claiming). */
function ticketButtons(claimedBy = null) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
    new ButtonBuilder()
      .setCustomId('ticket:claim')
      .setLabel(claimedBy ? 'Claimed' : 'Claim')
      .setStyle(claimedBy ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setEmoji('🙋')
      .setDisabled(!!claimedBy),
    new ButtonBuilder().setCustomId('ticket:transcript').setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('📄')
  );
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // main owner + granted users -> bypass every permission check in the button/menu handlers
    if (interaction.guild) await markPrivileged(interaction).catch(() => {});
    /* ---------------- TICKET: select menu ---------------- */
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket:select') {
      const guild = interaction.guild;
      if (!guild) return;
      const key = interaction.values[0];
      const cfg = await getTicketConfig(guild.id);

      // If the user already has a ticket open, point them there instead of opening a new one.
      const existing = await dbGet(
        "SELECT * FROM tickets WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1",
        [guild.id, interaction.user.id]
      );
      if (existing) {
        const ch = guild.channels.cache.get(existing.channel_id);
        return iReply(interaction, infoEmbed('🎫 You already have a ticket', ch ? `Your open ticket: <#${ch.id}>` : 'Your ticket channel no longer exists.'));
      }

      await interaction.deferReply({ flags: EPHEMERAL }).catch(() => {});
      try {
        const { channel, type } = await openTicket(guild, interaction.user, key);
        return iReply(interaction, okEmbed('🎫 Ticket created', `${type.emoji || ''} **${type.label}** ticket opened: <#${channel.id}>`));
      } catch (err) {
        return iReply(interaction, errEmbed('Could not open a ticket', truncate(err.message || 'Unknown error', 500)));
      }
    }

    /* ---------------- HELP: category dropdown ---------------- */
    if (interaction.isStringSelectMenu() && interaction.customId === 'help:cat') {
      const value = interaction.values[0];
      const payload =
        value === 'overview'
          ? buildHelpOverview(interaction, interaction.settings || (await getSettings(interaction.guild.id)))
          : buildHelpCategory(interaction, interaction.settings || (await getSettings(interaction.guild.id)), value);
      try {
        await interaction.update(payload);
      } catch (err) {
        logError('helpSelect', err);
        await iReply(interaction, errEmbed('Error', 'Could not switch category.'));
      }
      return;
    }

    /* ---------------- MUSIC: search dropdown (queues the picked track) ---------------- */
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('music:pick:')) {
      const cached = musicSearchCache.get(interaction.customId.slice('music:pick:'.length));
      if (!cached) return iReply(interaction, errEmbed('Search expired', 'Run the search command again.'));
      if (cached.userId !== interaction.user.id) return iReply(interaction, warnEmbed('Not your search', 'Run your own `search` command.'));
      const picked = cached.tracks[Number(interaction.values[0])];
      if (!picked) return iReply(interaction, errEmbed('Not found', 'That result is no longer available.'));

      await interaction.deferReply({ flags: EPHEMERAL }).catch(() => {});
      try {
        const voiceChannel = interaction.member && interaction.member.voice ? interaction.member.voice.channel : null;
        if (!voiceChannel) return iReply(interaction, errEmbed('No voice channel', 'Join a voice channel first.'));
        await musicConnect(interaction.guild, voiceChannel, interaction.channel);
        const cfg = await getMusicSettings(interaction.guild.id);
        const wasIdle = !musicState(interaction.guild.id).current;
        await musicEnqueue(interaction.guild, picked, interaction.channel, cfg);
        await musicEnsurePlaying(interaction.guild, voiceChannel, interaction.channel);
        return iReply(interaction, okEmbed(wasIdle ? '🎶 Playing' : '➕ Added to queue', `**[${truncate(picked.title, 100)}](${picked.url})**`));
      } catch (err) {
        logError('musicPick', err);
        return iReply(interaction, errEmbed('🎵 Could not play', truncate(err.message || 'Unknown error', 1500)));
      }
    }

    /* ---------------- BUTTONS ---------------- */
    if (!interaction.isButton()) return;
    const [scope, action, ...rest] = interaction.customId.split(':');

    /* ===== Music controls (now-playing buttons) ===== */
    if (scope === 'music') {
      const guild = interaction.guild;
      const state = musicStates.get(guild.id);
      const member = interaction.member;
      const settings = await getMusicSettings(guild.id);
      const isDj =
        hasPerm(interaction, PermissionFlagsBits.ManageGuild) ||
        (settings.dj_role && member && member.roles.cache.has(settings.dj_role));

      if (!state || !state.current) return iReply(interaction, errEmbed('Nothing playing', 'There is nothing to control.'));
      const sameChannel = member && member.voice && guild.members.me.voice && member.voice.channelId === guild.members.me.voice.channelId;
      if (!isDj && !sameChannel) return iReply(interaction, errEmbed('🎧 Join the voice channel', 'You must be in my voice channel to use the controls.'));

      if (action === 'pause') {
        if (!state.pausedAt) {
          state.player?.pause();
          state.pausedAt = Date.now();
        }
        await interaction.message.edit(buildNowPlayingPayload(state, state.current)).catch(() => {});
        return iReply(interaction, infoEmbed('⏸️ Paused', truncate(state.current.title, 90)));
      }
      if (action === 'resume') {
        if (state.pausedAt) {
          state.player?.unpause();
          state.pausedTotal += Date.now() - state.pausedAt;
          state.pausedAt = 0;
        }
        await interaction.message.edit(buildNowPlayingPayload(state, state.current)).catch(() => {});
        return iReply(interaction, infoEmbed('▶️ Resumed', truncate(state.current.title, 90)));
      }
      if (action === 'skip') {
        const skipped = state.current;
        state.current = null;
        stopPlayerQuietly(state);
        await musicAdvance(guild, state);
        return iReply(interaction, infoEmbed('⏭️ Skipped', truncate(skipped.title, 90)));
      }
      if (action === 'stop') {
        await musicDestroy(guild.id, 'Stopped via buttons');
        return iReply(interaction, infoEmbed('⏹️ Stopped', 'Queue cleared and left the voice channel.'));
      }
      if (action === 'shuffle') {
        for (let i = state.queue.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
        }
        return iReply(interaction, infoEmbed('🔀 Shuffled', `${state.queue.length} track(s) randomised.`));
      }
      if (action === 'loop') {
        state.loop = state.loop === 'off' ? 'track' : state.loop === 'track' ? 'queue' : 'off';
        return iReply(interaction, infoEmbed('🔁 Loop', `Mode: **${state.loop}**`));
      }
    }

    /* ===== Verification ===== */
    if (scope === 'verify' && action === 'grant') {
      const cfg = await getVerifyConfig(interaction.guild.id);
      if (!cfg.enabled) return iReply(interaction, errEmbed('Verification closed', 'Verification is currently disabled.'));
      if (!cfg.role) return iReply(interaction, errEmbed('Not configured', 'No verification role is set — ask staff.'));
      if (!interaction.member) return iReply(interaction, errEmbed('Not a member', 'Could not resolve your member object.'));

      const role = interaction.guild.roles.cache.get(cfg.role);
      if (!role) return iReply(interaction, errEmbed('Role missing', 'The verification role no longer exists — ask staff.'));
      if (interaction.member.roles.cache.has(role.id)) {
        return iReply(interaction, infoEmbed('✅ Already verified', 'You already have the verified role. Enjoy the server!'));
      }

      const me = interaction.guild.members.me;
      if (role.position >= me.roles.highest.position) {
        return iReply(interaction, errEmbed('Hierarchy error', 'My role is below the verification role — ask staff to move my role up.'));
      }
      if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return iReply(interaction, errEmbed('Missing permission', 'I need **Manage Roles** to verify you.'));
      }

      const done = await interaction.member.roles.add(role, `Verified via panel`).then(() => true).catch(() => false);
      if (!done) return iReply(interaction, errEmbed('Failed', 'I could not give you the role — ask staff.'));

      if (cfg.logchannel) {
        const logChannel = interaction.guild.channels.cache.get(cfg.logchannel);
        if (logChannel && logChannel.isTextBased()) {
          await logChannel.send({
            embeds: [
              baseEmbed(COLORS.success, '✅ Member verified').addFields(
                { name: 'User', value: `<@${interaction.user.id}> \`${interaction.user.tag}\``, inline: true },
                { name: 'Role', value: `<@&${role.id}>`, inline: true }
              ),
            ],
            allowedMentions: { parse: [] },
          }).catch(() => {});
        }
      }
      return iReply(interaction, okEmbed('✅ Verified!', `You now have access to **${interaction.guild.name}**. Enjoy!`));
    }

    /* ===== Giveaway entry toggle ===== */
    if (scope === 'gw' && action === 'enter') {
      const giveawayId = parseInt(rest[0], 10);
      const gw = await dbGet('SELECT * FROM giveaways WHERE id = ?', [giveawayId]);
      if (!gw) return iReply(interaction, errEmbed('Giveaway not found', 'This giveaway no longer exists.'));
      if (Number(gw.ended) === 1) return iReply(interaction, warnEmbed('Giveaway ended', 'Entries are closed for this giveaway.'));

      if (gw.role_required && interaction.member && !interaction.member.roles.cache.has(gw.role_required)) {
        return iReply(interaction, errEmbed('Requirement missing', `You need the <@&${gw.role_required}> role to enter this giveaway.`));
      }

      const existing = await dbGet('SELECT * FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?', [
        giveawayId,
        interaction.user.id,
      ]);
      if (existing) {
        await dbRun('DELETE FROM giveaway_entries WHERE giveaway_id = ? AND user_id = ?', [giveawayId, interaction.user.id]);
        scheduleGiveawayRefresh(client, giveawayId);
        return iReply(interaction, infoEmbed('🚪 Entry removed', `You are no longer entered in **${gw.prize}**.`));
      }
      await dbRun('INSERT INTO giveaway_entries (giveaway_id, user_id, created_at) VALUES (?, ?, ?)', [
        giveawayId,
        interaction.user.id,
        Date.now(),
      ]);
      scheduleGiveawayRefresh(client, giveawayId);
      return iReply(interaction, okEmbed('🎉 You are in!', `Your entry for **${gw.prize}** is registered.\n-# Click again to leave the giveaway.`));
    }

    /* ===== Ticket buttons ===== */
    if (scope === 'ticket') {
      const guild = interaction.guild;
      const channel = interaction.channel;
      const ticket = await ticketOfChannel(channel.id);
      if (!ticket) return iReply(interaction, errEmbed('Not a ticket', 'This channel is not a ticket.'));
      const cfg = await getTicketConfig(guild.id);
      const member = interaction.member;
      const isStaff =
        hasPerm(interaction, PermissionFlagsBits.ManageChannels) ||
        (cfg.support_role && member.roles.cache.has(cfg.support_role)) ||
        hasPerm(interaction, PermissionFlagsBits.Administrator);

      if (action === 'close') {
        // confirmation step
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ticket:closeconfirm').setLabel('Confirm close').setStyle(ButtonStyle.Danger).setEmoji('✅'),
          new ButtonBuilder().setCustomId('ticket:closecancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary).setEmoji('✖️')
        );
        return iReply(
          interaction,
          warnEmbed('🔒 Close this ticket?', `**#${channel.name}** will be closed: a transcript is saved and the channel is deleted after 5 seconds.`),
          EPHEMERAL,
          { components: [row] }
        );
      }

      if (action === 'closeconfirm') {
        const result = await closeTicket(channel, interaction.user, `Closed via button by ${interaction.user.tag}`);
        if (!result.ok) return iReply(interaction, errEmbed('Could not close', result.message));
        return iReply(interaction, okEmbed('Ticket closing', 'The transcript was saved. This channel disappears in 5 seconds.'));
      }

      if (action === 'closecancel') {
        return iReply(interaction, infoEmbed('Cancelled', 'This ticket stays open.'));
      }

      if (action === 'claim') {
        if (!isStaff) return iReply(interaction, errEmbed('Staff only', 'Only staff members can claim tickets.'));
        if (ticket.claimed_by) return iReply(interaction, warnEmbed('Already claimed', `This ticket was claimed by <@${ticket.claimed_by}>.`));
        await dbRun('UPDATE tickets SET claimed_by = ? WHERE id = ?', [interaction.user.id, ticket.id]);
        await interaction.message.edit({ components: [ticketButtons(interaction.user.id)] }).catch(() => {});
        await channel
          .send({
            embeds: [infoEmbed('🙋 Ticket claimed', `This ticket is now handled by <@${interaction.user.id}>.`)],
            allowedMentions: { parse: [] },
          })
          .catch(() => {});
        return iReply(interaction, okEmbed('Claimed', 'You are now handling this ticket.'));
      }

      if (action === 'transcript') {
        if (!isStaff && interaction.user.id !== ticket.user_id) {
          return iReply(interaction, errEmbed('Not allowed', 'Only staff or the ticket owner can generate a transcript.'));
        }
        await interaction.deferReply({ flags: EPHEMERAL }).catch(() => {});
        try {
          const { content, count } = await buildTranscript(channel, 1000);
          const file = new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: `transcript-${channel.name}.txt` });
          return iReply(interaction, okEmbed('📄 Transcript', `Saved **${count}** message(s).`), EPHEMERAL, { files: [file] });
        } catch (err) {
          logError('transcript', err);
          return iReply(interaction, errEmbed('Failed', 'I could not build the transcript.'));
        }
      }
    }
  } catch (err) {
    logError('interactionCreate', err);
    await iReply(interaction, errEmbed('Error', 'Something went wrong while handling that interaction.')).catch(() => {});
  }
});

/* ------------------------------------------------------------------------------------------
 * 19. GUILD EVENTS (anti-nuke audit log, autorole, welcome)
 * ---------------------------------------------------------------------------------------- */

client.on(Events.GuildAuditLogEntryCreate, async (entry, guild) => {
  await handleAuditEntry(entry, guild);
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    if (member.user.bot) return;
    const settings = await getSettings(member.guild.id);

    // Invite tracking (who brought this member in?)
    try {
      const found = await findInviter(member.guild, member);
      if (found.inviterId) {
        await addInviteJoin(member.guild.id, found.inviterId);
        await dbRun(
          'INSERT INTO invite_joins (guild_id, member_id, inviter_id) VALUES (?, ?, ?) ON CONFLICT(guild_id, member_id) DO UPDATE SET inviter_id = excluded.inviter_id',
          [member.guild.id, member.id, found.inviterId]
        );
      }
    } catch (err) {
      logError('inviteTracking:add', err);
    }

    // Auto role
    if (settings.autorole) {
      const role = member.guild.roles.cache.get(settings.autorole);
      const me = member.guild.members.me;
      if (role && !role.managed && role.position < me.roles.highest.position && me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        await member.roles.add(role, 'Auto role').catch(() => {});
      }
    }

    // Welcome message
    await sendWelcome(member);
  } catch (err) {
    logError('guildMemberAdd', err);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    const row = await dbGet('SELECT * FROM invite_joins WHERE guild_id = ? AND member_id = ?', [member.guild.id, member.id]);
    if (!row) return;
    await addInviteLeave(member.guild.id, row.inviter_id);
    await dbRun('DELETE FROM invite_joins WHERE guild_id = ? AND member_id = ?', [member.guild.id, member.id]);
  } catch (err) {
    logError('inviteTracking:leave', err);
  }
});

client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  await handleNameFilter(oldMember, newMember);
});

client.on(Events.InviteCreate, async (invite) => {
  await handleInviteCreate(invite);
});

client.on(Events.InviteDelete, async (invite) => {
  await handleInviteDelete(invite);
});

/* ------------------------------------------------------------------------------------------
 * 20. READY + SCHEDULERS + LOGIN
 * ---------------------------------------------------------------------------------------- */

client.once(Events.ClientReady, async (c) => {
  client.user.setPresence({
    activities: [{ name: 'your server 👀', type: 3 }],
    status: 'online',
  });
  console.log(`[BOT] Logged in as ${c.user.tag} (${c.user.id})`);
  console.log(`[BOT] Serving ${c.guilds.cache.size} guild(s)`);
  warnVoiceEnvironment();

  // Prime the invite cache so the very first join is already attributed.
  for (const guild of c.guilds.cache.values()) await syncInvites(guild);

  // Giveaway scheduler — persists across restarts because everything lives in SQLite.
  await giveawayScheduler(client);
  const scheduler = setInterval(() => giveawayScheduler(client), 10000);
  if (scheduler.unref) scheduler.unref();
});

/**
 * One-off voice environment report printed at boot, so UDP/DAVE problems are visible in the
 * console *before* someone runs `!play` and wonders why nothing happens.
 */
function warnVoiceEnvironment() {
  const voice = loadVoiceLib();
  if (!voice) {
    console.warn('[music] @discordjs/voice is not installed — music commands are disabled.');
    return;
  }
  const version = voiceLibVersion() || 'unknown';
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  const nodeMinor = parseInt(process.versions.node.split('.')[1], 10);
  const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 12);
  if (!voiceSupportsDave()) {
    console.warn(
      `[music] @discordjs/voice ${version} has no DAVE support — Discord rejects voice connections. ` +
        'Run: npm i @discordjs/voice@latest'
    );
  }
  if (!nodeOk) {
    console.warn(
      `[music] Node ${process.versions.node} is older than 22.12 — @discordjs/voice 0.19+ needs it for DAVE. ` +
        'Music may fail to connect.'
    );
  }
  console.log(
    `[music] voice ${version} · node ${process.versions.node} · DAVE ${daveEnabled() ? 'on' : 'off'} · ` +
      `ipv4first ${String(process.env.VOICE_IPV4 || 'on').toLowerCase() !== 'off' ? 'on' : 'off'}`
  );
}

/** Graceful shutdown. */
async function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal} received — closing…`);
  try {
    client.destroy();
  } catch (_) {
    /* ignore */
  }
  db.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/** Returns a human readable verdict about the shape of the token (never prints it). */
function inspectToken(token) {
  if (!token) return 'missing';
  if (/your[-_ ]?bot[-_ ]?token|paste[-_ ]?your|changeme|xxx+/i.test(token)) return 'placeholder';
  if (/^Bot\s+/i.test(token)) return 'has a "Bot " prefix — remove it';
  if (/\s/.test(token)) return 'contains spaces/newlines — wrap it in quotes or remove them';
  if (token.split('.').length !== 3) return 'not in the expected 3-part format (base64.base64.base64)';
  if (token.length < 50) return 'too short to be a valid token';
  return 'ok';
}

/** Prints exactly where we looked for the token, so misconfiguration is obvious. */
function reportMissingToken() {
  const checked = [...new Set([path.resolve(__dirname, '.env'), path.resolve(process.cwd(), '.env')])];
  console.error('');
  console.error('[FATAL] DISCORD_TOKEN could not be found.');
  console.error('');
  console.error('  Checked environment variables : DISCORD_TOKEN, BOT_TOKEN, TOKEN, DISCORD_BOT_TOKEN');
  console.error('  Checked .env files            :');
  for (const file of checked) {
    console.error(`      ${file} ${fs.existsSync(file) ? '(exists, but no DISCORD_TOKEN inside)' : '(not found)'}`);
  }
  if (loadedEnvFiles.length) console.error(`  Loaded from                   : ${loadedEnvFiles.join(', ')}`);
  console.error('');
  console.error('  Fix one of these:');
  console.error(`    1. Create ${checked[0]} containing exactly:  DISCORD_TOKEN=your-real-token`);
  console.error('    2. Make sure the file is named ".env" — Windows often saves it as ".env.txt"');
  console.error('       (enable "File name extensions" in Explorer to see the real name).');
  console.error('    3. Or run with the variable inline:  DISCORD_TOKEN="..." node bot.js');
  console.error('    4. Token: Developer Portal → your app → Bot → Reset Token → Copy.');
  console.error('');
}

/* Boot */
(async () => {
  try {
    await initDb();

    const verdict = inspectToken(TOKEN);
    if (verdict === 'missing') {
      reportMissingToken();
      process.exit(1);
    }
    if (verdict === 'placeholder') {
      console.error('');
      console.error('[FATAL] DISCORD_TOKEN still contains the placeholder text from .env.example.');
      console.error('        Open .env and replace it with your real token, e.g.  DISCORD_TOKEN=MTIzNDU2...');
      console.error('');
      process.exit(1);
    }
    if (verdict !== 'ok') {
      console.warn(`[ENV] DISCORD_TOKEN looks wrong: ${verdict}. Trying anyway…`);
    }

    await client.login(TOKEN);
  } catch (err) {
    if (err && (err.code === 'TokenInvalid' || /invalid token/i.test(err.message || ''))) {
      console.error('');
      console.error('[FATAL] Discord rejected the token (TokenInvalid).');
      console.error('        The token value was read correctly, but Discord says it is not valid:');
      console.error('        • it was reset/regenerated → copy the new one');
      console.error('        • the value is truncated or has trailing characters/quotes');
      console.error('        • it belongs to a deleted application');
      console.error('');
      process.exit(1);
    }
    logError('startup', err);
    process.exit(1);
  }
})();

module.exports = {
  client,
  db,
  dbRun,
  dbGet,
  dbAll,
  DRIVER_NAME,
  DRIVER_MODE,
  loadEnv,
  // exposed for the offline test-suite (not used by the bot itself)
  __commands: commands,
  __music: {
    musicState,
    musicStates,
    MUSIC_FILTERS,
    MUSIC_COLORS,
    detectMusicBinaries,
    buildMusicFilterChain,
    formatTime,
    musicProgressBar,
    buildQueueEmbed,
    loadVoiceLib,
    musicDestroy,
    createMusicStream,
    // voice / UDP diagnostics (new)
    voiceLibVersion,
    voiceSupportsDave,
    daveEnabled,
    musicVoiceOptions,
    musicJoinAttempts,
    musicConnectionReady,
    musicConnect,
    describeMusicVoiceError,
    musicVoiceFailureMessage,
    describeYtdlpError,
  },
  __antispam: {
    getSpamWhitelist,
    invalidateSpamWhitelist,
    isSpamWhitelisted,
    antiSpamCheck,
    detectSpam,
  },
  __access: {
    isMainOwner,
    hasAdminAccess,
    markPrivileged,
    actorPrivileged,
    hasPerm,
    assertNukeAdmin,
  },
  __antinuke: {
    punishNuker,
    nukeTimeoutMs,
    NUKE_PUNISHMENTS,
  },
};
