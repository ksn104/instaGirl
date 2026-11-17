import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StudioBrowser, validateSettings } from './automation.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export async function createApp({ directory = path.join(root, '.local'), browserFactory } = {}) {
  await Promise.all(['uploads', 'downloads'].map(dir => fs.mkdir(path.join(directory, dir), { recursive: true, mode: 0o700 })));
  let settings = validateSettings();
  try { settings = validateSettings(JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'))); } catch {}
  const events = []; let busy = false;
  const log = message => { events.unshift({ time: new Date().toISOString(), message }); events.splice(30); };
  const browser = browserFactory ? browserFactory(directory, log) : new StudioBrowser(directory, log);
  const app = express();
  app.use((req, res, next) => {
    const host = req.headers.host || '';
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return res.status(403).json({ error: '로컬 접속만 허용됩니다.' });
    if ((req.headers.origin && req.headers.origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '다른 사이트의 요청은 허용되지 않습니다.' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 1, fieldSize: 16000 } });
  const action = handler => async (req, res, next) => {
    if (busy) return res.status(409).json({ error: '이전 작업이 진행 중입니다.' });
    busy = true;
    try { const message = await handler(req); log(message); res.json({ message }); }
    catch (error) { next(error); } finally { busy = false; }
  };
  app.get('/api/status', async (req, res) => res.json({ settings, busy, prepared: browser.prepared, open: Boolean(browser.context), results: browser.listResults?.() || [], events, downloads: (await fs.readdir(path.join(directory, 'downloads'))).filter(name => !name.startsWith('.')).sort().reverse() }));
  app.post('/api/settings', action(async req => {
    settings = validateSettings(req.body);
    await fs.writeFile(path.join(directory, 'settings.json'), JSON.stringify(settings, null, 2), { mode: 0o600 });
    browser.prepared = false;
    return '연결 설정을 저장했습니다.';
  }));
  app.post('/api/open', action(async () => { await browser.open(settings); return '브라우저에서 로그인하고 이미지→영상 제작 화면을 열어주세요.'; }));
  app.post('/api/prepare', upload.single('image'), action(async req => {
    browser.prepared = false;
    const b = req.file?.buffer;
    const png = b && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpg = b && b[0] === 255 && b[1] === 216 && b[2] === 255;
    const webp = b && b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
    if (!(png || jpg || webp)) throw new Error('PNG, JPG, WebP 이미지를 선택하세요.');
    if (typeof req.body.prompt !== 'string' || !req.body.prompt.trim() || req.body.prompt.length > 8000) throw new Error('프롬프트는 1~8,000자로 입력하세요.');
    const file = path.join(directory, 'uploads', `${randomUUID()}.${png ? 'png' : jpg ? 'jpg' : 'webp'}`);
    await fs.writeFile(file, b, { mode: 0o600 });
    try { await browser.prepare(file, req.body.prompt, settings); } finally { await fs.unlink(file).catch(() => {}); }
    return '이미지와 프롬프트를 입력했습니다. 힉스필드 화면에서 업로드 완료, 모델·길이·비율·비용을 확인한 후 생성하세요.';
  }));
  app.post('/api/generate', action(async () => {
    await browser.generate(settings);
    return '생성 버튼을 클릭했습니다. 결과 영상 검색을 누르면 열린 힉스필드 화면의 영상을 찾습니다.';
  }));
  app.post('/api/results/scan', action(async () => {
    const results = await browser.scan(settings);
    return results.length ? `영상 ${results.length}개를 찾았습니다. 결과 후보에서 가져오기를 누르면 아래에서 재생하고 다운로드할 수 있습니다.` : '현재 화면에서 영상을 찾지 못했습니다. 생성이 완료됐는지 확인하고 힉스필드에서 결과 화면을 여세요.';
  }));
  app.post('/api/results/import', action(async req => {
    if (typeof req.body.id !== 'string') throw new Error('영상 항목을 선택하세요.');
    const name = await browser.importResult(req.body.id);
    return `영상을 가져왔습니다: ${name}`;
  }));
  app.use('/downloads', express.static(path.join(directory, 'downloads'), { dotfiles: 'deny' }));
  app.use(express.static(path.join(root, 'public')));
  app.use((error, req, res, next) => {
    const message = error.code === 'LIMIT_FILE_SIZE' ? '이미지는 20MB 이하여야 합니다.' : error.message || '작업에 실패했습니다.';
    log(message); res.status(400).json({ error: message });
  });
  return { app, browser };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { app, browser } = await createApp();
  const server = app.listen(4317, '127.0.0.1', () => console.log('Persona Motion: http://127.0.0.1:4317'));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await browser.close(); server.close(() => process.exit()); });
}
