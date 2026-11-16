(() => {
  const $ = id => document.getElementById(id);
  let csrf = '';
  const showMessage = (id, text, good = false) => { $(id).textContent = text; $(id).style.color = good ? '#7ed9a0' : '#ff7884'; };
  const api = async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (csrf && options.method && options.method !== 'GET') headers['x-csrf-token'] = csrf;
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'درخواست ناموفق بود.');
    return data;
  };
  const formatDate = value => new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  const enterDashboard = async () => {
    $('login-view').classList.add('hidden'); $('dashboard-view').classList.remove('hidden'); $('logout').classList.remove('hidden');
    await loadDashboard();
  };
  const loadDashboard = async () => {
    const data = await api('/api/admin/dashboard'); csrf = data.csrfToken;
    $('total-downloads').textContent = Number(data.total).toLocaleString('fa-IR');
    $('current-version').textContent = data.game.version;
    $('current-file').textContent = data.game.hasApk ? `فایل آماده دانلود · ${formatSize(data.game.apkSize)}` : 'فایل APK منتشر نشده';
    $('gameName').value = data.game.gameName; $('version').value = data.game.version; $('description').value = data.game.description;
    $('downloads-body').replaceChildren();
    if (!data.recent.length) $('downloads-body').innerHTML = '<tr><td colspan="5" class="muted">هنوز دانلودی ثبت نشده است.</td></tr>';
    data.recent.forEach(item => {
      const tr = document.createElement('tr');
      [item.downloadId, item.version, formatDate(item.createdAt), item.browser, item.device].forEach(value => { const td = document.createElement('td'); td.textContent = value; tr.appendChild(td); });
      $('downloads-body').appendChild(tr);
    });
    $('versions-list').textContent = data.byVersion.length ? data.byVersion.map(v => `${v.version}: ${v.count.toLocaleString('fa-IR')} دانلود`).join('  ·  ') : 'هنوز آماری وجود ندارد.';
    const max = Math.max(1, ...data.byDay.map(d => d.count));
    $('download-chart').replaceChildren();
    if (!data.byDay.length) { const span = document.createElement('span'); span.className = 'chart-empty'; span.textContent = 'در ۳۰ روز اخیر دانلودی ثبت نشده است.'; $('download-chart').appendChild(span); }
    data.byDay.forEach(day => { const bar = document.createElement('div'); bar.className = 'chart-bar'; bar.style.height = `${Math.max(5, day.count / max * 100)}%`; const label = document.createElement('span'); label.textContent = day.day.slice(5); bar.title = `${day.day}: ${day.count}`; bar.appendChild(label); $('download-chart').appendChild(bar); });
  };
  function formatSize(bytes) { if (!bytes) return '—'; const u = ['B','KB','MB','GB']; let i=0,n=bytes; while(n>=1024&&i<3){n/=1024;i++;} return `${n.toFixed(1)} ${u[i]}`; }
  $('login-form').addEventListener('submit', async e => {
    e.preventDefault(); showMessage('login-message', 'در حال بررسی...');
    try { const data = await api('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) }); csrf = data.csrfToken; $('password').value = ''; await enterDashboard(); }
    catch (err) { showMessage('login-message', err.message); }
  });
  $('game-form').addEventListener('submit', async e => {
    e.preventDefault(); showMessage('game-message', 'در حال ذخیره...');
    try { await api('/api/admin/game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gameName: $('gameName').value, version: $('version').value, description: $('description').value }) }); showMessage('game-message', 'اطلاعات با موفقیت ذخیره شد.', true); await loadDashboard(); }
    catch (err) { showMessage('game-message', err.message); }
  });
  $('upload-form').addEventListener('submit', async e => {
    e.preventDefault(); const file = $('apk').files[0]; if (!file) return;
    showMessage('upload-message', 'در حال آپلود فایل؛ لطفاً صفحه را نبندید...');
    try { const form = new FormData(); form.append('apk', file); await api('/api/admin/upload', { method: 'POST', body: form }); showMessage('upload-message', 'فایل با موفقیت منتشر شد.', true); $('apk').value = ''; await loadDashboard(); }
    catch (err) { showMessage('upload-message', err.message); }
  });
  $('logout').addEventListener('click', async () => { try { await api('/api/admin/logout', { method: 'POST' }); } catch (_) {} location.reload(); });
  api('/api/admin/status').then(data => { if (data.authenticated) enterDashboard().catch(err => { $('dashboard-view').classList.add('hidden'); $('login-view').classList.remove('hidden'); showMessage('login-message', err.message); }); }).catch(() => {});
})();
