// Runs a Lua program (Fengari: Lua 5.3 in JavaScript) off the main thread.
// in:  { code, name }      out: { type: 'out', data } ... { type: 'done' }
self.window = self; // the Fengari bundle expects a browser window
const out = (data) => postMessage({ type: 'out', data });
console.log = (...a) => out(a.join('\t') + '\n');
console.info = console.warn = console.error = console.log;
importScripts('../vendor/fengari/fengari-web.js');

self.onmessage = ({ data }) => {
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  // print and io.write go to the terminal
  const write = (L, sep, end) => {
    const n = lua.lua_gettop(L);
    const parts = [];
    for (let i = 1; i <= n; i++) parts.push(to_jsstring(lauxlib.luaL_tolstring(L, i)));
    out(parts.join(sep) + end);
    return 0;
  };
  lua.lua_pushjsfunction(L, (L) => write(L, '\t', '\n'));
  lua.lua_setglobal(L, to_luastring('print'));
  if (lua.lua_getglobal(L, to_luastring('io')) !== lua.LUA_TTABLE) {
    // this Lua build has no io library: provide io.write
    lua.lua_pop(L, 1);
    lua.lua_newtable(L);
    lua.lua_pushvalue(L, -1);
    lua.lua_setglobal(L, to_luastring('io'));
  }
  lua.lua_pushjsfunction(L, (L) => write(L, '', ''));
  lua.lua_setfield(L, -2, to_luastring('write'));
  lua.lua_pop(L, 1);
  let status = lauxlib.luaL_loadbuffer(L, to_luastring(data.code), null, to_luastring('@' + data.name));
  if (status === lua.LUA_OK) status = lua.lua_pcall(L, 0, 0, 0);
  if (status !== lua.LUA_OK) out(to_jsstring(lua.lua_tostring(L, -1)) + '\n');
  postMessage({ type: 'done' });
};
