// Client plugin for @max/dsh-desktop-bridge.
// Integrates with DSH sessions service, remote waterfall requests, and relays events to Mac client.

function __dsh_desktop_bridge_factory(require) {
  return {
    inject: ['sessions', 'remote'],
    apply(ctx) {
      console.log('[@max/dsh-desktop-bridge] Client plugin initialized');

      // Track previous running states to detect completion
      const runningMap = new Map();
      // Track completed sessions that have not been read/focused
      const completedSessions = new Set();
      let lastSentRunning = null;
      let lastSentBadge = null;

      // Extract raw text from message content blocks
      function extractTextFromContent(content) {
        if (!Array.isArray(content)) return '';
        const parts = [];
        for (const block of content) {
          if (!block) continue;
          if (block.type === 'text' && typeof block.text === 'string') {
            parts.push(block.text);
          }
        }
        return parts.join('\n');
      }

      // Find the last assistant reply text in a session event list
      function extractLastAssistantReplyFromEvents(entries) {
        if (!Array.isArray(entries)) return null;
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          const event = entry?.event || (entry?.type === 'assistant/message' ? entry : null);
          if (event?.type === 'assistant/message' && event?.data?.message?.content) {
            const text = extractTextFromContent(event.data.message.content);
            if (text && text.trim().length > 0) {
              return text.trim();
            }
          }
        }
        return null;
      }

      // Parse markdown export as fallback to find the last Assistant section
      function extractLastAssistantReplyFromMarkdown(md) {
        if (!md || typeof md !== 'string') return null;
        const matches = [...md.matchAll(/\*\*Assistant\*\*\s*\n\n([\s\S]*?)(?=\n\n\*\*(?:Tool|Assistant|User)\b|\n\n<details>|$)/g)];
        if (matches.length > 0) {
          const lastMatch = matches[matches.length - 1][1];
          if (lastMatch && lastMatch.trim()) {
            return lastMatch.trim();
          }
        }
        return null;
      }

      // Clean markdown, parse dsh-ui semantics at block-level, and format for native notification
      function formatNotificationBody(replyText, sessionTitle) {
        if (!replyText || typeof replyText !== 'string' || !replyText.trim()) {
          return sessionTitle ? `会话 [${sessionTitle}] 的任务已完成` : '任务已完成';
        }

        // 1. Remove <think>...</think> block
        let text = replyText.replace(/<think>[\s\S]*?<\/think>/gi, '');

        // 2. Block-level parsing to cleanly isolate dsh-ui fences and extract UI semantics
        let uiSummary = '';
        const lines = text.replace(/\r\n/g, '\n').split('\n');
        const filteredLines = [];
        let inDshUi = false;
        let dshUiBuffer = [];
        let inCodeBlock = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();

          if (!inDshUi && !inCodeBlock && /^```dsh-ui\b/.test(trimmed)) {
            inDshUi = true;
            dshUiBuffer = [];
            continue;
          }

          if (inDshUi) {
            if (trimmed === '```') {
              inDshUi = false;
              try {
                const spec = JSON.parse(dshUiBuffer.join('\n'));
                if (spec && typeof spec === 'object') {
                  const specTitle = spec.title ? `[${spec.title}] ` : '';
                  let core = '';
                  const items = spec.items || [];
                  for (const it of items) {
                    if (it.type === 'callout' && it.content) {
                      core = it.content;
                      break;
                    } else if (it.type === 'text' && it.content) {
                      core = it.content;
                      break;
                    } else if (it.type === 'steps' && Array.isArray(it.steps) && it.steps.length > 0) {
                      core = it.steps.map(s => s.title).filter(Boolean).slice(0, 3).join(' → ');
                      break;
                    }
                  }
                  if (!core && items.length > 0 && items[0]?.label) {
                    core = items[0].label;
                  }
                  uiSummary = `${specTitle}${core}`.trim();
                }
              } catch (e) {}
              dshUiBuffer = [];
              continue;
            } else {
              dshUiBuffer.push(line);
              continue;
            }
          }

          if (!inDshUi && /^```[a-zA-Z0-9_-]*$/.test(trimmed)) {
            inCodeBlock = !inCodeBlock;
            filteredLines.push('[代码块]');
            continue;
          }

          if (inCodeBlock) continue;

          filteredLines.push(line);
        }

        let prose = filteredLines.join('\n');

        // 3. Clean Markdown formatting
        prose = prose.replace(/!\[(.*?)\]\(.*?\)/g, '$1');
        prose = prose.replace(/\[(.*?)\]\(.*?\)/g, '$1');
        prose = prose.replace(/(\*\*|__)(.*?)\1/g, '$2');
        prose = prose.replace(/(\*|_)(.*?)\1/g, '$2');
        prose = prose.replace(/~~(.*?)~~/g, '$1');
        prose = prose.replace(/^#{1,6}\s+/gm, '');
        prose = prose.replace(/^>\s+/gm, '');
        prose = prose.replace(/^[\*\-]\s+/gm, '');
        prose = prose.replace(/\s+/g, ' ').trim();

        // 4. Combine UI summary and prose
        let finalBody = '';
        if (uiSummary && prose) {
          finalBody = prose.length > 30 ? prose : `${uiSummary} · ${prose}`;
        } else {
          finalBody = prose || uiSummary;
        }

        // 5. Clean orphan punctuation / residual quotes
        finalBody = finalBody.replace(/^[\s,."'\`]+|[\s,."'\`]+$/g, '').trim();

        const MAX_BODY_LEN = 160;
        if (finalBody.length > MAX_BODY_LEN) {
          finalBody = finalBody.slice(0, MAX_BODY_LEN).trim() + '...';
        }

        if (!finalBody) {
          return sessionTitle ? `会话 [${sessionTitle}] 的任务已完成` : '任务已完成';
        }

        return finalBody;
      }

      // Resolve the latest assistant message for the session
      async function resolveSessionReply(sid, sessionTitle) {
        // 1. Try currently active in-memory binding
        try {
          const binding = ctx.sessions?.binding?.(sid);
          if (binding && binding.eventSource) {
            const entries = binding.eventSource.getSnapshot()?.entries;
            const reply = extractLastAssistantReplyFromEvents(entries);
            if (reply) {
              return formatNotificationBody(reply, sessionTitle);
            }
          }
        } catch (e) {
          console.warn('[@max/dsh-desktop-bridge] read from binding failed:', e);
        }

        // 2. Try host endpoint /desktop-bridge/last-reply
        try {
          const res = await fetch(`/desktop-bridge/last-reply?sessionId=${encodeURIComponent(sid)}`, {
            credentials: 'same-origin',
          });
          if (res.ok) {
            const data = await res.json();
            if (data && data.ok && data.reply) {
              return formatNotificationBody(data.reply, sessionTitle);
            }
          }
        } catch (e) {
          console.warn('[@max/dsh-desktop-bridge] fetch /desktop-bridge/last-reply error:', e);
        }

        // 3. Fallback: try /api/session.markdown
        try {
          const res = await fetch(`/api/session.markdown?sessionId=${encodeURIComponent(sid)}`, {
            credentials: 'same-origin',
          });
          if (res.ok) {
            const md = await res.text();
            const reply = extractLastAssistantReplyFromMarkdown(md);
            if (reply) {
              return formatNotificationBody(reply, sessionTitle);
            }
          }
        } catch (e) {
          console.warn('[@max/dsh-desktop-bridge] fetch /api/session.markdown fallback error:', e);
        }

        return formatNotificationBody('', sessionTitle);
      }

      function syncStateToDesktop(forceSync = false) {
        const snapshot = ctx.sessions?.list?.getSnapshot();
        if (!snapshot) return;

        const items = snapshot.byId ? Object.values(snapshot.byId) : (snapshot.items || []);
        const isWindowActive = typeof document !== 'undefined' ? (!document.hidden && document.hasFocus()) : true;

        let anyRunning = false;

        for (const item of items) {
          const sid = item.id || item.sessionId;
          if (!sid) continue;

          const wasRunning = runningMap.get(sid) ?? false;
          const isRunning = item.running ?? false;
          const isViewing = (item.retainedBy?.mainView ?? 0) > 0;
          const isSubagent = item.origin === 'subagent';

          // Clear unread mark when the user is actively viewing this session
          if (isViewing && isWindowActive) {
            completedSessions.delete(sid);
          }

          if (isRunning) {
            anyRunning = true;
            completedSessions.delete(sid);
          } else if (wasRunning && !isRunning) {
            // Agent just completed work!
            // Mute background subagent child sessions unless directly viewed
            if (!isSubagent || isViewing) {
              if (!isViewing || !isWindowActive) {
                completedSessions.add(sid);
              }
              const title = item.displayTitle || item.title || '会话';

              // Small delay (150ms) to allow in-flight events and settlements to commit
              setTimeout(() => {
                resolveSessionReply(sid, title).then((bodyText) => {
                  sendNotification({
                    id: sid,
                    title: title,
                    body: bodyText,
                    action: 'session.completed',
                    sessionId: sid,
                  });
                }).catch((err) => {
                  console.warn('[@max/dsh-desktop-bridge] resolveSessionReply error:', err);
                  sendNotification({
                    id: sid,
                    title: title,
                    body: `会话 [${title}] 的任务已完成，请查看结果。`,
                    action: 'session.completed',
                    sessionId: sid,
                  });
                });
              }, 150);
            }
          }

          runningMap.set(sid, isRunning);
        }

        // Send overall running status and badge count to Desktop only on change
        const badgeCount = completedSessions.size;
        if (forceSync || anyRunning !== lastSentRunning || badgeCount !== lastSentBadge) {
          lastSentRunning = anyRunning;
          lastSentBadge = badgeCount;

          const bridge = window.desktopBridge || window.mygo;
          if (bridge) {
            bridge.call('DesktopBridge.SyncStatus', {
              anyRunning,
              badgeCount,
            }).catch((err) => {
              console.warn('[@max/dsh-desktop-bridge] SyncStatus error:', err);
            });
          }
        }
      }

      function sendNotification(notif) {
        console.log('[@max/dsh-desktop-bridge] Notify:', notif);
        const bridge = window.desktopBridge || window.mygo;
        if (bridge) {
          bridge.call('DesktopBridge.Notify', notif).catch((err) => {
            console.warn('[@max/dsh-desktop-bridge] Notify error:', err);
          });
        }
      }

      // Listen for session list changes
      ctx.sessions.list.subscribe(() => {
        syncStateToDesktop();
      });

      // Initial sync
      setTimeout(() => {
        syncStateToDesktop(true);
      }, 1000);

      // Listen for approval requests (waterfall)
      if (ctx.remote && ctx.remote.$on) {
        ctx.remote.$on('approval/request', function(request, next) {
          const toolName = request.toolName || '工具';
          const reason = request.displayReason || request.reason || 'Agent 需要执行操作，请审批';
          const sid = (ctx.sessions && typeof ctx.sessions.scopeOf === 'function' ? ctx.sessions.scopeOf(this) : null) || request.sessionId || null;
          sendNotification({
            id: 'approval-' + Date.now(),
            title: `等待审批: ${toolName}`,
            body: reason,
            action: 'approval.requested',
            sessionId: sid,
          });
          // Continue waterfall chain to existing UI handlers
          return next();
        });

        // Listen for user questions (waterfall)
        ctx.remote.$on('user-questions/request', function(request, next) {
          const questions = request.questions || [];
          const qText = questions[0]?.question || 'Agent 提出了问题，需要您回复';
          const sid = (ctx.sessions && typeof ctx.sessions.scopeOf === 'function' ? ctx.sessions.scopeOf(this) : null) || request.sessionId || null;
          sendNotification({
            id: 'question-' + Date.now(),
            title: '等待回复',
            body: qText,
            action: 'question.requested',
            sessionId: sid,
          });
          // Continue waterfall chain to existing UI handlers
          return next();
        });
      }

      // Navigate to a specific session in the UI (triggered by notification click or deep link)
      function navigateToSession(sessionId) {
        if (!sessionId) return false;
        console.log('[@max/dsh-desktop-bridge] Navigating to session:', sessionId);

        // 1. Try ctx.uiWorkspace.openSession(sessionId)
        try {
          var ws = null;
          if (ctx.get && typeof ctx.get === 'function') ws = ctx.get('uiWorkspace');
          if (!ws && ctx.uiWorkspace) ws = ctx.uiWorkspace;
          if (ws && typeof ws.openSession === 'function') {
            ws.openSession(sessionId);
            checkAndClearSession(sessionId);
            return true;
          }
        } catch (e) {
          console.warn('[@max/dsh-desktop-bridge] uiWorkspace.openSession error:', e);
        }

        // 2. Try ctx.sessions.open(sessionId)
        try {
          var sessSvc = null;
          if (ctx.get && typeof ctx.get === 'function') sessSvc = ctx.get('sessions');
          if (!sessSvc && ctx.sessions) sessSvc = ctx.sessions;
          if (sessSvc && typeof sessSvc.open === 'function') {
            sessSvc.open(sessionId);
            checkAndClearSession(sessionId);
            return true;
          }
        } catch (e) {
          console.warn('[@max/dsh-desktop-bridge] sessions.open error:', e);
        }

        // 3. Fallback: DOM click
        try {
          var row = document.querySelector(
            `[data-row-key="session:${sessionId}"], [data-session-id="${sessionId}"]`
          );
          if (row) {
            row.click();
            checkAndClearSession(sessionId);
            return true;
          }
        } catch (e) {
          console.warn('[@max/dsh-desktop-bridge] DOM click fallback error:', e);
        }

        return false;
      }

      // Register navigation callback with desktop bridge
      var bridge = window.desktopBridge || window.mygo;
      if (bridge && typeof bridge.onNavigateSession === 'function') {
        bridge.onNavigateSession((sessionId) => {
          navigateToSession(sessionId);
        });
      }

      window.addEventListener('dsh:navigate-session', (e) => {
        const sid = e.detail?.sessionId;
        if (sid) {
          navigateToSession(sid);
        }
      });

      // Clear completed badge when user selects/views a session
      function checkAndClearSession(sid) {
        if (sid && completedSessions.has(sid)) {
          completedSessions.delete(sid);
          syncStateToDesktop();
        }
      }

      window.addEventListener('click', (e) => {
        const row = e.target.closest('[data-row-key^="session:"], [data-session-id], [class*="sessionRow"]');
        if (row) {
          let sid = row.getAttribute('data-session-id');
          if (!sid) {
            const key = row.getAttribute('data-row-key');
            if (key && key.startsWith('session:')) {
              sid = key.slice(8);
            }
          }
          checkAndClearSession(sid);
        }
      });

      // Also monitor URL pathname/hash changes and window focus to clear badge
      function checkCurrentUrl() {
        const match = window.location.pathname.match(/\/session(?:s)?\/([a-zA-Z0-9_-]+)/) ||
                      window.location.hash.match(/session(?:s)?\/([a-zA-Z0-9_-]+)/);
        if (match && match[1]) {
          checkAndClearSession(match[1]);
        }
      }
      window.addEventListener('popstate', checkCurrentUrl);
      window.addEventListener('focus', () => syncStateToDesktop());
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) syncStateToDesktop();
      });
    }
  };
}

window.__ModuleLoader__.load({
  id: '@max/dsh-desktop-bridge',
  factory: __dsh_desktop_bridge_factory
});

window.__ModuleLoader__.load({
  id: 'dsh-desktop-bridge',
  factory: __dsh_desktop_bridge_factory
});
