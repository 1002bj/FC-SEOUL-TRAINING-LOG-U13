import express from 'express';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  getDocs,
  collection,
  deleteDoc,
  query,
  where,
  updateDoc,
  limit
} from 'firebase/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read Firebase config
const firebaseConfigRaw = fs.readFileSync(path.join(__dirname, 'firebase-applet-config.json'), 'utf-8');
const firebaseConfig = JSON.parse(firebaseConfigRaw);

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId || '(default)');

// Google Spreadsheet Web App URL for live synchronization
const GAS_WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbz_20iWlLdSBxGhuZ71F27zWi9jB7dSd0803FVA1Wsw6685O9af7iriwL2b9lsSXvXkJQ/exec';

// ============================================================================
// 🛡️ Firestore Quota Exceeded Circuit Breaker + Timeout + Local Cache Fallback
// ============================================================================
const SERVER_CACHE_FILE = '/tmp/fcseoul_server_cache.json';
const CIRCUIT_COOLDOWN_MS = 60 * 1000; // 60 seconds cooldown when quota exceeded
const FIRESTORE_OP_TIMEOUT_MS = 2800; // Fast 2.8s timeout to prevent infinite hang

const circuitBreaker = {
  isOpen: false,
  openedAt: 0,
  reason: '',
  check() {
    if (!this.isOpen) return false;
    if (Date.now() - this.openedAt > CIRCUIT_COOLDOWN_MS) {
      this.isOpen = false;
      this.reason = '';
      console.log('[CircuitBreaker] Cooldown elapsed. Half-open: allowing Firestore retry.');
      return false;
    }
    return true;
  },
  trip(err) {
    const msg = String(err?.message || err?.code || err || '');
    this.isOpen = true;
    this.openedAt = Date.now();
    this.reason = msg;
    console.warn(`[CircuitBreaker] OPENED for ${CIRCUIT_COOLDOWN_MS / 1000}s due to: ${msg}`);
  }
};

function isQuotaOrTimeoutError(err) {
  if (!err) return false;
  const code = String(err.code || '').toLowerCase();
  const msg = String(err.message || err || '').toLowerCase();
  return (
    code.includes('resource-exhausted') ||
    code.includes('unavailable') ||
    code.includes('deadline-exceeded') ||
    msg.includes('quota exceeded') ||
    msg.includes('resource-exhausted') ||
    msg.includes('firestore_timeout') ||
    msg.includes('시간 초과') ||
    msg.includes('backoff')
  );
}

function fsOp(promise, timeoutMs = FIRESTORE_OP_TIMEOUT_MS) {
  if (circuitBreaker.check()) {
    return Promise.reject(new Error('FIRESTORE_CIRCUIT_OPEN: Quota exceeded fallback active'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error('FIRESTORE_TIMEOUT: Operation timed out');
      err.code = 'resource-exhausted';
      circuitBreaker.trip(err);
      reject(err);
    }, timeoutMs);

    promise
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        if (isQuotaOrTimeoutError(err)) {
          circuitBreaker.trip(err);
        }
        reject(err);
      });
  });
}

// Persistent Server Cache
const serverCache = {
  users: {},
  entries: {},
  diaries: {},
  matchEvaluations: {},
  bugReports: {},
  files: {},
  lastGetAllAt: 0,
  lastListUsersAt: 0,
  gasSeeded: false
};

function loadServerCacheFromDisk() {
  try {
    if (fs.existsSync(SERVER_CACHE_FILE)) {
      const raw = fs.readFileSync(SERVER_CACHE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.users) serverCache.users = parsed.users;
        if (parsed.entries) serverCache.entries = parsed.entries;
        if (parsed.diaries) serverCache.diaries = parsed.diaries;
        if (parsed.matchEvaluations) serverCache.matchEvaluations = parsed.matchEvaluations;
        if (parsed.bugReports) serverCache.bugReports = parsed.bugReports;
        if (parsed.files) serverCache.files = parsed.files;
      }
    }
  } catch (e) {
    console.warn('[ServerCache] Failed to load disk cache:', e.message);
  }
}
loadServerCacheFromDisk();

let saveCacheTimer = null;
function persistServerCacheToDisk() {
  if (saveCacheTimer) clearTimeout(saveCacheTimer);
  saveCacheTimer = setTimeout(() => {
    try {
      const payload = {
        users: serverCache.users,
        entries: serverCache.entries,
        diaries: serverCache.diaries,
        matchEvaluations: serverCache.matchEvaluations,
        bugReports: serverCache.bugReports,
        savedAt: new Date().toISOString()
      };
      fs.writeFileSync(SERVER_CACHE_FILE, JSON.stringify(payload), 'utf-8');
    } catch (e) {
      console.warn('[ServerCache] Failed to write disk cache:', e.message);
    }
  }, 500);
}

