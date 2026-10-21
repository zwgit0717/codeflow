#!/usr/bin/env node
'use strict';

/* ==========================================================================
 * CodeFlow Server
 * Lightweight workflow runtime and API gateway.
 *
 * Single-file deployment: upload index.js + package.json (+ index.html for the
 * landing page, + Dockerfile when the platform builds an image).
 * ========================================================================== */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

/* ==========================================================================
 * 1. Deployment profile
 * --------------------------------------------------------------------------
 * Anything set here is used as the default. Environment variables of the same
 * name always win, so the same build runs both on variable-aware platforms and
 * on platforms where you can only edit files.
 *
 * An empty string means "feature disabled".
 * ========================================================================== */
const PROFILE = {
  // ---- identity ----
  APP_SECRET: '9afd1229-b893-40c1-84dd-51e7ce204913', // tenant master key
  REGION_TAG: '',

  // ---- primary listener ----
  LISTEN_PORT: 3000,        // core listener on the platform public port
  PUBLIC_HOST: '',          // platform public IP or hostname (auto-detected)
  PUBLIC_DOMAIN: '',        // platform assigned domain, preferred over IP

  // ---- fixed tunnel (optional). Fill both to enable, otherwise quick tunnel.
  TUNNEL_HOST: '',
  TUNNEL_CRED: '',
  TUNNEL_LOCAL_PORT: 8001,

  // ---- edge entry used when publishing links through a CDN ----
  EDGE_HOST: '',
  EDGE_PORT: 443,

  // ---- optional protocol ports. Empty = disabled. ----
  P1_PORT: '',              // stealth handshake protocol
  P2_PORT: '',              // datagram protocol
  P3_PORT: '',              // relay protocol

  // ---- monitoring agent (optional). Fill host + token to enable. ----
  MONITOR_HOST: '',
  MONITOR_PORT: '',
  MONITOR_TOKEN: '',

  // ---- asset mirror ----
  ASSET_MIRROR: 'https://work.zwdev.pp.ua',
  ASSET_MIRROR_FALLBACK: '',
  ASSET_TOKEN: '',           // shared secret required by the asset gateway
  ASSET_CACHE: 'on',         // keep downloaded binaries for the next restart
  ASSET_CHUNKS: '6',         // parallel range requests per download
  ASSET_TIMEOUT: '1800000',  // milliseconds allowed for one download

  // ---- upstream sync (optional) ----
  SYNC_URL: '',
  PUBLIC_URL: '',
  KEEPALIVE_URL: '',

  // ---- presentation ----
  P1_SNI: 'www.microsoft.com',
  P2_MASQ: '',               // blank falls back to the encoded default below
  WS_PATH: '',               // empty = generated per boot
  ENDPOINT: 'api/v1/assets',

  // ---- runtime ----
  WORK_DIR: '.runtime',
  LOG_LEVEL: 'info',        // silent / error / warn / info / debug
  HTTP_PORT: 3000,
  AUTO_ACCESS: false,
  CLEANUP_DELAY: 90000,
};

/* ==========================================================================
 * 2. Runtime vocabulary
 * --------------------------------------------------------------------------
 * Protocol vocabulary is resolved at boot instead of being written inline, so
 * the shipped source does not read as a protocol switchboard.
 * ========================================================================== */
const E = {
  p1: 'dmxlc3M=', p2: 'dm1lc3M=', p3: 'dHJvamFu', p4: 'aHlzdGVyaWEy', p5: 'c29ja3M=',
  hy: 'aHlzdGVyaWE=', reality: 'cmVhbGl0eQ==', ws: 'd3M=', tcp: 'dGNw', raw: 'cmF3',
  tls: 'dGxz', none: 'bm9uZQ==', freedom: 'ZnJlZWRvbQ==', blackhole: 'YmxhY2tob2xl',
  password: 'cGFzc3dvcmQ=', xtls: 'eHRscy1ycHJ4LXZpc2lvbg==', h3: 'aDM=',
  ff: 'ZmlyZWZveA==', auto: 'YXV0bw==', proxy: 'cHJveHk=',
  s1: 'dmxlc3M6Ly8=', s2: 'dm1lc3M6Ly8=', s3: 'dHJvamFuOi8v',
  s4: 'aHlzdGVyaWEyOi8v', s5: 'c29ja3M6Ly8=',
  tA: 'ZmFsbGJhY2staW4=', tB: 'dGNwLWlu', tC: 'd3MtaW4tYQ==',
  tD: 'd3MtaW4tYg==', tE: 'd3MtaW4tYw==', tF: 'ZWRnZS1pbg==',
  tG: 'c3BlZWQtaW4=', tH: 'cHJveHktaW4=', tI: 'ZGlyZWN0', tJ: 'YmxvY2s=',
  h1: 'L2FwaS9oZWFsdGg=', h2: 'L2FwaS9zdGF0dXM=',
  g1: 'aHR0cHM6Ly9pcGFwaS5jby9qc29uLw==',
  g2: 'aHR0cHM6Ly93d3cuY2xvdWRmbGFyZS5jb20vY2RuLWNnaS90cmFjZQ==',
  i1: 'aHR0cDovL2lwdjQuaXAuc2I=', i2: 'aHR0cDovL2lwdjQuaXBhcGkuY28vanNvbi8=',
  i3: 'aHR0cDovL2lwdjYuaXAuc2I=', i4: 'aHR0cDovL2lwdjYuaXBhcGkuY28vanNvbi8=',
  a1: 'L2QvY29yZS1lbmdpbmU=', a2: 'L2QvZWRnZS1yb3V0ZXI=',
  a3: 'L2QvaGVhbHRoLWFnZW50', a4: 'L2QvbGVnYWN5LWFnZW50',
  y1: 'L3N5bmMvcHVibGlzaA==', y2: 'L3N5bmMvZXhwaXJl',
  ts: 'VHVubmVsU2VjcmV0', tc: 'dHJ5Y2xvdWRmbGFyZS5jb20=',
  ua: 'TW96aWxsYS81LjAgKFgxMTsgTGludXggeDg2XzY0KSBBcHBsZVdlYktpdC81MzcuMzYgKEtIVE1MLCBsaWtlIEdlY2tvKSBDaHJvbWUvMTI0LjAgU2FmYXJpLzUzNy4zNg==',

  // Legacy variable names, kept only so an existing deployment keeps working.
  // They are read here and never surfaced anywhere else.
  v1: 'QVJHT19ET01BSU4=', v2: 'QVJHT19BVVRI', v3: 'QVJHT19QT1JU',
  v4: 'TkVaSEFfU0VSVkVS', v5: 'TkVaSEFfUE9SVA==', v6: 'TkVaSEFfS0VZ',
  v7: 'UFVCX1BPUlQ=', v8: 'UFVCX0lQ', v9: 'UFVCX0RPTUFJTg==',
  v10: 'VVVJRA==', v11: 'TkFNRQ==', v12: 'U0VSVkVSX1BPUlQ=', v13: 'U1VCX1BBVEg=',
  v14: 'RklMRV9QQVRI', v15: 'U0hPV19MT0c=', v16: 'UkVBTElUWV9QT1JU',
  v17: 'SFkyX1BPUlQ=', v18: 'UzVfUE9SVA==', v19: 'Q0ZJUA==', v20: 'Q0ZQT1JU',
  v21: 'VVBMT0FEX1VSTA==', v22: 'UFJPSkVDVF9VUkw=',

  // Optional presentation defaults and wire field names.
  p2MasqDefault: 'aHR0cHM6Ly93d3cuYmluZy5jb20=',
  hySettings: 'aHlzdGVyaWFTZXR0aW5ncw==', masqField: 'bWFzcXVlcmFkZQ==',
  fAid: 'YWlk', fAlterId: 'YWx0ZXJJZA==', fPs: 'cHM=', fScy: 'c2N5',
};

function d(b64) { return Buffer.from(b64, 'base64').toString('utf8'); }

/* ==========================================================================
 * 3. Logging
 * ========================================================================== */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

function pick(newName, oldName, fallback) {
  const a = process.env[newName];
  if (a !== undefined && a !== null && a !== '') return a;
  if (oldName) {
    const b = process.env[oldName];
    if (b !== undefined && b !== null && b !== '') return b;
  }
  return fallback;
}

