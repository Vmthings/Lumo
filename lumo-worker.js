// Lumo server for Cloudflare Workers + D1.
// Hosts school accounts, lessons, live lessons and the school AI key.
// Setup (dashboard only, no wrangler needed) is in README.md.
// Required binding: a D1 database, variable name DB.
// Optional: ALLOWED_ORIGIN (text variable), your site's address, e.g. https://yourname.github.io

const BUILTIN = 'https://groq-proxy.a765browne.workers.dev/'; // your Groq proxy, used when a school picks "Built-in"
const ITER = 10000; // PBKDF2 iterations (raise on the paid plan if you like)
const DAY = 24 * 3600e3;
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DEF = {
  builtin: 'openai/gpt-oss-120b', claude: 'claude-sonnet-5-5', gemini: 'gemini-2.5-flash',
  openai: 'gpt-5', groq: 'openai/gpt-oss-120b', deepseek: 'deepseek-chat',
};

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS schools(id TEXT PRIMARY KEY,name TEXT,city TEXT,listed INTEGER DEFAULT 0,ai TEXT DEFAULT \'{}\',ip TEXT,created INTEGER)',
  'CREATE TABLE IF NOT EXISTS users(school TEXT,u TEXT,role TEXT,st TEXT,ph TEXT,fails INTEGER DEFAULT 0,lock INTEGER DEFAULT 0,lessons TEXT DEFAULT \'[]\',PRIMARY KEY(school,u))',
  'CREATE TABLE IF NOT EXISTS tokens(t TEXT PRIMARY KEY,school TEXT,u TEXT,exp INTEGER)',
  'CREATE TABLE IF NOT EXISTS sessions(code TEXT PRIMARY KEY,hk TEXT,lesson TEXT,idx INTEGER DEFAULT 0,reveal INTEGER DEFAULT 0,lb INTEGER DEFAULT 0,ver INTEGER DEFAULT 0,ended INTEGER DEFAULT 0,school TEXT,owner TEXT,ip TEXT,created INTEGER)',
  'CREATE TABLE IF NOT EXISTS players(code TEXT,pid TEXT,name TEXT,score INTEGER DEFAULT 0,ans INTEGER,PRIMARY KEY(code,pid))',
  'CREATE TABLE IF NOT EXISTS sugs(code TEXT,n TEXT,x TEXT,at INTEGER)',
  'CREATE TABLE IF NOT EXISTS usage(school TEXT,u TEXT,day TEXT,n INTEGER,PRIMARY KEY(school,u,day))',
];

class HttpErr extends Error { constructor(s, m) { super(m); this.s = s; } }
const fail = (s, m) => { throw new HttpErr(s, m); };

const enc = (s) => new TextEncoder().encode(s);
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const rnd = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => ALPHA[b % 31]).join('');
const rtok = () => hex(crypto.getRandomValues(new Uint8Array(24)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);

async function pbk(pw, salt, iter) {
  const k = await crypto.subtle.importKey('raw', enc(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc(salt), iterations: iter }, k, 256));
}
async function mkHash(pw) { const s = rtok().slice(0, 16); return `${ITER}$${s}$${await pbk(pw, s, ITER)}`; }
async function chkHash(pw, ph) { const [i, s, h] = String(ph).split('$'); return (await pbk(pw, s, +i)) === h; }
async function ipHash(req) {
  return hex(await crypto.subtle.digest('SHA-256', enc(req.headers.get('CF-Connecting-IP') || 'x'))).slice(0, 16);
}

let ready;
const init = (env) => ready || (ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; }));

export default {
  async fetch(req, env) {
    const cors = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const send = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
    try {
      const url = new URL(req.url);
      if (url.pathname === '/') return new Response('Lumo server is running.', { headers: cors });
      if (url.pathname === '/api/ping') return send({ ok: true });
      await init(env);
      const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
      return send(await route(req, env, url, body));
    } catch (e) {
      if (e instanceof HttpErr) return send({ error: e.message }, e.s);
      console.error(e);
      return send({ error: 'Server error. Check that the D1 database is bound as DB.' }, 500);
    }
  },
};

