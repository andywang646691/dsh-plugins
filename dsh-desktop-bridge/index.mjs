export const name = '@max/dsh-desktop-bridge';
export const inject = ['webServer', 'sessionQuery'];

export function apply(ctx) {
  ctx.logger.info('@max/dsh-desktop-bridge loaded on host');

  if (ctx.webServer) {
    // 1. Endpoint for SSO credential relay
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/desktop-bridge/auth-bounce',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal');
          const redirect = url.searchParams.get('redirect');
          if (!redirect) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Missing redirect parameter');
            return;
          }

          // Parse cookies from incoming request
          const cookieHeader = req.headers['cookie'] || '';
          let cfAuth = '';
          let cfAppSession = '';
          const allCookies = [];

          const pairs = cookieHeader.split(';');
          for (const pair of pairs) {
            const trimmed = pair.trim();
            if (!trimmed) continue;
            allCookies.push(trimmed);
            const [k, ...vParts] = trimmed.split('=');
            const v = vParts.join('=');
            if (k === 'CF_Authorization') cfAuth = v;
            else if (k === 'CF_AppSession') cfAppSession = v;
          }

          // Also check header cf-access-jwt-assertion
          if (!cfAuth && req.headers['cf-access-jwt-assertion']) {
            cfAuth = req.headers['cf-access-jwt-assertion'];
          }

          const targetUrl = new URL(redirect);
          if (cfAuth) targetUrl.searchParams.set('cf_authorization', cfAuth);
          if (cfAppSession) targetUrl.searchParams.set('cf_app_session', cfAppSession);
          // Pass all cookies encoded so client gets the exact full authentication suite
          targetUrl.searchParams.set('cookies', allCookies.join('; '));

          res.writeHead(302, {
            'Location': targetUrl.toString(),
            'Cache-Control': 'no-store, no-cache, must-revalidate',
          });
          res.end();
        } catch (err) {
          ctx.logger.error('auth-bounce error: %s', err?.message || err);
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Internal Server Error');
        }
      }
    }));

    // 2. Lightweight endpoint to retrieve the latest assistant reply for a session
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/desktop-bridge/last-reply',
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal');
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'Missing sessionId parameter' }));
            return;
          }

          // Ensure in-flight session buffers are flushed to durability before reading
          try {
            const sessionsSvc = ctx.get('sessions') || ctx.sessions;
            if (sessionsSvc) {
              const liveSession = sessionsSvc.get?.(sessionId);
              if (liveSession) {
                await sessionsSvc.flush?.(liveSession);
              }
            }
          } catch (e) {
            // Non-fatal if flush is unavailable
          }

          const sessionQuery = ctx.sessionQuery || ctx.get('sessionQuery');
          if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: 'sessionQuery service unavailable' }));
            return;
          }

          const snapshot = await sessionQuery.readSession(sessionId);
          const events = snapshot?.events || [];
          let reply = '';

          // Walk events backwards to find the latest assistant reply with text content
          for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i];
            if (ev?.type === 'assistant/message' && ev?.data?.message?.content) {
              const content = ev.data.message.content;
              const textParts = [];
              if (Array.isArray(content)) {
                for (const b of content) {
                  if (b && b.type === 'text' && typeof b.text === 'string') {
                    textParts.push(b.text);
                  }
                }
              }
              const joined = textParts.join('\n').trim();
              if (joined) {
                reply = joined;
                break;
              }
            }
          }

          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store, no-cache',
          });
          res.end(JSON.stringify({ ok: true, reply }));
        } catch (err) {
          ctx.logger.error('last-reply error: %s', err?.message || err);
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
        }
      }
    }));
  }
}
