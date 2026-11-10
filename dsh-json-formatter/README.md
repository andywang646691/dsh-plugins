# @max/dsh-json-formatter

JSON Formatter and Tree Inspector plugin for DeepSeek Harness (DSH) Better Sidebar (`dsh-better-sidebar`).

## ✨ Features

- **Double Integration**:
  - **Sidebar Tab**: Register a dedicated `JSON 格式化` tab in Better Sidebar (`+` menu) to format, minify, sort keys, inspect, and fix JSON on the fly.
  - **File Viewer**: Automatically claims `.json` files in Better Sidebar file tree (`priority: 10`) for structured JSON inspection and 1-click formatting.
- **Core Operations**:
  - **Format / Beautify**: 2 spaces, 4 spaces, or Tab indentation.
  - **Minify**: Compact JSON into 1 line.
  - **Sort Keys**: Recursively sort object keys alphabetically.
  - **Escape / Unescape**: Convenient string literal escaping / unescaping for API payloads, curl, and log analysis.
  - **Smart Fix**: Automatically normalizes trailing commas, Python literals (`True`/`False`/`None`), and single-quoted keys/strings.
  - **Interactive Tree View**: Expand/collapse objects and arrays, highlight types, and 1-click copy JSONPath (`$.data.user.id`).
  - **Syntax Error Diagnostics**: Precise line and column error indicators with instant 1-click repair.
  - **Workspace File I/O**: Read from and save back to workspace files.
- **Design Tokens**: Strict compliance with DSH CSS variables (`--dsw-alias-*`), zero hardcoded colors, seamless Light & Dark theme support.
