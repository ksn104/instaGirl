import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { StudioBrowser, validateSettings } from '../automation.mjs';

test('외부 사이트와 잘못된 선택자 설정 차단', () => {
  for (const url of ['https://higgsfield.ai.evil.test/', 'http://higgsfield.ai/', 'https://user:pass@higgsfield.ai/', 'file:///tmp/file']) assert.throws(() => validateSettings({ url }));
  assert.equal(validateSettings({ url: 'https://higgsfield.ai/create/video' }).url, 'https://higgsfield.ai/create/video');
  assert.throws(() => validateSettings({ upload: [] }));
});
test('생성 클릭 타임아웃 후 중복 생성 방지', async () => {
  const browser = new StudioBrowser('/tmp/unused', () => {});
  let clicks = 0;
  const button = { count: async () => 1, click: async () => { clicks++; throw new Error('Timeout'); } };
  browser.current = async () => ({ getByRole: () => button });
  browser.prepared = true;
  await assert.rejects(browser.generate({}), /Timeout/);
  await assert.rejects(browser.generate({}), /먼저/);
  assert.equal(clicks, 1);
});
test('로컬 API: 보안 검사, 이미지 유효성, 업로드 후 파일 삭제', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-test-'));
  let preparedText = '', preparedFile = '';
  const { app } = await createApp({ directory, browserFactory: () => ({ prepared: false, prepare: async (file, prompt) => { preparedFile = file; preparedText = prompt; assert.ok((await fs.stat(file)).size > 0); } }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { Origin: 'https://evil.test', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const foreignHostStatus = await new Promise((resolve, reject) => { const req = http.get(`${base}/api/status`, { headers: { Host: 'evil.test:4317' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
  assert.equal(foreignHostStatus, 403);
  const invalid = new FormData(); invalid.append('image', new Blob(['not an image'], { type: 'image/png' }), 'x.png'); invalid.append('prompt', 'Hello');
  assert.equal((await fetch(`${base}/api/prepare`, { method: 'POST', body: invalid })).status, 400);
  const valid = new FormData(); valid.append('image', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6wAAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), 'x.png'); valid.append('prompt', 'Natural motion');
  assert.equal((await fetch(`${base}/api/prepare`, { method: 'POST', body: valid })).status, 200);
  assert.equal(preparedText, 'Natural motion'); await assert.rejects(fs.stat(preparedFile), { code: 'ENOENT' });
});

test('결과 검색은 URL을 노출하지 않고 동일 영상의 ID 유지 및 사라진 결과 제거', async () => {
  const browser = new StudioBrowser('/tmp/unused', () => {});
  let clips = [{ url: 'https://media.example.com/clip.mp4?signature=private', duration: 5, width: 720, height: 1280 }];
  browser.current = async () => ({ locator: () => ({ evaluateAll: async () => clips }) });
  const first = await browser.scan({});
  assert.equal(first[0].supported, true);
  assert.equal('url' in first[0], false);
  assert.equal((await browser.scan({}))[0].id, first[0].id);
  clips = [];
  assert.deepEqual(await browser.scan({}), []);
  await assert.rejects(browser.importResult(first[0].id), /다시 검색/);
  browser.results.set('blob', { url: 'blob:https://higgsfield.ai/id' });
  await assert.rejects(browser.importResult('blob'), /가져올 수 없는/);
});
