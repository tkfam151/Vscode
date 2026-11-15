// The workspace's files, held in memory. Paths are project-relative with no
// leading slash ("main.py", "src/util.py").
//
// Folders: a folder exists while it holds a file, or when it was created on
// purpose (New folder / mkdir). Those are saved as a marker entry whose path
// ends in "/" ("src/") with empty content, so empty folders survive reopening
// and are copied from a model workspace like any file. Change listeners see
// markers as ordinary paths ending in "/".

const isMarker = (p) => p.endsWith('/');

export class VFS {
  constructor() {
    this.files = new Map();
    this.dirs = new Set(); // folders created on purpose (have a marker)
    this.listeners = [];
  }

  /** Fill from storage without announcing changes. */
  load(entries) {
    for (const { path, content } of entries) {
      if (isMarker(path)) this.dirs.add(path.slice(0, -1));
      else this.files.set(path, content);
    }
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

  /** Every folder, created on purpose or holding files. */
  allDirs() {
    const out = new Set(this.dirs);
    for (const p of [...this.files.keys(), ...this.dirs]) {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  set(path, content, source = 'shell') {
    if (isMarker(path)) return this.mkdir(path.slice(0, -1), source);
    if (this.files.get(path) === content) return;
    this.files.set(path, content);
    this.#emit(path, content, source);
  }

  delete(path, source = 'shell') {
    if (isMarker(path)) {
      if (this.dirs.delete(path.slice(0, -1))) this.#emit(path, null, source);
      return;
    }
    if (!this.files.delete(path)) return;
    this.#emit(path, null, source);
    // Like a real disk: deleting the last file leaves its folder in place.
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent && source !== 'remote' && !this.isDir(parent)) this.mkdir(parent, source);
  }

  mkdir(path, source = 'shell') {
    if (!path || this.dirs.has(path)) return;
    this.dirs.add(path);
    this.#emit(path + '/', '', source);
  }

  isDir(path) {
    if (path === '') return true;
    if (this.dirs.has(path)) return true;
    const prefix = path + '/';
    for (const p of this.files.keys()) if (p.startsWith(prefix)) return true;
    for (const d of this.dirs) if (d.startsWith(prefix)) return true;
    return false;
  }

  /** Delete a folder and everything in it. */
  rmdir(path, source = 'shell') {
    const prefix = path + '/';
    for (const p of [...this.files.keys()]) if (p.startsWith(prefix)) this.files.delete(p) && this.#emit(p, null, source);
    for (const d of [...this.dirs]) if (d === path || d.startsWith(prefix)) this.dirs.delete(d) && this.#emit(d + '/', null, source);
  }

  /** Move a folder and everything in it. */
  renameDir(from, to, source = 'shell') {
    const prefix = from + '/';
    for (const d of [...this.dirs]) if (d === from || d.startsWith(prefix)) this.mkdir(to + d.slice(from.length), source);
    if (!this.dirs.has(to)) this.mkdir(to, source);
    for (const p of [...this.files.keys()]) if (p.startsWith(prefix)) this.set(to + p.slice(from.length), this.files.get(p), source);
    this.rmdir(from, source);
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

/**
 * The file to run when someone runs a folder: a conventional main file, or the
 * only program in it. Returns a path or null.
 */
export function entryFor(vfs, dir) {
  const prefix = dir ? dir + '/' : '';
  for (const name of ['main.py', '__main__.py', 'app.py', 'index.html', 'main.js', 'index.js', 'app.js']) {
    if (vfs.has(prefix + name)) return prefix + name;
  }
  const here = vfs.list(dir).filter((e) => !e.dir).map((e) => prefix + e.name);
  for (const re of [/\.py$/i, /\.(js|mjs)$/i, /\.html?$/i]) {
    const matches = here.filter((p) => re.test(p));
    if (matches.length === 1) return matches[0];
  }
  return null;
}
