// @max/dsh-fast-search — Independent Ultra-fast Session Search Engine for DSH Web GUI
import { mkdirSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { zstdDecompressSync } from 'node:zlib';

export const name = '@max/dsh-fast-search';
export const inject = ['sessionQuery'];

const ZSTD_MAGIC = 4247762216;

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset >= buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}

export function decompressZstdLog(buffer) {
  const frames = scanZstdFrames(buffer);
  const chunks = [];
  for (const { start, end } of frames) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(start, end)));
    } catch {}
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function containsCjk(text) {
  return /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(String(text || ''));
}

export function tokenizeCjk(text) {
  const tokens = [];
  const cjkRegex = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]+/g;
  let match;
  while ((match = cjkRegex.exec(text)) !== null) {
    const chunk = match[0];
    const chars = [...chunk];
    for (let i = 0; i < chars.length; i++) {
      tokens.push(chars[i]);
      if (i + 1 < chars.length) {
        tokens.push(chars[i] + chars[i + 1]);
      }
    }
  }
  return tokens;
}

export function buildSearchDoc(text) {
  if (!text) return '';
  const asciiWords = text
    .replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && w.length < 50);
  const cjkTokens = tokenizeCjk(text);
  return [...asciiWords, ...cjkTokens].join(' ');
}

