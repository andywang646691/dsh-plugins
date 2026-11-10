// Session Search Tool — Deep integration of Hermes 4-shape ergonomics and CJK routing
// with Obelisk's multi-agent historical intelligence.
//
// 1. Shapes (Hermes):
//    - DISCOVERY (query): Ranked sessions with best-match excerpt (+ opening/closing for #1)
//    - SCROLL (session_id + around_message_id): Context window around a match anchor
//    - READ (session_id alone): Head and tail of the session (≤2000 chars per message)
//    - BROWSE (no args): Recent active sessions
//
// 2. Search Engine:
//    - Local DSH: SQLite FTS5 (tokenize='trigram') for CJK substrings, with LIKE fallback
//      for <3 character terms and OR-relaxed retry when exact multi-term search misses.
//    - Multi-Agent Bridge: Reads Obelisk's database (~/.obelisk/obelisk.sqlite) when present,
//      transparently surfacing past conversations from Claude Code, Codex, Kimi, etc.
//    - Zero LLM calls: All operations run pure SQLite queries for sub-10ms response.

import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { defineTool } from '@deepseek-ai/dsh-tools';

const DISCOVERY_SNIPPET = 1200;
const SCROLL_MAX = 4000;
const READ_MAX = 2000;
const HIDDEN_ORIGINS = new Set(['subagent']);

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function containsCjk(text) {
  return /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(String(text || ''));
}

