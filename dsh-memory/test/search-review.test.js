import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionIndex, extractMessages, registerSessionSearch, cleanJson } from '../lib/session-search.js';
import { ReviewController, REVIEW_MAX_ITERATIONS } from '../lib/review.js';

const ev = (seq, type, data) => ({ seq, type, time: 1_800_000_000_000 + seq * 1000, data });
const user = (seq, text) => ev(seq, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } });
const asst = (seq, text) => ev(seq, 'assistant/message', { message: { content: [{ type: 'text', text }] } });

test('extractMessages keeps only real user prompts and assistant text', () => {
  const events = [
    user(1, '分析 hermes 记忆和自进化机制'),
    ev(2, 'user/message', { content: [{ type: 'text', text: 'runtime ctx' }], source: { kind: 'runtime-context' } }),
    asst(3, '好的，先看社区文章。'),
    ev(4, 'assistant/message', { message: { content: [{ type: 'tool-call', name: 'bash' }] } }),
  ];
  assert.deepEqual(extractMessages(events).map((m) => m.seq), [1, 3]);
});

test('trigram index finds Chinese terms that unicode61 misses; short terms fall back to LIKE', async () => {
  const idx = new SessionIndex(':memory:');
  await idx.ingest('s1', { createdAt: 1, cwd: '/w' }, [user(1, '分析 hermes 记忆和自进化机制'), asst(2, '压缩前抢救有必要实现吗？')], 'Hermes 研究');
  await idx.ingest('s2', { createdAt: 2, cwd: '/w' }, [user(1, 'deploy the web app to vercel')], 'Deploy');
  await idx.ingest('sub', { createdAt: 3, cwd: '/w', origin: 'subagent' }, [user(1, '自进化 子任务')], 'child');
  assert.deepEqual((await idx.search('自进化')).map((r) => r.session_id), ['s1']);
  assert.deepEqual((await idx.search('抢救')).map((r) => r.session_id), ['s1']); // 2 chars → LIKE
  assert.deepEqual((await idx.search('vercel')).map((r) => r.session_id), ['s2']);
  assert.deepEqual((await idx.search('hermes 记忆')).map((r) => r.session_id), ['s1']);
  assert.equal((await idx.search('不存在的词')).length, 0);
  // incremental: re-ingesting the same events adds nothing
  assert.equal(await idx.ingest('s1', { createdAt: 1 }, [user(1, '分析 hermes 记忆和自进化机制')]), 0);
  const recent = await idx.recent(10);
  assert.deepEqual(recent.map((r) => r.id).sort(), ['s1', 's2']);

  // OR-relaxation: multi-token query where not all words appear together
  // 'hermes' exists in s1, 'vercel' exists in s2. Exact AND fails; OR-relaxed returns both!
  const relaxedHits = await idx.search('hermes vercel');
  assert.equal(relaxedHits.isRelaxedHit, true);
  assert.equal(relaxedHits.length, 2);
  assert.deepEqual(relaxedHits.map((r) => r.session_id).sort(), ['s1', 's2']);
});

function fakeAgent(id, events = [], origin) {
  return { id, session: { header: { id, origin }, snapshotEvents: () => events } };
}

test('review counters: memory every N user turns, skills every N tool iterations; tool use resets', async () => {
  const spawned = [];
  const rc = new ReviewController({ ctx: {}, log: () => {}, memoryNudgeInterval: 3, skillNudgeInterval: 2 });
  rc.spawn = async (agent, opts) => { spawned.push(opts); };
  const a = fakeAgent('p1');
  const names = new Set(['memory', 'skill_manage']);
  const turn = (tools = 0) => {
    rc.onSessionEvent(a.session, user(0, 'hi'), a, names);
    for (let i = 0; i < tools; i++) {
      rc.onSessionEvent(a.session, ev(0, 'tool/call', { name: 'bash' }), a, names);
      rc.onSessionEvent(a.session, ev(0, 'step/end', {}), a, names);
    }
  };
  turn(); await rc.onTurnStopping(a);
  turn(); await rc.onTurnStopping(a);
  assert.equal(spawned.length, 0);
  turn(2); await rc.onTurnStopping(a);
  assert.deepEqual(spawned.pop(), { reviewMemory: true, reviewSkills: true });
  // memory tool call resets the memory counter
  turn(); rc.onSessionEvent(a.session, ev(0, 'tool/call', { name: 'memory' }), a, names); await rc.onTurnStopping(a);
  turn(); await rc.onTurnStopping(a);
  assert.equal(spawned.length, 0);
  // subagent sessions never trigger
  const child = fakeAgent('c1', [], 'subagent');
  for (let i = 0; i < 5; i++) rc.onSessionEvent(child.session, user(0, 'x'), child, names);
  await rc.onTurnStopping(child);
  assert.equal(spawned.length, 0);
});