/* ---------- auth ---------- */
async function auth(env, req, need) {
  const t = (req.headers.get('Authorization') || '').replace(/^Bearer /, '');
  const r = t && await env.DB.prepare(
    'SELECT t.school,t.u,t.exp,u.role,u.st FROM tokens t JOIN users u ON u.school=t.school AND u.u=t.u WHERE t.t=?'
  ).bind(t).first();
  if (!r || r.exp < Date.now() || r.st !== 'ok') { if (need) fail(401, 'Please log in again.'); return null; }
  return r;
}
async function newToken(env, school, u) {
  const t = rtok();
  await env.DB.prepare('INSERT INTO tokens(t,school,u,exp) VALUES(?,?,?,?)').bind(t, school, u, Date.now() + 30 * DAY).run();
  return t;
}
const schoolInfo = (s) => ({ id: s.id, name: s.name, city: s.city, ai: !!JSON.parse(s.ai || '{}').on });

/* ---------- router ---------- */
async function route(req, env, url, b) {
  const p = url.pathname, m = req.method, q = (k) => url.searchParams.get(k) || '', DB = env.DB;

  // ----- public: schools
  if (p === '/api/schools' && m === 'GET') {
    const like = '%' + q('q').toLowerCase().replace(/[%_]/g, '') + '%';
    const r = await DB.prepare('SELECT id,name,city FROM schools WHERE listed=1 AND (lower(name) LIKE ? OR lower(city) LIKE ?) ORDER BY name LIMIT 20').bind(like, like).all();
    return { schools: r.results };
  }
  if (p === '/api/school/info' && m === 'GET') {
    const s = await DB.prepare('SELECT * FROM schools WHERE id=?').bind(q('id').toUpperCase()).first();
    if (!s) fail(404, 'No school with that code.');
    return { school: schoolInfo(s) };
  }
  if (p === '/api/school/create' && m === 'POST') {
    const name = clean(b.name, 60), city = clean(b.city, 40), u = clean(b.u, 30), pw = String(b.p || '');
    if (!name || !/^[A-Za-z0-9_.-]{2,30}$/.test(u) || pw.length < 6) fail(400, 'Enter a school name, a username (2-30 letters or numbers) and a 6+ character password.');
    const ip = await ipHash(req);
    const c = await DB.prepare('SELECT COUNT(*) c FROM schools WHERE ip=? AND created>?').bind(ip, Date.now() - DAY).first();
    if (c.c >= 5) fail(429, 'Too many schools created from this connection today.');
    let id = rnd(6);
    for (let i = 0; i < 5 && await DB.prepare('SELECT 1 FROM schools WHERE id=?').bind(id).first(); i++) id = rnd(6);
    await DB.batch([
      DB.prepare('INSERT INTO schools(id,name,city,ip,created) VALUES(?,?,?,?,?)').bind(id, name, city, ip, Date.now()),
      DB.prepare('INSERT INTO users(school,u,role,st,ph) VALUES(?,?,?,?,?)').bind(id, u, 'principal', 'ok', await mkHash(pw)),
    ]);
    return { tok: await newToken(env, id, u), u, role: 'principal', school: { id, name, city, ai: false }, lessons: [] };
  }
  if (p === '/api/join' && m === 'POST') {
    const sid = String(b.school || '').toUpperCase(), u = clean(b.u, 30), pw = String(b.p || '');
    if (!/^[A-Za-z0-9_.-]{2,30}$/.test(u) || pw.length < 6) fail(400, 'Use a username of 2-30 letters or numbers and a 6+ character password.');
    if (!await DB.prepare('SELECT 1 FROM schools WHERE id=?').bind(sid).first()) fail(404, 'No school with that code.');
    if (await DB.prepare('SELECT 1 FROM users WHERE school=? AND lower(u)=lower(?)').bind(sid, u).first()) fail(409, 'That username is taken.');
    await DB.prepare('INSERT INTO users(school,u,role,st,ph) VALUES(?,?,?,?,?)').bind(sid, u, 'teacher', 'pending', await mkHash(pw)).run();
    return { msg: 'Request sent. You can log in once the principal accepts it.' };
  }
  if (p === '/api/login' && m === 'POST') {
    const sid = String(b.school || '').toUpperCase(), u = String(b.u || '').trim();
    const s = await DB.prepare('SELECT * FROM schools WHERE id=?').bind(sid).first();
    const x = s && await DB.prepare('SELECT * FROM users WHERE school=? AND u=?').bind(sid, u).first();
    if (!x) fail(401, 'Wrong username or password.');
    if (x.lock > Date.now()) fail(429, 'Too many wrong passwords. Try again in a few minutes.');
    if (!await chkHash(String(b.p || ''), x.ph)) {
      const f = x.fails + 1;
      await DB.prepare('UPDATE users SET fails=?,lock=? WHERE school=? AND u=?').bind(f >= 8 ? 0 : f, f >= 8 ? Date.now() + 10 * 60e3 : 0, sid, u).run();
      fail(401, 'Wrong username or password.');
    }
    if (x.st === 'pending') fail(403, 'The principal has not accepted your request yet.');
    if (x.st === 'off') fail(403, 'This account is suspended. Ask your principal.');
    await DB.prepare('UPDATE users SET fails=0,lock=0 WHERE school=? AND u=?').bind(sid, u).run();
    return { tok: await newToken(env, sid, u), u, role: x.role, school: schoolInfo(s), lessons: JSON.parse(x.lessons) };
  }

  // ----- students (no account)
  if (p === '/api/play/join' && m === 'POST') {
    const code = String(b.code || '').toUpperCase(), name = clean(b.name, 20);
    const s = await DB.prepare('SELECT * FROM sessions WHERE code=? AND ended=0').bind(code).first();
    if (!s) fail(404, 'No lesson with that code is running. Check the code, and make sure your teacher has started hosting.');
    if (!name) fail(400, 'Enter your name.');
    const n = await DB.prepare('SELECT COUNT(*) c FROM players WHERE code=?').bind(code).first();
    if (n.c >= 300) fail(403, 'This lesson is full.');
    const pid = rtok().slice(0, 16);
    await DB.batch([
      DB.prepare('INSERT INTO players(code,pid,name) VALUES(?,?,?)').bind(code, pid, name),
      DB.prepare('UPDATE sessions SET ver=ver+1 WHERE code=?').bind(code),
    ]);
    return { pid, state: await stuState(env, await getSess(env, code), pid) };
  }
  if (p === '/api/play/state' && m === 'GET') {
    const code = q('code').toUpperCase(), w = await waitVer(env, code, +q('since'));
    if (w.gone || w.ended) return { ended: true };
    if (w.same) return { same: true };
    return await stuState(env, await getSess(env, code), q('pid'));
  }
  if (p === '/api/play/answer' && m === 'POST') {
    const code = String(b.code || '').toUpperCase(), a = Math.floor(+b.a);
    if (!(a >= 0 && a <= 3)) fail(400, 'Bad answer.');
    const r = await DB.prepare('UPDATE players SET ans=? WHERE code=? AND pid=? AND ans IS NULL AND (SELECT reveal FROM sessions WHERE code=?)=0').bind(a, code, String(b.pid), code).run();
    if (r.meta?.changes) await DB.prepare('UPDATE sessions SET ver=ver+1 WHERE code=?').bind(code).run();
    return await stuState(env, await getSess(env, code), String(b.pid));
  }
  if (p === '/api/play/suggest' && m === 'POST') {
    const code = String(b.code || '').toUpperCase(), pl = await DB.prepare('SELECT name FROM players WHERE code=? AND pid=?').bind(code, String(b.pid)).first();
    const c = await DB.prepare('SELECT COUNT(*) c FROM sugs WHERE code=?').bind(code).first();
    if (pl && c.c < 50 && clean(b.x, 300)) {
      await DB.batch([
        DB.prepare('INSERT INTO sugs(code,n,x,at) VALUES(?,?,?,?)').bind(code, pl.name, clean(b.x, 300), Date.now()),
        DB.prepare('UPDATE sessions SET ver=ver+1 WHERE code=?').bind(code),
      ]);
    }
    return { ok: true };
  }

  // ----- hosting (controlled with the host key returned when the lesson starts)
  if (p === '/api/host' && m === 'POST') {
    const l = b.lesson;
    if (!l || !Array.isArray(l.items) || JSON.stringify(l).length > 400000) fail(400, 'Bad lesson.');
    const a = await auth(env, req, false), ip = await ipHash(req);
    const c = await DB.prepare('SELECT COUNT(*) c FROM sessions WHERE ip=? AND created>?').bind(ip, Date.now() - 3600e3).first();
    if (c.c >= 40) fail(429, 'Too many lessons started from this connection. Try again later.');
    const old = Date.now() - DAY;
    await DB.batch([
      DB.prepare('DELETE FROM players WHERE code IN (SELECT code FROM sessions WHERE created<?)').bind(old),
      DB.prepare('DELETE FROM sugs WHERE code IN (SELECT code FROM sessions WHERE created<?)').bind(old),
      DB.prepare('DELETE FROM sessions WHERE created<?').bind(old),
      DB.prepare('DELETE FROM tokens WHERE exp<?').bind(Date.now()),
    ]);
    let code = rnd(5);
    for (let i = 0; i < 8 && await DB.prepare('SELECT 1 FROM sessions WHERE code=?').bind(code).first(); i++) code = rnd(5);
    const hk = rtok(), items = seq(l);
    await DB.prepare('INSERT INTO sessions(code,hk,lesson,lb,school,owner,ip,created) VALUES(?,?,?,?,?,?,?,?)')
      .bind(code, hk, JSON.stringify({ title: clean(l.title, 120), items: items.map(cleanItem) }), l.lb ? 1 : 0, a?.school || null, a?.u || null, ip, Date.now()).run();
    return { code, hk };
  }
  if (p === '/api/host/state' && m === 'GET') {
    const code = q('code').toUpperCase(), s = await getSess(env, code, q('hk'));
    const w = await waitVer(env, code, +q('since'));
    if (w.gone || w.ended) return { ended: true };
    if (w.same) return { same: true };
    return await hostState(env, await getSess(env, code));
  }
  if (p === '/api/host/cmd' && m === 'POST') {
    const code = String(b.code || '').toUpperCase(), s = await getSess(env, code, String(b.hk));
    if (s.ended) return { ended: true };
    await command(env, s, b.a, b.v);
    return await hostState(env, await getSess(env, code));
  }
  if (p === '/api/host/end' && m === 'POST') {
    const code = String(b.code || '').toUpperCase();
    await getSess(env, code, String(b.hk));
    await DB.prepare('UPDATE sessions SET ended=1,ver=ver+1 WHERE code=?').bind(code).run();
    return { ok: true };
  }

  // ----- accounts that need a login
  const me = await auth(env, req, true);
  const S = me.school;
  const school = await DB.prepare('SELECT * FROM schools WHERE id=?').bind(S).first();

  if (p === '/api/me' && m === 'GET') {
    const x = await DB.prepare('SELECT lessons FROM users WHERE school=? AND u=?').bind(S, me.u).first();
    return { u: me.u, role: me.role, school: schoolInfo(school), lessons: JSON.parse(x.lessons) };
  }
  if (p === '/api/lessons' && m === 'GET') {
    const x = await DB.prepare('SELECT lessons FROM users WHERE school=? AND u=?').bind(S, me.u).first();
    return { lessons: JSON.parse(x.lessons) };
  }
  if (p === '/api/lessons' && m === 'PUT') return await saveLessons(DB, S, me.u, b.lessons);

  if (p === '/api/ai' && m === 'POST') {
    const a = JSON.parse(school.ai || '{}');
    if (!a.on) fail(403, 'The school AI is turned off.');
    const day = new Date().toISOString().slice(0, 10);
    await DB.prepare('INSERT INTO usage(school,u,day,n) VALUES(?,?,?,1) ON CONFLICT(school,u,day) DO UPDATE SET n=n+1').bind(S, me.u, day).run();
    const n = await DB.prepare('SELECT n FROM usage WHERE school=? AND u=? AND day=?').bind(S, me.u, day).first();
    if (n.n > (a.cap || 200)) fail(429, 'Daily school AI limit reached.');
    return { text: await llm(a, b.sys, b.p, b.web, b.h) };
  }

  // ----- principal only
  if (p.startsWith('/api/admin')) {
    if (me.role !== 'principal') fail(403, 'Only the principal can do this.');
    if (p === '/api/admin' && m === 'GET') {
      const us = (await DB.prepare('SELECT u,role,st,lessons FROM users WHERE school=? ORDER BY u').bind(S).all()).results;
      const teachers = us.filter((x) => x.role !== 'principal');
      const live = (await DB.prepare('SELECT code,owner,lesson,(SELECT COUNT(*) FROM players p WHERE p.code=s.code) n FROM sessions s WHERE school=? AND ended=0').bind(S).all()).results;
      const a = JSON.parse(school.ai || '{}'), pr = a.prov || 'builtin';
      return {
        school: { id: school.id, name: school.name, city: school.city, listed: !!school.listed, ai: { on: !!a.on, prov: pr, model: (a.models || {})[pr] || DEF[pr], cap: a.cap || 200, has: Object.fromEntries(Object.entries(a.keys || {}).map(([k, v]) => [k, !!v])) } },
        members: teachers.map((x) => ({ u: x.u, st: x.st, n: JSON.parse(x.lessons).length })),
        lessons: Object.fromEntries(teachers.map((x) => [x.u, JSON.parse(x.lessons).map((l) => ({ title: l.title, n: (l.items || []).length }))])),
        mine: JSON.parse(us.find((x) => x.role === 'principal')?.lessons || '[]'),
        live: live.map((x) => ({ code: x.code, owner: x.owner, title: JSON.parse(x.lesson).title, n: x.n })),
      };
    }
    if (p === '/api/admin/member' && m === 'POST') {
      const u = String(b.u || ''), t = await DB.prepare('SELECT role FROM users WHERE school=? AND u=?').bind(S, u).first();
      if (!t || t.role === 'principal') fail(404, 'No such teacher.');
      const stopTok = [DB.prepare('DELETE FROM tokens WHERE school=? AND u=?').bind(S, u),
        DB.prepare('UPDATE sessions SET ended=1,ver=ver+1 WHERE school=? AND owner=? AND ended=0').bind(S, u)];
      if (b.a === 'ok' || b.a === 'on') await DB.prepare("UPDATE users SET st='ok',fails=0,lock=0 WHERE school=? AND u=?").bind(S, u).run();
      else if (b.a === 'off') await DB.batch([DB.prepare("UPDATE users SET st='off' WHERE school=? AND u=?").bind(S, u), ...stopTok]);
      else if (b.a === 'deny' || b.a === 'rm') await DB.batch([DB.prepare('DELETE FROM users WHERE school=? AND u=?').bind(S, u), ...stopTok]);
      else if (b.a === 'pw') {
        if (String(b.pw || '').length < 6) fail(400, 'Password must be 6+ characters.');
        await DB.batch([DB.prepare('UPDATE users SET ph=?,fails=0,lock=0 WHERE school=? AND u=?').bind(await mkHash(String(b.pw)), S, u), ...stopTok]);
      } else fail(400, 'Unknown action.');
      return { ok: true };
    }
    if (p === '/api/admin/lessons') {
      const u = q('u'), t = await DB.prepare('SELECT lessons FROM users WHERE school=? AND u=?').bind(S, u).first();
      if (!t) fail(404, 'No such teacher.');
      if (m === 'GET') return { lessons: JSON.parse(t.lessons) };
      if (m === 'PUT') return await saveLessons(DB, S, u, b.lessons);
    }
    if (p === '/api/admin/ai' && m === 'POST') {
      const a = JSON.parse(school.ai || '{}'); a.keys = a.keys || {}; a.models = a.models || {};
      if ('on' in b) a.on = !!b.on;
      if (b.prov && DEF[b.prov]) a.prov = b.prov;
      const pr = a.prov || 'builtin';
      if (typeof b.key === 'string' && b.key.trim()) a.keys[pr] = b.key.trim().slice(0, 300);
      if (typeof b.model === 'string') a.models[pr] = b.model.trim().slice(0, 80);
      if (b.cap) a.cap = Math.max(1, Math.min(10000, Math.floor(+b.cap) || 200));
      await DB.prepare('UPDATE schools SET ai=? WHERE id=?').bind(JSON.stringify(a), S).run();
      return { ok: true };
    }
    if (p === '/api/admin/list' && m === 'POST') {
      await DB.prepare('UPDATE schools SET listed=? WHERE id=?').bind(b.listed ? 1 : 0, S).run();
      return { ok: true };
    }
    if (p === '/api/admin/end' && m === 'POST') {
      await DB.prepare('UPDATE sessions SET ended=1,ver=ver+1 WHERE code=? AND school=?').bind(String(b.code || '').toUpperCase(), S).run();
      return { ok: true };
    }
  }
  fail(404, 'Not found.');
}