let gasSeedPromise = null;
async function ensureServerCacheSeeded() {
  if (Object.keys(serverCache.users).length > 0 || serverCache.gasSeeded) return;
  if (gasSeedPromise) return gasSeedPromise;
  gasSeedPromise = (async () => {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const gasRes = await fetch(GAS_WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'getAllData', requesterId: 'admin' }),
        signal: controller.signal
      });
      clearTimeout(tid);
      const gasData = await gasRes.json();
      if (gasData && gasData.ok) {
        if (Array.isArray(gasData.users)) {
          gasData.users.forEach(u => {
            if (u && u.id) {
              serverCache.users[String(u.id)] = {
                id: String(u.id),
                pw: u.pw || '',
                name: u.name || String(u.id),
                role: u.role || 'player',
                photo: u.photo || '',
                granted: u.granted !== false,
                isAdmin: u.isAdmin === true,
                isSynced: !!u.pw
              };
            }
          });
        }
        if (Array.isArray(gasData.entries)) {
          gasData.entries.forEach(e => {
            if (e) {
              const eid = e.entryId || `entry_${e.playerId}_${e.type}_${formatDateKST(e.weekStartDate)}`;
              e.entryId = eid;
              if (e.weekStartDate) e.weekStartDate = formatDateKST(e.weekStartDate);
              serverCache.entries[eid] = e;
            }
          });
        }
        serverCache.gasSeeded = true;
        persistServerCacheToDisk();
        console.log('[ServerCache] Seeded fallback cache from Google Sheets.');
      }
    } catch (e) {
      console.warn('[ServerCache] GAS seed skipped:', e.message);
    } finally {
      gasSeedPromise = null;
    }
  })();
  return gasSeedPromise;
}

// KST (Asia/Seoul, UTC+9) date formatter to prevent 1-day lag from UTC timestamps
function formatDateKST(isoString) {
  if (!isoString) return '';
  if (isoString instanceof Date) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(isoString);
  }
  if (typeof isoString !== 'string') return String(isoString);
  if (isoString.includes('T')) {
    try {
      const d = new Date(isoString);
      if (!isNaN(d.getTime())) {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Seoul',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).format(d);
      }
    } catch (e) {}
    return isoString.split('T')[0];
  }
  return isoString;
}

// Ensure Nginx directly routes /api to bypass any auth bridge redirects and worker caching
function setupNginxApiBypass() {
  try {
    function patchNginxFile(filePath, isTemplate) {
      if (!fs.existsSync(filePath)) return false;
      let content = fs.readFileSync(filePath, 'utf-8');
      let changed = false;
      if (!content.includes('worker_shutdown_timeout')) {
        content = content.replace('worker_processes auto;', 'worker_processes auto;\nworker_shutdown_timeout 2s;');
        changed = true;
      }
      if (!content.includes('location /api {')) {
        const defaultPortVar = isTemplate ? '${DEFAULT_APP_PORT}' : '3000';
        const hostHeaderVar = isTemplate ? '${PROXY_FORWARDED_HOST_HEADER}' : '$host';
        const apiBlock = `
        # Direct proxy for API requests bypassing auth bridge checks
        location /api {
            proxy_pass http://localhost:${defaultPortVar};
            proxy_set_header Host localhost:${defaultPortVar};
            proxy_set_header X-Forwarded-Host ${hostHeaderVar};
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_buffering off;
        }
`;
        content = content.replace('# Serve the app for all other paths.', apiBlock + '\n        # Serve the app for all other paths.');
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(filePath, content);
        return true;
      }
      return false;
    }

    const confPatched = patchNginxFile('/etc/nginx/nginx.conf', false);
    patchNginxFile('/etc/nginx/nginx.conf.template', true);

    const luaPath = '/etc/nginx/user_auth_verification.lua';
    let luaPatched = false;
    if (fs.existsSync(luaPath)) {
      let luaContent = fs.readFileSync(luaPath, 'utf-8');
      if (!luaContent.includes('string.sub(ngx.var.uri, 1, 5) == "/api/"')) {
        luaContent = luaContent.replace(
          'if ngx.var.host == "localhost" then\n  return\nend',
          'if ngx.var.host == "localhost" then\n  return\nend\n\nif string.sub(ngx.var.uri, 1, 5) == "/api/" or ngx.var.uri == "/api" then\n  return\nend'
        );
        fs.writeFileSync(luaPath, luaContent);
        luaPatched = true;
      }
    }

    if (confPatched || luaPatched) {
      exec('nginx -s reload', (err) => {
        if (!err) console.log('[Nginx] Configured direct /api route.');
        setTimeout(() => {
          exec('pkill -9 -f "shutting down" || true');
        }, 1500);
      });
    } else {
      // Clean up any zombie or lingering workers from previous reloads
      exec('pkill -9 -f "shutting down" || true');
    }
  } catch (e) {
    console.warn('[Nginx setup notice]', e.message);
  }
}
setupNginxApiBypass();

const app = express();
const PORT = 3000;

// High limit for photos / videos in base64
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));