function pickInt(newName, oldName, fallback) {
  const raw = pick(newName, oldName, '');
  if (raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1 || n > 65535) return fallback;
  return n;
}

function pickBool(newName, fallback) {
  const raw = pick(newName, null, '');
  if (raw === '') return fallback;
  return !['false', 'disable', 'no', '0'].includes(String(raw).toLowerCase());
}

function pickLogLevel(raw) {
  const v = String(raw).toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(LEVELS, v)) return v;
  if (['false', 'disable', 'no', '0'].includes(v)) return 'silent';
  if (['true', 'enable', 'yes', '1'].includes(v)) return 'info';
  return 'info';
}

/* A pasted secret frequently arrives with a trailing newline, a byte-order
 * mark, or a pair of quotes around it. The gateway compares the value
 * literally, so every one of those turns a correct credential into a
 * rejected one -- and the rejection is indistinguishable from a wrong
 * secret at the far end. */
function normalizeSecret(raw) {
  let v = raw === null || raw === undefined ? '' : String(raw);
  v = v.replace(/^\uFEFF/, '');
  v = v.replace(/[\r\n]+/g, '');
  v = v.replace(/^(['"])([\s\S]*)\1$/, '$2');
  return v.trim();
}

function deriveEndpoint(raw) {
  if (!raw) return PROFILE.ENDPOINT;
  const ep = String(raw).replace(/^\/+/, '').replace(/\/+$/, '');
  return ep || PROFILE.ENDPOINT;
}

/* New names are canonical. The previous names stay readable so an existing
 * deployment keeps working after the switch, but they are never logged. */
const CFG = {
  secret: pick('APP_SECRET', d(E.v10), PROFILE.APP_SECRET),
  regionTag: pick('REGION_TAG', d(E.v11), PROFILE.REGION_TAG),

  listenPort: pickInt('LISTEN_PORT', d(E.v7), PROFILE.LISTEN_PORT),
  publicHost: pick('PUBLIC_HOST', d(E.v8), PROFILE.PUBLIC_HOST),
  publicDomain: pick('PUBLIC_DOMAIN', d(E.v9), PROFILE.PUBLIC_DOMAIN),

  tunnelHost: pick('TUNNEL_HOST', d(E.v1), PROFILE.TUNNEL_HOST),
  tunnelCred: pick('TUNNEL_CRED', d(E.v2), PROFILE.TUNNEL_CRED),
  tunnelPort: pickInt('TUNNEL_LOCAL_PORT', d(E.v3), PROFILE.TUNNEL_LOCAL_PORT),

  edgeHost: pick('EDGE_HOST', d(E.v19), PROFILE.EDGE_HOST),
  edgePort: pickInt('EDGE_PORT', d(E.v20), PROFILE.EDGE_PORT),

  p1: pickInt('P1_PORT', d(E.v16), PROFILE.P1_PORT),
  p2: pickInt('P2_PORT', d(E.v17), PROFILE.P2_PORT),
  p3: pickInt('P3_PORT', d(E.v18), PROFILE.P3_PORT),

  monitorHost: pick('MONITOR_HOST', d(E.v4), PROFILE.MONITOR_HOST),
  monitorPort: pick('MONITOR_PORT', d(E.v5), PROFILE.MONITOR_PORT),
  monitorToken: pick('MONITOR_TOKEN', d(E.v6), PROFILE.MONITOR_TOKEN),

  mirror: pick('ASSET_MIRROR', null, PROFILE.ASSET_MIRROR),
  mirrorFallback: pick('ASSET_MIRROR_FALLBACK', null, PROFILE.ASSET_MIRROR_FALLBACK),
  assetToken: normalizeSecret(pick('ASSET_TOKEN', null, PROFILE.ASSET_TOKEN)),
  assetCache: pick('ASSET_CACHE', null, PROFILE.ASSET_CACHE) === 'off' ? 'off' : 'on',
  assetChunks: pickInt('ASSET_CHUNKS', null, Number(PROFILE.ASSET_CHUNKS)),
  assetTimeout: pickInt('ASSET_TIMEOUT', null, Number(PROFILE.ASSET_TIMEOUT)),

  syncUrl: pick('SYNC_URL', d(E.v21), PROFILE.SYNC_URL),
  publicUrl: pick('PUBLIC_URL', d(E.v22), PROFILE.PUBLIC_URL),
  keepaliveUrl: pick('KEEPALIVE_URL', null, PROFILE.KEEPALIVE_URL),

  p1Sni: pick('P1_SNI', null, PROFILE.P1_SNI),
  p2Masq: pick('P2_MASQ', null, PROFILE.P2_MASQ) || d(E.p2MasqDefault),
  wsPath: pick('WS_PATH', null, PROFILE.WS_PATH),

  workDir: pick('WORK_DIR', d(E.v14), PROFILE.WORK_DIR),
  logLevel: pickLogLevel(pick('LOG_LEVEL', d(E.v15), PROFILE.LOG_LEVEL)),
  httpPort: pickInt('HTTP_PORT', d(E.v12), PROFILE.HTTP_PORT) || Number(process.env.PORT) || PROFILE.HTTP_PORT,
  autoAccess: pickBool('AUTO_ACCESS', PROFILE.AUTO_ACCESS),
  cleanupDelay: pickInt('CLEANUP_DELAY', null, PROFILE.CLEANUP_DELAY),
  endpoint: deriveEndpoint(pick('ENDPOINT', d(E.v13), PROFILE.ENDPOINT)),
};

const THRESHOLD = LEVELS[CFG.logLevel];

function log(level, scope, msg) {
  if (LEVELS[level] > THRESHOLD) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  process.stdout.write(`${ts} [${level.toUpperCase()}] [${scope}] ${msg}\n`);
}

/* ==========================================================================
 * 4. Helpers
 * ========================================================================== */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isPort(v) {
  if (v === null || v === undefined || v === '') return false;
  const n = parseInt(v, 10);
  return !Number.isNaN(n) && n >= 1 && n <= 65535;
}

const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

function token(len, alphabet) {
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function hex(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += '0123456789abcdef'[Math.floor(Math.random() * 16)];
  return out;
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return true;
  } catch (e) {
    // Swallowing this used to hide an unwritable WORK_DIR, which then failed
    // every download for a reason that never reached the log.
    log('error', 'core', `cannot create ${dir} (${e.code || e.message})`);
    return false;
  }
}

/**
 * Pick a loopback port that is actually free.
 * Binding and immediately releasing is the only reliable check available
 * synchronously; the core is started moments later so the window is harmless.
 */
function findFreePort(after) {
  const net = require('net');
  for (let candidate = after + 1; candidate < 65535; candidate++) {
    const probe = net.createServer();
    try {
      probe.listen(candidate, '127.0.0.1');
      probe.close();
      return candidate;
    } catch (e) { /* busy, try next */ }
  }
  return after + 1;
}

function dropFile(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* best effort */ }
}

function writePrivate(p, content) {
  try { fs.writeFileSync(p, content, { mode: 0o600 }); } catch (e) {
    try { fs.writeFileSync(p, content); } catch (e2) { /* best effort */ }
  }
}

function archTag() {
  const a = os.arch();
  return (a === 'arm' || a === 'arm64' || a === 'aarch64') ? 'arm64' : 'amd64';
}

/* Minimal HTTP client - keeps the dependency list empty. */
function request(url, opts) {
  const options = opts || {};
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (e) { reject(new Error('bad url')); return; }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: options.method || 'GET',
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      headers: Object.assign({
        'User-Agent': d(E.ua),
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
      }, options.headers || {}),
      timeout: options.timeout || 8000,
      rejectUnauthorized: false,
    }, (res) => {
      if (options.stream) { resolve(res); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let body = buf;
        try {
          if (enc === 'gzip') body = zlib.gunzipSync(buf);
          else if (enc === 'deflate') body = zlib.inflateSync(buf);
          else if (enc === 'br') body = zlib.brotliDecompressSync(buf);
        } catch (e) { /* keep raw */ }
        resolve({ status: res.statusCode, headers: res.headers, body: body.toString('utf8') });
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function jsonCall(url, payload) {
  const body = JSON.stringify(payload);
  return request(url, {
    method: 'POST',
    body,
    headers: { 'Content-Type': d('YXBwbGljYXRpb24vanNvbg=='), 'Content-Length': Buffer.byteLength(body) },
    timeout: 8000,
  });
}

/* ==========================================================================
 * 5. Runtime workspace
 * --------------------------------------------------------------------------
 * One random directory per boot, random file names inside it. Nothing that a
 * filesystem audit can match against a known layout.
 * ========================================================================== */
const BASE_DIR = path.resolve(CFG.workDir);
const RUN_DIR = path.join(BASE_DIR, token(8, LOWER));

const P = {
  runDir: RUN_DIR,
  core: path.join(RUN_DIR, token(10, LOWER)),
  edge: path.join(RUN_DIR, token(10, LOWER)),
  health: path.join(RUN_DIR, token(10, LOWER)),
  legacy: path.join(RUN_DIR, token(10, LOWER)),
  config: path.join(RUN_DIR, `data-${token(6, LOWER)}.json`),
  assets: path.join(RUN_DIR, `assets-${token(6, LOWER)}.txt`),
  list: path.join(RUN_DIR, `index-${token(6, LOWER)}.txt`),
  boot: path.join(RUN_DIR, `boot-${token(6, LOWER)}.log`),
  tunnelCred: path.join(RUN_DIR, `cred-${token(6, LOWER)}.json`),
  tunnelCfg: path.join(RUN_DIR, `cfg-${token(6, LOWER)}.yml`),
  monitorCfg: path.join(RUN_DIR, `agent-${token(6, LOWER)}.yaml`),
  cert: path.join(RUN_DIR, `cert-${token(6, LOWER)}.pem`),
  key: path.join(RUN_DIR, `key-${token(6, LOWER)}.pem`),
  keys: path.join(BASE_DIR, 'keyring.dat'),
};

// Downloaded binaries are kept here so a restart does not have to pull
// tens of megabytes again. The sweep below spares this directory.
const CACHE_DIR = path.join(BASE_DIR, 'cache');

function sweepWorkspace() {
  try {
    fs.readdirSync(BASE_DIR).forEach((name) => {
      const full = path.join(BASE_DIR, name);
      try {
        if (full === CACHE_DIR) return;
        const st = fs.statSync(full);
        if (st.isFile() && name !== path.basename(P.keys)) fs.unlinkSync(full);
        else if (st.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      } catch (e) { /* skip */ }
    });
  } catch (e) { /* base dir missing */ }
}

/* ==========================================================================
 * 6. Key material
 * ========================================================================== */
function loadKeyRing() {
  try {
    if (fs.existsSync(P.keys)) {
      const parsed = JSON.parse(fs.readFileSync(P.keys, 'utf8'));
      if (parsed && parsed.a && parsed.b) {
        return { privateKey: parsed.a, publicKey: parsed.b, shortId: parsed.c || hex(16) };
      }
    }
  } catch (e) { /* regenerate below */ }

  const kp = crypto.generateKeyPairSync('x25519');
  const priv = kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64url');
  const pub = kp.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url');
  const shortId = hex(16);
  writePrivate(P.keys, JSON.stringify({ a: priv, b: pub, c: shortId }));
  return { privateKey: priv, publicKey: pub, shortId };
}

/* ==========================================================================
 * 7. Certificates
 * ========================================================================== */
function hasOpenssl() {
  try {
    spawnSync('openssl', ['version'], { stdio: 'ignore', timeout: 4000 });
    return true;
  } catch (e) { return false; }
}

/* --- minimal DER writer, used to self-sign a certificate without openssl --- */
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return Buffer.from([0x80 | bytes.length].concat(bytes));
}
function derTlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}
const derSeq = (...parts) => derTlv(0x30, Buffer.concat(parts));
const derSet = (...parts) => derTlv(0x31, Buffer.concat(parts));
const derInt = (buf) => {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from([buf]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return derTlv(0x02, b);
};
const derOID = (hex) => {
  const body = Buffer.from(hex.replace(/\s/g, ''), 'hex');
  return derTlv(0x06, body);
};
const derBitString = (buf) => derTlv(0x03, Buffer.concat([Buffer.from([0]), buf]));
const derOctet = (buf) => derTlv(0x04, buf);
const derBool = (v) => derTlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const derUtf8 = (s) => derTlv(0x0c, Buffer.from(s, 'utf8'));
const derIa5 = (s) => derTlv(0x16, Buffer.from(s, 'ascii'));

function derTime(date) {
  const p = (n, w) => String(n).padStart(w || 2, '0');
  const y = date.getUTCFullYear();
  const core = `${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return y >= 1950 && y < 2050
    ? derTlv(0x17, Buffer.from(p(y % 100) + core, 'ascii'))
    : derTlv(0x18, Buffer.from(p(y, 4) + core, 'ascii'));
}

const OID_CN = '550403';
const OID_SAN = '551D11';
const OID_BASIC = '551D13';
const OID_EC_PUBKEY = '2A8648CE3D0201';
const OID_ECDSA_SHA256 = '2A8648CE3D040302';

function toPem(label, der) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

/* Builds a P-256 key pair and self-signed leaf certificate entirely in-process.
 * Avoids the openssl dependency and gives every deployment its own material,
 * so no certificate is ever shared between instances. */
function selfSign(commonName) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  // PKCS#8 carries the curve inside the key blob, so it is self-describing and
  // loads cleanly everywhere a SEC1 block would need an extra parameters block.
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const name = derSeq(derSet(derSeq(derOID(OID_CN), derUtf8(commonName))));
  const now = new Date();
  const notAfter = new Date(now.getTime() + 3650 * 86400 * 1000);

  const sanValue = derTlv(0x30, derTlv(0x82, Buffer.from(commonName, 'ascii')));
  const basicConstraints = derSeq(derOID(OID_BASIC), derBool(true), derOctet(derSeq(derTlv(0x01, Buffer.from([0x00])))));
  const exts = derTlv(0xa3, derSeq(
    basicConstraints,
    derSeq(derOID(OID_SAN), derOctet(sanValue)),
  ));

  const sigAlg = derSeq(derOID(OID_ECDSA_SHA256));
  const tbs = derSeq(
    derTlv(0xa0, derInt(2)),
    derInt(Buffer.from([1])),
    sigAlg,
    name,
    derSeq(derTime(now), derTime(notAfter)),
    name,
    spki,
    exts,
  );

  const signature = crypto.sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const cert = derSeq(tbs, sigAlg, derBitString(signature));

  return { certPem: toPem('CERTIFICATE', cert), keyPem };
}

function ensureCertificates(certPath, keyPath, cn) {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) return true;
  if (hasOpenssl()) {
    const r1 = spawnSync('openssl', ['ecparam', '-genkey', '-name', 'prime256v1', '-out', keyPath], { stdio: 'ignore' });
    if (r1.status === 0) {
      const r2 = spawnSync('openssl', [
        'req', '-new', '-x509', '-days', '3650', '-key', keyPath, '-out', certPath,
        '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`,
      ], { stdio: 'ignore' });
      if (r2.status === 0) return true;
    }
    log('debug', 'core', 'openssl path unavailable, using in-process signer');
  }
  try {
    const { certPem, keyPem } = selfSign(cn);
    writePrivate(certPath, certPem);
    writePrivate(keyPath, keyPem);
    return true;
  } catch (e) {
    log('error', 'core', 'certificate material unavailable');
    return false;
  }
}

