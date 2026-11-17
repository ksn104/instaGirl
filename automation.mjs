import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';

export function validateSettings(value = {}) {
  const url = new URL(value.url || 'https://higgsfield.ai/');
  if (url.protocol !== 'https:' || !(url.hostname === 'higgsfield.ai' || url.hostname.endsWith('.higgsfield.ai')) || url.username || url.password) throw new Error('힉스필드 HTTPS 주소만 사용할 수 있습니다.');
  const result = { url: url.href };
  for (const key of ['upload', 'prompt', 'generate', 'result']) {
    if (typeof (value[key] ?? '') !== 'string' || (value[key] || '').length > 500) throw new Error('선택자 형식을 확인하세요.');
    result[key] = (value[key] || '').trim();
  }
  return result;
}
export class StudioBrowser {
  constructor(directory, notify) { this.directory = directory; this.notify = notify; this.context = null; this.page = null; this.prepared = false; this.results = new Map(); this.watched = new WeakSet(); }
  async open(settings) {
    if (!this.context) {
      this.context = await chromium.launchPersistentContext(path.join(this.directory, 'browser-profile'), { headless: false, acceptDownloads: true, viewport: null });
      this.context.on('close', () => { this.context = null; this.page = null; this.prepared = false; });
      this.context.on('page', page => this.watch(page));
      this.context.pages().forEach(page => this.watch(page));
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context.pages()[0] || await this.context.newPage();
      await this.page.goto(settings.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    await this.page.bringToFront();
    return this.page;
  }
  watch(page) {
    if (this.watched.has(page)) return;
    this.watched.add(page);
    page.on('download', async download => {
      try {
        const name = `${Date.now()}-${path.basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const temporary = path.join(this.directory, 'downloads', `.${randomUUID()}.part`);
        await download.saveAs(temporary);
        await fs.rename(temporary, path.join(this.directory, 'downloads', name));
        this.notify(`다운로드 완료: ${name}`);
      } catch { this.notify('다운로드에 실패했습니다. 힉스필드에서 다시 다운로드하세요.'); }
    });
  }
  async current() {
    const pages = this.context?.pages().filter(p => !p.isClosed() && /^https:\/\/([\w-]+\.)*higgsfield\.ai(?:\/|$)/.test(p.url())) || [];
    if (!pages.length) throw new Error('먼저 브라우저를 열고 로그인한 다음 영상 제작 화면으로 이동하세요.');
    this.page = pages.at(-1);
    return this.page;
  }
  async unique(locator, label) {
    const count = await locator.count();
    if (count !== 1) throw new Error(`${label} 항목을 ${count}개 찾았습니다. 힉스필드 영상 제작 화면으로 이동하거나 연결 설정의 CSS 선택자를 지정하세요.`);
    return locator;
  }
  async prepare(file, prompt, settings) {
    this.prepared = false;
    const page = await this.current();
    const upload = await this.unique(page.locator(settings.upload || 'input[type="file"][accept*="image"]'), '이미지 업로드');
    await upload.setInputFiles(file, { timeout: 15000 });
    const input = await this.unique(page.locator(settings.prompt || 'textarea:visible, [contenteditable="true"]:visible'), '프롬프트 입력');
    await input.fill(prompt, { timeout: 15000 });
    this.prepared = true;
    await page.bringToFront();
  }
  async generate(settings) {
    if (!this.prepared) throw new Error('이미지와 프롬프트를 먼저 자동 입력하세요.');
    const page = await this.current();
    const button = await this.unique(settings.generate ? page.locator(settings.generate) : page.getByRole('button', { name: /^(generate|create|생성|영상 생성)(\s.*)?$/i }), '영상 생성 버튼');
    // Disable retries before clicking: a timed-out click may already have submitted a paid job.
    this.prepared = false;
    await button.click({ timeout: 15000 });
  }
  async scan(settings) {
    const page = await this.current();
    const clips = await page.locator(settings.result || 'main video').evaluateAll(elements => elements.map(element => ({
      url: element.currentSrc || element.src || element.querySelector('source')?.src || '',
      duration: Number.isFinite(element.duration) ? element.duration : null,
      width: element.videoWidth || 0, height: element.videoHeight || 0,
    })).filter(clip => clip.url).slice(0, 30));
    const previous = new Map([...this.results.values()].map(result => [result.url, result]));
    this.results.clear();
    for (const clip of clips) {
      const result = previous.get(clip.url) || { id: randomUUID(), ...clip };
      this.results.set(result.id, result);
    }
    return this.listResults();
  }
  listResults() {
    return [...this.results.values()].map(({ url, ...result }) => ({ ...result, supported: url.startsWith('https://') }));
  }
  async importResult(id) {
    const result = this.results.get(id);
    if (!result) throw new Error('영상을 다시 검색한 후 선택하세요.');
    if (result.filename) return result.filename;
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('직접 가져올 수 없는 영상 형식입니다. 힉스필드의 Download를 사용하세요.');
    const addresses = await lookup(url.hostname, { all: true, family: 4 });
    if (!addresses.length || addresses.some(({ address }) => {
      const [a,b] = address.split('.').map(Number);
      return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
    })) throw new Error('공개 영상 주소만 가져올 수 있습니다.');
    const response = await this.context.request.get(url.href, { timeout: 120000, maxRedirects: 0 });
    try {
      const type = (response.headers()['content-type'] || '').split(';')[0];
      if (!response.ok() || !['video/mp4', 'video/webm', 'video/quicktime'].includes(type)) throw new Error('재생 가능한 영상 파일을 가져오지 못했습니다. 힉스필드에서 결과를 연 뒤 다시 검색하세요.');
      const limit = 150 * 1024 * 1024;
      if (Number(response.headers()['content-length']) > limit) throw new Error('150MB 이하의 영상만 가져올 수 있습니다.');
      const bytes = await response.body();
      if (bytes.length > limit) throw new Error('150MB 이하의 영상만 가져올 수 있습니다.');
      const name = `${Date.now()}-${randomUUID().slice(0,8)}.${type === 'video/webm' ? 'webm' : type === 'video/quicktime' ? 'mov' : 'mp4'}`;
      const temporary = path.join(this.directory, 'downloads', `.${randomUUID()}.part`);
      try {
        await fs.writeFile(temporary, bytes, { mode: 0o600 });
        await fs.rename(temporary, path.join(this.directory, 'downloads', name));
      } finally { await fs.unlink(temporary).catch(() => {}); }
      result.filename = name;
      return name;
    } finally { await response.dispose(); }
  }
  async close() { await this.context?.close(); }
}