// CORS and Cache-Control headers for all API routes
app.use('/api', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Health check endpoint for /api
app.get('/api', (req, res) => {
  res.json({ ok: true, status: 'online', circuitOpen: circuitBreaker.isOpen, time: new Date().toISOString() });
});

// Static file serving
app.use(express.static(__dirname, {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Verify Firestore database connection on startup
async function initDatabase() {
  try {
    console.log('[Firebase] Connected successfully to Firestore database:', firebaseConfig.firestoreDatabaseId);
  } catch (err) {
    console.warn('[Firebase] Database connection notice:', err.message);
  }
}
initDatabase().catch(err => console.warn('[Firebase init warning]', err));

// File retrieval endpoint for uploaded photos / videos (with cache & circuit breaker)
app.get('/api/files/:id', async (req, res) => {
  const fileId = req.params.id;
  const sendFileData = (data) => {
    if (data && data.data && data.data.startsWith('data:')) {
      const parts = data.data.split(',');
      const meta = parts[0];
      const base64Data = parts[1];
      const mime = meta.match(/:(.*?);/)?.[1] || data.mimeType || 'application/octet-stream';
      const imgBuffer = Buffer.from(base64Data, 'base64');
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(imgBuffer);
    }
    return res.status(400).send('Invalid file format');
  };

  if (serverCache.files[fileId]) {
    return sendFileData(serverCache.files[fileId]);
  }

  try {
    const fileDoc = await fsOp(getDoc(doc(db, 'files', fileId)));
    if (!fileDoc.exists()) {
      return res.status(404).send('File not found');
    }
    const data = fileDoc.data();
    serverCache.files[fileId] = data;
    return sendFileData(data);
  } catch (err) {
    if (serverCache.files[fileId]) {
      return sendFileData(serverCache.files[fileId]);
    }
    console.error('File retrieval error:', err.message);
    res.status(500).send('Error retrieving file');
  }
});

function sanitizeUserForClient(u) {
  return {
    id: u.id,
    name: u.name,
    role: u.role || 'player',
    photo: u.photo || '',
    granted: u.granted || false,
    isAdmin: u.isAdmin || false
  };
}

function getAllDataFromServerCache() {
  const users = Object.values(serverCache.users).map(sanitizeUserForClient);
  const entries = Object.values(serverCache.entries).map(item => {
    const copy = { ...item };
    if (copy.weekStartDate) copy.weekStartDate = formatDateKST(copy.weekStartDate);
    return copy;
  });
  const matches = Object.values(serverCache.matchEvaluations).map(item => {
    const copy = { ...item };
    if (copy.matchDate) copy.matchDate = formatDateKST(copy.matchDate);
    return copy;
  }).sort((a, b) => new Date(b.matchDate || b.createdAt || 0) - new Date(a.matchDate || a.createdAt || 0));
  const diaries = Object.values(serverCache.diaries).map(item => {
    const copy = { ...item };
    if (copy.date) copy.date = formatDateKST(copy.date);
    return copy;
  });
  return { ok: true, users, entries, matches, diaries, _fromCache: circuitBreaker.isOpen };
}

// Main API Handler for all applet actions
async function handleApiRequest(req, res) {
  const payload = req.body || {};
  const action = payload.action;

  try {
    switch (action) {
      // 1. 회원가입
      case 'register': {
        const { id, pw, name, role, photo } = payload;
        if (!id || !pw || !name) {
          return res.json({ ok: false, error: '모든 항목을 입력해주세요.' });
        }

        if (serverCache.users[id]) {
          return res.json({ ok: false, error: '이미 사용 중인 아이디입니다.' });
        }

        let isFirst = Object.keys(serverCache.users).length === 0;
        if (!circuitBreaker.check()) {
          try {
            const userRef = doc(db, 'users', id);
            const userSnap = await fsOp(getDoc(userRef));
            if (userSnap.exists()) {
              serverCache.users[id] = userSnap.data();
              return res.json({ ok: false, error: '이미 사용 중인 아이디입니다.' });
            }
            const usersSnap = await fsOp(getDocs(query(collection(db, 'users'), limit(1))));
            isFirst = usersSnap.empty;
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        const isAdmin = isFirst && role === 'coach';
        const granted = isFirst || false;
        const newUser = {
          id,
          pw,
          name,
          role: role || 'player',
          photo: photo || '',
          granted,
          isAdmin,
          isSynced: true,
          createdAt: new Date().toISOString()
        };

        serverCache.users[id] = newUser;
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(setDoc(doc(db, 'users', id), newUser));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 2. 로그인 (임시 비밀번호 1234 완전 차단, 실제 가입/구글 시트 비밀번호만 허용)
      case 'login': {
        const { id, pw } = payload;
        if (!id || !pw) {
          return res.json({ ok: false, error: '아이디와 비밀번호를 입력해주세요.' });
        }

        let user = null;
        const userRef = doc(db, 'users', id);

        if (!circuitBreaker.check()) {
          try {
            const userSnap = await fsOp(getDoc(userRef));
            if (userSnap.exists()) {
              user = userSnap.data();
              serverCache.users[id] = user;
              persistServerCacheToDisk();
            }
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        if (!user) {
          await ensureServerCacheSeeded();
          user = serverCache.users[id] || null;
        }

        let isValid = false;
        if (user && user.isSynced && user.pw && user.pw === pw) {
          isValid = true;
        }

        // DB에 동기화되지 않았거나 비밀번호가 일치하지 않거나 캐시에 없는 경우 구글 시트(GAS) 대조
        if (!isValid) {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const gasRes = await fetch(GAS_WEBAPP_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify({ action: 'login', id, pw }),
              signal: controller.signal
            });
            clearTimeout(timeoutId);
            const gasData = await gasRes.json();
            if (gasData && gasData.ok) {
              isValid = true;
              if (!user) {
                const gasUser = gasData.user || {};
                user = {
                  id,
                  name: gasUser.name || id,
                  role: gasUser.role || 'player',
                  photo: gasUser.photo || '',
                  granted: gasUser.granted !== false,
                  isAdmin: gasUser.isAdmin === true,
                  pw,
                  isSynced: true
                };
              }
              user.pw = pw;
              user.isSynced = true;
              serverCache.users[id] = user;
              persistServerCacheToDisk();
            }
          } catch (gasErr) {
            console.warn('[Google Sheet Login Verification Error]', gasErr.message);
          }
        }

        if (!user) {
          return res.json({ ok: false, error: '등록되지 않은 아이디입니다.' });
        }
        if (!isValid) {
          return res.json({ ok: false, error: '비밀번호가 일치하지 않습니다.' });
        }

        return res.json({
          ok: true,
          user: sanitizeUserForClient(user),
          _fromCache: circuitBreaker.isOpen
        });
      }

      // 3. 아이디 찾기
      case 'findId': {
        const { name } = payload;
        if (!name) return res.json({ ok: false, error: '이름을 입력해주세요.' });
        const ids = [];

        if (!circuitBreaker.check()) {
          try {
            const q = query(collection(db, 'users'), where('name', '==', name));
            const qSnap = await fsOp(getDocs(q));
            qSnap.forEach(d => {
              const u = d.data();
              if (u && u.id) {
                serverCache.users[u.id] = u;
                ids.push(u.id);
              }
            });
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        if (ids.length === 0) {
          await ensureServerCacheSeeded();
          Object.values(serverCache.users).forEach(u => {
            if (u && u.name === name && !ids.includes(u.id)) ids.push(u.id);
          });
        }

        if (ids.length === 0) {
          try {
            const gasRes = await fetch(GAS_WEBAPP_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: JSON.stringify({ action: 'findId', name })
            });
            const gasData = await gasRes.json();
            if (gasData && gasData.ok && Array.isArray(gasData.ids)) {
              return res.json({ ok: true, ids: gasData.ids });
            }
          } catch (e) {}
          return res.json({ ok: false, error: '해당 이름으로 가입된 아이디를 찾을 수 없습니다.' });
        }

        return res.json({ ok: true, ids });
      }

      // 4. 비밀번호 재설정
      case 'resetPw': {
        const { id, name, newPw } = payload;
        if (!id || !name || !newPw) return res.json({ ok: false, error: '모든 항목을 입력해주세요.' });
        const userRef = doc(db, 'users', id);
        let user = serverCache.users[id] || null;

        if (!circuitBreaker.check()) {
          try {
            const userSnap = await fsOp(getDoc(userRef));
            if (userSnap.exists()) {
              user = userSnap.data();
              serverCache.users[id] = user;
            }
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        if (!user) {
          await ensureServerCacheSeeded();
          user = serverCache.users[id] || null;
        }
        if (!user) {
          return res.json({ ok: false, error: '아이디가 존재하지 않습니다.' });
        }
        if (user.name !== name) {
          return res.json({ ok: false, error: '가입된 이름과 일치하지 않습니다.' });
        }

        user.pw = newPw;
        user.isSynced = true;
        serverCache.users[id] = user;
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(updateDoc(userRef, { pw: newPw, isSynced: true }));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        try {
          fetch(GAS_WEBAPP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'resetPw', id, name, newPw })
          }).catch(() => {});
        } catch (e) {}

        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 5. 사용자 목록 조회
      case 'listUsers': {
        const now = Date.now();
        if (!circuitBreaker.check() && (now - serverCache.lastListUsersAt > 10000 || Object.keys(serverCache.users).length === 0)) {
          try {
            const snap = await fsOp(getDocs(collection(db, 'users')));
            const nextUsers = {};
            snap.forEach(d => {
              const u = d.data();
              if (u && u.id) nextUsers[u.id] = u;
            });
            serverCache.users = nextUsers;
            serverCache.lastListUsersAt = now;
            persistServerCacheToDisk();
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        if (Object.keys(serverCache.users).length === 0) {
          await ensureServerCacheSeeded();
        }

        const users = Object.values(serverCache.users).map(sanitizeUserForClient);
        return res.json({ ok: true, users, _fromCache: circuitBreaker.isOpen });
      }

      // 6. 가입 승인 및 역할 지정
      case 'setRoleAndApprove': {
        const { targetId, role } = payload;
        if (serverCache.users[targetId]) {
          serverCache.users[targetId].role = role;
          serverCache.users[targetId].granted = true;
          persistServerCacheToDisk();
        }
        if (!circuitBreaker.check()) {
          try {
            await fsOp(updateDoc(doc(db, 'users', targetId), { role, granted: true }));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 7. 권한 부여/회수
      case 'setPermission': {
        const { targetId, granted } = payload;
        if (serverCache.users[targetId]) {
          serverCache.users[targetId].granted = granted;
          persistServerCacheToDisk();
        }
        if (!circuitBreaker.check()) {
          try {
            await fsOp(updateDoc(doc(db, 'users', targetId), { granted }));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 7-1. 사용자 프로필 사진 수정
      case 'updateUserPhoto': {
        const { userId, photo } = payload;
        if (!userId) return res.json({ ok: false, error: '사용자 ID가 필요합니다.' });
        if (serverCache.users[userId]) {
          serverCache.users[userId].photo = photo || '';
          persistServerCacheToDisk();
        }
        if (!circuitBreaker.check()) {
          try {
            await fsOp(updateDoc(doc(db, 'users', userId), { photo: photo || '' }));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 8. 계정 삭제
      case 'deleteUser': {
        const { targetId, deleteEntries } = payload;
        delete serverCache.users[targetId];
        if (deleteEntries) {
          Object.keys(serverCache.entries).forEach(k => {
            if (serverCache.entries[k]?.playerId === targetId) delete serverCache.entries[k];
          });
          Object.keys(serverCache.diaries).forEach(k => {
            if (serverCache.diaries[k]?.playerId === targetId) delete serverCache.diaries[k];
          });
          Object.keys(serverCache.matchEvaluations).forEach(k => {
            if (serverCache.matchEvaluations[k]?.playerId === targetId) delete serverCache.matchEvaluations[k];
          });
        }
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(deleteDoc(doc(db, 'users', targetId)));
            if (deleteEntries) {
              const eq = query(collection(db, 'entries'), where('playerId', '==', targetId));
              const eSnap = await fsOp(getDocs(eq));
              await Promise.all(eSnap.docs.map(d => fsOp(deleteDoc(d.ref))));

              const dq = query(collection(db, 'diaries'), where('playerId', '==', targetId));
              const dSnap = await fsOp(getDocs(dq));
              await Promise.all(dSnap.docs.map(d => fsOp(deleteDoc(d.ref))));

              const mq = query(collection(db, 'matchEvaluations'), where('playerId', '==', targetId));
              const mSnap = await fsOp(getDocs(mq));
              await Promise.all(mSnap.docs.map(d => fsOp(deleteDoc(d.ref))));
            }
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 9. 주기화 일지 목록
      case 'listEntries': {
        const { playerId, type } = payload;
        if (!circuitBreaker.check()) {
          try {
            let q;
            if (type) {
              q = query(collection(db, 'entries'), where('playerId', '==', playerId), where('type', '==', type));
            } else {
              q = query(collection(db, 'entries'), where('playerId', '==', playerId));
            }
            const snap = await fsOp(getDocs(q));
            const entries = [];
            snap.forEach(d => {
              const item = d.data();
              if (item && item.entryId) {
                if (item.weekStartDate) item.weekStartDate = formatDateKST(item.weekStartDate);
                serverCache.entries[item.entryId] = item;
                entries.push(item);
              }
            });
            persistServerCacheToDisk();
            return res.json({ ok: true, entries });
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        await ensureServerCacheSeeded();
        const entries = Object.values(serverCache.entries).filter(e => {
          if (!e || e.playerId !== playerId) return false;
          if (type && e.type !== type) return false;
          return true;
        });
        return res.json({ ok: true, entries, _fromCache: true });
      }

      // 10. 특정 주기화 일지 조회
      case 'getEntry': {
        const { entryId } = payload;
        if (!circuitBreaker.check()) {
          try {
            const ref = doc(db, 'entries', entryId);
            const snap = await fsOp(getDoc(ref));
            if (snap.exists()) {
              const data = snap.data();
              serverCache.entries[entryId] = data;
              persistServerCacheToDisk();
              return res.json({ ok: true, entry: data });
            } else if (!serverCache.entries[entryId]) {
              return res.json({ ok: false, error: '일지를 찾을 수 없습니다.' });
            }
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        await ensureServerCacheSeeded();
        const cached = serverCache.entries[entryId];
        if (!cached) {
          return res.json({ ok: false, error: '일지를 찾을 수 없습니다.' });
        }
        return res.json({ ok: true, entry: cached, _fromCache: true });
      }

      // 11. 주기화 일지 저장
      case 'saveEntry': {
        const entry = payload.entry;
        if (!entry) return res.json({ ok: false, error: '저장할 일지 데이터가 없습니다.' });
        if (!entry.entryId) {
          entry.entryId = `entry_${entry.playerId}_${entry.type}_${entry.weekStartDate}_${Date.now()}`;
        }
        entry.updatedAt = new Date().toISOString();
        serverCache.entries[entry.entryId] = entry;
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(setDoc(doc(db, 'entries', entry.entryId), entry));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, entryId: entry.entryId, _fromCache: circuitBreaker.isOpen });
      }

      // 12. 주기화 일지 삭제
      case 'deleteEntry': {
        const { entryId } = payload;
        delete serverCache.entries[entryId];
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(deleteDoc(doc(db, 'entries', entryId)));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 12-1. 주기화 일지 정보(이름, 시작일, 유형) 단건 수정 및 이동
      case 'updateEntryMeta': {
        const { entryId, weekLabel, weekStartDate, type } = payload;
        if (!entryId) return res.json({ ok: false, error: 'entryId가 필요합니다.' });
        const updates = { updatedAt: new Date().toISOString() };
        if (weekLabel !== undefined) updates.weekLabel = weekLabel;
        if (weekStartDate !== undefined) updates.weekStartDate = weekStartDate;
        if (type !== undefined) updates.type = type;

        if (serverCache.entries[entryId]) {
          Object.assign(serverCache.entries[entryId], updates);
          persistServerCacheToDisk();
        }

        if (!circuitBreaker.check()) {
          try {
            await fsOp(setDoc(doc(db, 'entries', entryId), updates, { merge: true }));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 12-2. 파편화된 주기화 일지 하나로 묶기 (일괄 날짜/바퀴명/유형 통일)
      case 'batchUpdateEntryMeta': {
        const { entryIds, targetWeekLabel, targetWeekStartDate, targetType } = payload;
        if (!Array.isArray(entryIds) || entryIds.length === 0) {
          return res.json({ ok: false, error: '선택된 일지가 없습니다.' });
        }
        const updates = { updatedAt: new Date().toISOString() };
        if (targetWeekLabel) updates.weekLabel = targetWeekLabel;
        if (targetWeekStartDate) updates.weekStartDate = targetWeekStartDate;
        if (targetType) updates.type = targetType;

        entryIds.forEach(id => {
          if (serverCache.entries[id]) {
            Object.assign(serverCache.entries[id], updates);
          }
        });
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            const promises = entryIds.map(id => fsOp(setDoc(doc(db, 'entries', id), updates, { merge: true })));
            await Promise.all(promises);
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, count: entryIds.length, _fromCache: circuitBreaker.isOpen });
      }

      // 12-3. 경기 평가 일괄 수정 및 하나로 묶기 (경기명/일자 통일)
      case 'batchUpdateMatchMeta': {
        const { matchIds, targetMatchDate, targetOpponent, targetPeriodTopic } = payload;
        if (!Array.isArray(matchIds) || matchIds.length === 0) {
          return res.json({ ok: false, error: '선택된 경기 평가가 없습니다.' });
        }
        const updates = { updatedAt: new Date().toISOString() };
        if (targetMatchDate) updates.matchDate = targetMatchDate;
        if (targetOpponent !== undefined) updates.opponent = targetOpponent;
        if (targetPeriodTopic) updates.periodTopic = targetPeriodTopic;

        matchIds.forEach(id => {
          if (serverCache.matchEvaluations[id]) {
            Object.assign(serverCache.matchEvaluations[id], updates);
          }
        });
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            const promises = matchIds.map(id => fsOp(setDoc(doc(db, 'matchEvaluations', id), updates, { merge: true })));
            await Promise.all(promises);
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, count: matchIds.length, _fromCache: circuitBreaker.isOpen });
      }

      // 13. 포토 일지 목록
      case 'listDiary': {
        const { playerId } = payload;
        if (!circuitBreaker.check()) {
          try {
            const q = query(collection(db, 'diaries'), where('playerId', '==', playerId));
            const snap = await fsOp(getDocs(q));
            const diary = [];
            snap.forEach(d => {
              const item = d.data();
              if (item) {
                if (item.date) item.date = formatDateKST(item.date);
                if (item.diaryId) serverCache.diaries[item.diaryId] = item;
                diary.push(item);
              }
            });
            persistServerCacheToDisk();
            return res.json({ ok: true, diary });
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        const diary = Object.values(serverCache.diaries)
          .filter(d => d && d.playerId === playerId)
          .map(d => ({ ...d, date: d.date ? formatDateKST(d.date) : '' }));
        return res.json({ ok: true, diary, _fromCache: true });
      }

      // 14. 포토 일지 저장
      case 'saveDiary': {
        const { playerId, playerName, date, photoUrl, memo } = payload;
        const cleanDate = formatDateKST(date);
        const diaryId = `diary_${playerId}_${cleanDate}_${Date.now()}`;
        const diaryData = {
          diaryId,
          playerId,
          playerName,
          date: cleanDate,
          photoUrl: photoUrl || '',
          memo: memo || '',
          createdAt: new Date().toISOString()
        };
        serverCache.diaries[diaryId] = diaryData;
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(setDoc(doc(db, 'diaries', diaryId), diaryData));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, diaryId, _fromCache: circuitBreaker.isOpen });
      }

      // 15. 포토 일지 메모 수정
      case 'updateDiaryMemo': {
        const { diaryId, memo } = payload;
        if (serverCache.diaries[diaryId]) {
          serverCache.diaries[diaryId].memo = memo;
          persistServerCacheToDisk();
        }
        if (!circuitBreaker.check()) {
          try {
            await fsOp(updateDoc(doc(db, 'diaries', diaryId), { memo }));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 16. 포토 일지 삭제
      case 'deleteDiary': {
        const { diaryId } = payload;
        delete serverCache.diaries[diaryId];
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(deleteDoc(doc(db, 'diaries', diaryId)));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 17. 경기 평가 목록 조회
      case 'listMatchEvaluations': {
        const { playerId } = payload;
        if (!circuitBreaker.check()) {
          try {
            const q = playerId
              ? query(collection(db, 'matchEvaluations'), where('playerId', '==', playerId))
              : query(collection(db, 'matchEvaluations'));
            const snap = await fsOp(getDocs(q));
            const matches = [];
            snap.forEach(d => {
              const item = d.data();
              if (item) {
                const mid = item.matchId || item.id || d.id;
                item.matchId = mid;
                item.id = mid;
                serverCache.matchEvaluations[mid] = item;
                matches.push(item);
              }
            });
            persistServerCacheToDisk();
            matches.sort((a, b) => new Date(b.matchDate || b.createdAt || 0) - new Date(a.matchDate || a.createdAt || 0));
            return res.json({ ok: true, matches });
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        const matches = Object.values(serverCache.matchEvaluations)
          .filter(m => m && (!playerId || m.playerId === playerId))
          .sort((a, b) => new Date(b.matchDate || b.createdAt || 0) - new Date(a.matchDate || a.createdAt || 0));
        return res.json({ ok: true, matches, _fromCache: true });
      }

      // 18. 경기 평가 저장 (신규 등록 및 지도자/선수 수정 지원)
      case 'saveMatchEvaluation': {
        const match = payload.match;
        if (!match) return res.json({ ok: false, error: '저장할 경기 평가 데이터가 없습니다.' });
        const targetId = match.matchId || match.id;
        if (targetId) {
          match.matchId = targetId;
          match.id = targetId;
        } else {
          match.matchId = `match_${match.playerId}_${match.matchDate}_${Date.now()}`;
          match.id = match.matchId;
        }
        match.updatedAt = new Date().toISOString();
        if (!match.createdAt) match.createdAt = new Date().toISOString();

        serverCache.matchEvaluations[match.matchId] = match;
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(setDoc(doc(db, 'matchEvaluations', match.matchId), match, { merge: true }));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, matchId: match.matchId, _fromCache: circuitBreaker.isOpen });
      }

      // 19. 경기 평가 삭제
      case 'deleteMatchEvaluation': {
        const { matchId } = payload;
        delete serverCache.matchEvaluations[matchId];
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(deleteDoc(doc(db, 'matchEvaluations', matchId)));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 20. 전체 대시보드 데이터 조회 (TTL 중복 조회 방지 + 서킷 브레이커 + 캐시 폴백)
      case 'getAllData': {
        const now = Date.now();
        const hasCachedUsers = Object.keys(serverCache.users).length > 0;
        if (!circuitBreaker.check() && (!hasCachedUsers || now - serverCache.lastGetAllAt > 12000)) {
          try {
            const [usersSnap, entriesSnap, matchesSnap, diariesSnap] = await fsOp(
              Promise.all([
                getDocs(collection(db, 'users')),
                getDocs(collection(db, 'entries')),
                getDocs(collection(db, 'matchEvaluations')),
                getDocs(collection(db, 'diaries'))
              ]),
              3200
            );
            const nextUsers = {};
            usersSnap.forEach(d => {
              const u = d.data();
              if (u && u.id) nextUsers[u.id] = u;
            });
            const nextEntries = {};
            entriesSnap.forEach(d => {
              const item = d.data();
              if (item && item.entryId) {
                if (item.weekStartDate) item.weekStartDate = formatDateKST(item.weekStartDate);
                nextEntries[item.entryId] = item;
              }
            });
            const nextMatches = {};
            matchesSnap.forEach(d => {
              const item = d.data();
              if (item) {
                const mid = item.matchId || item.id || d.id;
                item.matchId = mid;
                item.id = mid;
                if (item.matchDate) item.matchDate = formatDateKST(item.matchDate);
                nextMatches[mid] = item;
              }
            });
            const nextDiaries = {};
            diariesSnap.forEach(d => {
              const item = d.data();
              if (item && item.diaryId) {
                if (item.date) item.date = formatDateKST(item.date);
                nextDiaries[item.diaryId] = item;
              }
            });

            serverCache.users = nextUsers;
            serverCache.entries = nextEntries;
            serverCache.matchEvaluations = nextMatches;
            serverCache.diaries = nextDiaries;
            serverCache.lastGetAllAt = now;
            serverCache.lastListUsersAt = now;
            persistServerCacheToDisk();
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        if (Object.keys(serverCache.users).length === 0) {
          await ensureServerCacheSeeded();
        }

        return res.json(getAllDataFromServerCache());
      }

      // 21. 오류 및 불편사항 제보 등록
      case 'submitBugReport': {
        const { userId, userName, userRole, content, screen, userAgent, systemLogs } = payload;
        if (!content || !content.trim()) return res.json({ ok: false, error: '제보 내용을 입력해주세요.' });
        const reportId = 'report_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const now = new Date();
        const reportData = {
          id: reportId,
          userId: userId || 'anonymous',
          userName: userName || '익명',
          userRole: userRole || 'player',
          content: content.trim(),
          screen: screen || '',
          userAgent: userAgent || '',
          systemLogs: Array.isArray(systemLogs) ? systemLogs.slice(-50) : [],
          createdAt: now.toISOString(),
          createdAtFormatted: now.toLocaleString('ko-KR', {
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
            hour12: true
          }),
          status: 'pending',
          adminReply: '',
          adminReplyDate: ''
        };

        serverCache.bugReports[reportId] = reportData;
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(setDoc(doc(db, 'bugReports', reportId), reportData));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, report: reportData, _fromCache: circuitBreaker.isOpen });
      }

      // 22. 오류 제보 목록 조회 (관리자는 전체, 일반 선수는 본인 것만)
      case 'listBugReports': {
        const { requesterId, isAdmin } = payload;
        if (!circuitBreaker.check()) {
          try {
            const reportsSnap = await fsOp(getDocs(collection(db, 'bugReports')));
            const nextReports = {};
            reportsSnap.forEach(d => {
              const r = d.data();
              if (r && r.id) nextReports[r.id] = r;
            });
            serverCache.bugReports = nextReports;
            persistServerCacheToDisk();
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }

        const reports = Object.values(serverCache.bugReports)
          .filter(r => r && (isAdmin || r.userId === requesterId))
          .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        return res.json({ ok: true, reports, _fromCache: circuitBreaker.isOpen });
      }

      // 23. 오류 제보 답변 등록/수정 (관리자 전용)
      case 'replyBugReport': {
        const { reportId, adminReply } = payload;
        if (!reportId) return res.json({ ok: false, error: '제보 ID가 필요합니다.' });
        const now = new Date();
        const dateStr = now.toLocaleString('ko-KR', {
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
          hour12: true
        });
        const updates = {
          adminReply: adminReply || '',
          adminReplyDate: adminReply ? dateStr : '',
          status: adminReply ? 'replied' : 'pending'
        };
        if (serverCache.bugReports[reportId]) {
          Object.assign(serverCache.bugReports[reportId], updates);
          persistServerCacheToDisk();
        }
        if (!circuitBreaker.check()) {
          try {
            await fsOp(updateDoc(doc(db, 'bugReports', reportId), updates));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, adminReply, adminReplyDate: dateStr, _fromCache: circuitBreaker.isOpen });
      }

      // 24. 오류 제보 삭제 (관리자 전용)
      case 'deleteBugReport': {
        const { reportId } = payload;
        if (!reportId) return res.json({ ok: false, error: '제보 ID가 필요합니다.' });
        delete serverCache.bugReports[reportId];
        persistServerCacheToDisk();

        if (!circuitBreaker.check()) {
          try {
            await fsOp(deleteDoc(doc(db, 'bugReports', reportId)));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
          }
        }
        return res.json({ ok: true, _fromCache: circuitBreaker.isOpen });
      }

      // 25. 파일 / 사진 / 동영상 업로드
      case 'uploadFile': {
        const fileContent = payload.base64 || payload.fileData || payload.data;
        const fname = payload.filename || payload.fileName || 'file';
        const mtype = payload.mimeType || payload.fileType || 'application/octet-stream';
        if (!fileContent) return res.json({ ok: false, error: '파일 데이터가 없습니다.' });
        const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const fileRecord = {
          fileId,
          filename: fname,
          mimeType: mtype,
          data: fileContent,
          createdAt: new Date().toISOString()
        };
        serverCache.files[fileId] = fileRecord;

        if (!circuitBreaker.check()) {
          try {
            await fsOp(setDoc(doc(db, 'files', fileId), fileRecord));
          } catch (e) {
            if (!isQuotaOrTimeoutError(e)) throw e;
            // Quota exceeded 시에도 클라이언트/서버에서 즉시 표시 가능하도록 base64 또는 캐시 URL 반환
          }
        }
        const viewUrl = `/api/files/${fileId}`;
        return res.json({ ok: true, viewUrl, directUrl: viewUrl, fileUrl: viewUrl, _fromCache: circuitBreaker.isOpen });
      }

      // 19. 구글 스프레드시트 데이터 안전하게 Firebase로 가져오기 (마이그레이션)
      case 'importFromGoogleSheets': {
        const { sheetUrl } = payload;
        if (!sheetUrl) return res.json({ ok: false, error: '구글 스프레드시트 웹앱 URL을 입력해주세요.' });

        try {
          const gasRes = await fetch(sheetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action: 'getAllData', requesterId: 'admin' })
          });
          const gasData = await gasRes.json();
          if (!gasData || !gasData.ok) {
            return res.json({ ok: false, error: '구글 스프레드시트에서 데이터를 가져오지 못했습니다: ' + (gasData?.error || '응답 오류') });
          }

          let userCount = 0;
          let entryCount = 0;
          let diaryCount = 0;

          if (Array.isArray(gasData.users)) {
            for (const u of gasData.users) {
              if (u.id) {
                const userObj = {
                  id: String(u.id),
                  pw: u.pw || null,
                  name: u.name || String(u.id),
                  role: u.role || 'player',
                  photo: u.photo || '',
                  granted: u.granted !== false,
                  isAdmin: u.isAdmin === true,
                  isSynced: !!u.pw,
                  importedAt: new Date().toISOString()
                };
                serverCache.users[String(u.id)] = userObj;
                if (!circuitBreaker.check()) {
                  try {
                    await fsOp(setDoc(doc(db, 'users', String(u.id)), userObj, { merge: true }));
                  } catch (e) {}
                }
                userCount++;
              }
            }
          }

          if (Array.isArray(gasData.entries)) {
            for (const e of gasData.entries) {
              const entryId = e.entryId || `entry_${e.playerId}_${e.type}_${e.weekStartDate}_${Date.now()}`;
              e.entryId = entryId;
              e.importedAt = new Date().toISOString();
              serverCache.entries[entryId] = e;
              if (!circuitBreaker.check()) {
                try {
                  await fsOp(setDoc(doc(db, 'entries', entryId), e, { merge: true }));
                } catch (err) {}
              }
              entryCount++;
            }
          }

          if (Array.isArray(gasData.users)) {
            for (const u of gasData.users) {
              if (u.role === 'player' && u.id) {
                try {
                  const dRes = await fetch(sheetUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify({ action: 'listDiary', playerId: String(u.id) })
                  });
                  const dData = await dRes.json();
                  if (dData && dData.ok && Array.isArray(dData.diary)) {
                    for (const d of dData.diary) {
                      const cleanDate = formatDateKST(d.date);
                      const diaryId = d.diaryId || `diary_${u.id}_${cleanDate}_${Date.now()}`;
                      d.diaryId = diaryId;
                      d.playerId = String(u.id);
                      if (d.date) d.date = cleanDate;
                      d.importedAt = new Date().toISOString();
                      serverCache.diaries[diaryId] = d;
                      if (!circuitBreaker.check()) {
                        try {
                          await fsOp(setDoc(doc(db, 'diaries', diaryId), d, { merge: true }));
                        } catch (err) {}
                      }
                      diaryCount++;
                    }
                  }
                } catch (de) {
                  console.warn('Diary import notice for player ' + u.id + ':', de.message);
                }
              }
            }
          }

          persistServerCacheToDisk();
          return res.json({
            ok: true,
            message: `성공적으로 데이터를 가져왔습니다. (선수/지도자: ${userCount}명, 훈련일지: ${entryCount}건, 포토일지: ${diaryCount}건)`,
            userCount,
            entryCount,
            diaryCount
          });
        } catch (fetchErr) {
          return res.json({ ok: false, error: '구글 스프레드시트 통신 실패: ' + fetchErr.message });
        }
      }

      default:
        return res.status(400).json({ ok: false, error: `알 수 없는 액션입니다: ${action}` });
    }
  } catch (err) {
    console.error(`API Error [${action}]:`, err);
    if (isQuotaOrTimeoutError(err)) {
      circuitBreaker.trip(err);
      if (action === 'getAllData') {
        await ensureServerCacheSeeded();
        return res.json(getAllDataFromServerCache());
      }
      if (action === 'listUsers') {
        await ensureServerCacheSeeded();
        return res.json({ ok: true, users: Object.values(serverCache.users).map(sanitizeUserForClient), _fromCache: true });
      }
    }
    return res.status(500).json({ ok: false, error: err.message || '서버 처리 중 오류가 발생했습니다.' });
  }
}

// Bind API handler to /api as well as fallback POST paths
app.post('/api', handleApiRequest);
app.post('/', handleApiRequest);
app.post('/__cookie_check.html', handleApiRequest);
app.post('/warmup.html', handleApiRequest);

// Safety redirect for cookie check GET requests
app.get('/__cookie_check.html', (req, res) => {
  const returnUrl = req.query.return_url || '/';
  res.redirect(302, returnUrl);
});

// API fallback for undefined API routes to ensure JSON response instead of HTML
app.all('/api*', (req, res) => {
  res.status(404).json({ ok: false, error: `API 엔드포인트를 찾을 수 없습니다: ${req.method} ${req.originalUrl}` });
});

// SPA fallback to index.html for page routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Global Express error handler to prevent HTML error responses
app.use((err, req, res, next) => {
  console.error('Express Server Error:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    ok: false,
    error: err.message || '서버 처리 중 오류가 발생했습니다.'
  });
});

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

export default app;
