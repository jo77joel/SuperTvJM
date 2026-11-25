// Super TV – activación, panel admin y descarga protegida del APK. Sin dependencias (Node 18+).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'cambia-esta-clave';
const DATA = process.env.DATA_DIR || __dirname;
const MAX_DESC = parseInt(process.env.MAX_DESCARGAS, 10) || 3;
const MAX_DISP = parseInt(process.env.MAX_DISPOSITIVOS, 10) || 2;
const MAX_APK = 500 * 1024 * 1024;
const DB = path.join(DATA, 'data.json'), APK = path.join(DATA, 'app.apk'), APK_BUN = path.join(__dirname, 'apk', 'app.apk');
// APK vigente: el más nuevo entre el subido desde el panel y el incluido en el proyecto
const cur = () => { const l = [APK, APK_BUN].filter(f => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); return l[0] || null; };
fs.mkdirSync(DATA, { recursive: true });
const sessions = new Set();

// --- Datos: en memoria + archivo + (opcional) Upstash Redis gratis para que no se pierdan en Render gratis ---
const RURL = process.env.UPSTASH_URL, RTOK = process.env.UPSTASH_TOKEN, APK_URL = process.env.APK_URL;
const redis = (cmd) => fetch(RURL, { method: 'POST', headers: { Authorization: 'Bearer ' + RTOK, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) })
  .then(r => r.json()).then(j => { if (j.error) throw new Error(j.error); return j.result; });