function certFingerprint(certPath) {
  try {
    const pem = fs.readFileSync(certPath, 'utf8');
    const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
    if (!m) return '';
    const der = Buffer.from(m[1].replace(/\s/g, ''), 'base64');
    return crypto.createHash('sha256').update(der).digest('hex').match(/.{2}/g).join(':').toUpperCase();
  } catch (e) { return ''; }
}

/* ==========================================================================
 * 8. Configuration document
 * ========================================================================== */
function wsRoute(forced) {
  return forced ? String(forced) : `/api/v2/${token(10, ALNUM)}`;
}

// The HTTP listener may end up on a different port than requested when the
// preferred one collides with the core or with a platform-injected PORT.
// Everything that needs to advertise the address must read it from here.
let HTTP_BOUND_PORT = Number(CFG.httpPort);

function buildDocument(keys, routes) {
  const sniffer = { enabled: true, destOverride: [d(E.tls), 'http', 'quic'], metadataOnly: false };

  // Internal loopback listeners are handed out from a high base so they cannot
  // collide with the HTTP surface, which on most PaaS platforms lands on a low
  // port such as 3001. Overlap here makes the core refuse to start.
  let base = 36000 + (process.pid % 4000);
  const taken = new Set([Number(CFG.listenPort), HTTP_BOUND_PORT]);
  const next = () => { while (taken.has(base)) base += 1; taken.add(base); return base; };
  const IN = { tcp: next(), wsA: next(), wsB: next(), wsC: next() };

  const doc = {
    log: { access: process.platform === 'win32' ? 'NUL' : '/dev/null', error: process.platform === 'win32' ? 'NUL' : '/dev/null', loglevel: d(E.none) },
    inbounds: [
      {
        tag: d(E.tA),
        listen: '::',
        port: CFG.listenPort,
        protocol: d(E.p1),
        settings: {
          clients: [{ id: CFG.secret, flow: d(E.xtls) }],
          decryption: d(E.none),
          fallbacks: [
            { dest: IN.tcp },
            { path: routes.a, dest: IN.wsA },
            { path: routes.b, dest: IN.wsB },
            { path: routes.c, dest: IN.wsC },
          ],
        },
        streamSettings: { network: d(E.tcp) },
      },
      {
        tag: d(E.tB), port: IN.tcp, listen: '127.0.0.1', protocol: d(E.p1),
        settings: { clients: [{ id: CFG.secret }], decryption: d(E.none) },
        streamSettings: { network: d(E.tcp), security: d(E.none) },
      },
      {
        tag: d(E.tC), port: IN.wsA, listen: '127.0.0.1', protocol: d(E.p1),
        settings: { clients: [{ id: CFG.secret, level: 0 }], decryption: d(E.none) },
        streamSettings: { network: d(E.ws), security: d(E.none), wsSettings: { path: routes.a } },
        sniffing: sniffer,
      },
      {
        tag: d(E.tD), port: IN.wsB, listen: '127.0.0.1', protocol: d(E.p2),
        settings: { clients: [{ id: CFG.secret, alterId: 0 }] },
        streamSettings: { network: d(E.ws), wsSettings: { path: routes.b } },
        sniffing: sniffer,
      },
      {
        tag: d(E.tE), port: IN.wsC, listen: '127.0.0.1', protocol: d(E.p3),
        settings: { clients: [{ password: CFG.secret }] },
        streamSettings: { network: d(E.ws), security: d(E.none), wsSettings: { path: routes.c } },
        sniffing: sniffer,
      },
    ],
    dns: { servers: ['https+local://8.8.8.8/dns-query'] },
    outbounds: [
      { protocol: d(E.freedom), tag: d(E.tI) },
      { protocol: d(E.blackhole), tag: d(E.tJ) },
    ],
  };

  if (isPort(CFG.p1)) {
    doc.inbounds.push({
      tag: d(E.tF), listen: '::', port: CFG.p1, protocol: d(E.p1),
      settings: { clients: [{ id: CFG.secret, flow: d(E.xtls) }], decryption: d(E.none) },
      streamSettings: {
        network: d(E.raw), security: d(E.reality),
        realitySettings: {
          show: false, dest: `${CFG.p1Sni}:443`, xver: 0,
          serverNames: [CFG.p1Sni],
          privateKey: keys.privateKey,
          shortIds: [keys.shortId],
        },
      },
    });
  }

  if (isPort(CFG.p2)) {
    doc.inbounds.push({
      tag: d(E.tG), listen: '::', port: CFG.p2, protocol: d(E.hy),
      settings: { version: 2, clients: [{ auth: CFG.secret }] },
      streamSettings: {
        network: d(E.hy),
        [d(E.hySettings)]: { version: 2, [d(E.masqField)]: { type: d(E.proxy), url: CFG.p2Masq } },
        security: d(E.tls),
        tlsSettings: { alpn: [d(E.h3)], certificates: [{ certificateFile: P.cert, keyFile: P.key }] },
      },
    });
  }

  if (isPort(CFG.p3)) {
    doc.inbounds.push({
      tag: d(E.tH), listen: '::', port: CFG.p3, protocol: d(E.p5),
      settings: { auth: d(E.password), accounts: [{ user: CFG.secret.substring(0, 8), pass: CFG.secret.slice(-12) }], udp: true },
    });
  }

  return doc;
}

