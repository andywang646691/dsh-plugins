// Port of Hermes background review (agent/background_review.py + nudge counters in
// turn_context.py / turn_iteration_prep.py / tool_executor.py / turn_finalizer.py).
// After a turn ends, if a nudge threshold was crossed, fork a child (same model, seeded with
// the parent's completed turns → warm prompt cache), whitelist its tools at dispatch time,
// cap its steps, and summarize successful writes.
import { MEMORY_REVIEW_PROMPT, SKILL_REVIEW_PROMPT, COMBINED_REVIEW_PROMPT } from './review-prompts.js';

export const REVIEW_MAX_ITERATIONS = 16;
export const REVIEW_FORK_PROVIDER = 'memory-review-fork';

const PROMPT_BY_SCOPE = {
  'true,true': COMBINED_REVIEW_PROMPT, 'true,false': MEMORY_REVIEW_PROMPT,
  'false,true': SKILL_REVIEW_PROMPT, 'false,false': SKILL_REVIEW_PROMPT,
};
const READ_TOOLS = ['skill', 'read', 'glob', 'grep'];

function getParentSystemPrompt(parent) {
  try {
    const events = parent.session?.snapshotEvents?.() || [];
    const sysMsg = events.findLast((e) => e.type === 'system/message');
    return sysMsg?.data?.message?.content?.[0]?.text || null;
  } catch {
    return null;
  }
}

export class ReviewController {
  constructor({ ctx, log, memoryNudgeInterval = 10, skillNudgeInterval = 10, enabled = true, onSummary }) {
    this.ctx = ctx;
    this.log = log;
    this.memoryInterval = memoryNudgeInterval;
    this.skillInterval = skillNudgeInterval;
    this.enabled = enabled;
    this.onSummary = onSummary;
    this.state = new WeakMap();   // Session -> counters
    this.children = new Map();    // child session id -> review record
    this.pendingChildren = new Map(); // child session id -> parent agent
    this.running = new WeakSet(); // parent sessions with a review in flight

    // Register dedicated in-process fork provider that captures the in-flight turn into the seed
    if (this.ctx?.subagents?.registerProvider) {
      try {
        this.providerDisposer = this.ctx.subagents.registerProvider({
          name: REVIEW_FORK_PROVIDER,
          capabilities: {
            agentOptions: true,
            agentPreset: false,
            outputSchema: true,
            depthLimit: true,
          },
          inheritsParentContext: true,
          prepareContinuable: (request) => {
            const parent = request.parent;
            const events = parent?.session?.snapshotEvents?.() || [];
            const lastEvent = events[events.length - 1];
            let seed;
            if (lastEvent && lastEvent.type !== 'turn/end') {
              const lastStart = events.findLast((e) => e.type === 'turn/start');
              const turnNum = lastStart?.data?.turn ?? 1;
              const syntheticEnd = {
                seq: events.length,
                type: 'turn/end',
                time: Date.now(),
                data: { turn: turnNum, reason: { kind: 'completed' } },
              };
              seed = [...events, syntheticEnd];
            } else {
              const lastEnd = events.findLast((e) => e.type === 'turn/end');
              seed = lastEnd === undefined ? events : events.slice(0, lastEnd.seq + 1);
            }
            if (request.sessionId && parent) {
              this.pendingChildren.set(request.sessionId, parent);
            }
            return Promise.resolve(seed.length > 0 ? { seed } : {});
          },
        });
      } catch (e) {
        this.log(`failed to register ${REVIEW_FORK_PROVIDER}: ${e?.message || e}`);
      }
    }
  }

  dispose() {
    try { this.providerDisposer?.(); } catch {}
  }

