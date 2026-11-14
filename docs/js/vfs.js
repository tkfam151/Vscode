// The workspace's files, held in memory. Paths are project-relative with no
// leading slash ("main.py", "src/util.py"). Folders exist while they contain
// a file, or for this session after `mkdir`.

export class VFS {
  constructor() {
    this.files = new Map();
    this.dirs = new Set();
    this.listeners = [];
  }

  /** cb(path, content | null, source) — content null means deleted. */
  onChange(cb) {
    this.listeners.push(cb);
  }

  #emit(path, content, source) {
    for (const cb of this.listeners) cb(path, content, source);
  }

  has(path) {
    return this.files.has(path);
  }

  get(path) {
    return this.files.get(path);
  }

  entries() {
    return [...this.files];
  }

  paths() {
    return [...this.files.keys()].sort((a, b) => a.localeCompare(b));
  }

  set(path, content, source = 'shell') {
    if (this.files.get(path) === content) return;
    this.files.set(path, content);
    this.#emit(path, content, source);
  }

  delete(path, source = 'shell') {
    if (this.files.delete(path)) this.#emit(path, null, source);
  }

  mkdir(path) {
    if (path) this.dirs.add(path);
  }

  isDir(path) {
    if (path === '') return true;
    if (this.dirs.has(path)) return true;
    const prefix = path + '/';
    for (const p of this.files.keys()) if (p.startsWith(prefix)) return true;
    for (const d of this.dirs) if (d.startsWith(prefix)) return true;
    return false;
  }

  rmdir(path) {
    const prefix = path + '/';
    for (const p of [...this.files.keys()]) if (p.startsWith(prefix)) this.delete(p);
    for (const d of [...this.dirs]) if (d === path || d.startsWith(prefix)) this.dirs.delete(d);
  }

  /** Immediate children of a folder: [{ name, dir }] */
  list(dir) {
    const prefix = dir ? dir + '/' : '';
    const out = new Map();
    const add = (p, isFile) => {
      if (!p.startsWith(prefix) || p === dir) return;
      const rest = p.slice(prefix.length);
      const i = rest.indexOf('/');
      const name = i < 0 ? rest : rest.slice(0, i);
      if (!name) return;
      const isDir = i >= 0 || !isFile;
      if (!out.has(name) || isDir) out.set(name, { name, dir: isDir });
    };
    for (const p of this.files.keys()) add(p, true);
    for (const d of this.dirs) add(d, false);
    return [...out.values()].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }
}