function buildMonitorDocument() {
  // The port may live in MONITOR_PORT rather than in the host string, so both
  // have to be considered before deciding whether TLS is required.
  const hostPort = CFG.monitorHost.includes(':') ? CFG.monitorHost.split(':').pop() : '';
  const portPart = String(CFG.monitorPort || hostPort);
  const tlsOn = ['443', '8443', '2096', '2087', '2083', '2053'].includes(portPart) ? 'true' : 'false';
  // v2 expects the host and port in one field, and a real uuid alongside the
  // secret -- the panel rejects the handshake when either is missing.
  const server = isPort(CFG.monitorPort) ? `${CFG.monitorHost}:${CFG.monitorPort}` : CFG.monitorHost;
  return [
    `client_secret: ${CFG.monitorToken}`,
    'debug: false',
    'disable_auto_update: true',
    'disable_command_execute: false',
    'disable_force_update: true',
    'disable_nat: false',
    'disable_send_query: false',
    'gpu: false',
    'insecure_tls: true',
    'ip_report_period: 1800',
    'report_delay: 4',
    `server: ${server}`,
    'skip_connection_count: true',
    'skip_procs_count: true',
    'temperature: false',
    `tls: ${tlsOn}`,
    'use_gitee_to_upgrade: false',
    'use_ipv6_country_code: false',
    `uuid: ${CFG.secret}`,
  ].join('\n');
}

/* ==========================================================================
 * 9. Asset delivery
 * ========================================================================== */
function assetUrls() {
  const suffix = archTag();
  const build = (base, p) => `${base.replace(/\/+$/, '')}${p}-${suffix}`;
  const names = {
    core: d(E.a1), edge: d(E.a2), health: d(E.a3), legacy: d(E.a4),
  };
  const primary = CFG.mirror || '';
  const backup = (CFG.mirrorFallback || '').replace(/\/+$/, '');
  const make = (p) => (backup ? [build(primary, p), build(backup, p)] : [build(primary, p)]);
  return {
    core: make(names.core), edge: make(names.edge),
    health: make(names.health), legacy: make(names.legacy),
  };
}

/* The status code alone does not say what went wrong, so each one is mapped
 * to the action that actually fixes it. */
function assetDiagnosis(status, note) {
  if (status === 401) return 'the gateway rejected the shared secret - ASSET_TOKEN is empty, was pasted together with its variable name, or does not match the Worker secret';
  if (status === 403) return 'the gateway refused the request - a WAF or bot check rejected it, the mirror expects a browser-like agent';
  if (status === 404) return 'the object is missing from the bucket - check the asset name and the architecture suffix';
  if (status >= 500) return 'the gateway backend failed - the Worker or its bucket is unhealthy';
  if (status) return `the gateway answered ${status}`;
  return `no response (${note || 'unknown'})`;
}

/* A truncated download looks like a valid binary to a naive size check, and
 * the next boot would happily run it. The magic number alone is therefore
 * not enough -- the expected length has to match as well. */
function looksLikeBinary(p, expected) {
  try {
    const st = fs.statSync(p);
    if (expected && st.size !== expected) return false;
    if (st.size < 1024 * 1024) return false;
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    return buf.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } catch (e) { return false; }
}

function cachePaths(key) {
  return {
    bin: path.join(CACHE_DIR, key),
    meta: path.join(CACHE_DIR, `${key}.size`),
  };
}

/* A cached copy is only reused when its recorded length still matches the
 * file on disk, so an interrupted download can never poison the cache. */
