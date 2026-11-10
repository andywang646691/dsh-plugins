// Port of Hermes tools/memory_tool_store.py (commit 8d7061f): bounded MEMORY.md / USER.md,
// '\n§\n' delimited, lock + reload-under-lock + atomic write, atomic batches checked only on
// the final result, and a frozen per-session system-prompt snapshot.
import { mkdirSync, openSync, closeSync, unlinkSync, readFileSync, writeFileSync, renameSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { firstThreatMessage } from './threats.js';

export const ENTRY_DELIMITER = '\n§\n';
export const MEMORY_BLOCK_HEADERS = {
  memory: 'MEMORY (your personal notes)',
  user: 'USER PROFILE (who the user is)',
};
const PATCH_DROP_HINT = "To drop text inside an entry, patch a longer span that contains it; 'remove' deletes the whole entry.";
const MAX_FAILURES_PER_TURN = 3;

const fmt = (n) => n.toLocaleString('en-US');
const err = (message, failureClass, extra = {}) => ({ success: false, error: message, failure_class: failureClass, ...extra });

function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function withFileLock(path, fn) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 10_000;
  let fd;
  for (;;) {
    try { fd = openSync(lock, 'wx'); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > 30_000) { unlinkSync(lock); continue; } } catch {}
      if (Date.now() > deadline) throw new Error(`memory lock timeout: ${lock}`);
      sleepSync(20);
    }
  }
  try { return fn(); } finally { closeSync(fd); try { unlinkSync(lock); } catch {} }
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

export function parseEntries(raw) {
  if (!raw || !raw.trim()) return [];
  const seen = new Set();
  const out = [];
  for (const part of raw.split(ENTRY_DELIMITER)) {
    const e = part.trim();
    if (e && !seen.has(e)) { seen.add(e); out.push(e); }
  }
  return out;
}

const normalizeForMatch = (s) => s
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-')
  .replace(/\s+/g, ' ').trim().toLowerCase();

function substringMatches(entries, oldText) {
  const exact = entries.flatMap((e, i) => (e.includes(oldText) ? [i] : []));
  if (exact.length) return exact;
  const needle = normalizeForMatch(oldText);
  if (!/[\p{L}\p{N}]/u.test(needle)) return [];
  return entries.flatMap((e, i) => (normalizeForMatch(e).includes(needle) ? [i] : []));
}

function findUniqueMatch(entries, oldText) {
  const exact = entries.flatMap((e, i) => (e === oldText ? [i] : []));
  const matches = exact.length ? exact : substringMatches(entries, oldText);
  if (new Set(matches.map((i) => entries[i])).size > 1) return { idx: null, ambiguous: true, matches };
  return { idx: matches.length ? matches[0] : null, ambiguous: false, matches };
}

