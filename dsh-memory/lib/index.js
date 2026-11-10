/**
 * dsh-memory — Hermes-style memory & learning loop for DeepSeek Harness.
 * Ports Hermes Agent (commit 8d7061f): bounded MEMORY.md/USER.md with a frozen per-session
 * system-prompt snapshot, the `memory` tool, "Skills come first" guidance, `skill_manage` over a
 * dedicated skills root, nudge-triggered background review, and the skill curator.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, relative, sep } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { MemoryStore } from './memory-store.js';
import { SkillManager, SKILL_MANAGE_DESCRIPTION } from './skill-manage.js';
import { SkillUsage } from './skill-usage.js';
import { Curator } from './curator.js';
import { ReviewController } from './review.js';
import { buildGuidance } from './guidance.js';
import { registerSessionSearch } from './session-search.js';

export const name = '@max/dsh-memory';
export const inject = ['systemPrompt', 'tools', 'subagents', 'agents'];

const MEMORY_DESCRIPTION =
  "Save durable facts to persistent memory that survive across sessions. Memory is injected into every " +
  "future turn, so keep entries compact and high-signal.\n\n" +
  "VIEW: call with action: 'view' (or read/list, operations omitted) to inspect current memory entries, " +
  "character usage, and formatted snapshots without modifying anything.\n\n" +
  "HOW: make ALL your changes to one target in ONE call via an 'operations' array (each item: {action, " +
  "content?, old_text?}). The batch applies atomically and the char limit is checked only on the FINAL " +
  "result — so a single call can remove/patch stale entries to free room AND add new ones, even when an add " +
  "alone would overflow. The response reports current/limit chars and confirms completion; one batch call " +
  "finishes the update, so don't repeat it.\n\n" +
  "WHEN: only for facts that apply to EVERY session regardless of task: who the user is, stable environment " +
  "facts, standing conventions with no task home. Anything learned while doing a task (procedures, pitfalls, " +
  "and the user's preferences and corrections for that kind of work) belongs in the task's skill via " +
  "skill_manage, where it loads only when relevant; memory is injected into every turn and must stay small.\n\n" +
  "IF FULL: an add is rejected with the current entries shown. Reissue as ONE batch that removes or shortens " +
  "enough stale entries and adds the new one together.\n\n" +
  "TARGETS: 'user' = who the user is (name, role, preferences, style). 'memory' = your notes (environment, " +
  "conventions, tool quirks, lessons).\n\n" +
  "SKIP: trivial/obvious info, easily re-discovered facts, raw data dumps, task progress, completed-work logs, " +
  "temporary TODO state (use session_search for those). Reusable procedures belong in a skill, not memory.";

function expandHome(p) { return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p; }

// Other plugins (e.g. dsh-mcp-hub) monkeypatch ctx.tools.register on the shared service and can
// leave a chain bound to a disposed context after an HMR reload. Register through the service
// class's own method so this plugin's tools bind to its own live context.
function registerTool(ctx, definition) {
  const proto = Object.getPrototypeOf(ctx.tools);
  const own = proto && Object.prototype.hasOwnProperty.call(ctx.tools, 'register') && typeof proto.register === 'function'
    ? proto.register : null;
  return own ? own.call(ctx.tools, definition) : ctx.tools.register(definition);
}

export function apply(ctx, rawConfig = {}) {
  const home = resolve(expandHome(rawConfig.home || process.env.AGENT_MEMORY_HOME || '~/agent-memory'));
  const cfg = {
    home,
    memoryDir: join(home, 'memories'),
    skillsDir: join(home, 'skills'),
    memoryCharLimit: rawConfig.memoryCharLimit ?? 2200,
    userCharLimit: rawConfig.userCharLimit ?? 1375,
    memoryNudgeInterval: rawConfig.memoryNudgeInterval ?? 10,
    skillNudgeInterval: rawConfig.skillNudgeInterval ?? 10,
    backgroundReview: rawConfig.backgroundReview ?? true,
    curator: rawConfig.curator ?? true,
    sessionSearch: rawConfig.sessionSearch ?? true,
    sectionOrder: rawConfig.sectionOrder ?? 9500,
    logFile: rawConfig.logFile ?? join(home, '.logs', 'dsh-memory.log'),
  };
  mkdirSync(cfg.memoryDir, { recursive: true });
  mkdirSync(cfg.skillsDir, { recursive: true });
  mkdirSync(join(home, '.logs'), { recursive: true });
  const log = (msg) => { try { appendFileSync(cfg.logFile, `${new Date().toISOString()} ${msg}\n`); } catch {} };
  log(`activated home=${home}`);

  const store = new MemoryStore({ dir: cfg.memoryDir, memoryCharLimit: cfg.memoryCharLimit, userCharLimit: cfg.userCharLimit });
  const usage = new SkillUsage(cfg.skillsDir);
  // Names of skills that live outside the dedicated root (read-only to skill_manage).
  let foreignSkills = new Set();
  const refreshForeignSkills = async (agent) => {
    const skills = ctx.get('skills');
    if (!skills) return;
    try {
      const list = await skills.list({ cwd: agent?.session?.header?.cwd, scope: agent });
      foreignSkills = new Set(list.filter((s) => !String(s.path || '').startsWith(cfg.skillsDir + sep)).map((s) => s.name));
    } catch (e) { log(`skills.list failed: ${e?.message || e}`); }
  };
  const manager = new SkillManager({ root: cfg.skillsDir, usage, existsElsewhere: (n) => foreignSkills.has(n) });

  // Expose service for other plugins (such as dsh-better-sidebar) to inspect memory & skills
  ctx.provide?.('dshMemory', {
    home: cfg.home,
    memoryDir: cfg.memoryDir,
    skillsDir: cfg.skillsDir,
    store,
    manager,
    usage,
    getMemory: (target) => store.view(target),
    getSkills: () => {
      const list = [];
      try {
        const usageData = usage.load() || {};
        if (existsSync(cfg.skillsDir)) {
          for (const name of readdirSync(cfg.skillsDir)) {
            if (name.startsWith('.')) continue;
            const dirPath = join(cfg.skillsDir, name);
            if (!statSync(dirPath).isDirectory()) continue;
            const skillFile = join(dirPath, 'SKILL.md');
            if (!existsSync(skillFile)) continue;
            const raw = readFileSync(skillFile, 'utf8');
            const mName = raw.match(/^name:\s*([^\r\n]+)/m);
            const mDesc = raw.match(/^description:\s*([^\r\n]+)/m);
            const u = usageData[name] || {};
            list.push({
              name,
              displayName: mName ? mName[1].trim() : name,
              description: mDesc ? mDesc[1].trim() : '',
              source: 'agent-memory',
              path: dirPath,
              state: u.state || 'active',
              createdBy: u.created_by || 'agent',
              useCount: u.use_count || 0,
              patchCount: u.patch_count || 0,
              lastUsedAt: u.last_used_at,
              createdAt: u.created_at,
              lastPatchedAt: u.last_patched_at,
            });
          }
        }
      } catch {}
      return list;
    },
    getSkill: (name) => {
      const dirPath = join(cfg.skillsDir, name);
      const skillFile = join(dirPath, 'SKILL.md');
      if (!existsSync(skillFile)) return null;
      const content = readFileSync(skillFile, 'utf8');
      const u = (usage.load() || {})[name] || {};
      const files = [];
      const scanDir = (sub) => {
        const fullSub = join(dirPath, sub);
        if (existsSync(fullSub) && statSync(fullSub).isDirectory()) {
          for (const f of readdirSync(fullSub)) {
            const fp = join(fullSub, f);
            const st = statSync(fp);
            if (st.isFile()) {
              files.push({ name: f, path: `${sub}/${f}`, size: st.size });
            }
          }
        }
      };
      ['references', 'templates', 'scripts', 'assets'].forEach(scanDir);
      return {
        name,
        content,
        path: dirPath,
        usage: u,
        files,
      };
    },
  });

  // ── System prompt: guidance + frozen per-session memory snapshot ──────────────────────────
  const guidance = buildGuidance({ sessionSearch: cfg.sessionSearch });
  ctx.systemPrompt.section({ name: 'dsh-memory:guidance', order: cfg.sectionOrder, text: guidance, interpolate: false });
  // Frozen per session: in memory for live sessions, and on disk keyed by session id so a resumed
  // session (restart, cold resume) replays the SAME bytes (Hermes persists the session's system
  // prompt for the same reason). Compaction is the one sanctioned refresh.
  const snapshotDir = join(home, '.snapshots');
  mkdirSync(snapshotDir, { recursive: true });
  const snapshots = new Map(); // session id -> frozen text
  const snapshotPath = (id) => join(snapshotDir, `${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.txt`);
  const frozenSnapshot = (id) => {
    if (snapshots.has(id)) return snapshots.get(id);
    let text;
    try { text = readFileSync(snapshotPath(id), 'utf8'); } catch {
      text = store.renderSnapshot();
      try { writeFileSync(snapshotPath(id), text); } catch {}
    }
    snapshots.set(id, text);
    return text;
  };
  ctx.systemPrompt.section({
    name: 'dsh-memory:snapshot',
    order: cfg.sectionOrder + 1,
    interpolate: false,
    text: (context) => (context.agent?.id ? frozenSnapshot(context.agent.id) : store.renderSnapshot()),
  });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'compaction/end' && !event.data?.error) {
      snapshots.delete(session.id);
      try { rmSync(snapshotPath(session.id), { force: true }); } catch {}
    }
  });
  ctx.on('agent/disposed', ({ agent }) => { snapshots.delete(agent.id); });
  // Prune snapshot files of sessions untouched for 30 days.
  try {
    const cutoff = Date.now() - 30 * 86_400_000;
    for (const f of readdirSync(snapshotDir)) {
      const p = join(snapshotDir, f);
      if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true });
    }
  } catch {}

  // ── Tools ────────────────────────────────────────────────────────────────────────────────
  registerTool(ctx, defineTool({
    name: 'memory',
    description: MEMORY_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        enum: ['add', 'patch', 'remove', 'view', 'read', 'list'],
        description: "Operation action. Use 'view' (or 'read') to inspect current memory entries and budget without modifying them.",
      },
      target: {
        type: 'string',
        enum: ['memory', 'user', 'all'],
        description: "Which memory store: 'memory' for personal notes, 'user' for user profile, or 'all' to view both.",
      },
      operations: {
        type: 'array',
        description: "Changes applied atomically in one call against the final char budget; a single change is a one-item list. Omit when action is 'view'.",
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', required: true, enum: ['add', 'patch', 'remove', 'view', 'read', 'list'] },
            content: { type: 'string', description: "Required for 'add' and 'patch'. For 'add', the new entry. For 'patch', the text that replaces old_text; the rest of the entry is kept." },
            old_text: { type: 'string', description: "REQUIRED for 'patch' and 'remove': text from one entry. 'patch' replaces exactly this span (it must occur once in the entry); 'remove' deletes the whole entry. Omit for 'add'." },
          },
        },
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    execute(args) {
      const isView = args.action === 'view' || args.action === 'read' || args.action === 'list'
        || (!args.operations && (args.target !== undefined || args.action === undefined))
        || (Array.isArray(args.operations) && args.operations.some((o) => o?.action === 'view' || o?.action === 'read' || o?.action === 'list'));
      if (isView) {
        const target = (args.target === 'user' || args.target === 'memory') ? args.target : 'all';
        const v = store.view(target);
        log(`memory view ${target}`);
        return Promise.resolve(v);
      }
      const r = store.applyBatch(args.target, args.operations);
      if (r.success) log(`memory ${args.target} ${JSON.stringify(args.operations).slice(0, 300)}`);
      return Promise.resolve(r);
    },
    presentCall: (args) => {
      const isView = args.action === 'view' || args.action === 'read' || args.action === 'list'
        || (!args.operations && (args.target !== undefined || args.action === undefined))
        || (Array.isArray(args.operations) && args.operations.some((o) => o?.action === 'view' || o?.action === 'read' || o?.action === 'list'));
      if (isView) {
        return {
          card: 'generic',
          title: `View ${args.target === 'user' ? 'user profile' : args.target === 'all' || !args.target ? 'memory and profile' : 'memory'}`,
          kind: 'view',
          rawInput: args,
        };
      }
      return { card: 'generic', title: `Update ${args.target === 'user' ? 'user profile' : 'memory'}`, kind: 'edit', rawInput: args };
    },
  }));

  registerTool(ctx, defineTool({
    name: 'skill_manage',
    description: SKILL_MANAGE_DESCRIPTION,
    parameters: {
      operations: {
        type: 'array', required: true,
        description: 'Ordered ops; each names its target skill (kebab-case, max 64 chars). create: name+content. patch: name+old_string+new_string (+file_path, replace_all) or name+content (full rewrite). write_file: name+file_path+file_content. remove_file: name+file_path. delete: name (sole op).',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            action: { type: 'string', required: true, enum: ['create', 'patch', 'write_file', 'remove_file', 'delete'] },
            name: { type: 'string', required: true },
            content: { type: 'string', description: 'create: full SKILL.md (YAML frontmatter with name + description, then markdown body). patch without old_string: REPLACES the whole SKILL.md (last resort).' },
            old_string: { type: 'string', description: 'patch: text to find (tolerates whitespace/indentation drift).' },
            new_string: { type: 'string', description: 'patch: replacement; empty string deletes the match.' },
            replace_all: { type: 'boolean', description: 'patch: replace all occurrences (default false).' },
            file_path: { type: 'string', description: "Path RELATIVE to the skill's own directory, e.g. 'references/api.md'; first segment references/, templates/, scripts/, or assets/. For patch, omit to target SKILL.md." },
            file_content: { type: 'string', description: 'write_file: full text of the supporting file.' },
          },
        },
      },
    },
    output: { schema: { type: 'json' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }] },
    async execute(args, exec) {
      await refreshForeignSkills(exec.agent);
      const rec = review.childRecord(exec.agent);
      const opCtx = rec
        ? {
            origin: 'background_review',
            hasRead: (skill, filePath) => filePath
              ? rec.reads.has(`file:${join(cfg.skillsDir, skill, filePath)}`)
              : rec.reads.has(`skill:${skill}`) || rec.reads.has(`file:${join(cfg.skillsDir, skill, 'SKILL.md')}`),
          }
        : { origin: 'foreground' };
      const r = manager.apply(args.operations, opCtx);
      if (r.success) log(`skill_manage ${opCtx.origin} ${r.results.map((x) => `${x.action}:${x.name}`).join(',')}`);
      return r;
    },
    presentCall: (args) => ({ card: 'generic', title: `Manage skills (${(args.operations || []).map((o) => `${o.action} ${o.name}`).join(', ')})`, kind: 'edit', rawInput: args }),
  }));

  // ── Background review ────────────────────────────────────────────────────────────────────
  // Both tools are registered globally by this plugin, so they are always in the agent's surface.
  const TOOL_NAMES = new Set(['memory', 'skill_manage']);
  const toolNamesOf = () => TOOL_NAMES;
  const review = new ReviewController({
    ctx, log,
    enabled: cfg.backgroundReview,
    memoryNudgeInterval: cfg.memoryNudgeInterval,
    skillNudgeInterval: cfg.skillNudgeInterval,
    onSummary: (agent, summary) => {
      // H: _publish_review_summary — one line to the user surface. Kept out of model history.
      log(`summary parent=${agent.id}: ${summary}`);
      try { process.stderr.write(`💾 dsh-memory background review: ${summary}\n`); } catch {}
    },
  });
  ctx.on('session/event', (session, event) => {
    if (!['user/message', 'tool/call', 'step/end'].includes(event.type)) return;
    const agent = ctx.agents.get?.(session.id);
    if (!agent) return;
    review.onSessionEvent(session, event, agent, toolNamesOf(agent));
  });
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    try { await review.onTurnStopping(agent, { interrupted: !!signal?.aborted }); } catch (e) { log(`turn-stopping error: ${e?.stack || e}`); }
  });
  ctx.on('agent/created', ({ agent }) => {
    try { review.onAgentCreated(agent); } catch (e) { log(`onAgentCreated error: ${e?.stack || e}`); }
  });
  ctx.effect?.(() => () => review.dispose?.());
  ctx.on('tools/pre-execute', async (exec, next) => review.gate(exec) ?? next());
  ctx.on('agent/pre-step', async (payload, next) => (review.stepAllowed(payload.agent) ? next() : { kind: 'reject' }));
  ctx.on('tools/result', (exec, result) => {
    review.observeResult(exec, result);
    store.resetTurnFailures?.();
    if (exec.name === 'skill' && !result?.isError) {
      const n = exec.arguments?.name;
      if (n && existsSync(join(cfg.skillsDir, n, 'SKILL.md'))) { try { usage.recordUsed(n); } catch {} }
    }
  });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') store.resetTurnFailures();
  });

  // ── Curator: hourly check, runs when interval elapsed and all agents idle ≥ minIdleHours ──
  if (cfg.curator) {
    const curator = new Curator({ root: cfg.skillsDir, usage, config: rawConfig.curatorConfig || {} });
    let lastActivity = Date.now();
    ctx.on('agent/status', ({ status }) => { if (status === 'running') lastActivity = Date.now(); });
    const tick = () => {
      try {
        const summary = curator.maybeRun({ idleForMs: Date.now() - lastActivity });
        if (summary) log(`curator ran: ${JSON.stringify(summary)}`);
      } catch (e) { log(`curator error: ${e?.message || e}`); }
    };
    const timer = setInterval(tick, 3_600_000);
    timer.unref?.();
    ctx.effect?.(() => () => clearInterval(timer));
    setTimeout(tick, 60_000).unref?.();
  }

  // ── Chinese-capable session_search (replaces DSH's experimental one) ──────────────────────
  if (cfg.sessionSearch) {
    try { registerSessionSearch(ctx, { indexPath: join(home, '.index', 'sessions.sqlite'), log, register: (d) => registerTool(ctx, d) }); }
    catch (e) { log(`session_search disabled: ${e?.message || e}`); }
  }
}