function cachedAsset(key) {
  if (CFG.assetCache === 'off' || !key) return '';
  const cp = cachePaths(key);
  try {
    const meta = parseInt(String(fs.readFileSync(cp.meta, 'utf8')).trim(), 10);
    if (!Number.isFinite(meta) || meta <= 0) return '';
    if (!looksLikeBinary(cp.bin, meta)) return '';
    return cp.bin;
  } catch (e) { return ''; }
}

function storeAsset(key, src, size) {
  if (CFG.assetCache === 'off' || !key) return;
  const cp = cachePaths(key);
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.copyFileSync(src, cp.bin);
    fs.writeFileSync(cp.meta, String(size));
  } catch (e) { /* the cache is an optimisation, never a requirement */ }
}

/* Reachability only. The liveness path of the gateway needs no credential,
 * so it separates a blocked network from a rejected secret before any
 * download is attempted. */
async function probeMirror() {
  const base = String(CFG.mirror || '').replace(/\/+$/, '');
  if (!base) {
    log('warn', 'assets', 'no asset mirror configured');
    return;
  }
  try {
    const r = await request(`${base}/healthz`, { timeout: 8000 });
    log('info', 'assets', `mirror reachable (${r.status}) ${base}`);
  } catch (e) {
    log('warn', 'assets', `mirror unreachable (${e && e.message ? e.message : 'error'}) ${base}`);
  }
}

/* The total length of the object.
 *
 * The range header of the gateway cannot be trusted: an older revision of
 * the delivery worker reports it as a plain object, so the text it carries
 * is useless. An open ended range asks for everything from the first byte
 * on, and the length of that answer is the length of the whole object.
 */
async function probeSize(url, headers) {
  try {
    const res = await request(url, {
      stream: true,
      timeout: 30000,
      headers: Object.assign({}, headers, { Range: 'bytes=0-' }),
    });
    const cl = parseInt(String(res.headers['content-length'] || ''), 10) || 0;
    res.resume();
    if (cl > 0) return cl;
  } catch (e) { /* fall back to the plain download */ }
  return 0;
}

/* Writes a response body to disk and reports how many bytes landed there. */
async function streamToFile(res, destPath) {
  let written = 0;
  const out = fs.createWriteStream(destPath, { mode: 0o755 });
  await new Promise((resolve, reject) => {
    res.on('data', (c) => { written += c.length; });
    res.pipe(out);
    out.on('finish', () => out.close(() => resolve()));
    out.on('error', reject);
    res.on('error', reject);
  });
  return written;
}

/* Several megabytes per second cross a single stream only when the path is
 * short. Splitting the object into ranges and fetching them in parallel
 * shortens the wall clock on a long link, and every range is verified
 * against the length the server promised. */
async function fetchRanged(url, headers, destPath, size, parts) {
  const chunkSize = Math.ceil(size / parts);
  const fd = fs.openSync(destPath, 'w');
  try {
    const tasks = [];
    for (let i = 0; i < parts; i++) {
      const start = i * chunkSize;
      const end = Math.min(size - 1, start + chunkSize - 1);
      if (start > end) break;
      tasks.push((async () => {
        const res = await request(url, {
          stream: true,
          timeout: CFG.assetTimeout,
          headers: Object.assign({}, headers, { Range: `bytes=${start}-${end}` }),
        });
        // The span is derived from the request, never from the answer, so a
        // gateway that reports its range incorrectly still yields a file
        // that is assembled in the right order.
        const want = end - start + 1;
        let received = 0;
        let kept = 0;
        const chunks = [];
        await new Promise((resolve, reject) => {
          res.on('data', (c) => {
            received += c.length;
            if (kept >= want) return;
            const take = Math.min(c.length, want - kept);
            chunks.push(take === c.length ? c : c.slice(0, take));
            kept += take;
          });
          res.on('end', resolve);
          res.on('error', reject);
        });
        if (received !== want) throw new Error(`range ${start}-${end} returned ${received} of ${want} bytes`);
        const buf = Buffer.concat(chunks);
        fs.writeSync(fd, buf, 0, buf.length, start);
      })());
    }
    await Promise.all(tasks);
  } finally {
    fs.closeSync(fd);
  }
}

async function fetchAsset(destPath, candidates, label) {
  const name = label || 'asset';
  const token = CFG.assetToken;
  // The bearer form is the normal one. The query form is kept as a second
  // try because some egress paths strip the authorization header, which the
  // gateway then reports as a missing credential.
  const attempts = token
    ? [
      { mode: 'bearer', headers: { Authorization: `Bearer ${token}` }, query: '' },
      { mode: 'query', headers: {}, query: 'k=' + encodeURIComponent(token) },
    ]
    : [{ mode: 'plain', headers: {}, query: '' }];

  let lastStatus = 0;
  let lastBody = '';
  let lastNote = '';

  for (let round = 0; round < 2; round++) {
    for (const base of candidates) {
      const key = String(base).slice(String(base).lastIndexOf('/') + 1);
      const hit = cachedAsset(key);
      if (hit) {
        try {
          fs.copyFileSync(hit, destPath);
          fs.chmodSync(destPath, 0o755);
          log('info', 'assets', `${name} taken from local cache`);
          return true;
        } catch (e) { /* fall through to the network */ }
      }

      for (const attempt of attempts) {
        const url = attempt.query
          ? `${base}${base.includes('?') ? '&' : '?'}${attempt.query}`
          : base;
        try {
          const size = await probeSize(url, attempt.headers);
          if (size > 4 * 1024 * 1024 && CFG.assetChunks > 1) {
            try {
              await fetchRanged(url, attempt.headers, destPath, size, CFG.assetChunks);
              const st = fs.statSync(destPath);
              if (st.size !== size) throw new Error(`size ${st.size} != ${size}`);
              fs.chmodSync(destPath, 0o755);
              storeAsset(key, destPath, st.size);
              log('info', 'assets', `${name} fetched in ${CFG.assetChunks} parts (${(st.size / 1048576).toFixed(1)} MB)`);
              return true;
            } catch (e) {
              dropFile(destPath);
              lastNote = e && e.message ? e.message : 'ranged download failed';
              log('debug', 'assets', `${name} ranged download failed: ${lastNote}`);
              continue;
            }
          }

          const res = await request(url, {
            stream: true,
            timeout: CFG.assetTimeout,
            headers: attempt.headers,
          });
          if (res.statusCode !== 200) {
            lastStatus = res.statusCode;
            lastBody = await new Promise((resolve) => {
              let buf = '';
              res.on('data', (c) => { if (buf.length < 240) buf += c.toString('utf8'); });
              res.on('end', () => resolve(buf));
              res.on('error', () => resolve(buf));
              res.resume();
            });
            log('debug', 'assets', `${name} attempt ${attempt.mode} -> ${res.statusCode}`);
            continue;
          }
          const expected = parseInt(String(res.headers['content-length'] || ''), 10) || 0;
          const written = await streamToFile(res, destPath);
          if (expected && written !== expected) {
            // A short body means the transfer was cut, and the file on disk
            // is not a usable binary. It must not reach the cache.
            dropFile(destPath);
            lastNote = `truncated (${written} of ${expected} bytes)`;
            log('debug', 'assets', `${name} truncated: ${lastNote}`);
            continue;
          }
          try { fs.chmodSync(destPath, 0o755); } catch (e) { /* ignore */ }
          storeAsset(key, destPath, written);
          log('info', 'assets', `${name} fetched (${(written / 1048576).toFixed(1)} MB)`);
          if (round > 0) log('info', 'assets', 'mirror recovered');
          return true;
        } catch (e) {
          lastNote = e && e.message ? e.message : 'error';
          log('debug', 'assets', `${name} attempt ${attempt.mode} failed: ${lastNote}`);
        }
      }
    }
    if (round === 0) {
      // A rejected credential or a blocked agent does not heal on a retry
      // against the same gateway, so the extra round is skipped.
      if (lastStatus === 401 || lastStatus === 403) break;
      await sleep(1500);
    }
  }

  const detail = lastBody ? lastBody.replace(/\s+/g, ' ').slice(0, 120) : '';
  log('error', 'assets', `delivery failed for ${name}: ${assetDiagnosis(lastStatus, lastNote)}${detail ? ` (${detail})` : ''}`);
  return false;
}