test('counters hydrate from persisted history (prior_user_turns % interval)', () => {
  const rc = new ReviewController({ ctx: {}, log: () => {}, memoryNudgeInterval: 10 });
  const events = Array.from({ length: 23 }, (_, i) => user(i, 'q'));
  const a = fakeAgent('p2', events);
  assert.equal(rc.counters(a.session).turnsSinceMemory, 3);
});

test('review child gate: whitelist, deny text, step cap, read tracking', () => {
  const rc = new ReviewController({ ctx: {}, log: () => {} });
  const child = fakeAgent('kid');
  rc.children.set('kid', { allowed: new Set(['skill', 'read', 'glob', 'grep', 'skill_manage']), steps: 0, reads: new Set(), writes: [] });
  assert.equal(rc.gate({ name: 'skill_manage', agent: child }), null);
  const deny = rc.gate({ name: 'bash', agent: child });
  assert.equal(deny.kind, 'deny');
  assert.doesNotMatch(deny.reason, /memory for notes/);
  assert.equal(rc.gate({ name: 'memory', agent: child }).kind, 'deny');
  assert.equal(rc.gate({ name: 'bash', agent: fakeAgent('parent') }), null);
  for (let i = 0; i < REVIEW_MAX_ITERATIONS; i++) assert.equal(rc.stepAllowed(child), true);
  assert.equal(rc.stepAllowed(child), false);
  rc.observeResult({ name: 'skill', agent: child, arguments: { name: 'demo' } }, { isError: false });
  assert.ok(rc.childRecord(child).reads.has('skill:demo'));
});

test('review-fork captures in-flight turn with synthetic turn/end and aligns prompt & tools', async () => {
  let registeredProvider = null;
  const mockSubagents = {
    registerProvider: (p) => { registeredProvider = p; return () => {}; },
    getProvider: (name) => (registeredProvider?.name === name ? registeredProvider : null),
  };
  const sharedToolA = { definition: { name: 'tool_a' } };
  const parentInterrupt = { definition: { name: 'interrupt_agent', description: 'Team Lead only.' } };
  const childInterrupt = { definition: { name: 'interrupt_agent', description: 'Subagent control.' } };
  const whenFn = () => true;
  const condTool = { definition: { name: 'web_search' }, when: whenFn };
  const mockTools = {
    view: (agent) => ({
      registrations: agent.id === 'parent'
        ? new Map([
            ['tool_a', sharedToolA],
            ['interrupt_agent', parentInterrupt],
            ['team_tool', { definition: { name: 'team_tool' } }],
            ['web_search', condTool],
          ])
        : new Map([
            ['tool_a', sharedToolA],
            ['interrupt_agent', childInterrupt],
            ['extra_preset_tool', { definition: { name: 'extra_preset_tool' } }],
          ]),
      restrictableNames: new Set(['tool_a', 'interrupt_agent', 'extra_preset_tool']),
    }),
  };

  const rc = new ReviewController({ ctx: { subagents: mockSubagents, tools: mockTools }, log: () => {} });
  assert.ok(registeredProvider, 'memory-review-fork provider should be registered');

  // 1. In-flight turn without turn/end should be sealed with synthetic turn/end
  const inFlightEvents = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    user(1, 'help me fix mcp'),
    asst(2, 'sure'),
    { seq: 3, type: 'step/end', data: { turn: 1, step: 1 } },
  ];
  const parent = {
    id: 'parent',
    session: {
      header: { id: 'parent' },
      snapshotEvents: () => [
        { seq: 0, type: 'system/message', data: { message: { content: [{ type: 'text', text: 'You are an AI assistant.' }] } } },
        ...inFlightEvents,
      ],
    },
  };

  const prep = await registeredProvider.prepareContinuable({ parent, sessionId: 'child_1' });
  assert.ok(prep.seed, 'seed should be returned');
  const lastSeedEvent = prep.seed[prep.seed.length - 1];
  assert.equal(lastSeedEvent.type, 'turn/end', 'last seed event must be synthetic turn/end');
  assert.equal(lastSeedEvent.data.turn, 1, 'turn number must match in-flight turn');
  assert.equal(lastSeedEvent.seq, 5, 'seq must be contiguous');

  // 2. onAgentCreated inherits parent system prompt and aligns missing + shadowed tools
  let completeSection = null;
  let suppressed = false;
  const childToolsRegistered = [];
  const childRestrictions = [];
  const childAgent = {
    id: 'child_1',
    ctx: {
      systemPrompt: {
        section: (s) => { completeSection = s; },
        suppressRuntimeContext: () => { suppressed = true; },
      },
      tools: {
        register: (def, opts) => { childToolsRegistered.push({ name: def.name, desc: def.description, when: opts?.when }); },
        restrict: (filter) => { childRestrictions.push(filter); },
      },
    },
  };

  rc.onAgentCreated(childAgent);
  assert.ok(completeSection, 'complete prompt section must be registered');
  assert.equal(completeSection.complete, true);
  assert.equal(completeSection.text, 'You are an AI assistant.');
  assert.equal(suppressed, true, 'runtime context should be suppressed');
  assert.deepEqual(childToolsRegistered, [
    { name: 'interrupt_agent', desc: 'Team Lead only.', when: undefined },
    { name: 'team_tool', desc: undefined, when: undefined },
    { name: 'web_search', desc: undefined, when: whenFn },
  ], 'shadowed and missing parent tools should be registered on child with exact options');
  assert.deepEqual(childRestrictions, [{ deny: ['extra_preset_tool'] }]);
});

