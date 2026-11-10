import test from 'node:test';
import assert from 'node:assert/strict';
import { FastSessionIndex, buildFtsQuery, buildSearchDoc, extractSnippet } from '../lib/index.js';

test('FastSessionIndex in @max/dsh-fast-search handles English, Chinese, and mixed searches', async () => {
  const index = new FastSessionIndex(':memory:');
  await index.open();

  const sessions = [
    {
      id: 'sess-plugin',
      title: 'DSH 插件开发指南',
      events: [
        { type: 'user/message', seq: 0, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '我想写一个 dsh plugin 扩展插件。' }] } },
        { type: 'assistant/message', seq: 1, time: 2000, data: { message: { content: [{ type: 'text', text: '开发 dsh plugin 需要遵循 Cordis 服务架构并提供 cordis.patch.yml 文件。' }] } } },
      ],
    },
    {
      id: 'sess-pool',
      title: '线上故障复盘',
      events: [
        { type: 'user/message', seq: 0, time: 3000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '后端服务为什么突然报连接池泄漏错误？' }] } },
        { type: 'assistant/message', seq: 1, time: 4000, data: { message: { content: [{ type: 'text', text: '定位发现是因为高并发时连接没有及时 release，导致连接池耗尽。' }] } } },
      ],
    },
  ];

  for (const s of sessions) {
    await index.ingestSession(s.id, { cwd: '/workspace' }, s.events, s.title, 10000);
  }

  // 1. English
  const hitsEnglish = await index.search('dsh plugin');
  assert.equal(hitsEnglish.length, 1);
  assert.equal(hitsEnglish[0].session_id, 'sess-plugin');
  assert.match(hitsEnglish[0].snippet, /dsh plugin/i);

  // 2. Chinese 2-character
  const hitsCjk = await index.search('泄漏');
  assert.equal(hitsCjk.length, 1);
  assert.equal(hitsCjk[0].session_id, 'sess-pool');
  assert.match(hitsCjk[0].snippet, /泄漏/);

  // 3. Mixed
  const hitsMixed = await index.search('dsh 插件');
  assert.equal(hitsMixed.length, 1);
  assert.equal(hitsMixed[0].session_id, 'sess-plugin');

  // 4. Snippet
  const snip = extractSnippet('在开发 dsh plugin 过程中遇到了问题', 'dsh plugin', 30);
  assert.match(snip, /dsh plugin/);
});
