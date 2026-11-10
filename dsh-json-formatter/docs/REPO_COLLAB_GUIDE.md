# Repository Collaboration Guide

## Verification & Testing Standards

1. **Syntax Check**:
   ```bash
   node --input-type=module -e 'import("./index.mjs");'
   node --check client.js
   ```
2. **Design Tokens**:
   - Zero hardcoded colors in CSS or styles.
   - All colors must derive from `--dsw-alias-*` variables or `color-mix`.
3. **Module Registration**:
   - Must invoke `window.__ModuleLoader__.load` for both `@max/dsh-json-formatter` and `dsh-json-formatter`.
   - Disposers must be properly returned in `ctx.effect(...)` callbacks for safe HMR.
