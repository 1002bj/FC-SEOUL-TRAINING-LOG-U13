import express from 'express';
import path from 'path';
import fs from 'fs';
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
  updateDoc
} from 'firebase/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read Firebase config
const firebaseConfigRaw = fs.readFileSync(path.join(__dirname, 'firebase-applet-config.json'), 'utf-8');
const firebaseConfig = JSON.parse(firebaseConfigRaw);

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId || '(default)');

const app = express();
const PORT = 3000;

// High limit for photos / videos in base64
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));

// Static file serving
app.use(express.static(__dirname));

// Ensure test connection
async function initDatabase() {
  try {
    const testRef = doc(db, 'test', 'connection');
    await setDoc(testRef, { connected: true, timestamp: new Date().toISOString() }, { merge: true });
    console.log('[Firebase] Connected successfully to Firestore database:', firebaseConfig.firestoreDatabaseId);
  } catch (err) {
    console.warn('[Firebase] Database initialization notice:', err.message);
  }
}
initDatabase();

// File retrieval endpoint for uploaded photos / videos
app.get('/api/files/:id', async (req, res) => {
  try {
    const fileId = req.params.id;
    const fileDoc = await getDoc(doc(db, 'files', fileId));
    if (!fileDoc.exists()) {
      return res.status(404).send('File not found');
    }
    const data = fileDoc.data();
    if (data.data && data.data.startsWith('data:')) {
      const parts = data.data.split(',');
      const meta = parts[0];
      const base64Data = parts[1];
      const mime = meta.match(/:(.*?);/)?.[1] || data.mimeType || 'application/octet-stream';
      const imgBuffer = Buffer.from(base64Data, 'base64');
      res.setHeader('Content-Type', mime);
      return res.send(imgBuffer);
    }
    return res.status(400).send('Invalid file format');
  } catch (err) {
    console.error('File retrieval error:', err);
    res.status(500).send('Error retrieving file');
  }
});

