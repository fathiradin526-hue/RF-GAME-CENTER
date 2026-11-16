(() => {
  const $ = id => document.getElementById(id);
  const formatSize = bytes => {
    if (!bytes) return 'هنوز آپلود نشده';
    const units = ['B', 'KB', 'MB', 'GB']; let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(i >= 2 ? 2 : 1)} ${units[i]}`;
  };
  fetch('/api/game').then(r => r.json()).then(game => {
    $('game-name').textContent = game.gameName;
    $('game-description').textContent = game.description;
    $('game-version').textContent = game.version;
    $('game-size').textContent = formatSize(game.apkSize);
    if (game.hasApk) {
      $('download-button').classList.remove('disabled');
      $('download-note').textContent = 'دانلود مستقیم فایل APK؛ نصب موفق در آمار دانلود محاسبه نمی‌شود.';
    } else {
      $('download-note').textContent = 'به‌زودی فایل APK از پنل مدیریت منتشر می‌شود.';
    }
  }).catch(() => { $('game-description').textContent = 'دریافت اطلاعات بازی ممکن نشد. لطفاً بعداً دوباره تلاش کنید.'; });
})();
