/* Joo-JeoB 이용 기록 서버 — Cloudflare Worker + D1 (서버리스)
   · POST /track              앱이 가입·로그인·접속·영상 만들기를 알린다(동의한 사람만, 비밀번호·영상은 받지 않음)
   · GET  /admin              관리자 페이지
   · GET  /admin/api/status   설정이 끝났는지, 로그인돼 있는지
   · POST /admin/api/login    관리자 비밀번호 + 인증 앱 6자리 코드 → 8시간 세션 쿠키
   · POST /admin/api/logout
   · GET  /admin/api          전체 목록 (세션 필요)
   · POST /admin/api/delete   한 사람의 기록 지우기 {id} (세션 필요)
   관리자는 주인만 들어온다: 비밀번호(12자 이상)와 주인 휴대폰 인증 앱의 코드가 둘 다 맞아야 하고,
   한 번 쓴 코드는 다시 못 쓰며(동시에 보내도 한 번만), 틀리면 잠긴다(같은 곳에서 15분에 5번.
   비밀번호는 맞고 코드만 틀린 시도는 전체에서 1시간에 10번 — 비밀번호를 모르는 사람은 주인을 잠글 수 없다).
   시도는 먼저 적고 센다: 한꺼번에 몰아 보내도 정해진 횟수만 확인을 받는다.
   세션 쿠키는 HttpOnly · Secure · SameSite=Strict 라 스크립트로 읽을 수 없고 다른 사이트에서는 실리지 않는다.
   ADMIN_PASS 나 ADMIN_TOTP 를 바꾸면 이전 로그인은 모두 풀린다.
   대시보드 → 이 Worker → Settings 에서 연결한다
   · Bindings: D1 database, 변수 이름 DB
   · Variables and Secrets (Secret): ADMIN_PASS = 관리자 비밀번호, ADMIN_TOTP = 인증 앱 키(관리자 페이지에서 만든다)
   · (선택) ALLOW_ORIGIN = 앱 주소, 여러 개면 쉼표로(예: https://joo-jeo-b.vercel.app). 비우면 어디서 오든 받는다.
     브라우저가 아닌 프로그램은 출처를 꾸밀 수 있으므로, 함부로 보내는 것까지 막으려면 TRACK_LIMIT(속도 제한)도 켠다
   표는 첫 요청 때 저절로 만든다. 마지막 이용 후 1년이 지난 기록은 기록이 들어올 때와 매일(Cron Trigger) 지운다.
   사용자가 동의를 철회하면(type: forget) 그 기기·이름의 기록을 바로 지운다. */

const KEEP_MS = 365 * 24 * 3600 * 1000;
const SESSION_MS = 8 * 3600 * 1000;
// 종류별로 [로그인 횟수 +, 영상 수 +, 마지막 로그인 시각 갱신]
const TYPES = { signup: [1, 0, 1], login: [1, 0, 1], visit: [0, 0, 0], work: [0, 1, 0] };

