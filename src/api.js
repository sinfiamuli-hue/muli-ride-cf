// Muli Ride API - Cloudflare Pages Functions + D1. Bindings: DB. Secrets: ADMIN_PASSWORD, TOKEN_SECRET.
const ISL = 'muli', enc = new TextEncoder(), DAY = 12 * 36e5;
const ST = ['NEW', 'ASSIGNED', 'CONFIRMED', 'PICKED_UP', 'COMPLETED', 'CANCELLED'];
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const same = (a, b) => a.length == b.length && [...a].reduce((r, c, i) => r | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) == 0;
const s = v => String(v ?? '').trim(), ph = v => s(v).replace(/[\s-]/g, ''), okPh = v => /^\+?\d{7,15}$/.test(v);
const BSQL = 'SELECT b.*,d.name dn,d.phone dp,d.taxi dt FROM bookings b LEFT JOIN drivers d ON d.id=b.driver_id';
const toB = r => ({ id: r.id, island: r.island, name: r.name, phone: r.phone, pickup: r.pickup, dest: r.dest, pax: r.pax, when: r.when_type, date: r.date, time: r.time, price: r.price, status: r.status, driverId: r.driver_id || '', driverName: r.dn || '', driverPhone: r.dp || '', taxi: r.dt || '', created: r.created });
const toD = r => ({ id: r.id, name: r.name, phone: r.phone, taxi: r.taxi, active: !!r.active, online: !!r.online });

async function sign(env, p) {
  const k = await crypto.subtle.importKey('raw', enc.encode(env.TOKEN_SECRET || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(p)));
}
async function mk(env, role, id) { const p = role + '.' + id + '.' + (Date.now() + DAY); return p + '.' + await sign(env, p); }
async function auth(env, req) {
  const t = (req.headers.get('authorization') || '').replace('Bearer ', '');
  const [role, id, exp, sig] = t.split('.');
  if (!env.TOKEN_SECRET || !sig || +exp < Date.now()) return null;
  return same(sig, await sign(env, [role, id, exp].join('.'))) ? { role, id } : null;
}
async function rl(env, req, key, max) {
  const ip = req.headers.get('cf-connecting-ip') || 'x', now = Date.now(), k = key + ip + Math.floor(now / 6e4);
  await env.DB.prepare('DELETE FROM rl WHERE t<?').bind(now - 36e5).run();
  await env.DB.prepare('INSERT INTO rl(k,n,t) VALUES(?,1,?) ON CONFLICT(k) DO UPDATE SET n=n+1').bind(k, now).run();
  return (await env.DB.prepare('SELECT n FROM rl WHERE k=?').bind(k).first()).n <= max;
}
async function getSet(env) {
  const r = await env.DB.prepare('SELECT json FROM settings WHERE island=?').bind(ISL).first();
  return { base: 50, night: 20, routes: [], phone: '7900319', ...(r ? JSON.parse(r.json) : {}) };
}
function fare(set, p, d, time) {
  const r = (set.routes || []).find(r => (r.from == p && r.to == d) || (r.from == d && r.to == p));
  let f = r ? +r.fare : +set.base;
  const h = time ? +time.split(':')[0] : (new Date().getUTCHours() + 5) % 24; // Maldives = UTC+5
  if (h >= 22 || h < 5) f += +set.night || 0;
  return f;
}

export async function onRequest({ request: req, env }) {
  const p = new URL(req.url).pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean), m = req.method;
  let b = {};
  if (m != 'GET' && m != 'DELETE') { try { b = await req.json(); } catch { } }
  try { return await route(env, req, m, p, b); } catch (e) { return J({ error: 'server' }, 500); }
}

