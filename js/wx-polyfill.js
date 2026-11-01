/**
 * wx-polyfill.js —— 微信小程序 API 的 Web/PWA 适配层
 * 
 * 覆盖小程序代码中用到的核心 API：
 *  存储类: getStorageSync, setStorageSync, removeStorageSync, getStorageInfoSync
 *  文件系统: getFileSystemManager (基于 IndexedDB + Blob)
 *  UI 类: showToast, showModal, showLoading, hideLoading
 *  导航类: navigateTo, redirectTo, reLaunch
 *  图片类: chooseImage, chooseMedia
 *  Canvas: createCanvasContext, canvasToTempFilePath
 *  其他: env.USER_DATA_PATH, getSystemInfoSync, onNetworkStatusChange
 */

// ================ 全局模拟对象 ================
const wx = {};
const App = (config) => { window.__app = config; return config; };
const Page = (config) => { window.__currentPage = config; return config; };
const getCurrentPages = () => [{ route: window.location.pathname, __proto__: window.__currentPage || {} }];

// 模拟全局 App 实例
window.__appInstance = null;

// ================ 工具函数 ================
function safeParse(val) {
  if (val === null || val === undefined) return val;
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return val; }
  }
  return val;
}
function safeStringify(val) {
  try { return JSON.stringify(val); } catch { return String(val); }
}
function generateId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ================ 1. 本地存储 ================
wx.getStorageSync = function(key) {
  try { return safeParse(localStorage.getItem(key)); } catch { return null; }
};
wx.setStorageSync = function(key, value) {
  try { localStorage.setItem(key, safeStringify(value)); } catch(e) {
    console.warn('[wx-polyfill] setStorageSync 可能超限:', e.message);
  }
};
wx.removeStorageSync = function(key) {
  try { localStorage.removeItem(key); } catch {}
};
wx.getStorage = function({ key, success, fail }) {
  try {
    const val = safeParse(localStorage.getItem(key));
    success && success({ data: val });
  } catch(e) { fail && fail(e); }
};
wx.setStorage = function({ key, data, success, fail }) {
  try {
    localStorage.setItem(key, safeStringify(data));
    success && success();
  } catch(e) { fail && fail(e); }
};
wx.removeStorage = function({ key, success, fail }) {
  try {
    localStorage.removeItem(key);
    success && success();
  } catch(e) { fail && fail(e); }
};
wx.getStorageInfoSync = function() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
  return { keys, currentSize: keys.length * 10, limitSize: 10240 };
};

// ================ 2. 文件系统（基于 IndexedDB） ================
/**
 * 使用 IndexedDB 模拟 USER_DATA_PATH 文件系统
 * 路径格式: wxfile://usr/xxx.jpg
 * 实际存在 IndexedDB 的 'files' store 里，key 是完整路径，value 是 Blob
 */
const DB_NAME = 'wx_user_data';
const DB_VERSION = 1;
let _fsDB = null;
const _pathCache = new Map(); // path -> Blob (内存缓存，加速同步读)

function openDB() {
  if (_fsDB) return Promise.resolve(_fsDB);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files');
      }
    };
    req.onsuccess = (e) => { _fsDB = e.target.result; resolve(_fsDB); };
    req.onerror = (e) => reject(e.target.error);
  });
}

// 同步 API 的异步桥接：用 queueMicrotask + Promise 等待
function dbOperation(fn) {
  return openDB().then(db => fn(db));
}