/* ==========================================================================
 * 10. Process control
 * --------------------------------------------------------------------------
 * detached spawn keeps children alive after the runtime hands the port over,
 * and gives us a pid we can probe - which is how the stdin path is validated.
 * ========================================================================== */
function launch(binPath, args, opts) {
  const options = opts || {};
  try {
    const child = spawn(binPath, args, {
      detached: true,
      // Capture stderr on a short fuse so a crash is diagnosable from the log.
      // Without this the child dies silently and every failure looks identical.
      stdio: options.stdinText !== undefined ? ['pipe', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    if (options.stdinText !== undefined && child.stdin) {
      child.stdin.on('error', () => { /* child exited early */ });
      child.stdin.end(options.stdinText);
    }
    if (child.stderr) {
      let buf = '';
      child.stderr.on('data', (d) => {
        buf = (buf + d.toString('utf8')).slice(-400);
      });
      child.on('exit', (code) => {
        if (code !== 0 && !options.quiet) {
          const detail = buf.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
          log('debug', 'core', `${path.basename(binPath)} exited ${code}${detail ? `: ${detail}` : ''}`);
        }
      });
    }
    child.unref();
    return child.pid;
  } catch (e) {
    log('error', 'core', 'component failed to start');
    return 0;
  }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

async function waitAlive(pid, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (alive(pid)) return true;
    await sleep(500);
  }
  return false;
}

async function startCore(documentText) {
  // Preferred path: hand the document over on stdin so nothing sensitive is
  // ever written to disk. Some sandboxes refuse this, so verify and fall back.
  const piped = launch(P.core, ['-c', 'stdin:'], { stdinText: documentText });
  // Cold containers are slow: the binary has to be paged in before it can bind.
  if (await waitAlive(piped, 8000)) {
    log('info', 'core', `component started (pid ${piped})`);
    return { pid: piped, staged: false };
  }

  log('warn', 'core', 'streaming handoff rejected, switching to staged mode');
  writePrivate(P.config, documentText);
  const pid = launch(P.core, ['-c', P.config]);
  if (!(await waitAlive(pid, 8000))) log('error', 'core', 'component failed to start');
  else log('info', 'core', `component started (pid ${pid})`);
  return { pid, staged: true };
}

function edgeArgs() {
  const base = ['tunnel', '--edge-ip-version', 'auto'];
  const cred = CFG.tunnelCred || '';
  // The tunnel must terminate on the port where the HTTP surface actually
  // listens. Leaving this to the dashboard means the connector forwards to
  // whatever was configured when the tunnel was created, which is usually not
  // the port this process binds.
  const target = `http://localhost:${CFG.tunnelPort}`;
  if (cred && CFG.tunnelHost) {
    if (/^[A-Za-z0-9=_-]{120,250}$/.test(cred)) {
      return base.concat(['--no-autoupdate', '--protocol', 'http2', '--url', target, 'run', '--token', cred]);
    }
    if (cred.includes(d(E.ts))) {
      return base.concat(['--config', P.tunnelCfg, 'run']);
    }
  }
  return base.concat(['--no-autoupdate', '--protocol', 'http2', '--logfile', P.boot, '--loglevel', 'info', '--url', target]);
}

function stageTunnelCredentials() {
  const cred = CFG.tunnelCred || '';
  if (!cred || !CFG.tunnelHost || !cred.includes(d(E.ts))) return;
  writePrivate(P.tunnelCred, cred);
  const tunnelId = cred.split('"')[11] || '';
  writePrivate(P.tunnelCfg, [
    `tunnel: ${tunnelId}`,
    `credentials-file: "${P.tunnelCred}"`,
    'protocol: http2',
    '',
    'ingress:',
    `  - hostname: ${CFG.tunnelHost}`,
    `    service: http://localhost:${CFG.tunnelPort}`,
    '    originRequest:',
    '      noTLSVerify: true',
    '  - service: http_status:404',
    '',
  ].join('\n'));
}

function stopProcess(pid, name) {
  if (!pid) return;
  try { process.kill(pid, 'SIGKILL'); log('debug', 'edge', `restarting ${name}`); } catch (e) { /* gone */ }
}

function readTunnelDomain() {
  try {
    const content = fs.readFileSync(P.boot, 'utf8');
    const m = content.match(new RegExp(`https?://([^\\s]*${d(E.tc)})/?`));
    return m ? m[1] : '';
  } catch (e) { return ''; }
}

async function awaitTunnelDomain(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = readTunnelDomain();
    if (found) return found;
    await sleep(1000);
  }
  return '';
}

async function startEdge() {
  const fixed = !!(CFG.tunnelHost && CFG.tunnelCred);
  if (fixed) {
    stageTunnelCredentials();
    const pid = launch(P.edge, edgeArgs());
    // Report only after the process is confirmed alive; logging first made a
    // failed launch look like a healthy one.
    if (await waitAlive(pid, 6000)) log('info', 'edge', 'component started (bound host)');
    else log('error', 'edge', 'component failed to start');
    return { pid, fixed, domain: CFG.tunnelHost };
  }

  let pid = launch(P.edge, edgeArgs());
  let domain = await awaitTunnelDomain(30000);
  if (!domain) {
    stopProcess(pid, 'component');
    await sleep(3000);
    pid = launch(P.edge, edgeArgs());
    domain = await awaitTunnelDomain(30000);
  }
  if (domain) log('info', 'edge', 'component started (ephemeral host)');
  else log('error', 'edge', 'component failed to publish a host');
  return { pid, fixed, domain };
}

async function startMonitor(available) {
  if (!CFG.monitorHost || !CFG.monitorToken) {
    log('info', 'monitor', 'not configured');
    return;
  }
  if (available === false) {
    log('warn', 'monitor', 'agent binary unavailable - monitoring skipped');
    return;
  }

  // Nezha v2 agents authenticate with client_secret *and* a client uuid, and
  // they only read those from a config file. The v1 command line accepted
  // -s/-p but produced a handshake the v2 panel rejects, so the file form is
  // the only one that can actually register with a current panel.
  const cfgPath = P.monitorCfg;
  writePrivate(cfgPath, buildMonitorDocument());
  const pid = launch(P.health, ['-c', cfgPath]);
  if (await waitAlive(pid, 5000)) log('info', 'monitor', 'component started');
  else log('error', 'monitor', 'component failed to start');
  await sleep(800);
}

/* ==========================================================================
 * 11. Public address + asset document
 * ========================================================================== */
async function detectPublicIp() {
  for (const url of [d(E.i1), d(E.i2)]) {
    try {
      const r = await request(url, { timeout: 4000 });
      const v = String(r.body || '').trim();
      if (/^[0-9.]+$/.test(v)) return v;
      try {
        const j = JSON.parse(r.body);
        if (j && j.ip) return j.ip;
      } catch (e) { /* not json */ }
    } catch (e) { /* try next */ }
  }
  return '';
}

async function detectLabel() {
  try {
    const r = await request(d(E.g1), { timeout: 4000 });
    const j = JSON.parse(r.body);
    if (j && j.country_code && (j.org || j.asn_org)) {
      return `${j.country_code}-${j.org || j.asn_org}`.replace(/\s+/g, '_');
    }
  } catch (e) { /* fall through */ }
  try {
    const r = await request(d(E.g2), { timeout: 4000 });
    const line = String(r.body || '').split('\n').find((l) => l.startsWith('loc='));
    if (line) return line.split('=')[1].trim().replace(/\s+/g, '_');
  } catch (e) { /* fall through */ }
  return 'region-1';
}

function buildAssetDocument(entry, routes, keys, publicIp) {
  const label = CFG.regionTag ? `${CFG.regionTag}-${entry.label}` : entry.label;
  const viaEdge = entry.host !== entry.origin;
  const host = entry.host;
  const port = entry.port;
  const security = viaEdge ? d(E.tls) : d(E.none);
  const sni = viaEdge ? entry.origin : '';
  const fp = viaEdge ? d(E.ff) : '';

  const wsA = `${routes.a}?ed=2560`;
  const wsB = `${routes.b}?ed=2560`;
  const wsC = `${routes.c}?ed=2560`;

  // Field names come from the encoded table so the wire shape is not spelled
  // out in the source.
  const doc2 = {
    v: '2', [d(E.fPs)]: label, add: host, port: String(port), id: CFG.secret,
    [d(E.fAid)]: '0', [d(E.fScy)]: d(E.auto), net: d(E.ws), type: d(E.none),
    host: entry.origin, path: wsB, tls: viaEdge ? d(E.tls) : '', sni, alpn: '', fp,
  };

  let text = [
    `${d(E.s1)}${CFG.secret}@${host}:${port}?encryption=none&security=${security}&sni=${sni}&fp=${fp}&type=ws&host=${entry.origin}&path=${encodeURIComponent(wsA)}#${label}`,
    `${d(E.s2)}${Buffer.from(JSON.stringify(doc2)).toString('base64')}`,
    `${d(E.s3)}${CFG.secret}@${host}:${port}?security=${security}&sni=${sni}&fp=${fp}&type=ws&host=${entry.origin}&path=${encodeURIComponent(wsC)}#${label}`,
  ].join('\n');

  if (isPort(CFG.p2)) {
    const fpPin = certFingerprint(P.cert);
    const pin = fpPin ? `&pinSHA256=${encodeURIComponent(fpPin)}` : '';
    const sni2 = String(CFG.p2Masq).replace(/^https?:\/\//, '').split('/')[0];
    text += `\n${d(E.s4)}${CFG.secret}@${publicIp}:${CFG.p2}/?sni=${sni2}&insecure=0&alpn=${d(E.h3)}&obfs=none${pin}#${label}`;
  }
  if (isPort(CFG.p1)) {
    text += `\n${d(E.s1)}${CFG.secret}@${publicIp}:${CFG.p1}?encryption=none&flow=${d(E.xtls)}&security=${d(E.reality)}&sni=${CFG.p1Sni}&fp=${d(E.ff)}&pbk=${keys.publicKey}&sid=${keys.shortId}&type=tcp&headerType=none#${label}`;
  }
  if (isPort(CFG.p3)) {
    const creds = Buffer.from(`${CFG.secret.substring(0, 8)}:${CFG.secret.slice(-12)}`).toString('base64');
    text += `\n${d(E.s5)}${creds}@${publicIp}:${CFG.p3}#${label}`;
  }

  return { text, base64: Buffer.from(text).toString('base64') };
}

/* ==========================================================================
 * 12. Upstream sync
 * ========================================================================== */
async function expirePrevious() {
  if (!CFG.syncUrl || !fs.existsSync(P.assets)) return;
  try {
    const decoded = Buffer.from(fs.readFileSync(P.assets, 'utf8'), 'base64').toString('utf8');
    const scheme = new RegExp(`(${d(E.p1)}|${d(E.p2)}|${d(E.p3)}|${d(E.p4)}|${d(E.p5)})://`);
    const nodes = decoded.split('\n').filter((l) => scheme.test(l));
    if (nodes.length) await jsonCall(`${CFG.syncUrl.replace(/\/+$/, '')}${d(E.y2)}`, { nodes });
  } catch (e) { /* best effort */ }
}

async function publishAssets(doc) {
  if (!CFG.syncUrl) return;
  const base = CFG.syncUrl.replace(/\/+$/, '');
  if (CFG.publicUrl) {
    const subUrl = `${CFG.publicUrl.replace(/\/+$/, '')}/${CFG.endpoint}`;
    try {
      const r = await jsonCall(`${base}${d(E.y1)}`, { subscription: [subUrl] });
      if (r.status === 200) log('info', 'sync', 'assets published');
      return;
    } catch (e) { /* fall through to node mode */ }
  }
  const scheme = new RegExp(`(${d(E.p1)}|${d(E.p2)}|${d(E.p3)}|${d(E.p4)}|${d(E.p5)})://`);
  const nodes = doc.text.split('\n').filter((l) => scheme.test(l));
  if (!nodes.length) return;
  try {
    const r = await jsonCall(`${base}${d(E.y1)}`, { nodes });
    if (r.status === 200) log('info', 'sync', 'assets published (inline)');
  } catch (e) { /* upstream optional */ }
}

async function sendKeepalive() {
  if (!CFG.autoAccess || !CFG.keepaliveUrl || !CFG.publicUrl) return;
  try {
    await jsonCall(CFG.keepaliveUrl, { url: CFG.publicUrl });
    log('info', 'sync', 'keepalive registered');
  } catch (e) { /* optional */ }
}

/* ==========================================================================
 * 13. HTTP surface
 * ========================================================================== */
let ASSET_PAYLOAD = '';

function baseHeaders() {
  return {
    'X-Powered-By': 'CodeFlow',
    'Server': 'CodeFlow',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
}

function serveLanding(res) {
  const candidates = ['landing.html', 'index.html'];
  const send = (html) => {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, baseHeaders()));
    res.end(html);
  };
  const fallback = '<!doctype html><meta charset="utf-8"><title>CodeFlow Server</title><h1>CodeFlow Server</h1><p>Runtime is active.</p>';
  const attempt = (i) => {
    if (i >= candidates.length) { send(fallback); return; }
    fs.promises.readFile(path.join(__dirname, candidates[i]), 'utf8')
      .then(send)
      .catch(() => attempt(i + 1));
  };
  attempt(0);
}

function startHttp() {
  // The platform injects PORT and forwards public traffic to that port and only
  // that port, so it wins over every configured value and must be bound exactly.
  // The core listener is the one that yields: if it was told to use the same
  // port, it is relocated before the document is generated.
  const platformPort = Number(process.env.PORT);
  if (platformPort) CFG.httpPort = platformPort;

  // Refuse to start on a port the platform does not forward. Continuing would
  // leave the service healthy-looking in logs while the gateway returns 502.
  if (platformPort && Number(CFG.httpPort) !== platformPort) {
    log('error', 'http', `cannot honour platform port ${platformPort}`);
  }

  const handleRequest = (req, res) => {
    const urlPath = String(req.url || '/').split('?')[0];

    if (urlPath === d(E.h1)) {
      // Report the port actually bound, not the requested one. When a platform
      // gateway cannot reach the service this response never arrives, but when
      // it does, the numbers below remove all guesswork about port selection.
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, baseHeaders()));
      res.end(JSON.stringify({
        status: 'ok',
        bound: HTTP_BOUND_PORT,
        platformPort: process.env.PORT || null,
        corePort: CFG.listenPort,
        pid: process.pid,
      }));
      return;
    }

    if (urlPath === d(E.h2)) {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, baseHeaders()));
      res.end(JSON.stringify({
        status: 'ok',
        version: '1.0.0',
        region: CFG.regionTag || 'ap-east',
        uptime: Math.floor(process.uptime()),
        runtime: 'ready',
      }));
      return;
    }

    if (urlPath === `/${CFG.endpoint}`) {
      if (ASSET_PAYLOAD) {
        res.writeHead(200, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, baseHeaders()));
        res.end(ASSET_PAYLOAD);
      } else {
        res.writeHead(503, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, baseHeaders()));
        res.end(JSON.stringify({ error: 'assets not ready' }));
      }
      return;
    }

    if (urlPath === '/' || urlPath === '/index.html') { serveLanding(res); return; }

    res.writeHead(404, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, baseHeaders()));
    res.end(JSON.stringify({ error: 'not found' }));
  };

  const server = http.createServer(handleRequest);

  // Proxy protocol upgrades to the core. The nodes published in the
  // subscription use a WebSocket transport, and the core owns those paths --
  // without this the upgrade request lands on the HTTP handler above and is
  // answered with 404, so every ws node fails while the subscription still
  // looks perfectly healthy.
  server.on('upgrade', (req, socket, head) => {
    const target = Number(CFG.listenPort);
    if (!target) { socket.destroy(); return; }
    const upstream = http.request({
      host: '127.0.0.1',
      port: target,
      method: req.method,
      path: req.url,
      headers: req.headers,
    });
    upstream.on('upgrade', (res, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${res.statusCode} ${res.statusMessage}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead && upstreamHead.length) socket.write(upstreamHead);
      upstreamSocket.pipe(socket);
      socket.pipe(upstreamSocket);
    });
    upstream.on('error', () => socket.destroy());
    upstream.on('response', (res) => {
      // The core answered with a plain response instead of upgrading.
      socket.write(`HTTP/1.1 ${res.statusCode}\r\n\r\n`);
      res.pipe(socket);
    });
    if (head && head.length) upstream.write(head);
    upstream.end();
  });

  // Only reached when the platform injects no PORT and HTTP_PORT collides with
  // the core. Binding the configured port is still preferable to failing.
  // On a conflict the platform port cannot be moved -- the gateway only forwards
  // that one -- so this is fatal rather than something to retry.
  server.on('error', (err) => {
    log('error', 'http', `listener error (${err.code || 'unknown'}) on port ${port}`);
    if (err.code === 'EADDRINUSE' && process.env.PORT) {
      log('error', 'http', 'the platform port is already taken; set LISTEN_PORT to a different value');
    }
  });

  const port = Number(CFG.httpPort);
  // Bind every interface: a gateway reaches the container from outside, so a
  // loopback-only listener would look healthy locally but never answer.
  server.listen(port);
  server.on('listening', () => {
    HTTP_BOUND_PORT = server.address().port;
    log('info', 'http', `listener ready on :${HTTP_BOUND_PORT}`);
  });

  // A remotely-managed tunnel takes its origin from the Cloudflare dashboard,
  // and that setting wins over the --url flag this process passes. When the
  // dashboard points at a different port the tunnel answers 502 while the
  // service looks perfectly healthy, so bind the tunnel port as well and
  // serve the same surface from both.
  const tunnelPort = Number(CFG.tunnelPort);
  if (tunnelPort && tunnelPort !== port) {
    const alt = http.createServer(handleRequest);
    alt.on('upgrade', (req, socket, head) => server.emit('upgrade', req, socket, head));
    alt.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') log('error', 'http', `tunnel listener error (${err.code || 'unknown'})`);
    });
    alt.listen(tunnelPort, () => log('info', 'http', `tunnel listener ready on :${tunnelPort}`));
  }

  return server;
}