async function saveLessons(DB, school, u, lessons) {
  if (!Array.isArray(lessons)) fail(400, 'Bad lessons.');
  const j = JSON.stringify(lessons);
  if (j.length > 1500000) fail(413, 'Too much lesson data. Clear some AI chat history or remove lessons.');
  await DB.prepare('UPDATE users SET lessons=? WHERE school=? AND u=?').bind(j, school, u).run();
  return { ok: true };
}

/* ---------- live lessons ---------- */
function seq(l) {
  const it = l.items;
  if (l.split === false) return it;
  const sl = it.filter((x) => x.type !== 'q'), qs = it.filter((x) => x.type === 'q');
  return sl.length && qs.length ? [...sl, { type: 'slide', title: 'Quiz time', body: 'The lesson is finished. Get ready for the questions.' }, ...qs] : it;
}
function cleanItem(x) {
  if (x.type === 'q') {
    const o = (Array.isArray(x.opts) ? x.opts : []).slice(0, 4).map((v) => clean(v, 200));
    while (o.length < 4) o.push('');
    return { type: 'q', q: clean(x.q, 400), opts: o, ans: Math.max(0, Math.min(3, Math.floor(+x.ans) || 0)) };
  }
  return { type: 'slide', title: clean(x.title, 200), body: String(x.body ?? '').slice(0, 4000) };
}
async function getSess(env, code, hk) {
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE code=?').bind(code).first();
  if (!s) fail(404, 'No lesson with that code is running.');
  if (hk !== undefined && s.hk !== hk) fail(403, 'Not your lesson.');
  return s;
}
async function waitVer(env, code, since) {
  for (let i = 0; i < 15; i++) {
    const r = await env.DB.prepare('SELECT ver,ended FROM sessions WHERE code=?').bind(code).first();
    if (!r) return { gone: true };
    if (r.ended) return { ended: true };
    if (r.ver !== since) return r;
    await sleep(1000);
  }
  return { same: true };
}
async function command(env, s, a, v) {
  const items = JSON.parse(s.lesson).items, DB = env.DB;
  if (a === 'go') {
    const n = Math.max(0, Math.min(items.length - 1, s.idx + Math.sign(+v || 0)));
    await DB.batch([
      DB.prepare('UPDATE sessions SET idx=?,reveal=0,ver=ver+1 WHERE code=?').bind(n, s.code),
      DB.prepare('UPDATE players SET ans=NULL WHERE code=?').bind(s.code),
    ]);
  } else if (a === 'rev') {
    const x = items[s.idx];
    if (x?.type !== 'q' || s.reveal) return;
    await DB.batch([
      DB.prepare('UPDATE players SET score=score+100 WHERE code=? AND ans=?').bind(s.code, x.ans),
      DB.prepare('UPDATE sessions SET reveal=1,ver=ver+1 WHERE code=?').bind(s.code),
    ]);
  } else if (a === 'tgl') {
    await DB.prepare('UPDATE sessions SET lb=?,ver=ver+1 WHERE code=?').bind(v ? 1 : 0, s.code).run();
  }
}
async function hostState(env, s) {
  const L = JSON.parse(s.lesson), it = L.items;
  const pl = (await env.DB.prepare('SELECT name,score,ans FROM players WHERE code=? ORDER BY score DESC,name').bind(s.code).all()).results;
  const sg = (await env.DB.prepare('SELECT n,x FROM sugs WHERE code=? ORDER BY at').bind(s.code).all()).results;
  return {
    ok: true, err: '', ver: s.ver, code: s.code, title: L.title, idx: s.idx, total: it.length, item: it[s.idx] || null,
    reveal: !!s.reveal, lb: !!s.lb, n: pl.length, answered: pl.filter((x) => x.ans !== null).length,
    board: pl.map((x) => ({ n: x.name, s: x.score })), sugs: sg,
  };
}
async function stuState(env, s, pid) {
  const L = JSON.parse(s.lesson), it = L.items, x = it[s.idx];
  const p = await env.DB.prepare('SELECT score,ans FROM players WHERE code=? AND pid=?').bind(s.code, pid).first();
  if (!p) fail(404, 'You are not in this lesson.');
  let lb = null;
  if (s.lb) lb = (await env.DB.prepare('SELECT name n,score s FROM players WHERE code=? ORDER BY score DESC,name LIMIT 5').bind(s.code).all()).results;
  return {
    t: 'st', ver: s.ver, title: L.title, idx: s.idx, total: it.length,
    item: x && (x.type === 'q' ? { type: 'q', q: x.q, opts: x.opts } : x),
    reveal: !!s.reveal, ans: s.reveal && x?.type === 'q' ? x.ans : null, mine: p.ans, score: p.score, lb,
  };
}