function noMatchError(entries, oldText, verb) {
  const words = (t) => new Set((t.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []));
  const w = words(oldText);
  const scored = w.size ? entries.map((e, i) => {
    const ew = words(e); let n = 0; for (const x of w) if (ew.has(x)) n++;
    return [n / w.size, i];
  }).sort((a, b) => b[0] - a[0] || a[1] - b[1]) : [];
  const closest = scored.slice(0, 3).filter(([s]) => s >= 0.3).map(([, i]) => entries[i]);
  const hint = oldText.includes('§') ? " old_text must come from ONE entry ('§' separates entries); use one op per entry." : '';
  return err(`No entry matched '${oldText}'.${hint} Retry the ${verb} with old_text copied verbatim from the intended entry${closest.length ? ' (closest_entries below).' : '.'}`,
    'no_match', closest.length ? { closest_entries: closest } : {});
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function patchEntry(entry, oldText, newText) {
  let span = oldText;
  let count = countOccurrences(entry, span);
  if (count === 0) {
    // Typography-folded fallback: locate the span case/space-insensitively.
    const re = new RegExp(oldText.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'i');
    const m = entry.match(re);
    if (m) { span = m[0]; count = countOccurrences(entry, span); }
  }
  if (count > 1) return { error: `'${oldText}' appears ${count} times in the matched entry, and patch edits one span. Include more surrounding text so old_text occurs once.`, cls: 'ambiguous' };
  if (count === 0) return { error: `'${oldText}' not found in the matched entry.`, cls: 'no_match' };
  const patched = entry.replace(span, newText);
  if (patched === entry) return { error: `Patch is a no-op: '${oldText}' -> '${newText}' leaves the entry unchanged.`, cls: 'invalid_args' };
  const scan = firstThreatMessage(patched, 'strict');
  if (scan) return { error: scan, cls: 'scan_blocked' };
  return { patched };
}

export class MemoryStore {
  constructor({ dir, memoryCharLimit = 2200, userCharLimit = 1375 }) {
    this.dir = dir;
    this.limits = { memory: memoryCharLimit, user: userCharLimit };
    this.failures = 0;
  }

  pathFor(target) { return join(this.dir, target === 'user' ? 'USER.md' : 'MEMORY.md'); }
  limitFor(target) { return this.limits[target]; }

  read(target) {
    const p = this.pathFor(target);
    if (!existsSync(p)) return [];
    return parseEntries(readFileSync(p, 'utf8'));
  }

  usage(target, entries) {
    const cur = entries.join(ENTRY_DELIMITER).length;
    const lim = this.limitFor(target);
    const pct = lim > 0 ? Math.min(100, Math.floor((cur / lim) * 100)) : 0;
    return { cur, lim, pct, text: `${pct}% — ${fmt(cur)}/${fmt(lim)} chars` };
  }

  resetTurnFailures() { this.failures = 0; }

  consolidationFailure(resp) {
    this.failures += 1;
    if (this.failures >= MAX_FAILURES_PER_TURN) {
      return { ...resp, error: `${resp.error} Stop retrying memory calls this turn: ${this.failures} memory writes failed. Continue the user's task; memory can be updated in a later turn.`, terminal: true };
    }
    return resp;
  }

  success(target, entries, message, extra = {}) {
    this.failures = 0;
    return {
      success: true, done: true, target,
      usage: this.usage(target, entries).text,
      entry_count: entries.length,
      ...(message ? { message } : {}),
      ...extra,
      note: 'Write saved. This update is complete — do not repeat it.',
    };
  }

  mutate(target, fn) {
    const path = this.pathFor(target);
    return withFileLock(path, () => {
      const entries = existsSync(path) ? parseEntries(readFileSync(path, 'utf8')) : [];
      const r = fn(entries, this.limitFor(target));
      if (!Array.isArray(r)) return r;
      const [next, message, extra] = r;
      atomicWrite(path, next.join(ENTRY_DELIMITER) + (next.length ? '\n' : ''));
      return this.success(target, next, message, extra);
    });
  }

  overBudget(target, entries, message) {
    return this.consolidationFailure(err(message, 'over_budget', { current_entries: entries, usage: this.usage(target, entries).text.replace(/^\d+% — /, '') }));
  }

  applyBatch(target, operations) {
    if (target !== 'memory' && target !== 'user') {
      return err(`Invalid target '${target}'. Use 'memory' or 'user'.`, 'invalid_args');
    }
    if (!Array.isArray(operations) || operations.length === 0) return err('operations list is empty.', 'invalid_args');
    const ops = operations.map((o) => o || {});
    for (const [i, op] of ops.entries()) {
      if (op.target !== undefined && op.target !== target) {
        return err(`Operation ${i + 1}: target '${op.target}' differs from the top-level target '${target}'. Use separate calls to update both stores.`, 'invalid_args');
      }
      if (op.action === 'replace') {
        return err(`Operation ${i + 1}: 'replace' is not available; use 'patch' (old_text is the span, content its replacement) or 'remove'.`, 'invalid_args');
      }
      if (op.action === 'add' && op.content) {
        const scan = firstThreatMessage(String(op.content), 'strict');
        if (scan) return err(`Operation ${i + 1}: ${scan}`, 'scan_blocked');
      }
    }
    return this.mutate(target, (entries, limit) => {
      const working = [...entries];
      const details = [];
      for (const [i, op] of ops.entries()) {
        const act = op.action;
        const pos = `Operation ${i + 1} (${act || 'unknown'})`;
        let content = String(op.content ?? op.new_text ?? '');
        let oldText = String(op.old_text ?? '');
        if (act !== 'patch') { content = content.trim(); oldText = oldText.trim(); }
        if (act === 'add') {
          if (!content) return this.batchFail(target, working, `${pos}: content is required.`, 'missing_content');
          if (!working.includes(content)) working.push(content);
          details.push({ action: 'add', content });
          continue;
        }
        if (act !== 'patch' && act !== 'remove') return this.batchFail(target, working, `${pos}: unknown action. Use add, patch, or remove.`, 'invalid_args');
        if (!oldText.trim()) return this.batchFail(target, working, `${pos}: old_text is required.`, 'missing_old_text');
        if (act === 'patch' && !content.trim()) return this.batchFail(target, working, `${pos}: content is required — set this operation object's own 'content' to the new text for the old_text span. ${PATCH_DROP_HINT}`, 'missing_content');
        const m = findUniqueMatch(working, act === 'patch' ? oldText : oldText);
        if (m.ambiguous) return this.batchFail(target, working, `${pos}: '${oldText}' matched multiple distinct entries -- be more specific.`, 'ambiguous');
        if (m.idx === null) {
          const miss = noMatchError(working, oldText, act);
          return this.batchFail(target, working, `${pos}: ${miss.error}`, 'no_match', miss.closest_entries);
        }
        const before = working[m.idx];
        if (act === 'remove') {
          working.splice(m.idx, 1);
          details.push({ action: 'remove', removed_entry: before });
          continue;
        }
        const p = patchEntry(before, oldText, content);
        if (p.error) return this.batchFail(target, working, `${pos}: ${p.error}`, p.cls);
        working[m.idx] = p.patched;
        details.push({ action: 'patch', before, after: p.patched });
      }
      const total = working.join(ENTRY_DELIMITER).length;
      if (total > limit) {
        const lone = ops.length === 1 && ops[0].action === 'add';
        if (lone) {
          const over = total - limit;
          const cur = entries.join(ENTRY_DELIMITER).length;
          return this.overBudget(target, entries,
            `Memory at ${fmt(cur)}/${fmt(limit)} chars; adding this entry (${String(ops[0].content).trim().length} chars) would exceed the limit by ${fmt(over)} chars. Retry as ONE 'operations' batch that removes or shortens (patch) stale entries from current_entries below to free at least ${fmt(over)} chars AND adds this entry — the limit is checked only on the batch result.`);
        }
        return this.batchFail(target, working, `Batch would put memory at ${fmt(total)}/${fmt(limit)} chars: free at least ${fmt(total - limit)} chars more in the same batch.`, 'over_budget');
      }
      const changed = working.length !== entries.length || working.some((e, i) => e !== entries[i]);
      if (!changed) return this.success(target, entries, 'Entry already exists (no duplicate added).');
      return [working, `Applied ${ops.length} operation(s).`, { operations: details }];
    });
  }

  batchFail(target, working, message, cls, closest) {
    return this.consolidationFailure(err(`${message} No operations were applied (batch is all-or-nothing).`, cls,
      { usage: this.usage(target, working).text.replace(/^\d+% — /, ''), ...(closest ? { closest_entries: closest } : {}) }));
  }

  raw(target) {
    const p = this.pathFor(target);
    if (!existsSync(p)) return '';
    return readFileSync(p, 'utf8');
  }

  view(target = 'all') {
    if (target === 'all' || !target) {
      const memEntries = this.read('memory');
      const usrEntries = this.read('user');
      const memUsage = this.usage('memory', memEntries);
      const usrUsage = this.usage('user', usrEntries);
      return {
        success: true,
        target: 'all',
        memory: {
          entries: memEntries,
          count: memEntries.length,
          chars: memUsage.cur,
          limit: memUsage.lim,
          pct: memUsage.pct,
          usage: memUsage.text,
          raw: this.raw('memory'),
        },
        user: {
          entries: usrEntries,
          count: usrEntries.length,
          chars: usrUsage.cur,
          limit: usrUsage.lim,
          pct: usrUsage.pct,
          usage: usrUsage.text,
          raw: this.raw('user'),
        },
        snapshot: this.renderSnapshot(),
      };
    }
    if (target !== 'memory' && target !== 'user') {
      return err(`Invalid target '${target}'. Use 'memory', 'user', or 'all'.`, 'invalid_args');
    }
    const entries = this.read(target);
    const u = this.usage(target, entries);
    return {
      success: true,
      target,
      entries,
      count: entries.length,
      chars: u.cur,
      limit: u.lim,
      pct: u.pct,
      usage: u.text,
      raw: this.raw(target),
      block: this.renderBlock(target),
    };
  }

  renderBlock(target) {
    const entries = this.read(target).map((e) => {
      const scan = firstThreatMessage(e, 'strict');
      return scan ? `[BLOCKED: entry withheld from the prompt — ${scan}]` : e;
    });
    if (!entries.length) return '';
    const sep = '═'.repeat(46);
    const usage = this.usage(target, this.read(target)).text;
    return `${sep}\n${MEMORY_BLOCK_HEADERS[target]} [${usage}]\n${sep}\n${entries.join(ENTRY_DELIMITER)}`;
  }

  renderSnapshot() {
    return [this.renderBlock('memory'), this.renderBlock('user')].filter(Boolean).join('\n\n');
  }
}