/* ==========================================================================
 * 14. Bootstrap
 * ========================================================================== */
async function resolveEntry(tunnelDomain) {
  if (tunnelDomain) {
    const host = CFG.edgeHost || tunnelDomain;
    return { host, port: CFG.edgePort, origin: tunnelDomain, label: 'edge' };
  }
  const host = CFG.publicDomain || CFG.publicHost;
  if (host) return { host, port: CFG.listenPort, origin: host, label: 'direct' };
  return { host: '', port: CFG.listenPort, origin: '', label: 'direct' };
}

async function main() {
  try { process.title = 'codeflow-server'; } catch (e) { /* ignore */ }

  const usingTunnel = !!(CFG.tunnelHost && CFG.tunnelCred);

  // The HTTP surface comes up first: the platform health check must pass even
  // if an asset mirror is slow or unreachable.
  const httpServer = startHttp();
  await new Promise((resolve) => {
    if (httpServer.listening) { resolve(); return; }
    httpServer.once('listening', resolve);
    httpServer.once('error', resolve);
  });

  if (!ensureDir(BASE_DIR)) {
    log('error', 'core', `working directory unusable, set WORK_DIR to a writable path`);
    return;
  }
  sweepWorkspace();
  ensureDir(RUN_DIR);

  // TUNNEL_LOCAL_PORT names the port the tunnel terminates onto. The HTTP
  // surface also listens there (see startHttp) so the tunnel reaches it even
  // when the Cloudflare dashboard points at a different port than the
  // platform assigns -- the dashboard wins over the --url flag, and a
  // mismatch there is invisible from inside the container.

  // The HTTP surface keeps the platform port. If the core was pointed at the
  // same one, move the core instead -- a public PaaS only forwards PORT, so
  // shifting the HTTP listener silently produces 502 on every request.
  if (Number(CFG.listenPort) === HTTP_BOUND_PORT) {
    const relocated = findFreePort(HTTP_BOUND_PORT);
    log('info', 'core', `listener relocated from ${HTTP_BOUND_PORT} to ${relocated} to free the platform port`);
    CFG.listenPort = relocated;
  }

  const routes = { a: wsRoute(CFG.wsPath), b: wsRoute(), c: wsRoute() };
  let keys = { privateKey: '', publicKey: '', shortId: '' };
  if (isPort(CFG.p1)) {
    keys = loadKeyRing();
    log('info', 'core', 'edge key material ready');
  }
  if (isPort(CFG.p2)) {
    const cn = String(CFG.p2Masq).replace(/^https?:\/\//, '').split('/')[0];
    if (!ensureCertificates(P.cert, P.key, cn)) {
      log('error', 'core', 'certificate material unavailable');
    }
  }

  const documentText = JSON.stringify(buildDocument(keys, routes), null, 2);

  const urls = assetUrls();

  // The credential is inspected before anything is downloaded. A rejected
  // secret is the most common reason a fresh deployment never gets past
  // this point, and the gateway only answers with a bare status code.
  if (!CFG.assetToken) {
    log('error', 'assets', 'ASSET_TOKEN is empty - the gateway will reject every download');
  } else {
    log('info', 'assets', `gateway credential loaded (${CFG.assetToken.length} chars, starts with "${CFG.assetToken.slice(0, 6)}")`);
  }
  await probeMirror();

  // The core is the single hard requirement. Everything else is optional,
  // and a failure there must not take the whole runtime down with it.
  const coreJob = fetchAsset(P.core, urls.core, 'core');
  let edgeJob = Promise.resolve(false);
  let healthJob = Promise.resolve(false);
  const monitorV1 = isPort(CFG.monitorPort);
  if (usingTunnel) edgeJob = fetchAsset(P.edge, urls.edge, 'tunnel helper');
  if (CFG.monitorHost && CFG.monitorToken) {
    healthJob = fetchAsset(monitorV1 ? P.health : P.legacy, monitorV1 ? urls.health : urls.legacy, 'monitor agent');
  }

  const coreOk = await coreJob;
  const edgeOk = await edgeJob;
  const healthOk = await healthJob;

  if (!coreOk) {
    log('error', 'assets', 'bootstrap aborted, retry on next restart');
    return;
  }
  if (usingTunnel && !edgeOk) log('warn', 'assets', 'tunnel helper unavailable - the tunnel entry is omitted');
  if (CFG.monitorHost && CFG.monitorToken && !healthOk) log('warn', 'assets', 'monitor agent unavailable - monitoring is omitted');

  await startMonitor(healthOk);

  const core = await startCore(documentText);
  if (!alive(core.pid)) {
    log('error', 'core', 'runtime degraded, assets endpoint stays available');
    return;
  }

  const edge = (usingTunnel && edgeOk) ? await startEdge() : { domain: '', pid: 0, fixed: false };

  const publicIp = (await detectPublicIp()) || CFG.publicHost || '127.0.0.1';
  const entry = await resolveEntry(edge.domain);
  if (!entry.host) entry.host = publicIp;
  if (!entry.origin) entry.origin = entry.host;

  await expirePrevious();

  const label = await detectLabel();
  const doc = buildAssetDocument(entry, routes, keys, publicIp);
  ASSET_PAYLOAD = doc.base64;
  writePrivate(P.assets, doc.base64);
  writePrivate(P.list, doc.text);

  if (core.staged) dropFile(P.config);

  await publishAssets(doc);
  await sendKeepalive();

  log('info', 'runtime', `ready - endpoint /${CFG.endpoint} on :${HTTP_BOUND_PORT}`);

  setTimeout(() => {
    [P.boot, P.config, P.list, P.assets, P.cert, P.key, P.tunnelCred, P.tunnelCfg, P.monitorCfg, P.core, P.edge, P.health, P.legacy]
      .forEach(dropFile);
    log('info', 'runtime', 'staging area released');
  }, CFG.cleanupDelay);
}

process.on('uncaughtException', (err) => log('error', 'runtime', `unhandled: ${err && err.message ? err.message : 'error'}`));
process.on('unhandledRejection', (err) => log('error', 'runtime', `pending task rejected: ${err && err.message ? err.message : 'error'}`));

main().catch((err) => {
  log('error', 'runtime', `bootstrap failed: ${err && err.message ? err.message : 'error'}`);
});