export function escapeLike(s) {
  return String(s || '').replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Visible conversation messages of one session log: user prompts and assistant text only. */
export function extractMessages(events) {
  const out = [];
  for (const e of events) {
    if (e.type === 'user/message' && e.data?.source?.kind === 'user') {
      const t = textOf(e.data.content);
      if (t) out.push({ seq: e.seq, time: e.time, role: 'user', text: t });
    } else if (e.type === 'assistant/message') {
      const t = textOf(e.data?.message?.content);
      if (t) out.push({ seq: e.seq, time: e.time, role: 'assistant', text: t });
    }
  }
  return out;
}

const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
const iso = (ms) => {
  if (!ms) return undefined;
  if (typeof ms === 'string' && ms.includes('T')) return ms;
  try {
    return new Date(Number(ms)).toISOString();
  } catch {
    return undefined;
  }
};

/**
 * Local DSH Session Index (FTS5 trigram + metadata)
 */
export class SessionIndex {
  constructor(path) {
    this.path = path;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    const { DatabaseSync } = await import('node:sqlite');
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);
    db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY,
        cwd TEXT,
        created INTEGER,
        title TEXT,
        indexed_through INTEGER,
        origin TEXT,
        revision TEXT
      );
      CREATE TABLE IF NOT EXISTS messages(
        rowid INTEGER PRIMARY KEY,
        session_id TEXT,
        seq INTEGER,
        time INTEGER,
        role TEXT,
        text TEXT,
        UNIQUE(session_id, seq)
      );
    `);

    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    if (!sessionCols.includes('revision')) {
      db.exec('ALTER TABLE sessions ADD COLUMN revision TEXT');
    }

    // Detect missing or incompatible FTS5 schema (e.g. legacy 2.0.0-bigram without `text` column)
    const ftsRow = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='messages_fts'")
      .get();
    const ftsCols = ftsRow
      ? db.prepare('PRAGMA table_info(messages_fts)').all().map((c) => c.name)
      : [];
    const ftsCompatible =
      Boolean(ftsRow) &&
      ftsCols.length === 1 &&
      ftsCols[0] === 'text' &&
      String(ftsRow.sql || '').toLowerCase().includes('trigram');

    if (!ftsCompatible) {
      db.exec('BEGIN');
      try {
        db.exec(`
          DROP TRIGGER IF EXISTS messages_ai;
          DROP TRIGGER IF EXISTS messages_ad;
          DROP TABLE IF EXISTS messages_fts;
          CREATE VIRTUAL TABLE messages_fts USING fts5(
            text,
            content='messages',
            content_rowid='rowid',
            tokenize='trigram'
          );
          INSERT INTO messages_fts(messages_fts) VALUES('rebuild');
        `);
        const hasSyncMeta = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_meta'")
          .get();
        if (hasSyncMeta) {
          db.prepare("INSERT OR REPLACE INTO sync_meta(key, val) VALUES ('schema_version', '3.0.0-trigram')").run();
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      END;
    `);
    this.db = db;
    return db;
  }

  async ingest(sessionId, header, events, title, revision = null) {
    const db = await this.open();
    const row = db.prepare('SELECT indexed_through FROM sessions WHERE id=?').get(sessionId);
    const from = row?.indexed_through ?? -1;
    const msgs = extractMessages(events).filter((m) => m.seq > from);
    const ins = db.prepare('INSERT OR IGNORE INTO messages(session_id, seq, time, role, text) VALUES (?,?,?,?,?)');
    db.exec('BEGIN');
    try {
      for (const m of msgs) ins.run(sessionId, m.seq, m.time ?? 0, m.role, m.text);
      const last = events.length ? events[events.length - 1].seq : from;
      db.prepare(`
        INSERT INTO sessions(id, cwd, created, title, indexed_through, origin, revision)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title = COALESCE(excluded.title, sessions.title),
          indexed_through = excluded.indexed_through,
          revision = COALESCE(excluded.revision, sessions.revision)
      `).run(
        sessionId,
        header?.cwd ?? null,
        header?.createdAt ?? 0,
        title ?? null,
        last,
        header?.origin ?? null,
        revision ?? null
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return msgs.length;
  }

  async setRevision(sessionId, revision) {
    if (!revision) return;
    const db = await this.open();
    db.prepare('UPDATE sessions SET revision=? WHERE id=?').run(revision, sessionId);
  }

  async sessionIndexState() {
    const db = await this.open();
    const rows = db.prepare('SELECT id, indexed_through, revision FROM sessions').all();
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * Search local sessions with Hermes CJK routing & OR-relaxation
   */
  async search(query, { limit = 3, excludeSessionId, after, before, sort, relaxed = false } = {}) {
    const db = await this.open();
    const rawTokens = query.trim().split(/\s+/).filter(Boolean);
    if (!rawTokens.length) return [];

    // Separate tokens: long (>=3 chars, eligible for trigram) vs short (<3 chars, need LIKE)
    const long = rawTokens.filter((t) => [...t].length >= 3);
    const short = rawTokens.filter((t) => [...t].length < 3);

    const runQuery = (isOrMode) => {
      const params = [];
      let sql;
      const op = isOrMode ? ' OR ' : ' AND ';

      if (long.length && !isOrMode) {
        sql = `SELECT m.session_id, m.seq, m.role, m.text, m.time, s.title, s.cwd, s.created,
                      bm25(messages_fts) AS rank
               FROM messages_fts
               JOIN messages m ON m.rowid = messages_fts.rowid
               JOIN sessions s ON s.id = m.session_id
               WHERE messages_fts MATCH ?`;
        params.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND '));
      } else if (long.length && isOrMode) {
        sql = `SELECT m.session_id, m.seq, m.role, m.text, m.time, s.title, s.cwd, s.created,
                      bm25(messages_fts) AS rank
               FROM messages_fts
               JOIN messages m ON m.rowid = messages_fts.rowid
               JOIN sessions s ON s.id = m.session_id
               WHERE messages_fts MATCH ?`;
        params.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR '));
      } else {
        sql = `SELECT m.session_id, m.seq, m.role, m.text, m.time, s.title, s.cwd, s.created, 0 AS rank
               FROM messages m
               JOIN sessions s ON s.id = m.session_id
               WHERE (1=1`;
        if (short.length) {
          const clauses = short.map(() => "(m.text LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')");
          sql += ` AND (${clauses.join(op)})`;
          for (const t of short) {
            const p = `%${escapeLike(t)}%`;
            params.push(p, p);
          }
        }
        sql += ')';
      }

      // If strict mode with short tokens: add LIKE clauses
      if (!isOrMode && short.length && long.length) {
        for (const t of short) {
          sql += " AND (m.text LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')";
          const p = `%${escapeLike(t)}%`;
          params.push(p, p);
        }
      }

      sql += " AND (s.origin IS NULL OR s.origin <> 'subagent')";
      if (excludeSessionId) {
        sql += ' AND m.session_id <> ?';
        params.push(excludeSessionId);
      }
      if (after) {
        sql += ' AND m.time >= ?';
        params.push(after);
      }
      if (before) {
        sql += ' AND m.time <= ?';
        params.push(before);
      }

      sql += long.length ? ' ORDER BY rank, m.time DESC LIMIT 300' : ' ORDER BY m.time DESC LIMIT 300';
      return db.prepare(sql).all(...params);
    };

    let rows = [];
    try {
      rows = runQuery(false);
    } catch (e) {
      // Syntax or operational fallback
      rows = [];
    }

    let isRelaxedHit = false;
    // Hermes OR-relaxed retry if exact match produced zero hits and we have multiple tokens
    if (rows.length === 0 && rawTokens.length >= 2) {
      try {
        rows = runQuery(true);
        if (rows.length > 0) isRelaxedHit = true;
      } catch {}
    }

    const bySession = new Map();
    for (const r of rows) {
      const cur = bySession.get(r.session_id);
      if (!cur) {
        bySession.set(r.session_id, { ...r, hits: 1, source: 'dsh' });
      } else {
        cur.hits++;
      }
    }

    let ranked = [...bySession.values()];
    if (sort === 'newest') ranked.sort((a, b) => b.time - a.time);
    else if (sort === 'oldest') ranked.sort((a, b) => a.time - b.time);

    const out = ranked.slice(0, Math.min(Math.max(limit, 1), 10));
    out.isRelaxedHit = isRelaxedHit;
    return out;
  }

  async sessionMeta(id) {
    const db = await this.open();
    return db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  }

  async messagesOf(id) {
    const db = await this.open();
    return db.prepare('SELECT seq, time, role, text FROM messages WHERE session_id=? ORDER BY seq').all(id);
  }

  async recent(limit, excludeSessionId) {
    const db = await this.open();
    return db.prepare(`
      SELECT s.*,
        (SELECT MAX(time) FROM messages m WHERE m.session_id=s.id) AS last_time,
        (SELECT text FROM messages m WHERE m.session_id=s.id AND role='user' ORDER BY seq LIMIT 1) AS first_prompt
      FROM sessions s
      WHERE (s.origin IS NULL OR s.origin <> 'subagent') AND s.id <> ?
      ORDER BY last_time DESC LIMIT ?
    `).all(excludeSessionId ?? '', limit);
  }
}

/**
 * Obelisk Historical Bridge: Queries ~/.obelisk/obelisk.sqlite for multi-agent history
 */
class ObeliskBridge {
  constructor(dbPath) {
    this.path = dbPath;
    this.db = null;
  }

  async open() {
    if (this.db) return this.db;
    if (!this.path || !existsSync(this.path)) return null;
    try {
      const { DatabaseSync } = await import('node:sqlite');
      this.db = new DatabaseSync(this.path, { readOnly: true });
      return this.db;
    } catch {
      return null;
    }
  }

  async search(query, { limit = 3, after, before, sort } = {}) {
    const db = await this.open();
    if (!db) return [];
    const rawTokens = query.trim().split(/\s+/).filter(Boolean);
    if (!rawTokens.length) return [];

    const isCjk = containsCjk(query);
    const params = [];
    let sql;

    if (!isCjk) {
      // FTS5 MATCH for ASCII
      const matchText = rawTokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
      sql = `
        SELECT m.session_id, m.uuid as seq, m.role, m.text, m.timestamp as time,
               s.title, s.project_path as cwd, COALESCE(s.source, m.source, 'agent') as source,
               mf.rank
        FROM messages_fts mf
        JOIN messages m ON m.uuid = mf.uuid
        LEFT JOIN sessions s ON s.id = m.session_id
        WHERE mf.text MATCH ? AND COALESCE(m.is_meta, 0) = 0
      `;
      params.push(matchText);
    } else {
      // LIKE query for CJK to ensure 100% precision on Chinese tokens
      const likes = rawTokens.map(() => "(m.text LIKE ? ESCAPE '\\' OR s.title LIKE ? ESCAPE '\\')").join(' AND ');
      sql = `
        SELECT m.session_id, m.uuid as seq, m.role, m.text, m.timestamp as time,
               s.title, s.project_path as cwd, COALESCE(s.source, m.source, 'agent') as source,
               0 as rank
        FROM messages m
        LEFT JOIN sessions s ON s.id = m.session_id
        WHERE ${likes} AND COALESCE(m.is_meta, 0) = 0
      `;
      for (const t of rawTokens) {
        const p = `%${escapeLike(t)}%`;
        params.push(p, p);
      }
    }

    if (after) {
      sql += ' AND m.timestamp >= ?';
      params.push(new Date(after).toISOString());
    }
    if (before) {
      sql += ' AND m.timestamp <= ?';
      params.push(new Date(before).toISOString());
    }

    sql += isCjk ? ' ORDER BY m.timestamp DESC LIMIT 100' : ' ORDER BY mf.rank, m.timestamp DESC LIMIT 100';

    try {
      const rows = db.prepare(sql).all(...params);
      const bySession = new Map();
      for (const r of rows) {
        const cur = bySession.get(r.session_id);
        if (!cur) {
          bySession.set(r.session_id, { ...r, hits: 1 });
        } else {
          cur.hits++;
        }
      }
      let ranked = [...bySession.values()];
      if (sort === 'newest') ranked.sort((a, b) => (b.time > a.time ? 1 : -1));
      else if (sort === 'oldest') ranked.sort((a, b) => (a.time > b.time ? 1 : -1));
      return ranked.slice(0, limit);
    } catch {
      return [];
    }
  }

  async messagesOf(sessionId) {
    const db = await this.open();
    if (!db) return [];
    try {
      return db
        .prepare(`
          SELECT uuid as id, role, timestamp as time, text
          FROM messages
          WHERE session_id = ? AND COALESCE(is_meta, 0) = 0
          ORDER BY timestamp ASC, rowid ASC
        `)
        .all(sessionId);
    } catch {
      return [];
    }
  }

  async sessionMeta(sessionId) {
    const db = await this.open();
    if (!db) return null;
    try {
      return db
        .prepare(`
          SELECT id as session_id, title, project_path as cwd, started_at as started, source
          FROM sessions
          WHERE id = ?
        `)
        .get(sessionId);
    } catch {
      return null;
    }
  }

  async recent(limit) {
    const db = await this.open();
    if (!db) return [];
    try {
      return db
        .prepare(`
          SELECT s.id as session_id, s.title, s.started_at as started, s.ended_at as last_time, s.source,
                 (SELECT text FROM messages m WHERE m.session_id = s.id AND role = 'user' ORDER BY timestamp ASC LIMIT 1) as first_prompt
          FROM sessions s
          ORDER BY COALESCE(s.ended_at, s.started_at) DESC
          LIMIT ?
        `)
        .all(limit);
    } catch {
      return [];
    }
  }
}

const RELATIVE = /^(\d+)\s*(h|d|w)$/i;
function bound(v) {
  if (!v) return undefined;
  const m = RELATIVE.exec(String(v).trim());
  if (m) {
    const scale = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase()];
    return Date.now() - Number(m[1]) * scale;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

function resolveObeliskDbPath() {
  const custom = process.env.OBELISK_DB_PATH;
  if (custom && existsSync(custom)) return custom;
  const p1 = '/var/lib/dsh/.obelisk/obelisk.sqlite';
  if (existsSync(p1)) return p1;
  const p2 = join(homedir(), '.obelisk', 'obelisk.sqlite');
  if (existsSync(p2)) return p2;
  return null;
}

export function cleanJson(val) {
  if (val === null || typeof val !== 'object') {
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) return null;
      if (Object.is(val, -0)) return 0;
    }
    return val;
  }
  if (Array.isArray(val)) {
    return val.filter((item) => item !== undefined).map(cleanJson);
  }
  const out = {};
  for (const [k, v] of Object.entries(val)) {
    if (v !== undefined) {
      out[k] = cleanJson(v);
    }
  }
  return out;
}

export function registerSessionSearch(
  ctx,
  {
    indexPath,
    log = () => {},
    register = (d) => ctx.tools.register(d),
    obeliskDbPath = resolveObeliskDbPath(),
  } = {}
) {
  const index = new SessionIndex(indexPath);
  const obelisk = new ObeliskBridge(obeliskDbPath);
  const sq = () => ctx.get?.('sessionQuery');
  const sp = () => ctx.get?.('sessionPersistence');
  const sessionsSvc = () => ctx.get?.('sessions');

  function extractTitle(events) {
    if (!Array.isArray(events) || !events.length) return undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e?.type === 'session/title' && typeof e.data?.title === 'string') {
        return e.data.title;
      }
    }
    return undefined;
  }

  async function safeReadTitle(svc, id, signal) {
    try {
      return (await svc.readTitle?.(id, signal))?.title;
    } catch {
      return undefined;
    }
  }

  async function ingestFromSource(svc, id, header, meta, knownRevision, signal) {
    if (typeof svc.observeSession === 'function') {
      const lease = await svc.observeSession(id, { signal, projectionMode: 'none' });
      try {
        const hdr = header ?? lease.header;
        if (HIDDEN_ORIGINS.has(hdr?.origin)) return 0;
        const lastSeq = typeof lease.cursor === 'number' ? lease.cursor : -1;
        const rev = lease.revision ?? knownRevision ?? null;
        if (meta && meta.indexed_through >= lastSeq) {
          if (rev && meta.revision !== rev) await index.setRevision(id, rev);
          return 0;
        }
        const events = lease.events;
        const title = extractTitle(events) ?? (await safeReadTitle(svc, id, signal));
        return await index.ingest(id, hdr, events, title, rev);
      } finally {
        lease?.[Symbol.dispose]?.();
      }
    }

    const snap = await svc.readSession(id);
    const hdr = header ?? snap.session;
    if (HIDDEN_ORIGINS.has(hdr?.origin)) return 0;
    const lastSeq = snap.events.length ? snap.events[snap.events.length - 1].seq : -1;
    if (meta && meta.indexed_through >= lastSeq) {
      if (knownRevision && meta.revision !== knownRevision) {
        await index.setRevision(id, knownRevision);
      }
      return 0;
    }
    const title = extractTitle(snap.events) ?? (await safeReadTitle(svc, id, signal));
    return await index.ingest(id, hdr, snap.events, title, knownRevision);
  }

  let inFlightRefresh = null;

  async function refresh(signal) {
    if (inFlightRefresh) return inFlightRefresh;
    inFlightRefresh = (async () => {
      const svc = sq();
      if (!svc) return 0;
      const records = await svc.listSessions(signal);
      const stateMap = await index.sessionIndexState();

      let revById = null;
      const persistence = sp();
      if (typeof persistence?.list === 'function') {
        try {
          const persisted = await persistence.list(signal ? { signal } : undefined);
          revById = new Map(persisted.map((p) => [p.header.id, p.revision]));
        } catch {}
      }

      let added = 0;
      for (const rec of records) {
        if (signal?.aborted) break;
        const id = rec.header.id;
        if (HIDDEN_ORIGINS.has(rec.header.origin)) continue;
        const meta = stateMap.get(id);
        const rev = revById?.get(id) ?? null;

        // Fast skip: persisted session whose revision matches the already-indexed revision
        if (!rec.live && meta && rev && meta.revision === rev) continue;

        try {
          added += await ingestFromSource(svc, id, rec.header, meta, rev, signal);
        } catch (e) {
          log(`session_search ingest ${id} failed: ${e?.message || e}`);
        }
      }
      return added;
    })();
    try {
      return await inFlightRefresh;
    } finally {
      inFlightRefresh = null;
    }
  }

  async function refreshOne(sessionId, signal) {
    const svc = sq();
    if (!svc) return 0;
    const meta = await index.sessionMeta(sessionId);
    const isLive = Boolean(sessionsSvc()?.get?.(sessionId));
    let knownRevision = null;

    if (!isLive && meta?.revision) {
      const persistence = sp();
      if (typeof persistence?.stat === 'function') {
        try {
          const st = await persistence.stat(sessionId, signal ? { signal } : undefined);
          knownRevision = st?.revision ?? null;
          if (knownRevision && meta.revision === knownRevision) return 0;
        } catch {}
      }
    }

    try {
      return await ingestFromSource(svc, sessionId, null, meta, knownRevision, signal);
    } catch (e) {
      log(`session_search ingest ${sessionId} failed: ${e?.message || e}`);
      return 0;
    }
  }

  const isObeliskId = (id) => String(id || '').includes(':');

  const fmtSession = async (id) => {
    const isOb = isObeliskId(id);
    const m = isOb ? await obelisk.sessionMeta(id) : await index.sessionMeta(id);
    const res = {
      session_id: id,
      source: (isOb ? m?.source : null) || (isOb ? 'obelisk' : 'dsh'),
    };
    if (m?.title) res.title = m.title;
    if (m?.cwd) res.cwd = m.cwd;
    const st = isOb ? iso(m?.started) : iso(m?.created);
    if (st) res.started = st;
    return res;
  };

  register(
    defineTool({
      name: 'session_search',
      description:
        "Search or read past DSH and multi-agent conversations (full-text, Chinese-capable), or scroll inside one. " +
        "Four shapes, picked by args:\n" +
        "- `query`: Discovery (top matching sessions across DSH and multi-agent history with best-matching message; #1 result includes opening and closing messages);\n" +
        "- `session_id` + `around_message_id`: Scroll (window of messages around an anchor);\n" +
        "- `session_id` alone: Read whole session (head/tail);\n" +
        "- no args: Browse recent sessions.\n" +
        "Results are actual stored messages, no LLM. Searches conversation history ONLY — when the user gave a direct source " +
        "(URL, file, live system), inspect that first; never conclude 'not found' from history alone. " +
        "Use for questions about past conversations: 'what did we do about X', 'where did we leave Y', '上次怎么做的'.",
      parameters: {
        query: {
          type: 'string',
          description:
            'Discovery: keywords or phrases (space-separated terms are ANDed, with automatic CJK/OR fallback). Omit to browse recent sessions.',
        },
        limit: {
          type: 'integer',
          description: 'Max sessions to return. Discovery defaults to 3; browse defaults to 10. Max 10.',
        },
        sort: {
          type: 'string',
          enum: ['newest', 'oldest'],
          description:
            "Discovery only: omit for relevance; 'newest' for \"where did we leave X\", 'oldest' for \"how did X start\".",
        },
        after: {
          type: 'string',
          description: "Only messages at/after this time: ISO date or relative '7d' / '24h' / '2w'.",
        },
        before: {
          type: 'string',
          description: 'Only messages at/before this time (same formats as after).',
        },
        session_id: {
          type: 'string',
          description: 'Read (alone) or scroll (with around_message_id) inside this session (supports both DSH and Obelisk IDs).',
        },
        around_message_id: {
          type: 'string',
          description: 'Scroll anchor: the message id (integer seq or string UUID) returned by discovery.',
        },
        window: {
          type: 'integer',
          description: 'Scroll: messages before and after the anchor (default 4, max 10).',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 1) }],
      },
      async execute(args, exec) {
        const self = exec?.agent?.id;

        // Shape 1: SCROLL
        if (args.session_id && args.around_message_id !== undefined) {
          let msgs = [];
          if (isObeliskId(args.session_id)) {
            msgs = await obelisk.messagesOf(args.session_id);
          } else {
            try {
              await refreshOne(args.session_id, exec?.signal);
            } catch (e) {
              log(`index refreshOne error: ${e?.message || e}`);
            }
            msgs = await index.messagesOf(args.session_id);
          }
          if (!msgs.length) return { success: false, error: 'Session not found or has no messages' };

          const target = String(args.around_message_id);
          const i = msgs.findIndex((m) => String(m.id ?? m.seq) === target || Number(m.seq) >= Number(target));
          if (i < 0) return { success: false, error: 'Anchor not found in that session' };

          const w = Math.min(Math.max(args.window ?? 4, 1), 10);
          return cleanJson({
            success: true,
            shape: 'scroll',
            ...(await fmtSession(args.session_id)),
            messages: msgs.slice(Math.max(0, i - w), i + w + 1).map((m) => {
              const item = {
                id: m.id ?? m.seq,
                role: m.role,
                text: clip(m.text, SCROLL_MAX),
              };
              const t = iso(m.time);
              if (t) item.time = t;
              if ((m.id ?? m.seq) === (msgs[i].id ?? msgs[i].seq)) item.anchor = true;
              return item;
            }),
          });
        }

        // Shape 2: READ
        if (args.session_id) {
          let msgs = [];
          if (isObeliskId(args.session_id)) {
            msgs = await obelisk.messagesOf(args.session_id);
          } else {
            try {
              await refreshOne(args.session_id, exec?.signal);
            } catch (e) {
              log(`index refreshOne error: ${e?.message || e}`);
            }
            msgs = await index.messagesOf(args.session_id);
          }
          if (!msgs.length) return { success: false, error: 'Session not found or has no messages' };

          const pick = msgs.length > 20 ? [...msgs.slice(0, 10), null, ...msgs.slice(-10)] : msgs;
          return cleanJson({
            success: true,
            shape: 'read',
            ...(await fmtSession(args.session_id)),
            total_messages: msgs.length,
            messages: pick.map((m) => {
              if (!m) {
                return {
                  omitted: msgs.length - 20,
                  hint: 'Scroll with session_id + around_message_id to see the middle.',
                };
              }
              const item = {
                id: m.id ?? m.seq,
                role: m.role,
                text: clip(m.text, READ_MAX),
              };
              const t = iso(m.time);
              if (t) item.time = t;
              return item;
            }),
          });
        }

        try {
          await refresh(exec?.signal);
        } catch (e) {
          log(`index refresh error: ${e?.message || e}`);
        }

        // Shape 3: BROWSE
        if (!args.query || !args.query.trim()) {
          const limit = Math.min(Math.max(args.limit ?? 10, 1), 10);
          const dshRows = await index.recent(limit, self);
          const obeliskRows = await obelisk.recent(limit);

          // Merge & sort recent sessions
          const combined = [
            ...dshRows.map((r) => {
              const item = {
                session_id: r.id,
                source: 'dsh',
                first_prompt: clip(r.first_prompt || '', 200),
              };
              if (r.title) item.title = r.title;
              const t = iso(r.last_time);
              if (t) item.last_active = t;
              return item;
            }),
            ...obeliskRows.map((r) => {
              const item = {
                session_id: r.session_id,
                source: r.source || 'obelisk',
                first_prompt: clip(r.first_prompt || '', 200),
              };
              if (r.title) item.title = r.title;
              const t = iso(r.last_time || r.started);
              if (t) item.last_active = t;
              return item;
            }),
          ];

          combined.sort((a, b) => String(b.last_active || '').localeCompare(String(a.last_active || '')));
          return cleanJson({
            success: true,
            shape: 'browse',
            sessions: combined.slice(0, limit),
          });
        }

        // Shape 4: DISCOVERY
        const limit = Math.min(Math.max(args.limit ?? 3, 1), 10);
        const searchOpts = {
          limit,
          excludeSessionId: self,
          after: bound(args.after),
          before: bound(args.before),
          sort: args.sort,
        };

        // Query DSH index first
        const localHits = await index.search(args.query, searchOpts);
        let hits = [...localHits];

        // If hits fewer than limit, or searching broadly, query Obelisk
        if (hits.length < limit) {
          const obeliskHits = await obelisk.search(args.query, {
            ...searchOpts,
            limit: limit - hits.length + 2,
          });
          const existingIds = new Set(hits.map((h) => h.session_id));
          for (const oh of obeliskHits) {
            if (!existingIds.has(oh.session_id)) {
              hits.push(oh);
              existingIds.add(oh.session_id);
            }
          }
        }

        const results = [];
        for (const [i, h] of hits.slice(0, limit).entries()) {
          const r = {
            ...(await fmtSession(h.session_id)),
            matches: h.hits,
            best_match: {
              id: h.seq,
              role: h.role,
              time: iso(h.time),
              text: clip(h.text, DISCOVERY_SNIPPET),
            },
          };

          // Hydrate opening & closing messages for the #1 top result
          if (i === 0) {
            let msgs = [];
            if (isObeliskId(h.session_id)) {
              msgs = await obelisk.messagesOf(h.session_id);
            } else {
              msgs = await index.messagesOf(h.session_id);
            }
            if (msgs.length) {
              r.opening = msgs.slice(0, 2).map((m) => ({
                id: m.id ?? m.seq,
                role: m.role,
                text: clip(m.text, 600),
              }));
              r.closing = msgs.slice(-2).map((m) => ({
                id: m.id ?? m.seq,
                role: m.role,
                text: clip(m.text, 600),
              }));
            }
          }
          results.push(r);
        }

        let hint = results.length
          ? 'Scroll with session_id + around_message_id for context.'
          : 'No matches. Try other or fewer keywords.';
        if (localHits.isRelaxedHit) {
          hint += ' (Note: Exact multi-token match yielded no results; showing OR-relaxed keyword matches)';
        }

        return cleanJson({
          success: true,
          shape: 'discovery',
          query: args.query,
          results,
          hint,
        });
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args.query
          ? `Search past sessions: ${args.query}`
          : args.session_id
          ? 'Read past session'
          : 'Browse recent sessions',
        kind: 'search',
        rawInput: args,
      }),
    })
  );

  return index;
}