  onAgentCreated(child) {
    const parent = this.pendingChildren.get(child?.id) || this.childRecord(child)?.parentAgent;
    if (!parent || !child) return;
    const rec = this.children.get(child.id);
    if (rec) rec.parentAgent = parent;

    // 1. Inherit parent system prompt verbatim with complete: true to achieve byte-identical prompt cache parity
    const parentSysPrompt = getParentSystemPrompt(parent);
    if (parentSysPrompt && child.ctx?.systemPrompt?.section) {
      try {
        child.ctx.systemPrompt.section({
          name: 'review:parent-system-prompt',
          order: 0,
          text: parentSysPrompt,
          complete: true,
          interpolate: false,
        });
        child.ctx.systemPrompt.suppressRuntimeContext?.();
      } catch (e) {
        this.log(`prompt parity setup failed for child ${child.id}: ${e?.message || e}`);
      }
    }

    // 2. Align tool surface to match parent tools 1:1 so request headers and tool schemas match exactly
    if (this.ctx?.tools?.view && child.ctx?.tools?.register) {
      try {
        const parentView = this.ctx.tools.view(parent);
        const childView = this.ctx.tools.view(child);
        const ownTools = this.ctx.tools.layers?.peek?.(child)?.tools;
        for (const [name, reg] of parentView.registrations.entries()) {
          if (!reg?.definition) continue;
          const childReg = childView.registrations.get(name);
          if (childReg === reg || (childReg?.definition === reg.definition && childReg?.when === reg.when)) continue;
          if (ownTools?.has?.(name)) continue;
          try {
            if (reg.when !== undefined) child.ctx.tools.register(reg.definition, { when: reg.when });
            else child.ctx.tools.register(reg.definition);
          } catch (e) {
            this.log(`tool alignment failed for child ${child.id} tool=${name}: ${e?.message || e}`);
          }
        }
        if (childView.restrictableNames && child.ctx?.tools?.restrict) {
          const extraNames = [...childView.restrictableNames].filter((name) => !parentView.registrations.has(name));
          if (extraNames.length > 0) {
            try {
              child.ctx.tools.restrict({ deny: extraNames });
            } catch (e) {
              this.log(`tool restriction alignment failed for child ${child.id}: ${e?.message || e}`);
            }
          }
        }
      } catch (e) {
        this.log(`tool alignment failed for child ${child.id}: ${e?.message || e}`);
      }
    }
  }

  counters(session) {
    let s = this.state.get(session);
    if (!s) {
      // Hydrate from persisted history (H: turn_context.py:808 prior_user_turns % interval).
      let priorUserTurns = 0;
      try {
        for (const e of session.snapshotEvents()) {
          if (e.type === 'user/message' && e.data?.source?.kind === 'user') priorUserTurns++;
        }
      } catch {}
      s = {
        turnsSinceMemory: this.memoryInterval > 0 ? priorUserTurns % this.memoryInterval : 0,
        itersSinceSkill: 0,
        countedTurn: null,
      };
      this.state.set(session, s);
    }
    return s;
  }

  isReviewChild(agent) { return !!agent && this.children.has(agent.id); }
  childRecord(agent) { return agent ? this.children.get(agent.id) : undefined; }

  eligible(agent) {
    const h = agent?.session?.header;
    if (!h) return false;
    if (h.origin === 'subagent' || this.children.has(agent.id)) return false;
    return true;
  }

