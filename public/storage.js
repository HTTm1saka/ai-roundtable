let db;
export async function openDB() {
  db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('local-ai-roundtable', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('app');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(new Error('无法打开 IndexedDB。请检查浏览器隐私设置及磁盘空间。'));
    r.onblocked = () => reject(new Error('数据库升级被其他页面阻挡，请关闭其他聊天室标签页后刷新。'));
  });
  db.onversionchange = () => db.close();
}
export function readDB() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('app', 'readonly');
    const r = tx.objectStore('app').get('state');
    r.onsuccess = () => resolve(r.result ?? null);
    r.onerror = () => reject(new Error('读取本地记录失败。请勿把读取失败视为空记录。'));
  });
}
export function writeDB(state) {
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction('app', 'readwrite');
      tx.objectStore('app').put(state, 'state');
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('保存失败：请检查浏览器存储权限或磁盘空间，并立即导出备份。'));
    } catch { reject(new Error('保存失败：本地数据库不可用，请立即导出备份。')); }
  });
}