let ready = null;
function init(db) {
  ready = ready || db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, dev TEXT NOT NULL, name TEXT NOT NULL, device TEXT,
      created_at INTEGER NOT NULL, last_login INTEGER, last_seen INTEGER NOT NULL,
      logins INTEGER NOT NULL DEFAULT 0, works INTEGER NOT NULL DEFAULT 0)`),
    db.prepare('CREATE INDEX IF NOT EXISTS users_seen ON users(last_seen)'),
    db.prepare('CREATE TABLE IF NOT EXISTS admin_sessions (h TEXT PRIMARY KEY, exp INTEGER NOT NULL, fp TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS admin_fails (ip TEXT NOT NULL, at INTEGER NOT NULL, pw INTEGER NOT NULL DEFAULT 0)'),
    db.prepare('CREATE TABLE IF NOT EXISTS admin_state (k TEXT PRIMARY KEY, v TEXT NOT NULL)'),
    db.prepare("INSERT OR IGNORE INTO admin_state (k, v) VALUES ('totp_last', '0')"),
  ]).catch((e) => { ready = null; throw e; });
  return ready;
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const enc = new TextEncoder();
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function deviceOf(ua) {
  ua = ua || '';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '기타';
  const br = /KAKAOTALK/i.test(ua) ? '카카오톡' : /NAVER\(inapp/i.test(ua) ? '네이버' : /Instagram/.test(ua) ? '인스타그램'
    : /SamsungBrowser/.test(ua) ? '삼성 인터넷' : /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '기타';
  return os + ' · ' + br;
}

/* 앱이 보내는 기록. 다른 사이트에서 보낸 것은 ALLOW_ORIGIN 으로 거른다 */
async function track(request, env, allow) {
  if (!allow) return json({ ok: false, error: 'origin' }, 403);
  const cors = { 'access-control-allow-origin': allow };
  if (env.TRACK_LIMIT) {
    const { success } = await env.TRACK_LIMIT.limit({ key: request.headers.get('cf-connecting-ip') || 'local' });
    if (!success) return json({ ok: false, error: 'rate' }, 429, cors);
  }
  let b = null;
  try { b = JSON.parse(await request.text()); } catch (e) {}
  const type = b && b.type, forget = type === 'forget';
  const t = forget ? null : (Object.prototype.hasOwnProperty.call(TYPES, type) ? TYPES[type] : undefined);
  const dev = String((b && b.dev) || ''), name = String((b && b.name) || '').trim();
  if (t === undefined || !/^[0-9a-f]{16,64}$/.test(dev) || !name || [...name].length > 24) return json({ ok: false, error: 'input' }, 400, cors);
  if (!env.DB) return json({ ok: false, error: 'no DB binding' }, 503, cors);
  await init(env.DB);
  const now = Date.now();
  const purge = env.DB.prepare('DELETE FROM users WHERE last_seen < ?1').bind(now - KEEP_MS);
  if (forget) {
    await env.DB.batch([env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(dev + ':' + name), purge]);
    return json({ ok: true }, 200, cors);
  }
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (id, dev, name, device, created_at, last_login, last_seen, logins, works)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5, ?7, ?8)
      ON CONFLICT(id) DO UPDATE SET device = excluded.device, last_seen = excluded.last_seen,
        last_login = COALESCE(excluded.last_login, users.last_login),
        logins = users.logins + excluded.logins, works = users.works + excluded.works`)
      .bind(dev + ':' + name, dev, name, deviceOf(request.headers.get('user-agent')), now, t[2] ? now : null, t[0], t[1]),
    purge,
  ]);
  return json({ ok: true }, 200, cors);
}

/* ---------- 관리자 확인 ---------- */
function base32(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, val = 0;
  const out = [];
  for (const c of String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    val = ((val << 5) | A.indexOf(c)) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
// RFC 6238 (30초, 6자리, HMAC-SHA1): Google Authenticator 등 일반 인증 앱과 같은 방식
async function totp(key, step) {
  const msg = new Uint8Array(8);
  for (let i = 7, c = step; i >= 0; i--, c = Math.floor(c / 256)) msg[i] = c & 255;
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', k, msg));
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}
const setupOf = (env) => ({ db: !!env.DB, pass: String(env.ADMIN_PASS || '').length >= 12, totp: base32(env.ADMIN_TOTP).length >= 10 });
const cookieOf = (request) => {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)jj_admin=([0-9a-f]{64})(?:;|$)/);
  return m ? m[1] : '';
};
const fpOf = (env) => sha256('jj-admin\n' + String(env.ADMIN_PASS) + '\n' + String(env.ADMIN_TOTP));
async function session(request, env, now) {
  const t = cookieOf(request);
  if (!t) return false;
  const row = await env.DB.prepare('SELECT exp, fp FROM admin_sessions WHERE h = ?1').bind(await sha256(t)).first();
  return !!row && row.exp > now && row.fp === (await fpOf(env));   // 비밀 값을 바꾸면 이전 로그인은 모두 풀린다
}