  /** session/event listener: counts user turns and tool-iteration steps. */
  onSessionEvent(session, event, agent, toolNames) {
    if (!this.enabled || !agent || !this.eligible(agent)) return;
    const s = this.counters(session);
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      if (this.memoryInterval > 0 && toolNames.has('memory')) s.turnsSinceMemory++;
    } else if (event.type === 'tool/call') {
      const name = event.data?.name;
      if (name === 'memory') s.turnsSinceMemory = 0;
      if (name === 'skill_manage') s.itersSinceSkill = 0;
    } else if (event.type === 'step/end') {
      // One tool-iteration = one model step that issued tool calls (H: turn_iteration_prep.py:166).
      if (this.skillInterval > 0 && toolNames.has('skill_manage') && s.stepHadToolCall) s.itersSinceSkill++;
      s.stepHadToolCall = false;
    }
    if (event.type === 'tool/call') s.stepHadToolCall = true;
  }

  /** agent/turn-stopping listener: decide and spawn (H: turn_finalizer.py:862 + _mirror_turn_to_memory). */
  async onTurnStopping(agent, { interrupted = false } = {}) {
    if (!this.enabled || !this.eligible(agent) || interrupted) return;
    const s = this.counters(agent.session);
    let reviewMemory = false;
    if (this.memoryInterval > 0 && s.turnsSinceMemory >= this.memoryInterval) { reviewMemory = true; s.turnsSinceMemory = 0; }
    let reviewSkills = false;
    if (this.skillInterval > 0 && s.itersSinceSkill >= this.skillInterval) { reviewSkills = true; s.itersSinceSkill = 0; }
    if (!reviewMemory && !reviewSkills) return;
    if (this.running.has(agent.session)) { this.log(`review already running for ${agent.id}; skipped`); return; }
    await this.spawn(agent, { reviewMemory, reviewSkills });
  }

  async spawn(agent, { reviewMemory, reviewSkills, focus }) {
    let prompt = PROMPT_BY_SCOPE[`${reviewMemory},${reviewSkills}`];
    if (focus) prompt += `\n\nThe user explicitly requested this review with the following focus — prioritize it over the general instructions above:\n${focus}`;
    const allowed = new Set([...READ_TOOLS, 'skill_manage', ...(reviewMemory ? ['memory'] : [])]);
    const memoryPhrase = allowed.has('memory') ? 'memory and skill ' : 'skill ';
    const text = `${prompt}\n\nYou can only call ${memoryPhrase}management tools (plus skill/read/glob/grep to read). Other tools will be denied at runtime — do not attempt them.`;
    const ac = new AbortController();
    this.running.add(agent.session);
    const record = { allowed, steps: 0, reads: new Set(), writes: [], reviewMemory, reviewSkills, parent: agent.id, parentAgent: agent };
    let activation;
    const provider = this.ctx?.subagents?.getProvider?.(REVIEW_FORK_PROVIDER) ? REVIEW_FORK_PROVIDER : 'fork';
    try {
      activation = await this.ctx.subagents.startActivation({
        provider,
        label: reviewMemory && reviewSkills ? 'memory & skill review' : reviewMemory ? 'memory review' : 'skill review',
        delivery: 'caller',
        signal: ac.signal,
        request: { parent: agent, signal: ac.signal, prompt: [{ type: 'text', text }] },
      });
    } catch (e) {
      this.running.delete(agent.session);
      this.log(`background review failed to start: ${e?.message || e}`);
      return;
    }
    this.children.set(activation.childId, record);
    this.log(`background review started child=${activation.childId} provider=${provider} memory=${reviewMemory} skills=${reviewSkills}`);
    activation.result.then((res) => {
      const summary = summarize(record.writes);
      const out = (res.output || []).map((b) => b.text || '').join('').replace(/\s+/g, ' ').slice(0, 300);
      this.log(`background review done child=${activation.childId} stop=${res.stopReason} steps=${record.steps} writes=${record.writes.length} ${summary} | reply: ${out}`);
      if (summary && this.onSummary) this.onSummary(agent, summary, record);
    }).catch((e) => this.log(`background review error: ${e?.message || e}`))
      .finally(() => {
        this.running.delete(agent.session);
        this.pendingChildren.delete(activation.childId);
        setTimeout(() => this.children.delete(activation.childId), 60_000);
      });
    return activation;
  }

  /** tools/pre-execute: dispatch-side whitelist for review children (H: background_review.py:1212). */
  gate(exec) {
    const rec = this.childRecord(exec.agent);
    if (!rec) return null;
    this.log(`review child tool call: ${exec.name} ${JSON.stringify(exec.arguments ?? {}).slice(0, 200)}`);
    if (rec.allowed.has(exec.name)) return null;
    const memoryDeny = rec.allowed.has('memory') ? ' and memory for notes' : '';
    return {
      kind: 'deny',
      reason: `Background review denied non-whitelisted tool: ${exec.name}. Allowed here: skill/read/glob/grep to read, skill_manage to change skills${memoryDeny}. Do not retry ${exec.name}.`,
    };
  }

  /** agent/pre-step: cap review child iterations. */
  stepAllowed(agent) {
    const rec = this.childRecord(agent);
    if (!rec) return true;
    rec.steps++;
    return rec.steps <= REVIEW_MAX_ITERATIONS;
  }

  /** tools/result: record reads (for read-before-write) and successful writes. */
  observeResult(exec, result) {
    const rec = this.childRecord(exec.agent);
    if (!rec || result?.isError) return;
    const args = exec.arguments || {};
    if (exec.name === 'skill' && args.name) rec.reads.add(`skill:${args.name}`);
    if (exec.name === 'read' && (args.file_path || args.path)) rec.reads.add(`file:${args.file_path || args.path}`);
    if ((exec.name === 'memory' || exec.name === 'skill_manage') && result?.value?.success !== false) {
      rec.writes.push({ tool: exec.name, args, value: result.value });
    }
  }
}

function summarize(writes) {
  const lines = [];
  for (const w of writes) {
    if (w.tool === 'memory') {
      const ops = (w.args.operations || []).map((o) => o.action).filter(Boolean);
      const counts = ops.reduce((m, a) => ((m[a] = (m[a] || 0) + 1), m), {});
      const target = w.args.target === 'user' ? 'user profile' : 'memory';
      lines.push(`${target}: ${Object.entries(counts).map(([a, n]) => `${a}×${n}`).join(', ')}`);
    } else {
      for (const r of w.value?.results || []) lines.push(`skill ${r.action}: ${r.name}${r.file ? `/${r.file}` : ''}`);
    }
  }
  return [...new Set(lines)].join(' · ');
}
