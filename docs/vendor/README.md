Third-party libraries, copied unmodified from their npm packages so the site works without a build step.

| Folder | Package | Version | License |
| --- | --- | --- | --- |
| `monaco/` | monaco-editor (`min/vs`) | 0.57.0 | MIT |
| `xterm/` | @xterm/xterm, @xterm/addon-fit | 6.0.0, 0.11.0 | MIT |
| `pyodide/` | pyodide (core runtime) | 314.0.8 | MPL-2.0 |
| `supabase/` | @supabase/supabase-js (UMD build) | 2.119.0 | MIT |
| `marked/` | marked (UMD build), Markdown preview | 18.2.0 | MIT |
| `sqljs/` | sql.js (worker build + wasm), SQLite | 1.16.0 | MIT |
| `fengari/` | fengari-web, Lua 5.3 | 0.1.4 | MIT |

If you update Pyodide, also update `PYODIDE_VERSION` in `docs/js/py-worker.js`.