export function buildFtsQuery(query, isOrMode = false) {
  const parts = query.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  const op = isOrMode ? ' OR ' : ' AND ';
  const matchTerms = [];

  for (const part of parts) {
    if (containsCjk(part)) {
      const chars = [...part.replace(/[^\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, '')];
      if (chars.length === 1) {
        matchTerms.push(`"${chars[0]}"`);
      } else {
        const biGrams = [];
        for (let i = 0; i < chars.length - 1; i++) {
          biGrams.push(`"${chars[i]}${chars[i + 1]}"`);
        }
        matchTerms.push(biGrams.length ? `(${biGrams.join(' AND ')})` : `"${chars.join('')}"`);
      }
    } else {
      const clean = part.replace(/"/g, '""');
      if (clean) matchTerms.push(`"${clean}"`);
    }
  }

  return matchTerms.join(op);
}

export function extractSnippet(rawText, query, maxLen = 140) {
  if (!rawText) return '';
  const clean = rawText.replace(/\s+/g, ' ').trim();
  const rawTerms = query.trim().split(/\s+/).filter(Boolean);
  let firstIdx = -1;
  let matchedTerm = '';

  for (const term of rawTerms) {
    const idx = clean.toLowerCase().indexOf(term.toLowerCase());
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
      firstIdx = idx;
      matchedTerm = term;
    }
  }

  if (firstIdx === -1) {
    return clean.length > maxLen ? clean.slice(0, maxLen) + '…' : clean;
  }

  const half = Math.floor((maxLen - matchedTerm.length) / 2);
  const start = Math.max(0, firstIdx - half);
  const end = Math.min(clean.length, firstIdx + matchedTerm.length + half);
  let snippet = clean.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < clean.length) snippet = snippet + '…';
  return snippet;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

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

export class FastSessionIndex {
  constructor(path, log = () => {}) {
    this.path = path;
    this.log = log;
    this.db = null;
    this.sessionsBaseDir = join(homedir(), '.dsh', 'sessions');
    this.lastCheckpointMtime = 0;
  }

  async open() {
    if (this.db) return this.db;
    const { DatabaseSync } = await import('node:sqlite');
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true });
    const db = new DatabaseSync(this.path);

    const SCHEMA_VERSION = '2.0.0-bigram';
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -64000;

      CREATE TABLE IF NOT EXISTS sync_meta(
        key TEXT PRIMARY KEY,
        val TEXT
      );
    `);

    let currentVersion = '';
    try {
      const vRow = db.prepare("SELECT val FROM sync_meta WHERE key='schema_version'").get();
      currentVersion = vRow?.val || '';
    } catch {}

    if (currentVersion !== SCHEMA_VERSION) {
      this.log(`Upgrading session search schema to "${SCHEMA_VERSION}"...`);
      db.exec(`
        DROP TABLE IF EXISTS messages_fts;
        DROP TABLE IF EXISTS messages;
        DROP TABLE IF EXISTS sessions;
        DELETE FROM sync_meta;
        INSERT INTO sync_meta(key, val) VALUES('schema_version', '${SCHEMA_VERSION}');
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY,
        cwd TEXT,
        created INTEGER,
        mtime INTEGER,
        title TEXT,
        indexed_through INTEGER,
        origin TEXT
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

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id UNINDEXED,
        seq UNINDEXED,
        time UNINDEXED,
        role UNINDEXED,
        raw_text UNINDEXED,
        search_text,
        tokenize = 'unicode61'
      );
    `);
    this.db = db;

    try {
      const row = db.prepare("SELECT val FROM sync_meta WHERE key='last_mtime'").get();
      if (row?.val) this.lastCheckpointMtime = Number(row.val);
    } catch {}

    return db;
  }

  async ingestSession(sessionId, header, events, title, mtime = 0) {
    const db = await this.open();
    const row = db.prepare('SELECT indexed_through FROM sessions WHERE id=?').get(sessionId);
    const from = row?.indexed_through ?? -1;
    const msgs = extractMessages(events).filter((m) => m.seq > from);

    if (msgs.length === 0 && row) return 0;

    const insRel = db.prepare('INSERT OR IGNORE INTO messages(session_id, seq, time, role, text) VALUES (?,?,?,?,?)');
    const insFts = db.prepare('INSERT INTO messages_fts(session_id, seq, time, role, raw_text, search_text) VALUES (?,?,?,?,?,?)');

    db.exec('BEGIN TRANSACTION');
    try {
      for (const m of msgs) {
        insRel.run(sessionId, m.seq, m.time ?? 0, m.role, m.text);
        const searchDoc = buildSearchDoc(`${title || ''} ${m.text}`);
        insFts.run(sessionId, m.seq, m.time ?? 0, m.role, m.text, searchDoc);
      }
      const last = events.length ? events[events.length - 1].seq : from;
      db.prepare(`
        INSERT INTO sessions(id, cwd, created, mtime, title, indexed_through, origin)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          title = COALESCE(excluded.title, sessions.title),
          mtime = MAX(excluded.mtime, sessions.mtime),
          indexed_through = excluded.indexed_through
      `).run(sessionId, header?.cwd ?? null, header?.createdAt ?? 0, mtime, title ?? null, last, header?.origin ?? null);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return msgs.length;
  }

  checkSessionExists(sessionId) {
    if (this.path === ':memory:') return true;
    if (!existsSync(this.sessionsBaseDir)) return true;
    try {
      const bareId = String(sessionId).replace(/^session-/, '');
      const prefixedId = 'session-' + bareId;
      const workspaces = readdirSync(this.sessionsBaseDir);
      for (const ws of workspaces) {
        const wsDir = join(this.sessionsBaseDir, ws);
        if (existsSync(join(wsDir, sessionId)) ||
            existsSync(join(wsDir, bareId)) ||
            existsSync(join(wsDir, prefixedId))) {
          return true;
        }
      }
      return false;
    } catch {
      return true;
    }
  }

  async purgeDeadSessions(sessionIds) {
    if (!sessionIds.length) return;
    const db = await this.open();
    try {
      db.exec('BEGIN TRANSACTION');
      const delSess = db.prepare('DELETE FROM sessions WHERE id=?');
      const delMsgs = db.prepare('DELETE FROM messages WHERE session_id=?');
      const delFts = db.prepare('DELETE FROM messages_fts WHERE session_id=?');
      for (const id of sessionIds) {
        delSess.run(id);
        delMsgs.run(id);
        delFts.run(id);
      }
      db.exec('COMMIT');
      this.log(`Purged ${sessionIds.length} stale/deleted sessions from index.`);
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch {}
      this.log(`Purge dead sessions error: ${e?.message || e}`);
    }
  }

  async runStartupGc() {
    const db = await this.open();
    if (!existsSync(this.sessionsBaseDir)) return;
    try {
      const dbIds = db.prepare('SELECT id FROM sessions').all().map((r) => r.id);
      if (!dbIds.length) return;

      const diskIds = new Set();
      const workspaces = readdirSync(this.sessionsBaseDir);
      for (const ws of workspaces) {
        const wsDir = join(this.sessionsBaseDir, ws);
        if (statSync(wsDir).isDirectory()) {
          for (const s of readdirSync(wsDir)) diskIds.add(s);
        }
      }

      const orphans = dbIds.filter((id) => !diskIds.has(id));
      if (orphans.length > 0) {
        this.log(`Startup GC: found ${orphans.length} orphan sessions, purging...`);
        await this.purgeDeadSessions(orphans);
      }
    } catch (e) {
      this.log(`Startup GC failed: ${e?.message || e}`);
    }
  }

  async syncRecent(sq, signal) {
    if (!existsSync(this.sessionsBaseDir)) return 0;
    const db = await this.open();
    let maxFoundMtime = this.lastCheckpointMtime;
    const dirtySessions = [];

    try {
      const workspaces = readdirSync(this.sessionsBaseDir);
      for (const ws of workspaces) {
        const wsDir = join(this.sessionsBaseDir, ws);
        if (!statSync(wsDir).isDirectory()) continue;
        const sessions = readdirSync(wsDir);
        for (const s of sessions) {
          const sDir = join(wsDir, s);
          try {
            const st = statSync(sDir);
            if (st.mtimeMs > this.lastCheckpointMtime) {
              dirtySessions.push({ id: s, dir: sDir, mtime: Math.floor(st.mtimeMs) });
              if (st.mtimeMs > maxFoundMtime) maxFoundMtime = st.mtimeMs;
            }
          } catch {}
        }
      }
    } catch (e) {
      this.log(`Scan dirty sessions error: ${e?.message || e}`);
    }

    if (!dirtySessions.length) return 0;

    let indexedCount = 0;
    for (const item of dirtySessions) {
      if (signal?.aborted) break;
      try {
        let snap = null;
        if (sq) {
          try { snap = await sq.readSession(item.id); } catch {}
        }

        if (snap?.events) {
          let title;
          try { title = (await sq.readTitle(item.id, signal))?.title; } catch {}
          indexedCount += await this.ingestSession(item.id, snap.session, snap.events, title, item.mtime);
        } else {
          const logFile = join(item.dir, 'session.v4.jsonl.zstd');
          if (existsSync(logFile)) {
            const jsonlText = decompressZstdLog(readFileSync(logFile));
            const lines = jsonlText.split('\n').filter(Boolean);
            let header = null;
            let title = '';
            const events = [];
            for (const line of lines) {
              try {
                const ev = JSON.parse(line);
                if (ev.type === 'session') header = ev;
                else if (ev.type === 'session/title') title = ev.data?.title || title;
                else events.push(ev);
              } catch {}
            }
            if (header && events.length) {
              indexedCount += await this.ingestSession(item.id, header, events, title, item.mtime);
            }
          }
        }
      } catch (e) {}
    }

    this.lastCheckpointMtime = maxFoundMtime;
    db.prepare("INSERT INTO sync_meta(key, val) VALUES('last_mtime', ?) ON CONFLICT(key) DO UPDATE SET val=excluded.val").run(String(Math.floor(maxFoundMtime)));
    return indexedCount;
  }

  async search(query, { limit = 20, excludeSessionId, after, before, sort } = {}) {
    const db = await this.open();
    const rawTerms = query.trim().split(/\s+/).filter(Boolean);
    if (!rawTerms.length) return [];

    const ftsAnd = buildFtsQuery(query, false);
    const ftsOr = buildFtsQuery(query, true);

    const runQuery = (matchClause) => {
      let sql = `
        SELECT m.session_id, m.seq, m.role, m.raw_text, m.time,
               s.title, s.cwd, s.created,
               bm25(messages_fts) AS rank
        FROM messages_fts m
        JOIN sessions s ON s.id = m.session_id
        WHERE messages_fts MATCH ?
      `;
      const params = [matchClause];

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

      sql += ' ORDER BY rank ASC, m.time DESC LIMIT 150';
      return db.prepare(sql).all(...params);
    };

    let rows = [];
    let isRelaxed = false;
    try {
      rows = runQuery(ftsAnd);
      if (!rows.length && rawTerms.length >= 2) {
        rows = runQuery(ftsOr);
        if (rows.length) isRelaxed = true;
      }
    } catch (e) {
      this.log(`FTS query failed: ${e?.message || e}`);
      return [];
    }

    const bySession = new Map();
    for (const r of rows) {
      const cur = bySession.get(r.session_id);
      if (!cur) {
        bySession.set(r.session_id, { ...r, hits: 1, source: 'dsh' });
      } else {
        cur.hits++;
        if (r.rank < cur.rank) {
          cur.seq = r.seq;
          cur.role = r.role;
          cur.raw_text = r.raw_text;
          cur.time = r.time;
          cur.rank = r.rank;
        }
      }
    }

    let candidates = [...bySession.values()];
    if (sort === 'newest') candidates.sort((a, b) => b.time - a.time);
    else if (sort === 'oldest') candidates.sort((a, b) => a.time - b.time);

    const validHits = [];
    const deadIds = [];

    for (const cand of candidates) {
      if (validHits.length >= limit) break;
      if (this.checkSessionExists(cand.session_id)) {
        validHits.push({
          ...cand,
          text: cand.raw_text,
          snippet: extractSnippet(cand.raw_text, query, 140),
        });
      } else {
        deadIds.push(cand.session_id);
      }
    }

    if (deadIds.length > 0) {
      setTimeout(() => this.purgeDeadSessions(deadIds), 10);
    }

    validHits.isRelaxedHit = isRelaxed;
    return validHits;
  }

  async messagesOf(id) {
    const db = await this.open();
    return db.prepare('SELECT seq, time, role, text FROM messages WHERE session_id=? ORDER BY seq').all(id);
  }

  async sessionMeta(id) {
    const db = await this.open();
    return db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
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

export function apply(ctx, rawConfig = {}) {
  const home = rawConfig.home || join(homedir(), '.dsh-fast-search');
  const dbPath = join(home, 'search.sqlite');
  mkdirSync(home, { recursive: true });

  const log = (msg) => {
    try {
      const line = `[${new Date().toISOString()}] [@max/dsh-fast-search] ${msg}\n`;
      process.stderr.write(line);
    } catch {}
  };

  const index = new FastSessionIndex(dbPath, log);

  // Startup GC & initial sync
  setTimeout(async () => {
    try {
      await index.runStartupGc();
      await index.syncRecent(ctx.get('sessionQuery'));
    } catch (e) {
      log(`Startup sync error: ${e?.message || e}`);
    }
  }, 300).unref?.();

  // Attach to sessionQuery for native Web GUI sidebar & menu search
  const attachToSessionQuery = (service) => {
    if (!service) return;
    service.searchSessions = async (request, execContext) => {
      const query = request?.query || '';
      if (!query.trim()) return { items: [] };

      try {
        await index.syncRecent(service, execContext?.signal);
      } catch {}

      const limit = request?.limit ?? 20;
      const hits = await index.search(query, { limit });

      return {
        items: hits.map((h) => ({
          header: {
            id: h.session_id,
            title: h.title,
            cwd: h.cwd,
          },
          bestMatch: {
            sessionId: h.session_id,
            surface: 'current',
            type: h.role === 'user' ? 'user/message' : 'assistant/message',
            snippet: h.snippet || clip(h.text, 240),
          },
        })),
        nextCursor: undefined,
      };
    };
    log('Fast search successfully hooked into ctx.sessionQuery.searchSessions');
  };

  try {
    ctx.inject(['sessionQuery'], (sqCtx) => {
      attachToSessionQuery(sqCtx.sessionQuery);
    });
  } catch {}
  attachToSessionQuery(ctx.get('sessionQuery'));
  ctx.on?.('loader/ready', () => attachToSessionQuery(ctx.get('sessionQuery')));
}