async function login(request, env, now) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  let b = null;
  try { b = await request.json(); } catch (e) {}
  const pass = String((b && b.pass) || ''), code = String((b && b.code) || '').replace(/\s/g, '');
  // 비밀번호는 늘 같은 방식으로 비교한다(맞았는지가 걸린 시간으로 드러나지 않게)
  const [x, y] = await Promise.all([sha256(pass), sha256(String(env.ADMIN_PASS))]);
  let d = pass ? 0 : 1;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i);
  const pwOk = d === 0;
  // 시도를 먼저 적고 센다(한 트랜잭션): 한꺼번에 몰아 보내도 정해진 횟수만 확인을 받는다
  const [, mine, guess, state] = await env.DB.batch([
    env.DB.prepare('INSERT INTO admin_fails (ip, at, pw) VALUES (?1, ?2, ?3)').bind(ip, now, pwOk ? 1 : 0),
    env.DB.prepare('SELECT COUNT(*) AS n FROM admin_fails WHERE ip = ?1 AND at > ?2').bind(ip, now - 15 * 60000),
    env.DB.prepare('SELECT COUNT(*) AS n FROM admin_fails WHERE pw = 1 AND at > ?1').bind(now - 3600000),
    env.DB.prepare("SELECT v FROM admin_state WHERE k = 'totp_last'"),
  ]);
  if (mine.results[0].n > 5 || guess.results[0].n > 10) return json({ error: '틀린 시도가 많아 잠시 잠겼습니다. 15분쯤 뒤에 다시 해 주세요.' }, 429);
  let step = -1;
  if (/^\d{6}$/.test(code)) {
    const key = base32(env.ADMIN_TOTP), c = Math.floor(now / 30000), last = Number((state.results[0] || {}).v || 0);
    for (const s of [c, c - 1, c + 1]) if (s > last && (await totp(key, s)) === code) { step = s; break; }
  }
  // 코드를 쓴 것으로 바꾸는 일은 조건 하나로 한 번에: 같은 코드로 동시에 들어와도 한 번만 성공한다
  const used = (pwOk && step >= 0) ? await env.DB.prepare("UPDATE admin_state SET v = ?1 WHERE k = 'totp_last' AND CAST(v AS INTEGER) < ?2")
    .bind(String(step), step).run() : null;
  if (!used || !used.meta || used.meta.changes !== 1) {
    await wait(400);
    return json({ error: '비밀번호나 인증 코드가 맞지 않습니다.' }, 401);
  }
  const tok = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_fails WHERE ip = ?1 OR pw = 1 OR at < ?2').bind(ip, now - 86400000),
    env.DB.prepare('DELETE FROM admin_sessions WHERE exp < ?1').bind(now),
    env.DB.prepare('INSERT INTO admin_sessions (h, exp, fp) VALUES (?1, ?2, ?3)').bind(await sha256(tok), now + SESSION_MS, await fpOf(env)),
  ]);
  return json({ ok: true }, 200, { 'set-cookie': `jj_admin=${tok}; Path=/admin; Max-Age=${SESSION_MS / 1000}; HttpOnly; Secure; SameSite=Strict` });
}

