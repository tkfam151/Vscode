// Launch page: starts the workspace (if needed) and then jumps to it.
const id = new URLSearchParams(location.search).get('ws');
const $ = (x) => document.getElementById(x);

function fail(message) {
  $('spinner').hidden = true;
  $('title').textContent = 'Could not open the workspace';
  $('msg').textContent = message;
  $('back').hidden = false;
}

try {
  if (!/^\d+$/.test(id || '')) throw new Error('Missing workspace.');
  const r = await fetch(`/api/workspaces/${id}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) location.replace('/');
  else if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  else location.replace(data.url);
} catch (e) {
  fail(e.message);
}
