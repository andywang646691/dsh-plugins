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
              sendNotification({
                id: sid,
                title: 'Agent 工作完成',
                body: `会话 [${title}] 的任务已完成，请查看结果。`,
                action: 'session.completed',
                sessionId: sid,
              });
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
          sendNotification({
            id: 'approval-' + Date.now(),
            title: `等待审批: ${toolName}`,
            body: reason,
            action: 'approval.requested',
          });
          // Continue waterfall chain to existing UI handlers
          return next();
        });

        // Listen for user questions (waterfall)
        ctx.remote.$on('user-questions/request', function(request, next) {
          const questions = request.questions || [];
          const qText = questions[0]?.question || 'Agent 提出了问题，需要您回复';
          sendNotification({
            id: 'question-' + Date.now(),
            title: '等待回复',
            body: qText,
            action: 'question.requested',
          });
          // Continue waterfall chain to existing UI handlers
          return next();
        });
      }

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