async function route(env, req, m, p, b) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const hasTok = !!req.headers.get('authorization'), a = await auth(env, req);

  if (p[0] == 'state' && m == 'GET') {
    if (hasTok && !a) return J({ error: 'auth' }, 401);
    const out = { set: await getSet(env), loc: [], drv: [], bk: [] };
    const L = (await q('SELECT id,name,active FROM locations WHERE island=? ORDER BY name', ISL).all()).results;
    out.loc = L.filter(x => a?.role == 'admin' || x.active).map(x => ({ ...x, active: !!x.active }));
    if (a?.role == 'admin') {
      out.drv = (await q('SELECT * FROM drivers WHERE island=?', ISL).all()).results.map(toD);
      out.bk = (await q(BSQL + ' WHERE b.island=? ORDER BY b.created DESC LIMIT 300', ISL).all()).results.map(toB);
    } else if (a?.role == 'driver') {
      const me = await q('SELECT * FROM drivers WHERE id=? AND active=1', a.id).first();
      if (!me) return J({ error: 'auth' }, 401);
      out.drv = [toD(me)];
      out.bk = (await q(BSQL + " WHERE b.driver_id=? AND b.status IN ('ASSIGNED','CONFIRMED','PICKED_UP')", a.id).all()).results.map(toB);
    }
    return J(out);
  }

  if (p[0] == 'bookings' && m == 'POST') {
    if (!await rl(env, req, 'bk', 6)) return J({ error: 'slow down' }, 429);
    const name = s(b.name).slice(0, 60), phone = ph(b.phone), pickup = s(b.pickup).slice(0, 80), dest = s(b.dest).slice(0, 80),
      pax = s(b.pax), when = b.when == 'LATER' ? 'LATER' : 'NOW', date = s(b.date), time = s(b.time);
    if (!name || !okPh(phone) || !pickup || !dest || !['1', '2', '3', '4', '5+'].includes(pax) ||
      (when == 'LATER' && !(/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time)))) return J({ error: 'invalid' }, 400);
    const dup = await q(BSQL + " WHERE b.island=? AND b.phone=? AND b.pickup=? AND b.dest=? AND b.status='NEW' AND b.created>?", ISL, phone, pickup, dest, Date.now() - 12e4).first();
    if (dup) return J(toB(dup));
    const price = fare(await getSet(env), pickup, dest, when == 'LATER' ? time : null);
    for (let i = 0; i < 5; i++) {
      const id = 'MUL-' + (1000 + Math.floor(Math.random() * 9e4));
      try {
        await q("INSERT INTO bookings(id,island,name,phone,pickup,dest,pax,when_type,date,time,price,pay,status,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,'cash','NEW',?)", id, ISL, name, phone, pickup, dest, pax, when, date, time, price, Date.now()).run();
        return J(toB(await q(BSQL + ' WHERE b.id=?', id).first()), 201);
      } catch (e) { }
    }
    return J({ error: 'try again' }, 500);
  }

  if (p[0] == 'lookup' && m == 'POST') {
    if (!await rl(env, req, 'lk', 12)) return J({ error: 'slow down' }, 429);
    const r = await q(BSQL + ' WHERE b.id=? AND b.phone=?', s(b.id).toUpperCase(), ph(b.phone)).first();
    return r ? J(toB(r)) : J({ error: 'not found' }, 404);
  }

  if (p[1] == 'login' && m == 'POST') {
    if (!await rl(env, req, 'lg', 8)) return J({ error: 'slow down' }, 429);
    if (p[0] == 'admin') {
      if (!env.ADMIN_PASSWORD) return J({ error: 'ADMIN_PASSWORD is not set on the server' }, 500);
      if (!env.TOKEN_SECRET) return J({ error: 'TOKEN_SECRET is not set on the server' }, 500);
      if (!same(await sha(s(b.password)), await sha(String(env.ADMIN_PASSWORD).trim()))) return J({ error: 'auth' }, 401);
      return J({ token: await mk(env, 'admin', 'admin') });
    }
    if (p[0] == 'driver') {
      const d = await q('SELECT * FROM drivers WHERE phone=? AND active=1 AND island=?', ph(b.phone), ISL).first();
      if (!d || !same(await sha(d.id + ':' + s(b.pin)), d.pin_hash)) return J({ error: 'auth' }, 401);
      return J({ token: await mk(env, 'driver', d.id) });
    }
  }

  if (p[0] == 'admin') {
    if (a?.role != 'admin') return J({ error: 'auth' }, 401);
    if (p[1] == 'drivers') {
      if (m == 'POST') {
        const name = s(b.name).slice(0, 60), phone = ph(b.phone), pin = s(b.pin);
        if (!name || !okPh(phone) || pin.length < 4) return J({ error: 'invalid' }, 400);
        const id = crypto.randomUUID().slice(0, 8);
        await q('INSERT INTO drivers(id,island,name,phone,taxi,pin_hash,active,online,created) VALUES(?,?,?,?,?,?,1,0,?)', id, ISL, name, phone, s(b.taxi).slice(0, 10), await sha(id + ':' + pin), Date.now()).run();
        return J({ ok: 1 }, 201);
      }
      if (m == 'PATCH') { await q('UPDATE drivers SET active=? WHERE id=? AND island=?', b.active ? 1 : 0, p[2], ISL).run(); return J({ ok: 1 }); }
      if (m == 'DELETE') { await q('DELETE FROM drivers WHERE id=? AND island=?', p[2], ISL).run(); return J({ ok: 1 }); }
    }
    if (p[1] == 'locations') {
      if (m == 'POST' && p[2] == 'seed') {
        for (const n of ['Home', 'Jetty', 'Ferry Terminal', 'School', 'Hospital', 'Guesthouse', 'Shop'])
          await q('INSERT INTO locations(id,island,name,active) VALUES(?,?,?,1)', crypto.randomUUID().slice(0, 8), ISL, n).run();
        return J({ ok: 1 });
      }
      if (m == 'POST') { const n = s(b.name).slice(0, 60); if (!n) return J({ error: 'invalid' }, 400); await q('INSERT INTO locations(id,island,name,active) VALUES(?,?,?,1)', crypto.randomUUID().slice(0, 8), ISL, n).run(); return J({ ok: 1 }, 201); }
      if (m == 'PATCH') { await q('UPDATE locations SET active=? WHERE id=? AND island=?', b.active ? 1 : 0, p[2], ISL).run(); return J({ ok: 1 }); }
      if (m == 'DELETE') { await q('DELETE FROM locations WHERE id=? AND island=?', p[2], ISL).run(); return J({ ok: 1 }); }
    }
    if (p[1] == 'settings' && m == 'PUT') {
      const routes = (Array.isArray(b.routes) ? b.routes : []).slice(0, 100).map(r => ({ from: s(r.from).slice(0, 80), to: s(r.to).slice(0, 80), fare: +r.fare || 0 }));
      const set = { base: Math.max(0, +b.base || 0), night: Math.max(0, +b.night || 0), phone: s(b.phone).slice(0, 20), routes };
      await q('INSERT INTO settings(island,json) VALUES(?,?) ON CONFLICT(island) DO UPDATE SET json=excluded.json', ISL, JSON.stringify(set)).run();
      return J({ ok: 1 });
    }
    if (p[1] == 'bookings' && m == 'PATCH') {
      const f = [], v = [];
      if (b.status) { if (!ST.includes(b.status)) return J({ error: 'bad' }, 400); f.push('status=?'); v.push(b.status); if (b.status == 'NEW') f.push('driver_id=NULL'); }
      if (b.driverId) { if (!await q('SELECT 1 x FROM drivers WHERE id=? AND active=1', s(b.driverId)).first()) return J({ error: 'bad driver' }, 400); f.push('driver_id=?'); v.push(s(b.driverId)); }
      if (b.pickup) { f.push('pickup=?'); v.push(s(b.pickup).slice(0, 80)); }
      if (b.dest) { f.push('dest=?'); v.push(s(b.dest).slice(0, 80)); }
      if (b.price != null && +b.price >= 0) { f.push('price=?'); v.push(+b.price); }
      if (!f.length) return J({ error: 'nothing' }, 400);
      await q('UPDATE bookings SET ' + f.join(',') + ' WHERE id=? AND island=?', ...v, p[2], ISL).run();
      return J({ ok: 1 });
    }
  }

  if (p[0] == 'driver') {
    if (a?.role != 'driver') return J({ error: 'auth' }, 401);
    if (!await q('SELECT 1 x FROM drivers WHERE id=? AND active=1', a.id).first()) return J({ error: 'auth' }, 401);
    if (p[1] == 'me' && m == 'PATCH') { await q('UPDATE drivers SET online=? WHERE id=?', b.online ? 1 : 0, a.id).run(); return J({ ok: 1 }); }
    if (p[1] == 'bookings' && m == 'PATCH') {
      const T = { ASSIGNED: ['CONFIRMED', 'NEW'], CONFIRMED: ['PICKED_UP'], PICKED_UP: ['COMPLETED'] };
      const r = await q('SELECT status FROM bookings WHERE id=? AND driver_id=?', p[2], a.id).first();
      if (!r || !(T[r.status] || []).includes(b.status)) return J({ error: 'not allowed' }, 403);
      if (b.status == 'NEW') await q("UPDATE bookings SET status='NEW',driver_id=NULL WHERE id=?", p[2]).run();
      else await q('UPDATE bookings SET status=? WHERE id=?', b.status, p[2]).run();
      return J({ ok: 1 });
    }
  }
  return J({ error: 'not found' }, 404);
}
