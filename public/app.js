const $ = id => document.getElementById(id);
let imageFile = null, imageUrl = null, working = false, initialized = false, renderedDownloads = '', renderedResults = '';
function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function prompt() {
  const text = [$('scene').value.trim(), $('camera').value, $('tone').value, $('identity').checked ? 'Preserve the identity, facial features, hairstyle and clothing of the reference character. Natural anatomy and consistent appearance.' : ''].filter(Boolean).join('\n');
  $('prompt').textContent = text; return text;
}
for (const id of ['scene', 'camera', 'tone', 'identity']) $(id).addEventListener('input', prompt);
document.querySelectorAll('[data-scene]').forEach(button => button.onclick = () => { $('scene').value = button.dataset.scene; prompt(); });
function setImage(file) {
  if (file && (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024)) return status('20MB 이하의 PNG, JPG, WebP 이미지를 선택하세요.', true);
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageFile = file; imageUrl = file ? URL.createObjectURL(file) : null;
  $('preview').hidden = !file; $('empty').hidden = Boolean(file); $('remove').hidden = !file;
  if (file) $('preview').src = imageUrl; else { $('preview').removeAttribute('src'); $('image').value = ''; }
  $('filename').textContent = file ? file.name : '힉스필드에서 만든 인물 이미지를 선택하세요.';
}
$('image').onchange = event => setImage(event.target.files[0]); $('remove').onclick = () => setImage(null);
$('drop').ondragover = event => { event.preventDefault(); $('drop').classList.add('drag'); };
$('drop').ondragleave = () => $('drop').classList.remove('drag');
$('drop').ondrop = event => { event.preventDefault(); $('drop').classList.remove('drag'); setImage(event.dataTransfer.files[0]); };
async function action(url, body) {
  if (working) return;
  working = true; document.querySelectorAll('button').forEach(b => b.disabled = true);
  status('작업 중입니다. 열린 브라우저를 닫지 마세요…');
  try {
    const response = await fetch(url, { method: 'POST', headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' }, body: body instanceof FormData ? body : JSON.stringify(body || {}) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error);
    status(data.message);
  } catch (error) { status(error.message, true); }
  finally { working = false; document.querySelectorAll('button').forEach(b => b.disabled = false); await refresh(); }
}
$('open').onclick = () => action('/api/open');
$('prepare').onclick = () => {
  if (!imageFile) return status('인물 이미지를 선택하세요.', true);
  if (!$('scene').value.trim()) return status('장면 설명을 입력하세요.', true);
  const data = new FormData(); data.append('image', imageFile); data.append('prompt', prompt()); action('/api/prepare', data);
};
$('scan').onclick = () => action('/api/results/scan');
$('generate').onclick = () => action('/api/generate');
$('save').onclick = () => action('/api/settings', { url: $('url').value, upload: $('uploadSelector').value, prompt: $('promptSelector').value, generate: $('generateSelector').value, result: $('resultSelector').value });
$('copy').onclick = async () => { try { await navigator.clipboard.writeText(prompt()); status('프롬프트를 복사했습니다.'); } catch { status('자동 복사가 불가능합니다. 펼쳐진 프롬프트를 선택해 복사하세요.', true); } };
async function refresh() {
  try {
    const response = await fetch('/api/status'); if (!response.ok) throw new Error(); const data = await response.json();
    $('connection').textContent = data.open ? '● 전용 브라우저 열림 · 로그인은 화면에서 확인' : '브라우저 연결 전';
    $('generate').disabled = working || !data.prepared;
    if (!initialized) { for (const [id,key] of [['url','url'],['uploadSelector','upload'],['promptSelector','prompt'],['generateSelector','generate'],['resultSelector','result']]) $(id).value = data.settings[key] || ''; initialized = true; }
    $('events').replaceChildren(...data.events.map(event => { const li = document.createElement('li'); li.textContent = `${new Date(event.time).toLocaleTimeString('ko-KR')} · ${event.message}`; return li; }));
    const resultKey = JSON.stringify(data.results);
    if (resultKey !== renderedResults) {
      renderedResults = resultKey;
      $('candidates').replaceChildren(...(data.results || []).map((result, index) => {
        const row = document.createElement('div'); row.className = 'candidate';
        const text = document.createElement('span');
        text.textContent = `영상 후보 ${index + 1} · ${result.width}×${result.height}${result.duration ? ` · ${Math.round(result.duration)}초` : ''}`;
        const button = document.createElement('button');
        button.textContent = result.filename ? '가져옴' : result.supported ? '가져와서 확인' : '직접 가져오기 미지원';
        button.dataset.unavailable = String(Boolean(result.filename || !result.supported));
        button.disabled = working || button.dataset.unavailable === 'true';
        button.onclick = () => action('/api/results/import', { id: result.id });
        row.append(text, button); return row;
      }));
    }
    document.querySelectorAll('[data-unavailable]').forEach(button => button.disabled = working || button.dataset.unavailable === 'true');
    const downloadsKey = JSON.stringify(data.downloads);
    // Keep existing video nodes during status polling so playback is not interrupted.
    if (downloadsKey !== renderedDownloads) {
      renderedDownloads = downloadsKey;
      const existing = new Map([...$('downloads').children].map(card => [card.dataset.name, card]));
      for (const card of existing.values()) if (!data.downloads.includes(card.dataset.name)) card.remove();
      for (const name of [...data.downloads].reverse()) {
        if (existing.has(name)) continue;
        const card = document.createElement('article'); card.className = 'video-card'; card.dataset.name = name;
        const source = `/downloads/${encodeURIComponent(name)}`;
        if (/\.(mp4|webm|mov)$/i.test(name)) {
          const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; video.playsInline = true; video.src = source;
          video.setAttribute('aria-label', '가져온 영상 재생');
          const error = document.createElement('p'); error.className = 'hint'; error.hidden = true; error.textContent = '이 브라우저에서 재생할 수 없습니다. 파일을 다운로드해 확인하세요.';
          video.addEventListener('error', () => error.hidden = false);
          card.append(video, error);
        }
        const label = document.createElement('p'); label.textContent = name;
        const a = document.createElement('a'); a.href = source; a.download = name; a.textContent = '↓ 영상 다운로드';
        card.append(label, a); $('downloads').prepend(card);
      }
    }
  } catch { if (!working) status('로컬 서버와 연결할 수 없습니다. 터미널에서 npm start 실행 여부를 확인하세요.', true); }
}
prompt(); refresh(); setInterval(refresh, 4000);