// Main API Handler for all applet actions
app.post('/api', async (req, res) => {
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
        const userRef = doc(db, 'users', id);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists()) {
          return res.json({ ok: false, error: '이미 사용 중인 아이디입니다.' });
        }

        const usersSnap = await getDocs(collection(db, 'users'));
        const isFirst = usersSnap.empty;
        const isAdmin = isFirst && role === 'coach';
        const granted = isFirst || false; // First account gets auto-approved, others wait for approval

        await setDoc(userRef, {
          id,
          pw,
          name,
          role: role || 'player',
          photo: photo || '',
          granted,
          isAdmin,
          createdAt: new Date().toISOString()
        });

        return res.json({ ok: true });
      }

      // 2. 로그인
      case 'login': {
        const { id, pw } = payload;
        if (!id || !pw) {
          return res.json({ ok: false, error: '아이디와 비밀번호를 입력해주세요.' });
        }
        const userRef = doc(db, 'users', id);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
          return res.json({ ok: false, error: '등록되지 않은 아이디입니다.' });
        }
        const user = userSnap.data();
        if (user.pw !== pw) {
          return res.json({ ok: false, error: '비밀번호가 일치하지 않습니다.' });
        }
        return res.json({
          ok: true,
          user: {
            id: user.id,
            name: user.name,
            role: user.role,
            photo: user.photo || '',
            granted: user.granted || false,
            isAdmin: user.isAdmin || false
          }
        });
      }

      // 3. 아이디 찾기
      case 'findId': {
        const { name } = payload;
        if (!name) return res.json({ ok: false, error: '이름을 입력해주세요.' });
        const q = query(collection(db, 'users'), where('name', '==', name));
        const qSnap = await getDocs(q);
        if (qSnap.empty) {
          return res.json({ ok: false, error: '해당 이름으로 가입된 아이디를 찾을 수 없습니다.' });
        }
        const ids = [];
        qSnap.forEach(d => ids.push(d.data().id));
        return res.json({ ok: true, ids });
      }

      // 4. 비밀번호 재설정
      case 'resetPw': {
        const { id, name, newPw } = payload;
        if (!id || !name || !newPw) return res.json({ ok: false, error: '모든 항목을 입력해주세요.' });
        const userRef = doc(db, 'users', id);
        const userSnap = await getDoc(userRef);
        if (!userSnap.exists()) {
          return res.json({ ok: false, error: '아이디가 존재하지 않습니다.' });
        }
        const user = userSnap.data();
        if (user.name !== name) {
          return res.json({ ok: false, error: '가입된 이름과 일치하지 않습니다.' });
        }
        await updateDoc(userRef, { pw: newPw });
        return res.json({ ok: true });
      }

      // 5. 사용자 목록 조회
      case 'listUsers': {
        const snap = await getDocs(collection(db, 'users'));
        const users = [];
        snap.forEach(d => {
          const u = d.data();
          users.push({
            id: u.id,
            name: u.name,
            role: u.role,
            photo: u.photo || '',
            granted: u.granted || false,
            isAdmin: u.isAdmin || false
          });
        });
        return res.json({ ok: true, users });
      }

      // 6. 가입 승인 및 역할 지정
      case 'setRoleAndApprove': {
        const { targetId, role } = payload;
        const userRef = doc(db, 'users', targetId);
        await updateDoc(userRef, { role, granted: true });
        return res.json({ ok: true });
      }

      // 7. 권한 부여/회수
      case 'setPermission': {
        const { targetId, granted } = payload;
        const userRef = doc(db, 'users', targetId);
        await updateDoc(userRef, { granted });
        return res.json({ ok: true });
      }

      // 7-1. 사용자 프로필 사진 수정
      case 'updateUserPhoto': {
        const { userId, photo } = payload;
        if (!userId) return res.json({ ok: false, error: '사용자 ID가 필요합니다.' });
        const userRef = doc(db, 'users', userId);
        await updateDoc(userRef, { photo: photo || '' });
        return res.json({ ok: true });
      }

      // 8. 계정 삭제
      case 'deleteUser': {
        const { targetId, deleteEntries } = payload;
        await deleteDoc(doc(db, 'users', targetId));
        if (deleteEntries) {
          // Delete entries
          const eq = query(collection(db, 'entries'), where('playerId', '==', targetId));
          const eSnap = await getDocs(eq);
          const eDeletions = eSnap.docs.map(d => deleteDoc(d.ref));
          await Promise.all(eDeletions);

          // Delete diaries
          const dq = query(collection(db, 'diaries'), where('playerId', '==', targetId));
          const dSnap = await getDocs(dq);
          const dDeletions = dSnap.docs.map(d => deleteDoc(d.ref));
          await Promise.all(dDeletions);

          // Delete match evaluations
          const mq = query(collection(db, 'matchEvaluations'), where('playerId', '==', targetId));
          const mSnap = await getDocs(mq);
          const mDeletions = mSnap.docs.map(d => deleteDoc(d.ref));
          await Promise.all(mDeletions);
        }
        return res.json({ ok: true });
      }

      // 9. 주기화 일지 목록
      case 'listEntries': {
        const { playerId, type } = payload;
        let q;
        if (type) {
          q = query(collection(db, 'entries'), where('playerId', '==', playerId), where('type', '==', type));
        } else {
          q = query(collection(db, 'entries'), where('playerId', '==', playerId));
        }
        const snap = await getDocs(q);
        const entries = [];
        snap.forEach(d => entries.push(d.data()));
        return res.json({ ok: true, entries });
      }

      // 10. 특정 주기화 일지 조회
      case 'getEntry': {
        const { entryId } = payload;
        const ref = doc(db, 'entries', entryId);
        const snap = await getDoc(ref);
        if (!snap.exists()) {
          return res.json({ ok: false, error: '일지를 찾을 수 없습니다.' });
        }
        return res.json({ ok: true, entry: snap.data() });
      }

      // 11. 주기화 일지 저장
      case 'saveEntry': {
        const entry = payload.entry;
        if (!entry) return res.json({ ok: false, error: '저장할 일지 데이터가 없습니다.' });
        if (!entry.entryId) {
          entry.entryId = `entry_${entry.playerId}_${entry.type}_${entry.weekStartDate}_${Date.now()}`;
        }
        entry.updatedAt = new Date().toISOString();
        await setDoc(doc(db, 'entries', entry.entryId), entry);
        return res.json({ ok: true, entryId: entry.entryId });
      }

      // 12. 주기화 일지 삭제
      case 'deleteEntry': {
        const { entryId } = payload;
        await deleteDoc(doc(db, 'entries', entryId));
        return res.json({ ok: true });
      }

      // 13. 포토 일지 목록
      case 'listDiary': {
        const { playerId } = payload;
        const q = query(collection(db, 'diaries'), where('playerId', '==', playerId));
        const snap = await getDocs(q);
        const diary = [];
        snap.forEach(d => diary.push(d.data()));
        return res.json({ ok: true, diary });
      }

      // 14. 포토 일지 저장
      case 'saveDiary': {
        const { playerId, playerName, date, photoUrl, memo } = payload;
        const diaryId = `diary_${playerId}_${date}_${Date.now()}`;
        const diaryData = {
          diaryId,
          playerId,
          playerName,
          date,
          photoUrl: photoUrl || '',
          memo: memo || '',
          createdAt: new Date().toISOString()
        };
        await setDoc(doc(db, 'diaries', diaryId), diaryData);
        return res.json({ ok: true, diaryId });
      }

      // 15. 포토 일지 메모 수정
      case 'updateDiaryMemo': {
        const { diaryId, memo } = payload;
        await updateDoc(doc(db, 'diaries', diaryId), { memo });
        return res.json({ ok: true });
      }

      // 16. 포토 일지 삭제
      case 'deleteDiary': {
        const { diaryId } = payload;
        await deleteDoc(doc(db, 'diaries', diaryId));
        return res.json({ ok: true });
      }

      // 17. 경기 평가 목록 조회
      case 'listMatchEvaluations': {
        const { playerId } = payload;
        let q;
        if (playerId) {
          q = query(collection(db, 'matchEvaluations'), where('playerId', '==', playerId));
        } else {
          q = query(collection(db, 'matchEvaluations'));
        }
        const snap = await getDocs(q);
        const matches = [];
        snap.forEach(d => matches.push(d.data()));
        matches.sort((a, b) => new Date(b.matchDate || b.createdAt) - new Date(a.matchDate || a.createdAt));
        return res.json({ ok: true, matches });
      }

      // 18. 경기 평가 저장
      case 'saveMatchEvaluation': {
        const match = payload.match;
        if (!match) return res.json({ ok: false, error: '저장할 경기 평가 데이터가 없습니다.' });
        if (!match.matchId) {
          match.matchId = `match_${match.playerId}_${match.matchDate}_${Date.now()}`;
        }
        match.updatedAt = new Date().toISOString();
        if (!match.createdAt) match.createdAt = new Date().toISOString();
        await setDoc(doc(db, 'matchEvaluations', match.matchId), match, { merge: true });
        return res.json({ ok: true, matchId: match.matchId });
      }

      // 19. 경기 평가 삭제
      case 'deleteMatchEvaluation': {
        const { matchId } = payload;
        await deleteDoc(doc(db, 'matchEvaluations', matchId));
        return res.json({ ok: true });
      }

      // 20. 전체 대시보드 데이터 조회
      case 'getAllData': {
        const [usersSnap, entriesSnap, matchesSnap] = await Promise.all([
          getDocs(collection(db, 'users')),
          getDocs(collection(db, 'entries')),
          getDocs(collection(db, 'matchEvaluations'))
        ]);
        const users = [];
        usersSnap.forEach(d => {
          const u = d.data();
          users.push({
            id: u.id,
            name: u.name,
            role: u.role,
            photo: u.photo || '',
            granted: u.granted || false,
            isAdmin: u.isAdmin || false
          });
        });
        const entries = [];
        entriesSnap.forEach(d => entries.push(d.data()));
        const matches = [];
        matchesSnap.forEach(d => matches.push(d.data()));
        matches.sort((a, b) => new Date(b.matchDate || b.createdAt) - new Date(a.matchDate || a.createdAt));
        return res.json({ ok: true, users, entries, matches });
      }

      // 21. 파일 / 사진 / 동영상 업로드
      case 'uploadFile': {
        const fileContent = payload.base64 || payload.fileData || payload.data;
        const fname = payload.filename || payload.fileName || 'file';
        const mtype = payload.mimeType || payload.fileType || 'application/octet-stream';
        if (!fileContent) return res.json({ ok: false, error: '파일 데이터가 없습니다.' });
        const fileId = `file_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        await setDoc(doc(db, 'files', fileId), {
          fileId,
          filename: fname,
          mimeType: mtype,
          data: fileContent,
          createdAt: new Date().toISOString()
        });
        const viewUrl = `/api/files/${fileId}`;
        return res.json({ ok: true, viewUrl, directUrl: viewUrl, fileUrl: viewUrl });
      }

      // 19. 구글 스프레드시트 데이터 안전하게 Firebase로 가져오기 (마이그레이션)
      case 'importFromGoogleSheets': {
        const { sheetUrl } = payload;
        if (!sheetUrl) return res.json({ ok: false, error: '구글 스프레드시트 웹앱 URL을 입력해주세요.' });

        try {
          // 구글 스프레드시트 데이터 읽기 전용 조회
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

          // 1) 사용자 데이터 가져오기
          if (Array.isArray(gasData.users)) {
            for (const u of gasData.users) {
              if (u.id) {
                const userRef = doc(db, 'users', String(u.id));
                await setDoc(userRef, {
                  id: String(u.id),
                  pw: u.pw || '1234',
                  name: u.name || String(u.id),
                  role: u.role || 'player',
                  photo: u.photo || '',
                  granted: u.granted !== false,
                  isAdmin: u.isAdmin === true,
                  importedAt: new Date().toISOString()
                }, { merge: true });
                userCount++;
              }
            }
          }

          // 2) 주기화 일지 데이터 가져오기
          if (Array.isArray(gasData.entries)) {
            for (const e of gasData.entries) {
              const entryId = e.entryId || `entry_${e.playerId}_${e.type}_${e.weekStartDate}_${Date.now()}`;
              e.entryId = entryId;
              e.importedAt = new Date().toISOString();
              await setDoc(doc(db, 'entries', entryId), e, { merge: true });
              entryCount++;
            }
          }

          // 3) 선수별 포토 일지 가져오기 (가능한 경우)
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
                      const diaryId = d.diaryId || `diary_${u.id}_${d.date}_${Date.now()}`;
                      d.diaryId = diaryId;
                      d.playerId = String(u.id);
                      d.importedAt = new Date().toISOString();
                      await setDoc(doc(db, 'diaries', diaryId), d, { merge: true });
                      diaryCount++;
                    }
                  }
                } catch (de) {
                  console.warn('Diary import notice for player ' + u.id + ':', de.message);
                }
              }
            }
          }

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
    return res.status(500).json({ ok: false, error: err.message || '서버 처리 중 오류가 발생했습니다.' });
  }
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
});