let cache = {}, timer = null, dirty = false;
const load = () => cache;
async function flush() {
  timer = null; if (!dirty) return; dirty = false;
  try { await redis(['SET', 'stv:db', JSON.stringify(cache)]); } catch (e) { console.error('Redis:', e.message); dirty = true; timer = setTimeout(flush, 5000); }
}
const save = (d) => { cache = d; try { fs.writeFileSync(DB, JSON.stringify(d, null, 2)); } catch (e) {} if (RURL) { dirty = true; if (!timer) timer = setTimeout(flush, 300); } };
async function init() {
  if (RURL) {
    for (let i = 0; i < 5; i++) {
      try { const v = await redis(['GET', 'stv:db']); cache = v ? JSON.parse(v) : {}; return; }
      catch (e) { console.error('Redis:', e.message); await new Promise(r => setTimeout(r, 2000)); }
    }
    console.error('No se pudo leer Redis; se detiene para no borrar tus datos.'); process.exit(1);
  }
  try { cache = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) { cache = {}; }
}
// --- APK alojado fuera (GitHub Releases): el servidor lo entrega sin mostrar el enlace real ---
async function proxyApk(req, res) {
  try {
    const h = req.headers.range ? { Range: req.headers.range } : {};
    const r = await fetch(APK_URL, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: h, redirect: 'follow' });
    if (!r.ok) return text(res, 502, 'No se pudo obtener la app. Intenta más tarde.');
    const o = { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="SuperTV.apk"', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    ['content-length', 'content-range'].forEach(k => { const v = r.headers.get(k); if (v) o[k] = v; });
    res.writeHead(r.status, o);
    if (req.method === 'HEAD' || !r.body) return res.end();
    require('stream').Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) { if (!res.headersSent) text(res, 502, 'No se pudo obtener la app. Intenta más tarde.'); else res.destroy(); }
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const text = (res, code, s) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(s); };
const body = (req) => new Promise((ok) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { ok({}); } }); });
const same = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const authed = (req) => sessions.has((req.headers.authorization || '').replace('Bearer ', ''));
const file = (res, f, type) => { try { const a = path.join(__dirname, 'public', f), b = path.join(__dirname, f); res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' }); res.end(fs.readFileSync(fs.existsSync(a) ? a : b)); } catch (e) { res.writeHead(404); res.end('No encontrado'); } };
const hasApk = () => !!cur() || !!APK_URL;
const isPk = (f) => { const fd = fs.openSync(f, 'r'), b = Buffer.alloc(2); fs.readSync(fd, b, 0, 2, 0); fs.closeSync(fd); return b[0] === 0x50 && b[1] === 0x4b; };
const valid = (c) => c && !(c.expira && Date.now() > c.expira);

function sendApk(req, res, c, db) {
  const F = cur(); if (!F) return proxyApk(req, res);
  const st = fs.statSync(F); let start = 0, end = st.size - 1, code = 200;
  const h = { 'Content-Type': 'application/vnd.android.package-archive', 'Content-Disposition': 'attachment; filename="SuperTV.apk"', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (r) {
    if (r[1] !== '') { start = +r[1]; if (r[2] !== '') end = Math.min(+r[2], end); }
    else if (r[2] !== '') start = Math.max(0, st.size - +r[2]);
    if (start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    code = 206; h['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
  }
  h['Content-Length'] = end - start + 1;
  res.writeHead(code, h);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(F, { start, end }).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname; let m;
  try {
    // ---- Cliente: consulta de su enlace ----
    if ((m = p.match(/^\/api\/activar\/([a-f0-9]{6,32})$/))) {
      const c = load()[m[1]];
      if (!c) return send(res, 404, { error: 'no existe' });
      if (!valid(c)) return send(res, 410, { error: 'vencido' });
      if (!c.pagado) return send(res, 200, { pagado: false });
      const max = c.max || MAX_DESC;
      return send(res, 200, { pagado: true, nombre: c.nombre, apk: hasApk(), instalado: (c.inst || []).length, confirmo: c.confirmo || 0, restantes: Math.max(0, max - (c.usos || 0)), expira: c.expira ? new Date(c.expira).toLocaleDateString('es-PE') : '' });
    }
    if (/^\/a\/[a-f0-9]+$/.test(p)) return file(res, 'activar.html', 'text/html; charset=utf-8');

    // ---- Cliente: descarga del APK (solo si pagó) ----
    if ((m = p.match(/^\/d\/([a-f0-9]{6,32})$/)) && (req.method === 'GET' || req.method === 'HEAD')) {
      const db = load(), c = db[m[1]];
      if (!valid(c)) return text(res, 404, 'Enlace vencido o no válido. Pídele a tu vendedor uno nuevo.');
      if (!c.pagado) return text(res, 402, 'Pago pendiente. Cuando se confirme podrás descargar.');
      if (!hasApk()) return text(res, 503, 'La app aún no está lista. Intenta más tarde.');
      const max = c.max || MAX_DESC, reciente = c.ultimo && Date.now() - c.ultimo < 120000;
      if (req.method === 'GET' && !reciente) {
        if ((c.usos || 0) >= max) return text(res, 403, 'Llegaste al límite de descargas. Pídele a tu vendedor que habilite otra.');
        c.usos = (c.usos || 0) + 1; c.ultimo = Date.now(); const ua = req.headers['user-agent'] || ''; c.disp = /AFT|Amazon/i.test(ua) ? 'Fire TV' : /TV|BRAVIA|SMART/i.test(ua) ? 'TV' : /Android/i.test(ua) ? 'Android' : 'Otro'; save(db);
      }
      return sendApk(req, res, c, db);
    }

    // ---- La app Super TV confirma que se instaló/activó (y valida su licencia) ----
    if (p === '/api/app/activar' && req.method === 'POST') {
      const b = await body(req), db = load(), t = String(b.codigo || '').trim().toLowerCase(), c = db[t];
      if (!c) return send(res, 404, { error: 'codigo' });
      if (!valid(c)) return send(res, 410, { error: 'vencido' });
      if (!c.pagado) return send(res, 402, { error: 'pago' });
      const id = String(b.id || '').slice(0, 64); if (!id) return send(res, 400, { error: 'id' });
      c.inst = c.inst || []; let d = c.inst.find(x => x.id === id);
      if (!d) { if (c.inst.length >= MAX_DISP) return send(res, 403, { error: 'limite' }); d = { id, fecha: Date.now() }; c.inst.push(d); }
      d.modelo = String(b.modelo || '').slice(0, 40); d.visto = Date.now(); save(db);
      return send(res, 200, { ok: true, nombre: c.nombre, expira: c.expira });
    }

    // ---- El cliente avisa desde su página que ya instaló la app (dato declarado por él) ----
    if ((m = p.match(/^\/api\/instalada\/([a-f0-9]{6,32})$/)) && req.method === 'POST') {
      await body(req); const db = load(), c = db[m[1]];
      if (!valid(c)) return send(res, 404, { error: 'no existe' });
      if (!c.pagado) return send(res, 402, { error: 'pago' });
      if (!c.confirmo) { const ua = req.headers['user-agent'] || ''; c.confirmo = Date.now(); c.confDisp = /AFT|Amazon/i.test(ua) ? 'Fire TV' : /TV|BRAVIA|SMART/i.test(ua) ? 'TV' : /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone' : 'Otro'; save(db); }
      return send(res, 200, { ok: 1 });
    }

    // ---- Admin ----
    if (p === '/admin' || p === '/admin/') return file(res, 'admin.html', 'text/html; charset=utf-8');
    if (p === '/admin/api/login' && req.method === 'POST') {
      const b = await body(req);
      if (!same(b.pass || '', ADMIN_PASS)) return send(res, 401, { error: 'Clave incorrecta' });
      const t = crypto.randomBytes(24).toString('hex'); sessions.add(t); return send(res, 200, { token: t });
    }
    if (p.startsWith('/admin/api/')) {
      if (!authed(req)) { req.resume(); return send(res, 401, { error: 'sesión' }); }
      if (p === '/admin/api/apk' && req.method === 'GET') {
        if (!cur()) return send(res, 200, { existe: !!APK_URL, enlace: !!APK_URL });
        const s = fs.statSync(cur()); return send(res, 200, { existe: true, size: s.size, fecha: s.mtimeMs });
      }
      if (p === '/admin/api/apk' && req.method === 'PUT') {          // subida por partes
        const off = +u.searchParams.get('offset') || 0, total = +u.searchParams.get('total') || 0, tmp = APK + '.tmp';
        if (!total || total > MAX_APK) { req.resume(); return send(res, 413, { error: 'archivo muy grande' }); }
        if (off === 0) fs.writeFileSync(tmp, '');
        else if (!fs.existsSync(tmp) || fs.statSync(tmp).size !== off) { req.resume(); return send(res, 409, { error: 'reintenta la subida' }); }
        const ws = fs.createWriteStream(tmp, { flags: 'r+', start: off });
        ws.on('error', () => send(res, 500, { error: 'no se pudo guardar' }));
        ws.on('finish', () => {
          const sz = fs.statSync(tmp).size;
          if (sz < total) return send(res, 200, { ok: 1, parcial: true });
          if (sz > total || !isPk(tmp)) { fs.unlinkSync(tmp); return send(res, 400, { error: 'ese archivo no es un APK' }); }
          fs.renameSync(tmp, APK); send(res, 200, { ok: 1, listo: true });
        });
        return req.pipe(ws);
      }
      const db = load();
      if (p === '/admin/api/clientes' && req.method === 'GET')
        return send(res, 200, Object.entries(db).map(([t, c]) => Object.assign({ token: t, maxEf: c.max || MAX_DESC }, c)).sort((a, b) => b.creado - a.creado));
      if (p === '/admin/api/clientes' && req.method === 'POST') {
        const b = await body(req), t = crypto.randomBytes(4).toString('hex'), dias = parseInt(b.dias, 10) || 30;
        db[t] = { nombre: String(b.nombre || 'Cliente').slice(0, 60), tel: String(b.tel || '').replace(/\D/g, ''), pagado: false, usos: 0, max: (parseInt(b.max, 10) > 0 ? Math.min(parseInt(b.max, 10), 10) : undefined), creado: Date.now(), expira: Date.now() + dias * 864e5 };
        save(db); return send(res, 200, { token: t });
      }
      if ((m = p.match(/^\/admin\/api\/clientes\/([a-f0-9]+)(\/pagar|\/descarga|\/reset)?$/)) && db[m[1]]) {
        const c = db[m[1]];
        if (m[2] === '/pagar' && req.method === 'POST') { c.pagado = !c.pagado; save(db); return send(res, 200, { ok: 1 }); }
        if (m[2] === '/descarga' && req.method === 'POST') { c.max = (c.max || MAX_DESC) + 1; save(db); return send(res, 200, { ok: 1 }); }
        if (m[2] === '/reset' && req.method === 'POST') { c.inst = []; save(db); return send(res, 200, { ok: 1 }); }
        if (!m[2] && req.method === 'DELETE') { delete db[m[1]]; save(db); return send(res, 200, { ok: 1 }); }
      }
      return send(res, 404, { error: 'no existe' });
    }
    if (p === '/') { res.writeHead(302, { Location: '/admin/' }); return res.end(); }
    res.writeHead(404); res.end('No encontrado');
  } catch (e) { console.error(e); if (!res.headersSent) text(res, 500, 'Error del servidor'); }
});
server.requestTimeout = 0;
init().then(() => server.listen(PORT, () => console.log('Super TV activo en puerto ' + PORT)));