// 把 wxfile://usr/xxx.jpg 转成纯 key
function pathToKey(path) {
  if (!path) return '';
  return path.replace(/^wxfile:\/\/usr\//, 'usr/');
}
function keyToPath(key) { return 'wxfile://' + key; }

const fs = {
  // 同步写（实际先写内存缓存，再异步落 IndexedDB）
  writeFileSync(path, data, encoding) {
    const key = pathToKey(path);
    let blob;
    if (encoding === 'base64') {
      // base64 → Blob
      const binary = atob(data.replace(/^data:image\/\w+;base64,/, ''));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      blob = new Blob([bytes], { type: 'image/jpeg' });
    } else if (typeof data === 'string') {
      blob = new Blob([data], { type: 'text/plain' });
    } else {
      blob = new Blob([data]);
    }
    _pathCache.set(key, blob);
    // 异步落 IndexedDB
    dbOperation(db => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(blob, key);
    }).catch(e => console.warn('[FS] writeFileSync 异步落盘失败:', e));
  },

  // 同步读（先查内存缓存，再查 IndexedDB）
  readFileSync(path, encoding) {
    const key = pathToKey(path);
    // 查内存缓存
    if (_pathCache.has(key)) {
      const blob = _pathCache.get(key);
      if (encoding === 'base64') {
        // Blob → base64 (同步 XHR workaround)
        const url = URL.createObjectURL(blob);
        try {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url, false); // 同步请求
          xhr.send();
          URL.revokeObjectURL(url);
          // xhr.responseText 是二进制字符串
          let binary = xhr.responseText;
          let base64 = btoa(binary);
          return 'data:image/jpeg;base64,' + base64;
        } catch(e) {
          URL.revokeObjectURL(url);
          throw new Error('readFileSync base64 转换失败: ' + e.message);
        }
      } else {
        // utf8
        const reader = new FileReaderSync();
        return reader.readAsText(blob);
      }
    }
    // 内存没找到，查 IndexedDB（这步是异步的，同步读不到 → 抛异常）
    throw new Error('readFileSync: 文件不存在或未加载: ' + path);
  },

  accessSync(path) {
    const key = pathToKey(path);
    if (_pathCache.has(key)) return true;
    throw new Error('accessSync: 文件不存在');
  },

  unlinkSync(path) {
    const key = pathToKey(path);
    _pathCache.delete(key);
    dbOperation(db => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').delete(key);
    }).catch(e => console.warn('[FS] unlinkSync 异步删除失败:', e));
  },

  readdirSync(path) {
    // 返回内存缓存里所有 key 的文件名
    const prefix = pathToKey(path);
    const result = [];
    for (const key of _pathCache.keys()) {
      if (key.startsWith(prefix)) {
        const fname = key.slice(prefix.length).replace(/^\//, '');
        if (fname && !fname.includes('/')) result.push(fname);
      }
    }
    return result;
  },

  // ===== 异步 API (Promise 版) =====
  async readFile({ filePath, encoding, success, fail }) {
    try {
      await this._loadFromDB(filePath);
      const data = this.readFileSync(filePath, encoding);
      success && success({ data });
      return data;
    } catch(e) { fail && fail(e); throw e; }
  },
  async writeFile({ filePath, data, encoding, success, fail }) {
    try {
      this.writeFileSync(filePath, data, encoding);
      success && success();
    } catch(e) { fail && fail(e); throw e; }
  },
  async unlink({ filePath, success, fail }) {
    try {
      this.unlinkSync(filePath);
      success && success();
    } catch(e) { fail && fail(e); throw e; }
  },

  // 从 IndexedDB 加载到内存缓存（首次访问时调用）
  _loadFromDB(path) {
    const key = pathToKey(path);
    if (_pathCache.has(key)) return Promise.resolve();
    return dbOperation(db => new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readonly');
      const req = tx.objectStore('files').get(key);
      req.onsuccess = () => {
        if (req.result) {
          _pathCache.set(key, req.result);
          resolve();
        } else {
          reject(new Error('文件不存在: ' + path));
        }
      };
      req.onerror = () => reject(req.error);
    }));
  },

  // 加载所有文件到内存缓存（页面初始化时调用）
  async _preloadAll() {
    try {
      await openDB();
      const db = _fsDB;
      const keys = await new Promise((resolve, reject) => {
        const tx = db.transaction('files', 'readonly');
        const req = tx.objectStore('files').getAllKeys();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      for (const key of keys) {
        const blob = await new Promise((resolve, reject) => {
          const tx = db.transaction('files', 'readonly');
          const req = tx.objectStore('files').get(key);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if (blob) _pathCache.set(key, blob);
      }
      console.log('[wx-polyfill] FS 预加载完成，共 ' + keys.length + ' 个文件');
    } catch(e) {
      console.warn('[wx-polyfill] FS 预加载失败:', e);
    }
  },

  // 把 Blob 路径转成可显示的 URL
  getBlobURL(path) {
    const key = pathToKey(path);
    if (_pathCache.has(key)) return URL.createObjectURL(_pathCache.get(key));
    return path; // 可能已经是 blob: url
  }
};

// 暴露内存缓存给页面脚本（work.js / import_export.html 直接访问 fs._pathCache）
fs._pathCache = _pathCache;

// 启动时预加载所有文件到内存
fs._preloadAll();

wx.getFileSystemManager = () => fs;
wx.env = { USER_DATA_PATH: 'wxfile://usr' };

// saveFile / copyFile 走 writeFileSync
wx.saveFile = function({ tempFilePath, filePath, success, fail }) {
  try {
    // tempFilePath 可能是 blob: url，先 fetch 拿 Blob
    fetch(tempFilePath).then(r => r.blob()).then(blob => {
      const reader = new FileReader();
      reader.onload = () => {
        fs.writeFileSync(filePath, reader.result.split(',')[1], 'base64');
        success && success({ savedFilePath: filePath });
      };
      reader.readAsDataURL(blob);
    }).catch(e => { fail && fail(e); });
  } catch(e) { fail && fail(e); }
};
wx.copyFile = function({ srcPath, destPath, success, fail }) {
  try {
    fs._loadFromDB(srcPath).then(() => {
      const data = fs.readFileSync(srcPath, 'base64');
      fs.writeFileSync(destPath, data.split(',')[1], 'base64');
      success && success();
    }).catch(e => fail && fail(e));
  } catch(e) { fail && fail(e); }
};
wx.getFileInfo = function({ filePath, success, fail }) {
  try {
    fs._loadFromDB(filePath).then(() => {
      const key = pathToKey(filePath);
      const blob = _pathCache.get(key);
      if (blob) success && success({ size: blob.size });
      else fail && fail({ errMsg: 'file not found' });
    }).catch(e => fail && fail(e));
  } catch(e) { fail && fail(e); }
};
// getFileInfoSync 在真机上也不可用，这里返回 undefined
wx.getFileInfoSync = function(filePath) {
  const key = pathToKey(filePath);
  const blob = _pathCache.get(key);
  if (!blob) return undefined;
  return { size: blob.size };
};

// ================ 3. UI 组件 ================
// Toast
let _toastEl = null;
wx.showToast = function({ title, icon = 'none', duration = 2000, mask = false }) {
  if (!_toastEl) {
    _toastEl = document.createElement('div');
    _toastEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.8);color:#fff;padding:12px 24px;border-radius:8px;z-index:9999;font-size:14px;pointer-events:none;transition:opacity .2s;opacity:0';
    document.body.appendChild(_toastEl);
  }
  _toastEl.textContent = title;
  _toastEl.style.opacity = '1';
  clearTimeout(_toastEl._hideTimer);
  _toastEl._hideTimer = setTimeout(() => { _toastEl.style.opacity = '0'; }, duration);
};
wx.hideToast = function() { if (_toastEl) _toastEl.style.opacity = '0'; };

// Modal
wx.showModal = function({ title, content, showCancel = true, confirmText = '确定', cancelText = '取消', success }) {
  const result = window.confirm((title ? title + '\n\n' : '') + content);
  success && success({ confirm: result, cancel: !result });
};

// Loading
let _loadingEl = null;
wx.showLoading = function({ title = '', mask = true }) {
  if (!_loadingEl) {
    _loadingEl = document.createElement('div');
    _loadingEl.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:10px"><div style="width:36px;height:36px;border:3px solid #fff;border-top-color:#07c160;border-radius:50%;animation:spin 1s linear infinite"></div><span id="ldTxt"></span></div>';
    _loadingEl.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.8);color:#fff;padding:20px 30px;border-radius:8px;z-index:9999;display:none';
    if (!document.getElementById('__spin_style')) {
      const s = document.createElement('style'); s.id = '__spin_style'; s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(s);
    }
    document.body.appendChild(_loadingEl);
  }
  _loadingEl.querySelector('#ldTxt').textContent = title;
  _loadingEl.style.display = 'flex';
};
wx.hideLoading = function() { if (_loadingEl) _loadingEl.style.display = 'none'; };

// TabBar (PWA 用底部 nav 替代，这里只 stub)
wx.showTabBar = function() {};
wx.hideTabBar = function() {};

// ================ 4. 导航 ================
wx.navigateTo = function({ url }) { window.location.href = url; };
wx.redirectTo = function({ url }) { window.location.replace(url); };
wx.reLaunch = function({ url }) { window.location.href = url; };
wx.switchTab = function({ url }) { window.location.href = url; };

// ================ 5. 选择图片 ================
wx.chooseImage = function({ count = 1, sizeType = ['original', 'compressed'], sourceType = ['album', 'camera'], success, fail }) {
  // 创建隐藏的 input
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = count > 1;
  // 优先相机
  if (sourceType.includes('camera') && !sourceType.includes('album')) {
    input.setAttribute('capture', 'environment');
  }
  input.onchange = async () => {
    const files = Array.from(input.files || []);
    const tempFilePaths = [];
    for (const file of files.slice(0, count)) {
      // 把文件存到 fs，生成 wxfile://usr 路径
      const tempPath = 'wxfile://tmp_' + generateId() + '.jpg';
      const reader = new FileReader();
      reader.readAsDataURL(file);
      await new Promise(resolve => {
        reader.onload = () => {
          const base64 = reader.result.split(',')[1];
          fs.writeFileSync(tempPath, base64, 'base64');
          tempFilePaths.push(tempPath);
          resolve();
        };
        reader.onerror = resolve;
      });
    }
    tempFilePaths.tempFiles = tempFilePaths.map(p => ({ path: p, size: 0 }));
    success && success({ tempFilePaths, tempFiles: tempFilePaths.tempFiles });
  };
  input.click();
};

wx.chooseMedia = function({ count = 1, mediaType = ['image'], sourceType = ['album', 'camera'], success, fail }) {
  wx.chooseImage({ count, sourceType, success, fail });
};

// ================ 6. Canvas ================
/**
 * 微信小程序 Canvas 命令式 API → Web Canvas 2D 立即式 API 的适配层
 * 
 * 小程序是命令式：ctx.setFontSize(14); ctx.fillText('x', 0, 0); ctx.draw()
 * Web Canvas 是立即式：ctx.font = '14px sans-serif'; ctx.fillText('x', 0, 0);
 * 并且小程序的 ctx.draw() 在 Web 上不存在（直接用就行）
 */
wx.createCanvasContext = function(canvasId, instance) {
  const canvas = document.getElementById(canvasId) || document.querySelector(`[canvas-id="${canvasId}"]`);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  return wrapCanvasContext(ctx);
};

function wrapCanvasContext(ctx) {
  // 已经包裹过就不重复包
  if (ctx.__wrapped) return ctx;
  
  // 小程序的 Canvas 2D 适配方法
  ctx.setFillStyle = function(color) {
    this.fillStyle = color;
    return this;
  };
  ctx.setStrokeStyle = function(color) {
    this.strokeStyle = color;
    return this;
  };
  ctx.setLineWidth = function(width) {
    this.lineWidth = width;
    return this;
  };
  ctx.setFontSize = function(size) {
    // 字体大小变了，需要重建 ctx.font
    const family = 'sans-serif';
    this.font = size + 'px ' + family;
    return this;
  };
  ctx.setGlobalAlpha = function(alpha) {
    this.globalAlpha = alpha;
    return this;
  };
  ctx.setShadow = function(offsetX, offsetY, blur, color) {
    this.shadowOffsetX = offsetX;
    this.shadowOffsetY = offsetY;
    this.shadowBlur = blur;
    this.shadowColor = color;
    return this;
  };
  ctx.setLineCap = function(cap) {
    this.lineCap = cap;
    return this;
  };
  ctx.setLineJoin = function(join) {
    this.lineJoin = join;
    return this;
  };
  ctx.setLineDash = function(dash) {
    this.setLineDash(dash); // 同名方法，直接调
    return this;
  };
  // ctx.drawImage 直接用 Web Canvas 原生实现
  // ctx.fillText / strokeText / measureText 直接用原生
  
  // 小程序特有的 ctx.draw() —— Web Canvas 没有，立即执行完后回调
  ctx.draw = function(reserve, callback) {
    // Web Canvas 所有操作都是立即绘制的，直接回调就行
    if (typeof reserve === 'function') {
      reserve();
    } else if (typeof callback === 'function') {
      callback();
    }
    return this;
  };
  
  ctx.__wrapped = true;
  return ctx;
}

/**
 * 加载图片，支持 wxfile://usr/xxx (从内存 Blob URL)、base64、http(s)、data:
 */
function loadImageSrc(src) {
  return new Promise((resolve, reject) => {
    // wxfile://usr/xxx → 内存缓存的 Blob URL
    if (src && src.indexOf('wxfile://') === 0) {
      const blobUrl = fs.getBlobURL(src);
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = blobUrl;
      return;
    }
    // 其他路径，直接加载
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

wx.getImageInfo = function({ src, success, fail }) {
  loadImageSrc(src).then(img => {
    success && success({
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      type: img.src.match(/\.(jpg|png|gif)/i)?.[1] || 'jpg',
      path: src
    });
  }).catch(e => fail && fail({ errMsg: 'getImageInfo:fail ' + e.message }));
};

wx.canvasToTempFilePath = function({ canvasId, success, fail, x = 0, y = 0, width, height, destWidth, destHeight, fileType = 'jpg', quality = 0.8 }) {
  // 找到 canvas 元素（可能是 canvas-id 或直接 id）
  let canvas = document.getElementById(canvasId);
  if (!canvas) {
    canvas = document.querySelector(`canvas[canvas-id="${canvasId}"]`);
  }
  if (!canvas) {
    fail && fail({ errMsg: 'canvas not found: ' + canvasId });
    return;
  }
  // 直接 toBlob 生成临时文件
  const mime = fileType === 'png' ? 'image/png' : 'image/jpeg';
  canvas.toBlob((blob) => {
    if (!blob) { fail && fail({ errMsg: 'toBlob failed' }); return; }
    const tempPath = 'wxfile://tmp_' + generateId() + '.' + fileType;
    // 把 Blob 存到 fs 内存缓存
    const key = pathToKey(tempPath);
    _pathCache.set(key, blob);
    // 异步落 IndexedDB
    dbOperation(db => {
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(blob, key);
    }).catch(e => {});
    success && success({ tempFilePath: tempPath });
  }, mime, quality);
};

// ================ 7. 网络/系统 ================
wx.login = function({ success }) {
  success && success({ code: 'mock_code_' + generateId() });
};
wx.cloud = { init: function() {}, database: function() { return {}; }, callFunction: function() {} };
wx.getUpdateManager = function() {
  return { onUpdateReady: function(cb) {}, applyUpdate: function() {} };
};
wx.onNetworkStatusChange = function(cb) {
  const handler = () => cb({ isConnected: navigator.onLine, networkType: navigator.onLine ? 'wifi' : 'none' });
  window.addEventListener('online', handler);
  window.addEventListener('offline', handler);
  handler();
};
wx.getNetworkType = function({ success }) {
  success && success({ networkType: navigator.onLine ? 'wifi' : 'none' });
};
wx.getSystemInfoSync = function() {
  return {
    platform: 'devtools',
    system: navigator.platform,
    model: 'Web',
    windowWidth: window.innerWidth,
    windowHeight: window.innerHeight,
    pixelRatio: window.devicePixelRatio || 1,
    safeArea: { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth, height: window.innerHeight, width: window.innerWidth }
  };
};
wx.getSystemInfo = function({ success }) { success && success(wx.getSystemInfoSync()); };

// ================ 8. 复制/剪贴板 ================
wx.setClipboardData = function({ data, success, fail }) {
  // execCommand 兜底（clipboard API 被拒绝或不支持时）
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = data;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    if (ok) success && success({ data });
    else fail && fail({ errMsg: 'setClipboardData:fail' });
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(data).then(
      () => success && success({ data }),
      () => fallback()
    );
  } else {
    fallback();
  }
};
wx.getClipboardData = function({ success }) {
  if (navigator.clipboard) {
    navigator.clipboard.readText().then(text => success && success({ data: text }));
  }
};

// ================ 9. JSON 导出下载 ================
// 小程序用 shareFileMessage，PWA 用 Blob + download
wx.saveFileToDownloads = function(data, filename) {
  const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
};

// ================ 10. 图片预览 ================
wx.previewImage = function({ urls, current }) {
  // PWA 简化实现：打开新窗口显示图片
  const url = current || (urls && urls[0]) || '';
  if (url) window.open(url, '_blank');
};

// ================ 11. 运行门禁：隐私同意 + 授权有效 ================
// 与小程序 app.js 的 updateTabBarVisibility / startAuthExpiryCheck 对齐
(function () {
  function isPrivacyAgreed() {
    const v = wx.getStorageSync('privacyAgreed');
    return v === true || v === 'true';
  }
  function hasValidAuth() {
    const verified = wx.getStorageSync('appPasswordVerified');
    const expire = Number(wx.getStorageSync('appPermissionExpireTime') || 0);
    return !!verified && (!expire || expire > Date.now());
  }
  function updateTabBarVisibility() {
    const bars = document.querySelectorAll('.tab-bar');
    const show = isPrivacyAgreed() && hasValidAuth();
    for (let i = 0; i < bars.length; i++) bars[i].style.display = show ? '' : 'none';
  }
  wx.__isPrivacyAgreed = isPrivacyAgreed;
  wx.__hasValidAuth = hasValidAuth;
  wx.__updateTabBarVisibility = updateTabBarVisibility;

  // 是否处于首页（含站点根路径）
  function isHomePage() {
    return /(^|\/)index\.html$/.test(location.pathname) || /\/$/.test(location.pathname);
  }

  // 跳转去重标记：避免多次检查重复启动倒计时
  let redirectingHome = false;

  // 授权到期：清授权状态；首页弹授权框，其他页 3 秒倒计时回首页
  function handleAuthExpired() {
    redirectingHome = true;
    wx.removeStorageSync('appPasswordVerified');
    wx.removeStorageSync('videoPermission');
    wx.removeStorageSync('appPermissionExpireTime');
    updateTabBarVisibility();
    const isHome = isHomePage();
    if (isHome) {
      if (typeof window.openAuthModal === 'function') window.openAuthModal();
      wx.showToast({ title: '授权已到期，请重新输入授权码', icon: 'none' });
      return;
    }
    let left = 3;
    wx.showToast({ title: '授权已到期，' + left + '秒后返回首页', icon: 'none', duration: 900 });
    const timer = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        clearInterval(timer);
        location.href = './index.html';
        return;
      }
      wx.showToast({ title: '授权已到期，' + left + '秒后返回首页', icon: 'none', duration: 900 });
    }, 1000);
  }

  // 未授权（从未输入授权码或被清除）且不在首页：倒计时返回首页
  // 对应小程序 onLaunch 每次从首页启动 + 非首页未授权时回首页的行为
  function backHomeIfUnauthorized() {
    if (redirectingHome || isHomePage()) return;
    if (wx.getStorageSync('appPasswordVerified')) return;
    redirectingHome = true;
    let left = 3;
    const tick = function () {
      if (left <= 0) {
        location.href = './index.html';
        return;
      }
      wx.showToast({ title: '未授权，' + left + '秒后返回首页', icon: 'none', duration: 900 });
      left -= 1;
      setTimeout(tick, 1000);
    };
    tick();
  }

  function checkAuthExpiry() {
    const verified = wx.getStorageSync('appPasswordVerified');
    const expire = Number(wx.getStorageSync('appPermissionExpireTime') || 0);
    if (verified && expire > 0 && Date.now() >= expire) {
      handleAuthExpired();
      return;
    }
    // 从未授权：非首页一律回首页
    if (!verified) backHomeIfUnauthorized();
  }

  function initGuard() {
    updateTabBarVisibility();
    checkAuthExpiry();
    setInterval(checkAuthExpiry, 5000);
  }

  // 网络状态变化提示（与小程序一致）
  wx.onNetworkStatusChange(function (res) {
    if (!res.isConnected) wx.showToast({ title: '网络连接已断开', icon: 'none' });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initGuard);
  } else {
    initGuard();
  }
})();

// ================ 导出到全局 ================
window.wx = wx;
window.App = App;
window.Page = Page;
window.fs = fs; // 暴露文件系统给页面脚本直接访问
window.getCurrentPages = getCurrentPages;
