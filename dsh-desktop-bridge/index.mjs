export const name = '@max/dsh-desktop-bridge';
export const inject = ['webServer'];

export function apply(ctx) {
  ctx.logger.info('@max/dsh-desktop-bridge loaded on host');

  if (ctx.webServer) {
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
  }
}