test('review-fork real DSH ToolsService + SystemPrompt achieves byte-identical tool schemas for Team Lead parent', async () => {
  const { Context } = await import('/opt/dsh/app/node_modules/@deepseek-ai/cordis/lib/index.js');
  const { createScope } = await import('/opt/dsh/app/node_modules/@deepseek-ai/dsh-scope/lib/index.js');
  const { SystemPrompt } = await import('/opt/dsh/app/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js');
  const { ToolsService, defineTool } = await import('/opt/dsh/app/node_modules/@deepseek-ai/dsh-tools/lib/index.js');
  const { NativeToolExecutor } = await import('/opt/dsh/app/node_modules/@deepseek-ai/dsh-tool-executor-native/lib/index.js');

  const root = new Context();
  root.plugin(SystemPrompt, {});
  root.plugin(ToolsService, {});
  await new Promise((r) => setTimeout(r, 20));
  const tools = root.get('tools');
  const systemPrompt = root.get('systemPrompt');
  tools.setExecutor(new NativeToolExecutor(root));

  const makeTool = (name, description, paramName) => defineTool({
    name,
    description,
    parameters: { [paramName]: { type: 'string', required: true, description: 'param' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, render: () => [{ type: 'text', text: 'ok' }] },
    execute: async () => ({ ok: true }),
  });

  const attachServices = (c) => {
    Object.defineProperty(c, 'tools', { get: () => c.get('tools') });
    Object.defineProperty(c, 'systemPrompt', { get: () => c.get('systemPrompt') });
    return c;
  };

  // Simulate preset-standard mounting tool-subagent-control
  const presetKey = { preset: 'standard' };
  const presetCtx = attachServices(createScope(root, presetKey).ctx);
  presetCtx.tools.register(makeTool('read', 'Read file', 'path'));
  presetCtx.tools.register(makeTool('interrupt_agent', 'Ask a subagent to stop', 'agent_id'));
  presetCtx.tools.register(makeTool('list_agents', 'List subagents you started', 'scope'));
  presetCtx.tools.register(makeTool('send_message', 'Send a message to an agent', 'agent_id'));

  // Parent Team Lead shadows the 3 control tools and adds Team tools
  const parent = {
    id: 'parent',
    session: {
      header: { id: 'parent' },
      snapshotEvents: () => [{ seq: 0, type: 'system/message', data: { message: { content: [{ type: 'text', text: 'SYS_PROMPT' }] } } }],
    },
  };
  parent.ctx = attachServices(createScope(root, parent, { parent: presetKey }).ctx);
  parent.ctx.tools.register(makeTool('interrupt_agent', 'Interrupt one teammate. Team Lead only.', 'target'));
  parent.ctx.tools.register(makeTool('list_agents', 'List the Lead and every durable teammate.', 'unused'));
  parent.ctx.tools.register(makeTool('send_message', 'Send one message to another Team member.', 'target'));
  parent.ctx.tools.register(makeTool('spawn_teammate', 'Create one teammate.', 'name'));

  // Child inherits preset-standard without Team membership
  const child = {
    id: 'child',
    session: { header: { id: 'child' }, snapshotEvents: () => [] },
  };
  child.ctx = attachServices(createScope(root, child, { parent: presetKey }).ctx);

  const rc = new ReviewController({ ctx: { tools, subagents: { registerProvider: () => () => {} } }, log: () => {} });
  rc.pendingChildren.set('child', parent);
  rc.onAgentCreated(child);

  const pAsm = await systemPrompt.assemble({ scope: parent });
  const cAsm = await systemPrompt.assemble({ scope: child });
  assert.equal(JSON.stringify(cAsm.tools), JSON.stringify(pAsm.tools));
  assert.equal(cAsm.sections.length, 1);
  assert.equal(cAsm.sections[0].text, 'SYS_PROMPT');
});

test('session_search produces lossless JSON for all shapes (zero undefined properties)', async () => {
  const { snapshotJsonValue } = await import('/opt/dsh/app/node_modules/@deepseek-ai/dsh-util-values/lib/index.js');

  let registeredTool = null;
  const mockCtx = {
    tools: {
      register: (t) => { registeredTool = t; return () => {}; },
    },
  };

  const idx = await registerSessionSearch(mockCtx, { indexPath: ':memory:' });
  await idx.ingest('sess_test_1', { createdAt: 1000, cwd: '/app' }, [
    user(1, '第一条测试提问'),
    asst(2, '第一条回答'),
    user(3, '第二条提问'),
    asst(4, '第二条回答'),
  ], '测试会话 1');

  assert.ok(registeredTool, 'session_search tool must be registered');

  // Test Shape 1: SCROLL (this was the crashing case with anchor: undefined)
  const scrollRes = await registeredTool.execute({
    session_id: 'sess_test_1',
    around_message_id: '2',
    window: 2,
  });
  assert.equal(scrollRes.success, true);
  assert.equal(scrollRes.shape, 'scroll');
  assert.equal(scrollRes.messages.length, 4);
  assert.equal(scrollRes.messages.find((m) => m.id === 2)?.anchor, true);
  assert.equal(scrollRes.messages.find((m) => m.id === 1)?.anchor, undefined);
  // Must pass DSH lossless JSON check without throwing or returning undefined
  const scrollSnap = snapshotJsonValue(scrollRes);
  assert.ok(scrollSnap !== undefined, 'scroll result must be losslessly JSON-serializable');

  // Test Shape 2: READ
  const readRes = await registeredTool.execute({ session_id: 'sess_test_1' });
  assert.equal(readRes.success, true);
  assert.equal(readRes.shape, 'read');
  const readSnap = snapshotJsonValue(readRes);
  assert.ok(readSnap !== undefined, 'read result must be losslessly JSON-serializable');

  // Test Shape 3: BROWSE
  const browseRes = await registeredTool.execute({});
  assert.equal(browseRes.success, true);
  assert.equal(browseRes.shape, 'browse');
  const browseSnap = snapshotJsonValue(browseRes);
  assert.ok(browseSnap !== undefined, 'browse result must be losslessly JSON-serializable');

  // Test Shape 4: DISCOVERY
  const discoRes = await registeredTool.execute({ query: '测试' });
  assert.equal(discoRes.success, true);
  assert.equal(discoRes.shape, 'discovery');
  const discoSnap = snapshotJsonValue(discoRes);
  assert.ok(discoSnap !== undefined, 'discovery result must be losslessly JSON-serializable');
});

test('SessionIndex auto-migrates legacy 2.0.0-bigram FTS5 schema without losing messages', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-search-mig-'));
  const dbPath = join(dir, 'sessions.sqlite');
  try {
    // Seed a legacy 2.0.0-bigram database matching the broken production layout
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE sync_meta(key TEXT PRIMARY KEY, val TEXT);
      INSERT INTO sync_meta VALUES ('schema_version', '2.0.0-bigram');
      CREATE TABLE sessions(id TEXT PRIMARY KEY, cwd TEXT, created INTEGER, mtime INTEGER, title TEXT, indexed_through INTEGER, origin TEXT);
      CREATE TABLE messages(rowid INTEGER PRIMARY KEY, session_id TEXT, seq INTEGER, time INTEGER, role TEXT, text TEXT, UNIQUE(session_id, seq));
      CREATE VIRTUAL TABLE messages_fts USING fts5(session_id UNINDEXED, seq UNINDEXED, time UNINDEXED, role UNINDEXED, raw_text UNINDEXED, search_text, tokenize='unicode61');
    `);
    legacy.prepare("INSERT INTO sessions(id, cwd, created, mtime, title, indexed_through, origin) VALUES ('s-old', '/app', 1000, 1000, '旧会话', 2, NULL)").run();
    legacy.prepare("INSERT INTO messages(session_id, seq, time, role, text) VALUES ('s-old', 1, 1000, 'user', '历史迁移关键词测试')").run();
    legacy.exec(`CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text); END;`);
    legacy.close();

    const idx = new SessionIndex(dbPath);
    const added = await idx.ingest('s-new', { createdAt: 2000, cwd: '/app' }, [
      user(1, '新会话插入验证'),
      asst(2, '完成写入'),
    ], '新会话');
    assert.equal(added, 2);

    const oldHits = await idx.search('迁移关键词');
    assert.equal(oldHits.length, 1);
    assert.equal(oldHits[0].session_id, 's-old');

    const newHits = await idx.search('新会话插入');
    assert.equal(newHits.length, 1);
    assert.equal(newHits[0].session_id, 's-new');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session_search skips full-corpus refresh on scroll/read and skips unchanged revisions', async () => {
  let listCalls = 0;
  let observeCalls = 0;
  let revA = 'rev-a-1';
  const sessionsData = {
    'sess-a': {
      header: { id: 'sess-a', createdAt: 1000, cwd: '/app' },
      events: [user(1, '第一条消息alpha'), asst(2, '回复alpha')],
    },
    'sess-b': {
      header: { id: 'sess-b', createdAt: 2000, cwd: '/app' },
      events: [user(1, '第二条消息beta'), asst(2, '回复beta')],
    },
  };

  let registeredTool = null;
  const mockCtx = {
    tools: { register: (t) => { registeredTool = t; return () => {}; } },
    get: (name) => {
      if (name === 'sessionPersistence') {
        return {
          list: async () => [
            { header: sessionsData['sess-a'].header, revision: revA },
            { header: sessionsData['sess-b'].header, revision: 'rev-b-1' },
          ],
          stat: async (id) => ({
            header: sessionsData[id].header,
            revision: id === 'sess-a' ? revA : 'rev-b-1',
          }),
        };
      }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => {
            listCalls++;
            return [
              { header: sessionsData['sess-b'].header, live: false, persisted: true },
              { header: sessionsData['sess-a'].header, live: false, persisted: true },
            ];
          },
          observeSession: async (id) => {
            observeCalls++;
            const s = sessionsData[id];
            return {
              source: 'prepared',
              header: s.header,
              events: s.events,
              cursor: s.events.at(-1).seq,
              revision: id === 'sess-a' ? revA : 'rev-b-1',
              [Symbol.dispose]: () => {},
            };
          },
        };
      }
      return null;
    },
  };

  registerSessionSearch(mockCtx, { indexPath: ':memory:' });
  assert.ok(registeredTool);

  // 1. Discovery runs initial full refresh (2 observes)
  const d1 = await registeredTool.execute({ query: 'alpha' });
  assert.equal(d1.results.length, 1);
  assert.equal(listCalls, 1);
  assert.equal(observeCalls, 2);

  // 2. Second discovery skips both unchanged revisions (0 observes!)
  const d2 = await registeredTool.execute({ query: 'beta' });
  assert.equal(d2.results.length, 1);
  assert.equal(listCalls, 2);
  assert.equal(observeCalls, 2);

  // 3. Scroll does NOT call listSessions() and skips unchanged stat revision (0 observes!)
  const sc = await registeredTool.execute({ session_id: 'sess-a', around_message_id: '1', window: 2 });
  assert.equal(sc.success, true);
  assert.equal(listCalls, 2);
  assert.equal(observeCalls, 2);

  // 4. When sess-a changes on disk, scroll refreshes ONLY sess-a (1 observe, still 0 listCalls)
  revA = 'rev-a-2';
  sessionsData['sess-a'].events.push(user(3, '新增第三条gamma'));
  const sc2 = await registeredTool.execute({ session_id: 'sess-a', around_message_id: '3', window: 2 });
  assert.equal(sc2.success, true);
  assert.ok(sc2.messages.some((m) => m.id === 3 && m.anchor === true));
  assert.equal(listCalls, 2);
  assert.equal(observeCalls, 3);
});