async function adminApi(request, env, path) {
  const setup = setupOf(env), now = Date.now();
  const done = setup.db && setup.pass && setup.totp;
  if (path === '/admin/api/status') {
    if (done) await init(env.DB);
    return json({ setup, authed: done ? await session(request, env, now) : false });
  }
  if (!done) return json({ error: '관리자 설정이 아직 끝나지 않았습니다.', setup }, 503);
  if (request.method === 'POST') {
    // 이 페이지에서 보낸 것만(다른 사이트가 몰래 보내는 요청을 막는다)
    const origin = request.headers.get('origin');
    if (request.headers.get('x-jj-admin') !== '1' || (origin && origin !== new URL(request.url).origin)) return json({ error: 'forbidden' }, 403);
  }
  await init(env.DB);
  if (path === '/admin/api/login' && request.method === 'POST') return login(request, env, now);
  if (path === '/admin/api/logout' && request.method === 'POST') {
    const t = cookieOf(request);
    if (t) await env.DB.prepare('DELETE FROM admin_sessions WHERE h = ?1').bind(await sha256(t)).run();
    return json({ ok: true }, 200, { 'set-cookie': 'jj_admin=; Path=/admin; Max-Age=0; HttpOnly; Secure; SameSite=Strict' });
  }
  if (!(await session(request, env, now))) return json({ error: '로그인이 필요합니다.' }, 401);
  if (path === '/admin/api' && request.method === 'GET') {
    const [, list, stats] = await env.DB.batch([
      env.DB.prepare('DELETE FROM users WHERE last_seen < ?1').bind(now - KEEP_MS),
      env.DB.prepare(`SELECT id, name, device, created_at, last_login, last_seen, logins, works
        FROM users ORDER BY last_seen DESC LIMIT 5000`),
      env.DB.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(last_seen >= ?1), 0) AS active7,
        COALESCE(SUM(logins), 0) AS logins, COALESCE(SUM(works), 0) AS works FROM users`).bind(now - 7 * 864e5),
    ]);
    return json({ users: list.results, stats: stats.results[0], now });
  }
  if (path === '/admin/api/delete' && request.method === 'POST') {
    let b = null;
    try { b = await request.json(); } catch (e) {}
    if (!b || typeof b.id !== 'string') return json({ error: 'id' }, 400);
    await env.DB.prepare('DELETE FROM users WHERE id = ?1').bind(b.id).run();
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/track') {
      const origin = request.headers.get('origin');
      const list = (env.ALLOW_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
      const allow = !list.length ? '*' : (origin && list.includes(origin) ? origin : null);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
        'access-control-allow-origin': allow || 'null', 'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' } });
      if (request.method === 'POST') return track(request, env, allow);
      return json({ error: 'method' }, 405);
    }
    if (path.startsWith('/admin/api')) return adminApi(request, env, path);
    if (path === '/admin') return new Response(ADMIN_HTML, { headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } });
    if (path === '/') return Response.redirect(url.origin + '/admin', 302);
    return json({ error: 'not found' }, 404);
  },
  // 매일 한 번 1년 지난 기록 지우기(Settings → Triggers → Cron Triggers 또는 wrangler.toml [triggers])
  async scheduled(event, env) {
    if (!env.DB) return;
    await init(env.DB);
    await env.DB.prepare('DELETE FROM users WHERE last_seen < ?1').bind(Date.now() - KEEP_MS).run();
  },
};

const ADMIN_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Joo-JeoB 관리자</title>
<style>
:root{--bg:#0B0D12;--panel:#13161D;--panel2:#1A1E28;--line:#262C38;--cy:#8AB0FF;--ink:#0B1020;--tx:#ECEFF4;--tx2:#A7AEBC;--tx3:#707888;--ok:#3DD68C;--bad:#FF6B6B}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.6 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:20px 16px 48px}
h1{margin:0 0 4px;font-size:22px}
h2{margin:0 0 10px;font-size:16px}
.sub{margin:0 0 18px;color:var(--tx2);font-size:13px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px}
label{display:block;font-size:12.5px;color:var(--tx2);margin:10px 0 6px}
label:first-of-type{margin-top:0}
input,select{width:100%;min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel2);color:var(--tx);font:inherit}
button,a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 16px;border-radius:10px;border:1px solid var(--line);background:var(--panel2);color:var(--tx);font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
button.pri{background:var(--cy);border-color:var(--cy);color:var(--ink)}
button.bad{color:var(--bad)}
.full{width:100%;margin-top:14px}
.row{display:flex;gap:8px;align-items:center}
.err{margin-top:10px;color:var(--bad);font-size:13px}
.check{list-style:none;margin:0 0 12px;padding:0;display:grid;gap:6px;font-size:13.5px}
.check li{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:6px 0}
.check .y,.check .n{flex:none;white-space:nowrap;font-weight:700}.check .y{color:var(--ok)}.check .n{color:var(--bad)}
.key{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:17px;letter-spacing:.06em;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px;word-break:keep-all;margin:10px 0}
ol{margin:10px 0 0;padding-left:20px;color:var(--tx2);font-size:13px}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}
.stats div{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px}
.stats b{display:block;font-size:11px;color:var(--tx3);font-weight:600}
.stats span{font-size:20px;font-weight:700;color:var(--cy)}
.tools{display:grid;grid-template-columns:1fr 180px auto;gap:8px;margin-bottom:12px}
.tools .row button{flex:1;white-space:nowrap}
.list{display:grid;gap:8px}
.u{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:center}
.u .nm{font-weight:700;overflow-wrap:anywhere}
.u .dv,.u .ct{color:var(--tx2);font-size:12.5px}
.u .tm{grid-column:1/-1;color:var(--tx3);font-size:12px}
.u button{grid-column:2;grid-row:1/3;min-height:36px;font-size:12.5px}
.empty{color:var(--tx3);text-align:center;padding:28px 0}
.note{margin-top:18px;color:var(--tx3);font-size:12px}
@media (max-width:640px){.stats{grid-template-columns:repeat(2,1fr)}.tools{grid-template-columns:1fr 1fr}.tools .row{grid-column:1/-1}}
</style></head>
<body><div class="wrap">
<h1>Joo-JeoB 관리자</h1>
<p class="sub">로그인 · 가입한 사용자 현황 (기록 전송에 동의한 사람만)</p>

<div class="card" id="setup" hidden>
  <h2>관리자 설정이 아직 끝나지 않았습니다</h2>
  <ul class="check" id="checks"></ul>
  <div id="totpBox" hidden>
    <p class="sub" style="margin:0">인증 앱 키가 필요합니다. 아래 버튼을 누르면 이 화면 안에서만 무작위 키가 만들어지고, 어디로도 보내지 않습니다.</p>
    <button class="pri full" id="mkKey">인증 앱 키 만들기</button>
    <div id="keyOut" hidden>
      <div class="key" id="keyText"></div>
      <a class="btn" id="keyLink" href="#">휴대폰 인증 앱에 바로 추가</a>
      <ol>
        <li>휴대폰 인증 앱(Google Authenticator 등)에서 '설정 키 입력'으로 위 키를 추가하세요. 계정 이름은 아무거나, 종류는 시간 기준입니다.</li>
        <li>Cloudflare 대시보드 → 이 Worker → Settings → Variables and Secrets → Add → 종류 Secret, 이름 <b>ADMIN_TOTP</b>, 값에 같은 키를 넣고 저장하세요.</li>
        <li>이 페이지를 새로 고치면 로그인 칸이 나옵니다. 화면을 닫기 전에 두 곳에 다 넣으세요.</li>
      </ol>
    </div>
  </div>
</div>

<div class="card" id="gate" hidden>
  <label for="pw">관리자 비밀번호</label>
  <input id="pw" type="password" autocomplete="current-password">
  <label for="code">인증 앱 6자리 코드</label>
  <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456">
  <button class="pri full" id="go">열기</button>
  <div class="err" id="gateErr" hidden></div>
</div>

<div id="main" hidden>
  <div class="stats">
    <div><b>전체 사용자</b><span id="sTotal">0</span></div>
    <div><b>최근 7일 접속</b><span id="sActive">0</span></div>
    <div><b>총 로그인</b><span id="sLogins">0</span></div>
    <div><b>만든 영상</b><span id="sWorks">0</span></div>
  </div>
  <div class="tools">
    <input id="q" type="search" placeholder="이름 · 기기로 찾기">
    <select id="sort">
      <option value="last_seen">마지막 접속순</option>
      <option value="created_at">가입순(최근)</option>
      <option value="logins">로그인 많은 순</option>
      <option value="works">영상 많은 순</option>
    </select>
    <div class="row"><button id="reload">새로 고침</button><button id="out">잠그기</button></div>
  </div>
  <div class="err" id="mainErr" hidden></div>
  <div class="list" id="list"></div>
  <p class="note">같은 이름이라도 기기가 다르면 다른 사람으로 셉니다(계정이 각 기기 안에만 있기 때문). 마지막 이용 후 1년이 지난 기록은 저절로 지워집니다. 로그인은 8시간 뒤 풀립니다.</p>
</div>
</div>
<script>
'use strict';
const $ = (id) => document.getElementById(id);
let users = [];
const when = (ms) => ms ? new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: '2-digit', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-jj-admin': '1' }, body: JSON.stringify(body) };
  const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opt));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || ('오류 ' + r.status)); e.status = r.status; throw e; }
  return d;
}
function view(name, err) {
  for (const id of ['setup', 'gate', 'main']) $(id).hidden = id !== name;
  const box = name === 'main' ? $('mainErr') : $('gateErr');
  box.hidden = !err; box.textContent = err || '';
}
function render() {
  const q = $('q').value.trim().toLowerCase(), k = $('sort').value;
  const rows = users.filter((u) => !q || (u.name + ' ' + u.device).toLowerCase().includes(q)).sort((a, b) => (b[k] || 0) - (a[k] || 0));
  const list = $('list');
  list.textContent = '';
  if (!rows.length) { const p = document.createElement('div'); p.className = 'empty'; p.textContent = users.length ? '찾는 사용자가 없습니다.' : '아직 기록이 없습니다.'; list.append(p); return; }
  for (const u of rows) {
    const el = document.createElement('div'); el.className = 'u';
    const nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = u.name;
    const dv = document.createElement('div'); dv.className = 'dv'; dv.textContent = u.device || '-';
    const ct = document.createElement('div'); ct.className = 'ct'; ct.textContent = '로그인 ' + u.logins + '회 · 영상 ' + u.works + '개';
    const tm = document.createElement('div'); tm.className = 'tm';
    tm.textContent = '가입 ' + when(u.created_at) + ' · 마지막 로그인 ' + when(u.last_login) + ' · 마지막 접속 ' + when(u.last_seen);
    const del = document.createElement('button'); del.className = 'bad'; del.textContent = '기록 삭제';
    del.addEventListener('click', async () => {
      if (!confirm(u.name + ' (' + (u.device || '-') + ') 의 기록을 지울까요? 되돌릴 수 없습니다.')) return;
      try { await api('/admin/api/delete', { id: u.id }); await load(); } catch (e) { e.status === 401 ? view('gate', e.message) : view('main', e.message); }
    });
    el.append(nm, del, dv, ct, tm);
    list.append(el);
  }
}
async function load() {
  try {
    const d = await api('/admin/api');
    users = d.users || [];
    $('sTotal').textContent = d.stats.total; $('sActive').textContent = d.stats.active7;
    $('sLogins').textContent = d.stats.logins; $('sWorks').textContent = d.stats.works;
    view('main'); render();
  } catch (e) { e.status === 401 ? view('gate', e.message) : view('main', e.message); }
}
async function start() {
  let s;
  try { s = await api('/admin/api/status'); } catch (e) { view('gate', e.message); return; }
  const ok = s.setup.db && s.setup.pass && s.setup.totp;
  if (!ok) {
    const items = [['D1 데이터베이스 연결 (Bindings → 변수 이름 DB)', s.setup.db], ['관리자 비밀번호 ADMIN_PASS (Secret, 12자 이상)', s.setup.pass], ['인증 앱 키 ADMIN_TOTP (Secret)', s.setup.totp]];
    $('checks').textContent = '';
    for (const [t, y] of items) {
      const li = document.createElement('li'); const a = document.createElement('span'); a.textContent = t;
      const b = document.createElement('span'); b.className = y ? 'y' : 'n'; b.textContent = y ? '됨' : '필요';
      li.append(a, b); $('checks').append(li);
    }
    $('totpBox').hidden = s.setup.totp;
    view('setup'); return;
  }
  if (s.authed) load(); else view('gate');
}
$('mkKey').addEventListener('click', () => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0, val = 0, key = '';
  for (const x of bytes) { val = ((val << 8) | x) & 0xffff; bits += 8; while (bits >= 5) { key += A[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  $('keyText').textContent = key.replace(/(.{4})/g, '$1 ').trim();
  $('keyLink').href = 'otpauth://totp/Joo-JeoB:admin?secret=' + key + '&issuer=Joo-JeoB&algorithm=SHA1&digits=6&period=30';
  $('keyOut').hidden = false;
});
$('go').addEventListener('click', async () => {
  const pass = $('pw').value, code = $('code').value.replace(/\\s/g, '');
  $('go').disabled = true;
  try { await api('/admin/api/login', { pass, code }); $('pw').value = ''; $('code').value = ''; await load(); }
  catch (e) { view('gate', e.message); $('code').value = ''; }
  $('go').disabled = false;
});
for (const id of ['pw', 'code']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('go').click(); });
$('reload').addEventListener('click', load);
$('out').addEventListener('click', async () => { try { await api('/admin/api/logout', {}); } catch (e) {} users = []; $('list').textContent = ''; view('gate'); });
$('q').addEventListener('input', render);
$('sort').addEventListener('change', render);
start();
</script>
</body></html>`;
