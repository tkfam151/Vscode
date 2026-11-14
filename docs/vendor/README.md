Third-party libraries, copied unmodified from their npm packages so the site works without a build step.

| Folder | Package | Version | License |
| --- | --- | --- | --- |
| `monaco/` | monaco-editor (`min/vs`) | 0.57.0 | MIT |
| `xterm/` | @xterm/xterm, @xterm/addon-fit | 6.0.0, 0.11.0 | MIT |
| `pyodide/` | pyodide (core runtime) | 314.0.8 | MPL-2.0 |
| `supabase/` | @supabase/supabase-js (UMD build) | 2.119.0 | MIT |

If you update Pyodide, also update `PYODIDE_VERSION` in `docs/js/py-worker.js`.