/* ---------- school AI ---------- */
function norm(h, p) {
  const o = [];
  for (const m of [...h, { role: 'user', content: p }]) {
    const r = m.role === 'user' ? 'user' : 'assistant', l = o[o.length - 1];
    if (l && l.role === r) l.content += '\n\n' + m.content; else if (l || r === 'user') o.push({ role: r, content: m.content });
  }
  return o;
}
async function llm(a, sys, p, web, h) {
  const P = a.prov || 'builtin', k = (a.keys || {})[P], md = (a.models || {})[P] || DEF[P];
  const hist = (Array.isArray(h) ? h : []).slice(-14).map((x) => ({ role: x.role === 'user' ? 'user' : 'assistant', content: String(x.content).slice(0, 20000) }));
  sys = String(sys || '').slice(0, 30000); p = String(p || '').slice(0, 60000);
  const hd = { 'Content-Type': 'application/json' };
  let url, b;
  if (P === 'builtin') {
    url = BUILTIN; b = { model: md, messages: [{ role: 'system', content: sys }, ...hist, { role: 'user', content: p }] };
    if (web) b.tools = [{ type: 'browser_search' }];
  } else {
    if (!k) fail(400, 'The school AI has no API key yet.');
    if (P === 'claude') {
      hd['x-api-key'] = k; hd['anthropic-version'] = '2023-06-01'; url = 'https://api.anthropic.com/v1/messages';
      b = { model: md, max_tokens: 4096, system: sys, messages: norm(hist, p) };
      if (web) b.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
    } else if (P === 'gemini') {
      hd['x-goog-api-key'] = k; url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(md)}:generateContent`;
      b = { systemInstruction: { parts: [{ text: sys }] }, contents: norm(hist, p).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })) };
      if (web) b.tools = [{ google_search: {} }];
    } else {
      hd.Authorization = 'Bearer ' + k;
      url = { openai: 'https://api.openai.com/v1/chat/completions', groq: 'https://api.groq.com/openai/v1/chat/completions', deepseek: 'https://api.deepseek.com/chat/completions' }[P];
      b = { model: md, messages: [{ role: 'system', content: sys }, ...hist, { role: 'user', content: p }] };
      if (web && P === 'groq' && /gpt-oss/.test(md)) b.tools = [{ type: 'browser_search' }];
    }
  }
  const r = await fetch(url, { method: 'POST', headers: hd, body: JSON.stringify(b) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && P !== 'builtin') fail(502, j.error?.message || 'The AI provider returned an error (' + r.status + ').');
  if (P === 'claude') return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  if (P === 'gemini') return (j.candidates?.[0]?.content?.parts || []).map((c) => c.text || '').join('');
  return j.choices?.[0]?.message?.content || j.reply || j.text || j.content || '';
}
