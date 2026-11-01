/**
 * work.js —— PWA 版工作页核心逻辑
 * 包含：设备分组渲染、搜索过滤、状态标记、备注、拍照+水印+存图、导出、
 *       巡检进度、编辑设备、删除/回收站（自定义模态框）
 */

// =============== state ===============
const state = {
  machines: [],
  deletedMachines: [],       // 回收站
  selectedMachine: null,
  selectedArea: '',          // 当前选中分区（'' 表示全部）
  areaListExpanded: false,   // 总区域列表是否展开
  sMenuOpen: false,          // S 按钮菜单是否展开
  selectedInfoExpanded: false, // X 按钮：已选设备信息面板
  autoCollapseEnabled: false,  // X 自动模式：每次点设备自动展开信息面板（长按 X 开启）
  showStatusFilterBtn: true,   // 状态筛选按钮是否显示（长按搜索栏切换）
  isLockedMode: false,         // 区域锁定模式（长按「总区域」按钮切换）
  imagesSectionExpanded: false, // 设备图片区域是否展开
  searchKeyword: '',
  statusFilter: 'all',       // all / normal / warning / error / pending
  lockedAreas: [],           // 已锁定的区域名（与小程序 lockedAreas 一致）
  inspectionDisplayMode: 'all',  // all=全部显示 / expand=选配模式
  inspectionMaxSelect: 1,        // 选配模式下最多可确认的检查项数
  inspectionRemarkLink: 0,       // 0=不联动 1=仅数值 2=所有值（写入备注）
  inspectionHideRemarkValue: false, // 隐藏检查项名称中进备注的数值部分
  batchRemarkScope: 'all',   // 批量备注范围：all / normal / warning / error
  batchRemarkAppend: false,  // 批量备注追加模式
  clickMode: 'double',       // 点击模式：single 单击点检 / double 双击点检
  autoMarkInspectionItems: false,// 点检为正常时自动标记全部检查项
  showInspectionInList: true,    // 设备列表是否显示检查项
  currentActionMachine: null,
  globalData: {
    showProjectHeader: false,
    projectContent: '',
    statusNames: { normal: '正常', warning: '警告', error: '错误' }
  }
};

function getApp() { return { globalData: state.globalData }; }

// =============== 数据存取 ===============
function loadMachines() {
  const saved = loadMachineStatus();
  if (saved && saved.checkStatus && saved.checkStatus.length > 0) {
    state.machines = saved.checkStatus;
  } else {
    const machines = [];
    for (let i = 1; i <= 50; i++) {
      machines.push({
        id: 'JT-' + String(i).padStart(3, '0'),
        name: i.toString(),
        area: '',
        displayName: i.toString(),
        status: '',
        remark: '',
        images: []
      });
    }
    state.machines = machines;
    saveMachines();
  }
  state.deletedMachines = wx.getStorageSync('deletedMachines') || [];
  state.lockedAreas = wx.getStorageSync('lockedAreas') || [];
  if (!Array.isArray(state.lockedAreas)) state.lockedAreas = [];
  render();
}

// 读取 machineStatus：合并分片（兼容小程序 _sharded 存储），并兜底旧键 machines
function loadMachineStatus() {
  let data = wx.getStorageSync('machineStatus');
  if (data && data._sharded) {
    let list = [];
    for (let i = 0; i < (data._shardCount || 0); i++) {
      try {
        const shard = wx.getStorageSync('machineStatus_shard_' + i);
        if (shard) list = list.concat(shard);
      } catch (e) { /* 忽略损坏分片 */ }
    }
    data.checkStatus = list;
  }
  if ((!data || !data.checkStatus || data.checkStatus.length === 0)) {
    const old = wx.getStorageSync('machines');
    if (Array.isArray(old) && old.length > 0) data = { checkStatus: old };
  }
  return data;
}

function saveMachines() {
  wx.setStorageSync('machineStatus', { checkStatus: state.machines });
}

// 自动导出：开启后按设置页的间隔自动备份数据到本地（与小程序一致）
function maybeAutoBackup() {
  var s = wx.getStorageSync('machineSettings') || {};
  if (!s.autoExportEnabled) return;
  var interval = Number(s.autoExportInterval) || 60 * 60 * 1000;
  var last = Number(wx.getStorageSync('autoExportLastTime') || 0);
  if (Date.now() - last < interval) return;
  try {
    wx.setStorageSync('autoExportBackup', { time: Date.now(), data: wx.getStorageSync('machineStatus') });
    wx.setStorageSync('autoExportLastTime', Date.now());
  } catch (e) {
    console.warn('[PWA] 自动备份失败:', e);
  }
}

// =============== 历史记录 ===============
function addHistoryLog(logData) {
  try {
    const logRecord = {
      id: Date.now().toString() + Math.floor(Math.random() * 1000).toString().padStart(3, '0'),
      timestamp: Date.now(),
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      ...logData
    };
    let logs = wx.getStorageSync('checkHistory');
    if (!Array.isArray(logs)) logs = [];
    logs.unshift(logRecord);
    if (logs.length > 1000) logs.splice(1000);
    wx.setStorageSync('checkHistory', logs);
  } catch (e) { console.warn('[PWA] addHistoryLog 失败:', e); }
}

// =============== 区域分组（自然排序 + 类型归组） ===============
const areaTypeOrder = ['环', '区', '栋', '楼', '层', '其他'];

function tokenize(s) {
  const tokens = [];
  const re = /(\d+|\D+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    tokens.push(/^\d+$/.test(m[1]) ? parseInt(m[1], 10) : m[1]);
  }
  return tokens;
}

function naturalCompare(a, b) {
  const pa = tokenize(a), pb = tokenize(b);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    const xNum = typeof x === 'number', yNum = typeof y === 'number';
    if (xNum && yNum) {
      if (x !== y) return x - y;
    } else if (!xNum && !yNum) {
      const c = String(x).localeCompare(String(y), 'zh');
      if (c !== 0) return c;
    } else {
      return xNum ? -1 : 1;
    }
  }
  if (pa.length !== pb.length) return pa.length - pb.length;
  return String(a).localeCompare(String(b), 'zh');
}

function areaNameCompare(a, b) {
  const typeA = areaTypeOrder.findIndex(t => a.indexOf(t) !== -1);
  const typeB = areaTypeOrder.findIndex(t => b.indexOf(t) !== -1);
  const ta = typeA === -1 ? 999 : typeA;
  const tb = typeB === -1 ? 999 : typeB;
  if (ta !== tb) return ta - tb;
  return naturalCompare(a, b);
}

function groupMachinesByArea(machines) {
  const groups = {};
  machines.forEach(m => {
    const area = (m.area || '').trim() || '未分区';
    if (!groups[area]) groups[area] = [];
    groups[area].push(m);
  });
  const names = Object.keys(groups).sort(areaNameCompare);
  // 每组内设备也自然排序
  names.forEach(name => {
    groups[name].sort((a, b) => naturalCompare(a.displayName || a.name || '', b.displayName || b.name || ''));
  });
  return names.map(name => ({ name, machines: groups[name] }));
}

// =============== 搜索过滤 ===============
function onSearch(keyword) {
  state.searchKeyword = (keyword || '').trim();
  const clearBtn = document.getElementById('clearSearch');
  if (clearBtn) clearBtn.style.display = state.searchKeyword ? '' : 'none';
  renderDeviceList();
}

// =============== 状态筛选（与小程序一致） ===============
const STATUS_FILTER_LABELS = { all: '全部', pending: '未检查' };

function statusFilterLabel(key) {
  if (STATUS_FILTER_LABELS[key]) return STATUS_FILTER_LABELS[key];
  return state.globalData.statusNames[key] || key;
}

function updateStatusFilterUI() {
  const text = document.getElementById('filterBtnText');
  if (text) text.textContent = statusFilterLabel(state.statusFilter);
  const sn = state.globalData.statusNames;
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText('filterTextNormal', sn.normal || '正常');
  setText('filterTextWarning', sn.warning || '警告');
  setText('filterTextError', sn.error || '错误');
}

function showStatusFilter() {
  const menu = document.getElementById('statusFilterMenu');
  if (!menu) return;
  menu.style.display = (menu.style.display === 'none') ? '' : 'none';
}

function setStatusFilter(v) {
  state.statusFilter = v || 'all';
  const menu = document.getElementById('statusFilterMenu');
  if (menu) menu.style.display = 'none';
  updateStatusFilterUI();
  renderDeviceList();
}

function clearSearch() {
  const input = document.getElementById('searchInput');
  if (input) input.value = '';
  onSearch('');
}

// =============== 区域锁定（与小程序 lockedAreas 一致） ===============
function isAreaLocked(m) {
  if (!m) return false;
  return (state.lockedAreas || []).indexOf(areaKey(m)) !== -1;
}

function toggleAreaLock(name) {
  const list = (state.lockedAreas || []).slice();
  const idx = list.indexOf(name);
  if (idx === -1) {
    if (!confirm('锁定「' + name + '」后，该区域设备将不可修改状态或删除。确定锁定吗？')) return;
    list.push(name);
  } else {
    if (!confirm('确定解锁「' + name + '」吗？')) return;
    list.splice(idx, 1);
  }
  state.lockedAreas = list;
  wx.setStorageSync('lockedAreas', list);
  renderAreas();
  renderDeviceList();
  wx.showToast({ title: idx === -1 ? '区域已锁定' : '区域已解锁', icon: 'success' });
}

// 分区键（空分区归入“未分区”）
function areaKey(m) {
  return ((m.area || '').trim()) || '未分区';
}

// 完成判定：兼容小程序 isChecked 与 PWA status 两种口径
function isMachineChecked(m) {
  if (!m) return false;
  if (m.isChecked === true || m.isChecked === 'true' || m.isChecked === 1) return true;
  return m.status === 'normal' || m.status === 'warning' || m.status === 'error';
}

function getFilteredMachines() {
  let list = state.machines;
  if (state.selectedArea) {
    list = list.filter(m => areaKey(m) === state.selectedArea);
  }
  // 状态筛选（与小程序一致）
  if (state.statusFilter && state.statusFilter !== 'all') {
    const f = state.statusFilter;
    list = list.filter(m => f === 'pending' ? !isMachineChecked(m) : (m.status || '') === f);
  }
  const k = state.searchKeyword.toLowerCase();
  if (k) {
    list = list.filter(m => {
      const name = (m.displayName || m.name || '').toLowerCase();
      const area = (m.area || '').toLowerCase();
      const remark = (m.remark || '').toLowerCase();
      return name.includes(k) || area.includes(k) || remark.includes(k);
    });
  }
  // 按分区自然排序后再按设备名排序
  return groupMachinesByArea(list).reduce((acc, g) => acc.concat(g.machines), []);
}

// =============== 渲染 ===============
const STATUS_COLORS = { normal: '#4CAF50', warning: '#FF9800', error: '#f44336', pending: '#909399', checked: '#2196F3' };

function render() {
  renderAreas();
  renderDeviceList();
  renderSelectedInfo();
  renderImages();
  updateStorageStats();
  updatePhotoButtons();
  renderInspectionProgress();
  renderInspectionItems();
  const recycleCountEl = document.getElementById('recycleCount');
  if (recycleCountEl) {
    recycleCountEl.textContent = state.deletedMachines.length > 0 ? ' ' + state.deletedMachines.length : '';
  }
}

function renderInspectionProgress() {
  const total = state.machines.length;
  const checked = state.machines.filter(m => m.status === 'normal' || m.status === 'warning' || m.status === 'error').length;
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  document.getElementById('checkedCount').textContent = checked;
  document.getElementById('totalCount').textContent = total;
  document.getElementById('progressPct').textContent = pct;
  document.getElementById('progressFill').style.width = pct + '%';
}

// 区域格子（20% 宽，一排 5 个）
function renderAreas() {
  const el = document.getElementById('areaList');
  const btn = document.getElementById('areaToggleBtn');
  el.style.display = state.areaListExpanded ? '' : 'none';
  btn.textContent = '总区域 ' + (state.areaListExpanded ? '▲' : '▼');
  // 锁定模式按钮高亮（对齐小程序 area-toggle-btn-locked）
  btn.classList.toggle('area-toggle-btn-locked', !!state.isLockedMode);
  // 状态筛选按钮显隐（长按搜索栏切换）
  const fBtn = document.getElementById('filterBtn');
  if (fBtn) fBtn.style.display = state.showStatusFilterBtn ? '' : 'none';

  const groups = groupMachinesByArea(state.machines);
  el.innerHTML = groups.map(g => {
    const checked = g.machines.filter(m => m.status).length;
    const active = state.selectedArea === g.name ? ' area-item-active' : '';
    const locked = (state.lockedAreas || []).indexOf(g.name) !== -1;
    return `<div class="area-item${active}${locked ? ' area-item-locked' : ''}" data-area="${escapeAttr(g.name)}" onclick="selectArea('${escapeAttr(g.name)}')">
      <span class="area-number">${escapeHtml(g.name)}</span>
      <span class="area-count">${checked}/${g.machines.length}</span>
    </div>`;
  }).join('');
  updateAreaGroupsVisibility();
}

// 区域分组容器：区域列表 / 设备信息面板 / 空状态都无内容时整体隐藏
function updateAreaGroupsVisibility() {
  const g = document.getElementById('areaGroups');
  const empty = document.getElementById('emptyState');
  const panelShown = state.selectedMachine && state.selectedInfoExpanded;
  const emptyShown = empty && empty.style.display !== 'none';
  g.style.display = (state.areaListExpanded || panelShown || emptyShown) ? '' : 'none';
}

function selectArea(name) {
  state.selectedArea = state.selectedArea === name ? '' : name;
  renderAreas();
  renderDeviceList();
}

// 设备列表（单列行）
function renderDeviceList() {
  const items = document.getElementById('deviceItems');
  const emptyState = document.getElementById('emptyState');
  const emptyIcon = document.getElementById('emptyIcon');
  const emptyText = document.getElementById('emptyText');
  const filtered = getFilteredMachines();
  const statusNames = state.globalData.statusNames;

  document.getElementById('listCount').textContent = filtered.length;

  // 空状态提示
  if (state.machines.length === 0) {
    emptyIcon.textContent = '📭';
    emptyText.textContent = '当前机台数量为0，点击 S ▾ 新增设备';
    emptyState.style.display = '';
  } else if (filtered.length === 0 && !state.searchKeyword && !state.selectedArea) {
    emptyIcon.textContent = '👆';
    emptyText.textContent = '点击总区域▲选择分区，或搜索设备';
    emptyState.style.display = '';
  } else {
    emptyState.style.display = 'none';
  }

  if (filtered.length === 0) {
    items.innerHTML = (state.searchKeyword || state.selectedArea)
      ? '<div class="no-results"><span class="no-results-icon">📦</span><span class="no-results-text">没有找到匹配的设备</span></div>'
      : '';
    updateAreaGroupsVisibility();
    return;
  }

  items.innerHTML = filtered.map(m => {
    const status = m.status || '';
    const badgeClass = 'badge-' + (status || 'pending');
    const badgeText = status ? (statusNames[status] || status) : '无状态';
    const color = STATUS_COLORS[status] || STATUS_COLORS.pending;
    // 备注输入 888 后开启图片上传，这里给出提示
    const uploadTag = m.uploadEnabled
      ? `<span class="meta-item">📷 上传已开启${m.uploadStatusFilter ? '（' + escapeHtml(m.uploadStatusFilter) + '）' : ''}</span>`
      : '';
    let insp = '';
    if (state.inspectionEnabled && state.showInspectionInList &&
        Array.isArray(m.inspectionItems) && m.inspectionItems.length > 0) {
      // 选配模式：列表只显示当前项与已确认项（保留原始索引）
      let entries = m.inspectionItems.map(function (it, i) { return { it: it, i: i }; });
      if (state.inspectionDisplayMode === 'expand') {
        const curIdx = (typeof m.selectedInspectionIndex === 'number' && m.selectedInspectionIndex < entries.length)
          ? m.selectedInspectionIndex : 0;
        const shown = entries.filter(function (e) {
          return e.i === curIdx || (e.it.result && e.it.result !== '待检查');
        });
        entries = shown.length ? shown : [entries[curIdx]];
      }
      insp = '<div class="device-inspection-items">' + entries.map(e => {
        const it = e.it;
        const r = it.result || '待检查';
        const cls = r === '正常' ? 'result-pass' : r === '异常' ? 'result-fail' : 'result-pending';
        const icon = r === '正常' ? '✓' : r === '异常' ? '✕' : '○';
        const dot = state.inspectionDisplayMode === 'expand'
          ? `<span style="color:${getRainbowColor(e.i)}">● </span>` : '';
        return `<div class="device-inspection-item" onclick="onInspectionItemTap(event, '${escapeAttr(m.id)}', ${e.i})">
          <span class="device-inspection-name">${dot}${escapeHtml(getInspectionDisplayName(it.name))}</span>
          <span class="device-inspection-result ${cls}">${icon}</span>
        </div>`;
      }).join('') + '</div>';
    }
    return `<div class="device-item-wrapper">
      <div class="device-item" data-id="${m.id}" onclick="onMachineTap('${m.id}')">
        <div class="device-status-indicator" style="background-color:${color}"></div>
        <div class="device-info">
          <div class="device-header">
            <span class="device-name">${escapeHtml(m.displayName || m.name)}</span>
            <span class="device-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="device-meta"><span class="meta-item">⏰ ${escapeHtml(m.statusTime || '从未点检')}</span>${uploadTag}</div>
          ${hasVisibleRemark(m.remark) ? `<div class="device-remark">📝 备注: ${escapeHtml(filterRemark(m.remark))}</div>` : ''}
          ${insp}
        </div>
        <span class="arrow-icon">></span>
      </div>
    </div>`;
  }).join('');
  updateAreaGroupsVisibility();
}

// 已选设备信息面板（X 按钮控制显隐）
// =========== 备注过滤 / 检查项显示（对齐小程序 remarkFilter.wxs） ===========
var PASSWORD_REMARKS = ['111', '222', '333', '444', '555', '666', '777', '888', '999', '000'];
var PASSWORD_PREFIXES = ['111-', '222-', '333-', '444-', '555-', '666-', '777-', '888-', '999-'];

// 密码备注（111/222-1 等）不显示在界面上
function isPasswordRemark(remark) {
  if (!remark) return false;
  var s = String(remark);
  for (var i = 0; i < PASSWORD_REMARKS.length; i++) if (s === PASSWORD_REMARKS[i]) return true;
  for (var j = 0; j < PASSWORD_PREFIXES.length; j++) if (s.indexOf(PASSWORD_PREFIXES[j]) === 0) return true;
  return false;
}

function filterRemark(remark) {
  return isPasswordRemark(remark) ? '' : (remark || '');
}

function hasVisibleRemark(remark) {
  return !isPasswordRemark(remark) && !!remark;
}

// 选配模式：隐藏检查项名称中进备注的数值部分（如 "80装备+63W" → "80装备"）
function getInspectionDisplayName(name) {
  if (!state.inspectionHideRemarkValue || !name) return name || '';
  var m = String(name).match(/^(.+?)([+-]?[\d.]+[a-zA-Z\u4e00-\u9fa5]*)$/);
  return m ? m[1] : name;
}

// 检查项彩虹循环配色，用于区分不同检查项
var RAINBOW_COLORS = ['#F44336', '#FF9800', '#FBC02D', '#4CAF50', '#00BCD4', '#2196F3', '#9C27B0'];
function getRainbowColor(index) {
  var i = parseInt(index, 10);
  if (isNaN(i) || i < 0) i = 0;
  return RAINBOW_COLORS[i % RAINBOW_COLORS.length];
}

function renderSelectedInfo() {
  const panel = document.getElementById('selectedInfoPanel');
  const m = state.selectedMachine;
  const xBtn = document.getElementById('xBtn');
  if (xBtn) {
    // 对齐小程序：自动模式优先显示黄色样式，未选中时无高亮
    xBtn.className = 'batch-btn x-btn' + (state.autoCollapseEnabled ? ' x-btn-auto' : (state.selectedMachine ? ' x-btn-active' : ''));
    xBtn.textContent = 'X ' + (state.selectedInfoExpanded ? '▲' : '▼');
  }

  if (!m || !state.selectedInfoExpanded) {
    panel.style.display = 'none';
    updateAreaGroupsVisibility();
    return;
  }
  panel.style.display = '';

  const statusNames = state.globalData.statusNames;
  const statusText = m.status ? (statusNames[m.status] || m.status) : '无状态';
  const rows = [];
  rows.push(`<div class="selected-machine-detail machine-name-row">
    <span class="selected-machine-label">设备名称：</span>
    <span class="selected-machine-value machine-name">${escapeHtml(m.displayName || m.name)}</span>
  </div>`);
  rows.push(`<div class="selected-machine-detail">
    <span class="selected-machine-label">设备状态：</span>
    <span class="selected-machine-value status-${m.status || 'none'}">${statusText}</span>
  </div>`);
  // 图片上传状态（备注输入 888 开启 / 999 关闭）
  rows.push(`<div class="selected-machine-detail">
    <span class="selected-machine-label">图片上传：</span>
    <span class="selected-machine-value">${m.uploadEnabled ? '已开启' + (m.uploadStatusFilter ? '（仅 ' + escapeHtml(m.uploadStatusFilter) + '）' : '') : '未开启'}</span>
  </div>`);
  if (m.area) {
    rows.push(`<div class="selected-machine-detail">
      <span class="selected-machine-label">设备位置：</span>
      <span class="selected-machine-value">${escapeHtml(m.area)}</span>
    </div>`);
  }
  if (m.statusTime) {
    rows.push(`<div class="selected-machine-detail">
      <span class="selected-machine-label">点检时间：</span>
      <span class="selected-machine-value">${escapeHtml(m.statusTime)}</span>
    </div>`);
  }
  // 与小程序一致：密码备注不显示，双击备注区才编辑
  rows.push(`<div class="selected-machine-detail remark-section" onclick="onRemarkSectionTap()">
    <span class="selected-machine-label">备注信息：</span>
    <span class="selected-machine-value">${escapeHtml(filterRemark(m.remark)) || '暂无备注'}</span>
    <span class="remark-edit-hint">${hasVisibleRemark(m.remark) ? '双击编辑' : '双击添加'}</span>
  </div>`);
  // 长按菜单只保留「警告 / 错误 / 重置」，编辑与删除放这里
  rows.push(`<div class="selected-machine-actions">
    <button class="sm-action-btn" type="button" onclick="openEditForSelected()">✏️ 编辑设备</button>
    <button class="sm-action-btn danger" type="button" onclick="deleteSelectedMachine()">🗑️ 删除设备</button>
  </div>`);
  document.getElementById('selectedInfoContent').innerHTML = rows.join('');

  const arrow = document.getElementById('imagesEntryArrow');
  if (arrow) arrow.textContent = state.imagesSectionExpanded ? '▼' : '▶';
  document.getElementById('imagesSection').style.display = state.imagesSectionExpanded ? '' : 'none';
  document.getElementById('imgCountHint').textContent =
    (m.images || []).length > 0 ? `(${(m.images || []).length}/20)` : '';
}

function toggleAreaList() {
  state.areaListExpanded = !state.areaListExpanded;
  renderAreas();
}

function toggleSButtonMenu() {
  state.sMenuOpen = !state.sMenuOpen;
  if (state.sMenuOpen) {
    updateSMenuItems();
    positionSMenu();
  }
  document.getElementById('sMenu').style.display = state.sMenuOpen ? '' : 'none';
  document.getElementById('sBtn').textContent = 'S ' + (state.sMenuOpen ? '▲' : '▼');
}

// 菜单挂在 S 按钮下方居中，避免横向压住整列按钮与列表
function positionSMenu() {
  const menu = document.getElementById('sMenu');
  const btn = document.getElementById('sBtn');
  if (!menu || !btn || !btn.parentElement) return;
  const wrap = btn.parentElement;
  const menuW = menu.offsetWidth || 200;
  let left = btn.offsetLeft + btn.offsetWidth / 2 - menuW / 2;
  const maxLeft = wrap.clientWidth - menuW - 8;
  left = Math.max(8, Math.min(left, Math.max(8, maxLeft)));
  menu.style.left = left + 'px';
  menu.style.right = 'auto';
}

function hideSMenu() {
  state.sMenuOpen = false;
  document.getElementById('sMenu').style.display = 'none';
  document.getElementById('sBtn').textContent = 'S ▼';
}

// 点菜单以外区域收起菜单（小程序点空白处即关闭）
function bindSMenuOutsideClick() {
  document.addEventListener('click', function (e) {
    if (!state.sMenuOpen) return;
    const menu = document.getElementById('sMenu');
    const btn = document.getElementById('sBtn');
    if (menu && (menu.contains(e.target) || menu === e.target)) return;
    if (btn && (btn.contains(e.target) || btn === e.target)) return;
    hideSMenu();
  }, true);
  window.addEventListener('resize', function () { if (state.sMenuOpen) positionSMenu(); });
}

// 「开启/关闭检查项目」与小程序 S 菜单一致，按当前状态互斥显示
function updateSMenuItems() {
  const on = !!state.inspectionEnabled;
  const mgr = document.getElementById('sMenuItemManager');
  const en = document.getElementById('sMenuItemEnableInsp');
  const dis = document.getElementById('sMenuItemDisableInsp');
  // 与小程序一致：开启后才出现「检查项目管理 / 关闭检查项目」，未开启只显示「开启检查项目」
  if (mgr) mgr.style.display = on ? '' : 'none';
  if (en) en.style.display = on ? 'none' : '';
  if (dis) dis.style.display = on ? '' : 'none';
}

function enableInspectionFromMenu() {
  hideSMenu();
  state.inspectionEnabled = true;
  wx.setStorageSync('isInspectionItemsEnabled', true);
  render();
  wx.showToast({ title: '已开启检查项目', icon: 'success' });
}

function disableInspectionFromMenu() {
  if (!confirm('关闭检查项目后，设备列表将不再显示检查项。确定关闭吗？')) return;
  hideSMenu();
  state.inspectionEnabled = false;
  wx.setStorageSync('isInspectionItemsEnabled', false);
  render();
  wx.showToast({ title: '已关闭检查项目' });
}

// 点击 X 按钮（对齐小程序 toggleMachineInfoExpand）
function toggleMachineInfoExpand() {
  // 点击 X 按钮时关闭 S 按钮菜单
  state.sMenuOpen = false;
  hideSMenu();

  // 自动模式（黄色）下，点击 X 直接恢复正常模式并关闭面板
  if (state.autoCollapseEnabled) {
    state.autoCollapseEnabled = false;
    state.selectedInfoExpanded = false;
    render();
    return;
  }

  // 未选中设备时，自动选中当前过滤列表的第一个设备
  if (!state.selectedMachine) {
    const first = getFilteredMachines()[0];
    if (first) {
      selectMachineOnly(first.id);
      return;
    }
    wx.showToast({ title: '请先点击设备' });
    return;
  }

  const newExpanded = !state.selectedInfoExpanded;
  state.selectedInfoExpanded = newExpanded;
  render();
  // 展开后滚动到设备信息面板位置（与小程序一致）
  if (newExpanded) {
    setTimeout(function () { window.scrollTo({ top: 100, behavior: 'smooth' }); }, 100);
  }
}

// 长按 X 按钮：进入自动模式（黄色），每次点设备都自动打开信息面板
function toggleAutoCollapse() {
  if (!state.selectedMachine) {
    const first = getFilteredMachines()[0];
    if (first) state.selectedMachine = first;
  }
  state.selectedInfoExpanded = true;
  state.autoCollapseEnabled = true;
  render();
  // 未选中区域时滚动到面板位置
  if (!state.selectedArea) {
    setTimeout(function () { window.scrollTo({ top: 100, behavior: 'smooth' }); }, 100);
  }
}

// 长按「总区域」按钮：切换区域锁定模式（对齐小程序 toggleLockedMode）
function toggleLockedMode() {
  const newMode = !state.isLockedMode;
  if (newMode) {
    wx.showToast({ title: '已进入区域锁定模式', icon: 'none', duration: 2000 });
  } else {
    // 退出锁定模式时关闭所有密码模式
    state.clickMode = 'double';
    state.batchRemarkScope = 'all';
    state.batchRemarkAppend = false;
    state.selectedArea = '';
    wx.showToast({ title: '已退出区域锁定模式', icon: 'none', duration: 2000 });
  }
  state.isLockedMode = newMode;
  // 锁定模式下取消选中设备并展开区域列表，需主动选区域
  state.selectedMachine = null;
  state.selectedInfoExpanded = false;
  state.autoCollapseEnabled = false;
  if (newMode) state.areaListExpanded = true;
  render();
}

// 长按搜索栏：显示/隐藏状态筛选按钮（对齐小程序 toggleStatusFilterVisibility）
function toggleStatusFilterVisibility() {
  state.showStatusFilterBtn = !state.showStatusFilterBtn;
  wx.setStorageSync('showStatusFilterBtn', state.showStatusFilterBtn);
  render();
  wx.showToast({
    title: state.showStatusFilterBtn ? '状态筛选已显示' : '状态筛选已隐藏',
    icon: 'none'
  });
}

function clearSelectedMachine() {
  state.selectedMachine = null;
  state.selectedInfoExpanded = false;
  state.imagesSectionExpanded = false;
  render();
}

function toggleImagesSection() {
  state.imagesSectionExpanded = !state.imagesSectionExpanded;
  renderSelectedInfo();
  renderImages();
}

function openRemarkForSelected() {
  if (!state.selectedMachine) return;
  state.currentActionMachine = state.selectedMachine;
  openRemark();
}

// 与小程序 doubleTapMachineRemark 一致：300ms 内两次点按才打开备注编辑
var __lastRemarkTapTime = 0;
function onRemarkSectionTap() {
  const now = Date.now();
  if (now - __lastRemarkTapTime < 300) {
    __lastRemarkTapTime = 0;
    openRemarkForSelected();
    return;
  }
  __lastRemarkTapTime = now;
}

function goPage(url) {
  location.href = url;
}

// 批量备注的目标设备（按范围过滤：全部 / 正常 / 警告 / 错误）
function getBatchRemarkList() {
  const scope = state.batchRemarkScope || 'all';
  const list = getFilteredMachines();
  return scope === 'all' ? list : list.filter(m => m.status === scope);
}

// 批量备注（应用到当前列表的全部设备）
function openBatchRemark() {
  state.batchRemarkScope = 'all';
  const list = getBatchRemarkList();
  if (list.length === 0) { wx.showToast({ title: '当前列表没有设备' }); return; }
  document.getElementById('batchRemarkTitle').textContent = `批量备注 (${list.length}台设备)`;
  document.getElementById('batchRemarkInput').value = '';
  resetBatchRemarkAppend();
  document.getElementById('batchRemarkMask').classList.add('active');
}

function resetBatchRemarkAppend() {
  state.batchRemarkAppend = false;
  const sw = document.getElementById('batchRemarkAppendSwitch');
  if (sw) sw.classList.remove('on');
}

// 追加模式开关（对齐小程序 switch）
function toggleBatchRemarkAppend() {
  state.batchRemarkAppend = !state.batchRemarkAppend;
  const sw = document.getElementById('batchRemarkAppendSwitch');
  if (sw) sw.classList.toggle('on', state.batchRemarkAppend);
}

// =========== 全部备注操作表（长按「备注」按钮） ===========
function showAllRemarkSheet() {
  const sn = (state.globalData && state.globalData.statusNames) || {};
  document.getElementById('allRemarkNormal').textContent = sn.normal || '正常';
  document.getElementById('allRemarkWarning').textContent = sn.warning || '警告';
  document.getElementById('allRemarkError').textContent = sn.error || '错误';
  document.getElementById('allRemarkSheet').style.display = 'flex';
}

function hideAllRemarkSheet() {
  document.getElementById('allRemarkSheet').style.display = 'none';
}

function onAllRemarkSelect(index) {
  hideAllRemarkSheet();
  const statusList = ['all', 'normal', 'warning', 'error'];
  batchAddRemark(statusList[index]);
}

// 按状态范围打开批量备注弹窗
function batchAddRemark(status) {
  state.batchRemarkScope = status || 'all';
  const list = getBatchRemarkList();
  if (!list.length) {
    wx.showToast({ title: '没有符合条件的设备', icon: 'none' });
    state.batchRemarkScope = 'all';
    return;
  }
  const sn = (state.globalData && state.globalData.statusNames) || {};
  const scopeName = status === 'all' ? '全部' : (sn[status] || status);
  document.getElementById('batchRemarkTitle').textContent = `${scopeName}备注 (${list.length}台设备)`;
  document.getElementById('batchRemarkInput').value = '';
  resetBatchRemarkAppend();
  document.getElementById('batchRemarkMask').classList.add('active');
}

function hideBatchRemark() {
  document.getElementById('batchRemarkMask').classList.remove('active');
}

function confirmBatchRemark() {
  const list = getBatchRemarkList();
  const val = document.getElementById('batchRemarkInput').value.trim();
  const append = !!state.batchRemarkAppend;
  const now = new Date().toLocaleString('zh-CN', { hour12: false });

  // 999：批量关闭图片上传（不改备注内容）
  if (val === '999') {
    if (!confirm(`确定要关闭这 ${list.length} 台设备的图片上传功能吗？`)) return;
    list.forEach(m => { m.uploadEnabled = false; m.uploadStatusFilter = ''; });
    saveMachines();
    addHistoryLog({
      action: '批量关闭图片上传',
      machineName: list.map(m => m.displayName || m.name).join('、'),
      areaName: state.selectedArea || '',
      remark: '批量备注 999'
    });
    hideBatchRemark();
    render();
    wx.showToast({ title: `已关闭 ${list.length} 台设备上传` });
    return;
  }

  // 888 或 888+状态筛选：批量开启图片上传
  const match888 = val.match(/888(\S+)/);
  if (val === '888' || (val.indexOf('888') !== -1 && match888)) {
    if (!confirm(`确定要开启这 ${list.length} 台设备的图片上传功能吗？`)) return;
    list.forEach(m => { m.uploadEnabled = true; m.uploadStatusFilter = match888 ? match888[1] : ''; });
    saveMachines();
    addHistoryLog({
      action: '批量开启图片上传',
      machineName: list.map(m => m.displayName || m.name).join('、'),
      areaName: state.selectedArea || '',
      remark: match888 ? '筛选：' + match888[1] : '批量备注 888'
    });
    hideBatchRemark();
    render();
    wx.showToast({ title: `已开启 ${list.length} 台设备上传` });
    return;
  }

  // 普通批量备注（追加模式下接到现有备注后面）
  list.forEach(m => {
    if (append && val && m.remark) {
      m.remark = String(m.remark).replace(/\s+$/, '') + ' ' + val;
    } else {
      m.remark = val;
    }
    if (val) m.remarkTime = now;
  });
  saveMachines();
  addHistoryLog({
    action: '批量备注',
    machineName: list.map(m => m.displayName || m.name).join('、'),
    areaName: state.selectedArea || '',
    remark: val + (append ? '（追加）' : '')
  });
  hideBatchRemark();
  render();
  wx.showToast({
    title: val ? `已为 ${list.length} 台设备${append ? '追加' : ''}备注` : '已清空备注'
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
  return String(s || '').replace(/'/g, "\\'");
}

function renderImages() {
  const grid = document.getElementById('imgGrid');
  const hint = document.getElementById('photoHint');

  if (!state.selectedMachine) {
    hint.textContent = '请先选择设备，再拍照记录';
    hint.style.display = '';
    grid.innerHTML = '';
    return;
  }

  const imgs = state.selectedMachine.images || [];
  hint.textContent = imgs.length === 0
    ? '暂无图片，可拍照或从相册选择'
    : `已记录 ${imgs.length}/20 张`;

  grid.innerHTML = '';
  imgs.forEach((path, idx) => {
    const item = document.createElement('div');
    item.className = 'img-item';
    const blobUrl = fs.getBlobURL(path);
    item.innerHTML = `
      <img src="${blobUrl}" onclick="previewImg(${idx})" alt="">
      <button class="img-delete" type="button" onclick="deleteImg(${idx})">×</button>
    `;
    grid.appendChild(item);
  });
}

function updateStorageStats() {
  let totalKB = 0, imgCount = 0;
  state.machines.forEach(m => {
    (m.images || []).forEach(path => {
      const key = path.replace(/^wxfile:\/\/usr\//, 'usr/');
      const blob = fs._pathCache.get(key);
      if (blob) { totalKB += blob.size / 1024; imgCount++; }
    });
  });
  document.getElementById('imgCount').textContent = imgCount;
  document.getElementById('imgSize').textContent = totalKB >= 1024 ? (totalKB / 1024).toFixed(1) + 'M' : totalKB.toFixed(0);
  // 没有图片时隐藏整个「存储状态」区块
  const statBlock = document.getElementById('storageStatBlock');
  if (statBlock) statBlock.style.display = imgCount > 0 ? '' : 'none';
}

function updatePhotoButtons() {
  const selected = state.selectedMachine;
  const hasSlot = selected && (selected.images || []).length < 20;
  document.getElementById('cameraBtn').disabled = !hasSlot;
  document.getElementById('albumBtn').disabled = !hasSlot;
}

// =============== 设备点击 → 状态弹窗 ===============
// 点击卡片（对齐小程序 handleMachineTap）：
// 单击模式 → 选中并检查正常；双击模式 → 第一次点击只选中，第二次（300ms 内）检查正常
var __lastTapId = null, __lastTapTime = 0;

function onMachineTap(machineId) {
  const m = state.machines.find(x => x.id === machineId);
  if (!m) return;
  hideSMenu();
  // 锁定模式下允许查看设备信息，但不允许点检（对齐小程序）
  if (state.isLockedMode) {
    selectMachineOnly(machineId);
    return;
  }
  if (state.clickMode === 'double') {
    const same = __lastTapId === machineId;
    if (!same || !__lastTapTime || Date.now() - __lastTapTime > 300) {
      __lastTapId = machineId;
      __lastTapTime = Date.now();
      selectMachineOnly(machineId);
      return;
    }
  }
  selectMachineOnly(machineId);
  checkMachineNormal(machineId);
}

// 只选中设备，不弹操作表（对齐小程序 selectMachine：正常模式不自动展开 X 面板）
function selectMachineOnly(machineId) {
  const m = state.machines.find(x => x.id === machineId);
  if (!m) return;
  state.selectedMachine = m;
  // 自动模式下，每次点击都展开并重置为第一次打开的状态
  if (state.autoCollapseEnabled) state.selectedInfoExpanded = true;
  render();
}

// 点检正常：只对待检查（无状态）设备生效，已点检 / 警告 / 错误不处理
function checkMachineNormal(machineId) {
  const m = state.machines.find(x => x.id === machineId);
  if (!m) return;
  // 对齐小程序 checkMachine：锁定模式 / X 展开 / 自动模式 / 锁定区域内不允许点检
  if (state.isLockedMode) {
    wx.showToast({ title: '锁定模式下无法点检', icon: 'none' });
    return;
  }
  if (state.selectedInfoExpanded) {
    wx.showToast({ title: 'X展开状态下无法点检', icon: 'none' });
    return;
  }
  if (state.autoCollapseEnabled) {
    wx.showToast({ title: '自动模式下无法点检', icon: 'none' });
    return;
  }
  if (isAreaLocked(m)) {
    wx.showToast({ title: '该区域已锁定，无法操作', icon: 'none' });
    return;
  }
  const cur = m.status || '';
  if (cur && cur !== 'pending' && cur !== 'PENDING') return;
  state.currentActionMachine = m;
  setStatus('normal');
}

// 长按「备注」按钮：切换单击 / 双击模式（对齐小程序 toggleClickModeOnRemark）
function toggleClickMode() {
  state.clickMode = state.clickMode === 'single' ? 'double' : 'single';
  wx.setStorageSync('clickMode', state.clickMode);
  wx.showToast({
    title: state.clickMode === 'double' ? '已切换为双击模式' : '已切换为单击模式',
    icon: 'none'
  });
}

function hideActionSheet() {
  document.getElementById('actionMask').classList.remove('active');
  document.getElementById('actionSheet').classList.remove('active');
  state.currentActionMachine = null;
}

// =============== 长按设备 → 快速操作（与小程序长按菜单一致） ===============
function showQuickAction(machine) {
  if (!machine) return;
  const t = document.getElementById('quickTitle');
  if (t) t.textContent = (machine.displayName || machine.name || '设备') + ' · 快速操作';
  const sn = state.globalData.statusNames;
  const w = document.getElementById('quickLabelWarning'); if (w) w.textContent = sn.warning || '警告';
  const e = document.getElementById('quickLabelError'); if (e) e.textContent = sn.error || '错误';
  state.currentActionMachine = machine;
  // 上传图片仅在开启 888 密码（uploadEnabled）后出现
  const upItem = document.getElementById('quickUploadItem');
  if (upItem) upItem.style.display = machine.uploadEnabled ? '' : 'none';
  document.getElementById('quickMask').classList.add('active');
  document.getElementById('quickActionSheet').classList.add('active');
}

function hideQuickAction() {
  document.getElementById('quickMask').classList.remove('active');
  document.getElementById('quickActionSheet').classList.remove('active');
  state.currentActionMachine = null;
}

function quickSetStatus(status) {
  const m = state.currentActionMachine;
  if (!m) { hideQuickAction(); return; }
  document.getElementById('quickMask').classList.remove('active');
  document.getElementById('quickActionSheet').classList.remove('active');
  state.currentActionMachine = m;
  setStatus(status);
}

function quickUpload() {
  const m = state.currentActionMachine;
  hideQuickAction();
  if (!m) return;

  // 与小程序一致：备注 888 可附带状态筛选，设备状态不匹配时不允许上传
  if (m.uploadStatusFilter) {
    const statusMap = {
      '正常': 'normal', '警告': 'warning', '错误': 'error',
      'normal': 'normal', 'warning': 'warning', 'error': 'error'
    };
    let canUpload = false;
    Object.keys(statusMap).forEach(key => {
      if (m.uploadStatusFilter.includes(key) && m.status === statusMap[key]) canUpload = true;
    });
    if (!canUpload) {
      wx.showToast({ title: '设备状态与备注不匹配', icon: 'none' });
      return;
    }
  }

  state.selectedMachine = m;
  state.selectedInfoExpanded = true;
  state.imagesSectionExpanded = true;
  renderSelectedInfo();
  pickFromAlbum();
}

// 长按事件委托（设备列表）
function bindDeviceLongPress() {
  const itemsEl = document.getElementById('deviceItems');
  if (!itemsEl) return;
  let lpTimer = null, lpFired = false, lpId = null;
  const clear = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
  itemsEl.addEventListener('pointerdown', (e) => {
    const item = e.target.closest ? e.target.closest('.device-item[data-id]') : null;
    if (!item) return;
    lpFired = false;
    lpId = item.getAttribute('data-id');
    lpTimer = setTimeout(() => {
      lpFired = true;
      const m = state.machines.find(x => x.id === lpId);
      if (m) showQuickAction(m);
    }, 500);
  });
  itemsEl.addEventListener('pointerup', () => { clear(); lpId = null; });
  itemsEl.addEventListener('pointerleave', clear);
  itemsEl.addEventListener('pointercancel', clear);
  // 长按后不触发点击（避免又弹出完整操作表）
  itemsEl.addEventListener('click', (e) => {
    if (lpFired) { e.stopPropagation(); e.preventDefault(); lpFired = false; }
  }, true);
  itemsEl.addEventListener('contextmenu', (e) => e.preventDefault());
}

// 长按「备注」按钮：弹出全部备注操作表（与小程序 toggleClickModeOnRemark 一致）
function bindRemarkBtnLongPress() {
  const el = document.getElementById('remarkBtn');
  if (!el) return;
  let timer = null, fired = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', function () {
    fired = false;
    timer = setTimeout(function () { fired = true; toggleClickMode(); }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (evt) {
    el.addEventListener(evt, clear);
  });
  el.addEventListener('click', function (e) {
    if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; }
  }, true);
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
}

// 长按 X 按钮：进入自动模式（对齐小程序 toggleAutoCollapse）
function bindXBtnLongPress() {
  const el = document.getElementById('xBtn');
  if (!el) return;
  let timer = null, fired = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', function () {
    fired = false;
    timer = setTimeout(function () { fired = true; toggleAutoCollapse(); }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (evt) {
    el.addEventListener(evt, clear);
  });
  el.addEventListener('click', function (e) {
    if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; }
  }, true);
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
}

// 长按「总区域」按钮：切换锁定模式（对齐小程序 toggleLockedMode）
function bindAreaBtnLongPress() {
  const el = document.getElementById('areaToggleBtn');
  if (!el) return;
  let timer = null, fired = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', function () {
    fired = false;
    timer = setTimeout(function () { fired = true; toggleLockedMode(); }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (evt) {
    el.addEventListener(evt, clear);
  });
  el.addEventListener('click', function (e) {
    if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; }
  }, true);
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
}

// 长按搜索栏：显示/隐藏状态筛选按钮（对齐小程序 toggleStatusFilterVisibility）
function bindSearchBarLongPress() {
  const el = document.querySelector('.search-bar');
  if (!el) return;
  let timer = null, fired = false;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', function () {
    fired = false;
    timer = setTimeout(function () { fired = true; toggleStatusFilterVisibility(); }, 500);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (evt) {
    el.addEventListener(evt, clear);
  });
  el.addEventListener('click', function (e) {
    if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; }
  }, true);
  el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
}

// 长按区域列表项：锁定/解锁该区域
function bindAreaLongPress() {
  const el = document.getElementById('areaList');
  if (!el) return;
  let timer = null, fired = false, area = null;
  const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    const item = e.target.closest ? e.target.closest('.area-item[data-area]') : null;
    if (!item) return;
    fired = false;
    area = item.getAttribute('data-area');
    timer = setTimeout(function () {
      fired = true;
      if (area) toggleAreaLock(area);
    }, 500);
  });
  el.addEventListener('pointerup', clear);
  el.addEventListener('pointerleave', clear);
  el.addEventListener('pointercancel', clear);
  el.addEventListener('click', function (e) {
    if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; }
  }, true);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

function setStatus(status) {
  if (!state.currentActionMachine) { hideActionSheet(); return; }
  const m = state.currentActionMachine;
  if (isAreaLocked(m)) {
    hideActionSheet();
    wx.showToast({ title: '该区域已锁定，请先解锁', icon: 'none' });
    return;
  }
  const oldStatus = m.status || '';
  m.status = status;
  m.statusTime = status ? new Date().toLocaleString('zh-CN', { hour12: false }) : '';
  // 点检为正常且开启自动标记：把该设备所有检查项一并标记为正常
  if (status === 'normal' && state.autoMarkInspectionItems && Array.isArray(m.inspectionItems) && m.inspectionItems.length) {
    m.inspectionItems.forEach(function (it) {
      if (it) { it.result = '正常'; it.checkTime = m.statusTime; }
    });
    m.hasPendingInspection = false;
  }
  // 同步小程序口径字段（isChecked / lastCheck / checkTime），保证两端数据互认
  m.isChecked = !!status;
  m.lastCheck = m.statusTime;
  m.checkTime = m.statusTime;
  saveMachines();
  addHistoryLog({
    action: status ? '点检' : '清除状态',
    machineName: m.displayName || m.name,
    areaName: m.area || '',
    fromStatus: oldStatus,
    toStatus: status
  });
  hideActionSheet();
  // 自动模式下，每次点检都重新展开信息面板并滚动到面板位置（与小程序一致）
  if (state.autoCollapseEnabled) {
    state.selectedMachine = m;
    state.selectedInfoExpanded = true;
  }
  render();
  if (state.autoCollapseEnabled) {
    setTimeout(function () { window.scrollTo({ top: 100, behavior: 'smooth' }); }, 100);
  }
  if (status) {
    wx.showToast({ title: `已标记为${state.globalData.statusNames[status] || status}` });
  } else {
    wx.showToast({ title: '已清除状态' });
  }
}

// =============== 备注 ===============
function openRemark() {
  if (!state.currentActionMachine) return;
  document.getElementById('actionMask').classList.remove('active');
  document.getElementById('actionSheet').classList.remove('active');
  document.getElementById('remarkTitle').textContent =
    '备注 — ' + (state.currentActionMachine.displayName || state.currentActionMachine.name);
  document.getElementById('remarkInput').value = state.currentActionMachine.remark || '';
  state.remarkExisting = state.currentActionMachine.remark || '';
  // 保险：备注弹窗与快速操作表不同时出现
  document.getElementById('quickMask').classList.remove('active');
  document.getElementById('quickActionSheet').classList.remove('active');
  document.getElementById('remarkMask').classList.add('active');
  setTimeout(() => document.getElementById('remarkInput').focus(), 100);
}

// 快速插入运算符号（与小程序 insertRemarkSymbol 一致）
function insertRemarkSymbol(sym) {
  const input = document.getElementById('remarkInput');
  if (!input) return;
  input.value = (input.value || '') + sym;
  input.focus();
}

// 一键把原备注填入（与小程序 fillExistingRemark 一致：已有内容时追加，不覆盖）
function fillExistingRemark() {
  const input = document.getElementById('remarkInput');
  if (!input) return;
  const existing = state.remarkExisting || '';
  if (!existing) return;
  const content = input.value || '';
  if (content.indexOf(existing) !== -1) { input.focus(); return; }
  input.value = content ? content.replace(/\s+$/, '') + ' ' + existing + ' ' : existing + ' ';
  input.focus();
}

function hideRemark() {
  document.getElementById('remarkMask').classList.remove('active');
  state.currentActionMachine = null;
}

function confirmRemark() {
  if (!state.currentActionMachine) { hideRemark(); return; }
  const m = state.currentActionMachine;
  const val = document.getElementById('remarkInput').value.trim();

  // 999：关闭该设备的图片上传功能（备注内容保持不变，与小程序一致）
  if (val === '999') {
    if (!confirm('确定要关闭该设备的图片上传功能吗？')) return;
    m.uploadEnabled = false;
    m.uploadStatusFilter = '';
    saveMachines();
    addHistoryLog({
      action: '关闭图片上传',
      machineName: m.displayName || m.name,
      areaName: m.area || '',
      remark: '备注输入 999'
    });
    hideRemark();
    render();
    wx.showToast({ title: '上传功能已关闭' });
    return;
  }

  // 888 或 888+状态筛选：开启该设备的图片上传功能
  const match888 = val.match(/888(\S+)/);
  if (val === '888' || (val.indexOf('888') !== -1 && match888)) {
    if (!confirm('确定要开启该设备的图片上传功能吗？')) return;
    m.uploadEnabled = true;
    // 888 后面带文字时作为上传状态筛选条件
    m.uploadStatusFilter = match888 ? match888[1] : '';
    saveMachines();
    addHistoryLog({
      action: '开启图片上传',
      machineName: m.displayName || m.name,
      areaName: m.area || '',
      remark: match888 ? '筛选：' + match888[1] : '备注输入 888'
    });
    hideRemark();
    render();
    wx.showToast({ title: '上传功能已开启' });
    return;
  }

  // 普通备注
  m.remark = val;
  if (val) m.remarkTime = new Date().toLocaleString('zh-CN', { hour12: false });
  saveMachines();
  addHistoryLog({
    action: '备注',
    machineName: m.displayName || m.name,
    areaName: m.area || '',
    remark: val
  });
  hideRemark();
  render();
  wx.showToast({ title: val ? '备注已保存' : '备注已清空' });
}

// =============== 编辑设备 ===============
function openEdit() {
  if (!state.currentActionMachine) return;
  const m = state.currentActionMachine;
  document.getElementById('actionMask').classList.remove('active');
  document.getElementById('actionSheet').classList.remove('active');
  document.getElementById('editArea').value = m.area || '';
  // 从 name 中提取编号
  const parts = (m.name || '').split('-');
  document.getElementById('editName').value = parts[parts.length - 1].replace(/[^0-9]/g, '') || m.name || '';
  document.getElementById('editMask').classList.add('active');
}

function openEditForSelected() {
  if (!state.selectedMachine) return;
  state.currentActionMachine = state.selectedMachine;
  openEdit();
}

function deleteSelectedMachine() {
  if (!state.selectedMachine) return;
  state.currentActionMachine = state.selectedMachine;
  deleteMachine();
}

function hideEdit() {
  document.getElementById('editMask').classList.remove('active');
  state.currentActionMachine = null;
}

function confirmEdit() {
  if (!state.currentActionMachine) { hideEdit(); return; }
  const m = state.currentActionMachine;
  const area = document.getElementById('editArea').value.trim();
  const name = document.getElementById('editName').value.trim();
  if (!name) { wx.showToast({ title: '编号不能为空' }); return; }
  m.area = area;
  // 区域有数字前缀时（如"1区域"→"1"），name 用数字前缀；纯文字区域则用区域名本身
  const areaNum = area.replace(/[^\d]/g, '');
  m.name = area ? `${areaNum || area}-${name}` : name;
  m.displayName = area ? `${area}-${name}` : name;
  saveMachines();
  addHistoryLog({
    action: '编辑设备',
    machineName: m.displayName || m.name,
    areaName: m.area || '',
    remark: `区域/编号修改`
  });
  hideEdit();
  render();
  wx.showToast({ title: '已保存' });
}

// =============== 新增设备 ===============
function openAddDevice() {
  document.getElementById('addArea').value = '';
  document.getElementById('addName').value = '';
  document.getElementById('addMask').classList.add('active');
  setTimeout(() => document.getElementById('addName').focus(), 100);
}

function hideAddDevice() {
  document.getElementById('addMask').classList.remove('active');
}

function confirmAddDevice() {
  const area = document.getElementById('addArea').value.trim();
  const name = document.getElementById('addName').value.trim();
  if (!name) { wx.showToast({ title: '编号不能为空' }); return; }
  const areaNum = area.replace(/[^\d]/g, '');
  const fullName = area ? `${areaNum || area}-${name}` : name;
  const displayName = area ? `${area}-${name}` : name;
  // 防止重复（同区域同编号）
  const dup = state.machines.some(m => (m.displayName || m.name) === displayName);
  if (dup) { wx.showToast({ title: '该设备已存在' }); return; }
  const newMachine = {
    id: 'JT-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    name: fullName,
    area: area,
    displayName: displayName,
    status: '',
    remark: '',
    images: []
  };
  state.machines.push(newMachine);
  saveMachines();
  addHistoryLog({
    action: '新增设备',
    machineName: displayName,
    areaName: area,
    remark: ''
  });
  hideAddDevice();
  render();
  wx.showToast({ title: '已添加' });
}

// =============== 删除 / 回收站 ===============
function deleteMachine() {
  if (!state.currentActionMachine) { hideActionSheet(); return; }
  const m = state.currentActionMachine;
  // 锁定模式下不允许删除（对齐小程序）
  if (state.isLockedMode) {
    hideActionSheet();
    wx.showToast({ title: '锁定模式下无法删除', icon: 'none' });
    return;
  }
  if (isAreaLocked(m)) {
    hideActionSheet();
    wx.showToast({ title: '该区域已锁定，请先解锁', icon: 'none' });
    return;
  }
  if (!confirm(`确定删除设备「${m.displayName || m.name}」吗？可在回收站恢复。`)) return;
  const idx = state.machines.findIndex(x => x.id === m.id);
  if (idx !== -1) {
    const deleted = state.machines.splice(idx, 1)[0];
    state.deletedMachines.push({ ...deleted, deletedAt: Date.now() });
    wx.setStorageSync('deletedMachines', state.deletedMachines);
    saveMachines();
    addHistoryLog({
      action: '删除设备',
      machineName: m.displayName || m.name,
      areaName: m.area || '',
      remark: '移入回收站'
    });
    if (state.selectedMachine && state.selectedMachine.id === m.id) state.selectedMachine = null;
    hideActionSheet();
    render();
    wx.showToast({ title: '已移入回收站' });
  }
}

// 回收站选中状态（存 id 集合）
const recycleSelected = new Set();

function openRecycleBin() {
  if (state.deletedMachines.length === 0) {
    wx.showToast({ title: '回收站为空' });
    return;
  }
  recycleSelected.clear();
  renderRecycleList();
  document.getElementById('recycleMask').classList.add('active');
}

function hideRecycleBin() {
  document.getElementById('recycleMask').classList.remove('active');
  recycleSelected.clear();
}

function renderRecycleList() {
  const list = document.getElementById('recycleList');
  document.getElementById('recycleTotal').textContent = state.deletedMachines.length;
  updateRecycleSelectAllLabel();
  if (state.deletedMachines.length === 0) {
    list.innerHTML = '<div class="recycle-empty">回收站为空</div>';
    return;
  }
  list.innerHTML = '';
  state.deletedMachines.forEach((m, idx) => {
    const item = document.createElement('div');
    const checked = recycleSelected.has(m.id);
    item.className = 'recycle-item' + (checked ? ' checked' : '');
    const deletedDate = m.deletedAt ? new Date(m.deletedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false }) : '';
    item.innerHTML = `
      <div class="checkbox">${checked ? '✓' : ''}</div>
      <div class="recycle-info">
        <div class="recycle-name">${escapeHtml(m.displayName || m.name)}${m.area ? '（' + escapeHtml(m.area) + '）' : ''}</div>
        <div class="recycle-meta">${deletedDate} 删除 · ${(m.images || []).length}张图片</div>
      </div>
    `;
    item.onclick = () => toggleRecycleItem(m.id);
    list.appendChild(item);
  });
}

function toggleRecycleItem(id) {
  if (recycleSelected.has(id)) recycleSelected.delete(id);
  else recycleSelected.add(id);
  renderRecycleList();
}

function toggleRecycleSelectAll() {
  if (recycleSelected.size === state.deletedMachines.length) {
    recycleSelected.clear();
  } else {
    state.deletedMachines.forEach(m => recycleSelected.add(m.id));
  }
  renderRecycleList();
}

function updateRecycleSelectAllLabel() {
  const el = document.getElementById('recycleSelectAll');
  if (el) el.textContent = recycleSelected.size === state.deletedMachines.length && state.deletedMachines.length > 0 ? '取消全选' : '全选';
}

function restoreSelected() {
  if (recycleSelected.size === 0) {
    wx.showToast({ title: '请先勾选要恢复的设备' });
    return;
  }
  const toRestore = state.deletedMachines.filter(m => recycleSelected.has(m.id));
  toRestore.forEach(m => {
    const { deletedAt, ...rest } = m;
    state.machines.push(rest);
  });
  state.deletedMachines = state.deletedMachines.filter(m => !recycleSelected.has(m.id));
  wx.setStorageSync('deletedMachines', state.deletedMachines);
  saveMachines();
  const count = toRestore.length;
  addHistoryLog({
    action: '恢复设备',
    machineName: toRestore.map(m => m.displayName || m.name).join('、'),
    areaName: '',
    remark: `从回收站恢复 ${count} 台`
  });
  hideRecycleBin();
  render();
  wx.showToast({ title: `已恢复 ${count} 台` });
}

function emptyRecycleBin() {
  if (state.deletedMachines.length === 0) {
    wx.showToast({ title: '回收站已为空' });
    return;
  }
  if (!confirm(`确定清空回收站吗？${state.deletedMachines.length} 台设备将永久删除，不可恢复。`)) return;
  state.deletedMachines = [];
  wx.setStorageSync('deletedMachines', state.deletedMachines);
  hideRecycleBin();
  render();
  wx.showToast({ title: '回收站已清空' });
}

// =============== 图片预览/删除 ===============
function previewImg(index) {
  if (!state.selectedMachine) return;
  const path = (state.selectedMachine.images || [])[index];
  if (path) wx.previewImage({ urls: [fs.getBlobURL(path)], current: fs.getBlobURL(path) });
}

function deleteImg(index) {
  if (!state.selectedMachine) return;
  if (!confirm('确定删除这张图片吗？')) return;
  const imgs = state.selectedMachine.images || [];
  const removed = imgs.splice(index, 1)[0];
  try { fs.unlinkSync(removed); } catch (e) {}
  state.selectedMachine.images = imgs;
  saveMachines();
  render();
  wx.showToast({ title: '已删除' });
}

// =============== 拍照/选图 ===============
function takePhoto() {
  if (!state.selectedMachine) return;
  wx.chooseImage({
    count: 3,
    sourceType: ['camera'],
    success: (res) => saveImagesToMachineDirect(state.selectedMachine.id, res.tempFilePaths)
  });
}

function pickFromAlbum() {
  if (!state.selectedMachine) return;
  wx.chooseImage({
    count: 3,
    sourceType: ['album'],
    success: (res) => saveImagesToMachineDirect(state.selectedMachine.id, res.tempFilePaths)
  });
}

function saveImagesToMachineDirect(machineId, tempFilePaths) {
  const machines = state.machines;
  const machineIndex = machines.findIndex(m => m.id === machineId);
  if (machineIndex === -1) return;

  const machine = machines[machineIndex];
  const existingImages = machine.images || [];
  const availableSlot = 20 - existingImages.length;

  if (availableSlot <= 0) {
    wx.showToast({ title: '该设备图片已满（20张）' });
    return;
  }

  const imagesToAdd = tempFilePaths.slice(0, availableSlot);
  let savedCount = 0, totalBytes = 0;
  const savedImagePaths = [...existingImages];

  showProgress('正在处理图片...');

  const saveNext = (index) => {
    if (index >= imagesToAdd.length) {
      machines[machineIndex].images = savedImagePaths;
      if (state.selectedMachine && state.selectedMachine.id === machineId) {
        state.selectedMachine = machines[machineIndex];
      }
      saveMachines();
      hideProgress();
      const totalKB = Math.round(totalBytes / 1024);
      wx.showToast({
        title: `${savedCount}张 · ${totalKB >= 1024 ? (totalKB / 1024).toFixed(1) + 'MB' : totalKB + 'KB'}`,
        duration: 2000
      });
      render();
      return;
    }
    addWatermarkToImage(imagesToAdd[index], machine, existingImages.length + savedCount).then(result => {
      savedImagePaths.push(result.path);
      savedCount++;
      totalBytes += result.size;
      showProgress(`正在处理图片... (${savedCount}/${imagesToAdd.length})`);
      saveNext(index + 1);
    });
  };
  saveNext(0);
}

// =============== 加水印（Web Canvas 版） ===============
function addWatermarkToImage(imagePath, machine, imageIndex) {
  return new Promise((resolve) => {
    const showProjectHeader = state.globalData.showProjectHeader;
    const projectContent = state.globalData.projectContent;

    let watermarkText = '';
    const isSingleArea = machine.name && !machine.name.includes('-');
    const deviceNumber = machine.name ? machine.name.split('-').pop() : machine.name;
    if (showProjectHeader && projectContent) {
      watermarkText = isSingleArea ? `${projectContent}-${deviceNumber}` : `${projectContent}-${machine.area}-${deviceNumber}`;
    } else {
      watermarkText = isSingleArea ? `${deviceNumber}` : `${machine.area}-${deviceNumber}`;
    }
    watermarkText = `${watermarkText}-${imageIndex + 1}`;

    wx.getImageInfo({
      src: imagePath,
      success: (res) => {
        const maxDimension = 1280;
        let drawWidth = res.width, drawHeight = res.height;
        if (res.width > maxDimension || res.height > maxDimension) {
          const scale = maxDimension / Math.max(res.width, res.height);
          drawWidth = Math.round(res.width * scale);
          drawHeight = Math.round(res.height * scale);
        }

        const canvas = document.getElementById('watermarkCanvas');
        canvas.width = drawWidth;
        canvas.height = drawHeight;
        const ctx = wx.createCanvasContext('watermarkCanvas');

        loadImageSrc(imagePath).then(img => {
          ctx.drawImage(img, 0, 0, drawWidth, drawHeight);

          const fontSize = Math.max(16, Math.min(drawWidth, drawHeight) * 0.04);
          ctx.setFontSize(fontSize);
          const textWidth = ctx.measureText(watermarkText).width;
          const rightPadding = fontSize * 2;
          const bottomPadding = fontSize;
          const x = drawWidth - textWidth - rightPadding;
          const y = drawHeight - bottomPadding;

          ctx.setStrokeStyle('rgba(0, 0, 0, 0.8)');
          ctx.setLineWidth(fontSize * 0.15);
          ctx.strokeText(watermarkText, x, y - 5 + fontSize * 0.5);

          ctx.setFillStyle('rgba(255, 255, 255, 0.95)');
          ctx.fillText(watermarkText, x, y - 5 + fontSize * 0.5);

          wx.canvasToTempFilePath({
            canvasId: 'watermarkCanvas',
            fileType: 'jpg',
            quality: 0.6,
            success: (result) => {
              const permanentPath = `wxfile://usr/img_${Date.now()}_${imageIndex}_wm.jpg`;
              persistTempFile(result.tempFilePath, permanentPath).then(resolve);
            },
            fail: () => resolve({ path: imagePath, size: 0 })
          });
        }).catch(() => resolve({ path: imagePath, size: 0 }));
      },
      fail: () => resolve({ path: imagePath, size: 0 })
    });
  });
}

function persistTempFile(tempPath, permanentPath) {
  return new Promise((resolve) => {
    fs._loadFromDB(tempPath).then(() => {
      try {
        const b64 = fs.readFileSync(tempPath, 'base64');
        const size = Math.round((b64 || '').length * 3 / 4);
        fs.writeFileSync(permanentPath, b64.split(',')[1] || b64, 'base64');
        resolve({ path: permanentPath, size });
      } catch (e) {
        fallbackPersist(tempPath, permanentPath, resolve);
      }
    }).catch(() => fallbackPersist(tempPath, permanentPath, resolve));
  });
}

function fallbackPersist(tempPath, permanentPath, resolve) {
  const blobUrl = fs.getBlobURL(tempPath);
  fetch(blobUrl).then(r => r.blob()).then(blob => {
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = reader.result.split(',')[1];
      fs.writeFileSync(permanentPath, b64, 'base64');
      resolve({ path: permanentPath, size: blob.size });
    };
    reader.readAsDataURL(blob);
  }).catch(() => resolve({ path: tempPath, size: 0 }));
}

// =============== 检查项目（核心版） ===============
// 存储键与原小程序一致：isInspectionItemsEnabled / defaultInspectionItems
// machine.inspectionItems = [{ name, result: '待检查'|'正常'|'异常', checkTime }]
function loadInspectionSettings() {
  const v = wx.getStorageSync('isInspectionItemsEnabled');
  state.inspectionEnabled = (v === true || v === 'true');

  let items = wx.getStorageSync('defaultInspectionItems');
  if (typeof items === 'string') {
    items = items.split('\n').map(s => s.trim()).filter(Boolean);
  }
  // 兼容小程序结构 [{name, selected}] 与纯字符串数组
  state.inspectionItemNames = (Array.isArray(items) ? items : [])
    .map(function (it) {
      if (it && typeof it === 'object') return String(it.name || '');
      return String(it || '');
    })
    .filter(Boolean);

  // 显示/联动/自动标记等偏好（与小程序存储键一致）
  const showInList = wx.getStorageSync('showInspectionInList');
  state.showInspectionInList = !(showInList === 'false' || showInList === false);
  const autoMark = wx.getStorageSync('autoMarkInspectionItems');
  state.autoMarkInspectionItems = (autoMark === true || autoMark === 'true');
  const mode = wx.getStorageSync('inspectionDisplayMode');
  state.inspectionDisplayMode = (mode === 'expand' || mode === 'all') ? mode : 'all';
  const maxSel = parseInt(wx.getStorageSync('inspectionMaxSelect'), 10);
  state.inspectionMaxSelect = (!isNaN(maxSel) && maxSel >= 1) ? maxSel : 1;
  const link = parseInt(wx.getStorageSync('inspectionRemarkLink'), 10);
  state.inspectionRemarkLink = (link === 1 || link === 2) ? link : 0;
  const hideVal = wx.getStorageSync('inspectionHideRemarkValue');
  state.inspectionHideRemarkValue = (hideVal === true || hideVal === 'true');
  // 点击模式：single 单击即点检 / double 双击才点检（默认双击，与小程序一致）
  const cm = wx.getStorageSync('clickMode');
  state.clickMode = (cm === 'single' || cm === 'double') ? cm : 'double';
}

// 保证设备带有与全局表对齐的检查项
function ensureMachineInspectionItems(m) {
  if (!Array.isArray(m.inspectionItems) || m.inspectionItems.length === 0) {
    const oldByName = {};
    (Array.isArray(m.inspectionItems) ? m.inspectionItems : []).forEach(function (it) {
      if (it && it.name) oldByName[it.name] = it;
    });
    m.inspectionItems = state.inspectionItemNames.map(function (n) {
      return oldByName[n] || { name: n, result: '待检查', checkTime: '' };
    });
  }
  return m.inspectionItems;
}

function renderInspectionItems() {
  const section = document.getElementById('inspectionSection');
  const list = document.getElementById('inspectionList');
  const hint = document.getElementById('inspectionHint');
  const m = state.selectedMachine;
  if (!state.inspectionEnabled || !m) {
    section.style.display = 'none';
    return;
  }
  // 设备自身无检查项时，基于全局列表即时展示（首次点按时才写库）
  const own = Array.isArray(m.inspectionItems) ? m.inspectionItems : [];
  if (own.length === 0 && state.inspectionItemNames.length === 0) {
    section.style.display = 'none';
    return;
  }
  const source = own.length > 0 ? own : state.inspectionItemNames.map(n => ({ name: n, result: '待检查', checkTime: '' }));
  section.style.display = '';
  const expand = state.inspectionDisplayMode === 'expand';
  hint.textContent = expand
    ? `${m.displayName || m.name} · 选配模式：点按选择检查项（最多${state.inspectionMaxSelect}项）`
    : `${m.displayName || m.name} · 点按选择结果`;
  list.innerHTML = '';
  source.forEach((it, idx) => {
    const result = it.result || '待检查';
    const cls = result === '正常' ? 'result-pass' : result === '异常' ? 'result-fail' : 'result-pending';
    const icon = result === '正常' ? '✓ 正常' : result === '异常' ? '✕ 异常' : '○ 待检查';
    const timeStr = it.checkTime ? ' · ' + String(it.checkTime).slice(5, 16) : '';
    const div = document.createElement('div');
    div.className = 'inspection-item';
    // 选配模式下按小程序显示彩虹圆点，便于区分不同检查项
    const dot = expand ? `<span style="color:${getRainbowColor(idx)}">● </span>` : '';
    div.innerHTML = `
      <span class="inspection-item-name">${dot}${escapeHtml(getInspectionDisplayName(it.name))}</span>
      <span class="inspection-item-result ${cls}">${icon}${timeStr}</span>
    `;
    // 选配模式下未确认的当前项：点按先选检查项，再选结果
    const confirmed = it.result && it.result !== '待检查';
    div.onclick = () => {
      if (expand && !confirmed) openInspectionPicker(m.id);
      else showInspectionResultModal(m.id, idx);
    };
    list.appendChild(div);
  });
}

// 兼容旧调用：改为打开结果选择弹窗
function cycleInspection(machineId, index) {
  showInspectionResultModal(machineId, index);
}

// =========== 检查项结果选择弹窗（正常 / 异常 / 待检查） ===========
var inspEditing = { machineId: '', index: -1, result: '待检查' };

// 点按设备卡片上的检查项（不触发设备操作表）
function onInspectionItemTap(e, machineId, index) {
  if (e && e.stopPropagation) e.stopPropagation();
  const m = state.machines.find(x => x.id === machineId);
  if (!m) return;
  const items = ensureMachineInspectionItems(m);
  const it = items[index];
  if (!it) return;
  const confirmed = it.result && it.result !== '待检查';
  if (state.inspectionDisplayMode === 'expand' && !confirmed) openInspectionPicker(machineId);
  else showInspectionResultModal(machineId, index);
}

// 打开检查项相关弹窗时，确保设备操作表已收起
function closeMachineSheets() {
  ['quickMask', 'quickActionSheet', 'actionMask', 'actionSheet'].forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('active');
  });
}

function showInspectionResultModal(machineId, index) {
  const m = state.machines.find(x => x.id === machineId);
  if (!m) return;
  const items = ensureMachineInspectionItems(m);
  if (!items[index]) return;
  closeMachineSheets();
  inspEditing = { machineId: machineId, index: index, result: items[index].result || '待检查' };
  document.getElementById('inspResultTitle').textContent = items[index].name || '检查项';
  document.getElementById('inspResultMask').classList.add('active');
  renderInspectionResultPick();
}

function renderInspectionResultPick() {
  const rows = document.querySelectorAll('#inspResultMask .insp-result-row');
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('active', rows[i].getAttribute('data-result') === inspEditing.result);
  }
}

function pickInspectionResult(result) {
  inspEditing.result = result;
  renderInspectionResultPick();
}

function hideInspectionResultModal() {
  document.getElementById('inspResultMask').classList.remove('active');
}

function confirmInspectionResult() {
  hideInspectionResultModal();
  const m = state.machines.find(x => x.id === inspEditing.machineId);
  if (!m) return;
  if (isAreaLocked(m)) {
    wx.showToast({ title: '该区域已锁定，无法操作', icon: 'none' });
    return;
  }
  const items = ensureMachineInspectionItems(m);
  const it = items[inspEditing.index];
  if (!it) return;

  const result = inspEditing.result;
  const prev = it.result || '待检查';
  it.result = result;
  it.checkTime = result === '待检查' ? '' : new Date().toLocaleString('zh-CN', { hour12: false });
  m.selectedInspectionIndex = inspEditing.index;

  // 备注联动：确认时写入、清除（待检查）时移除，用户手动备注保留
  if (state.inspectionRemarkLink > 0) {
    if (result === '待检查') stripLinkedRemark(m, it.name);
    else if (prev === '待检查') appendLinkedRemark(m, it.name);
  }

  const hasPending = items.some(x => (x.result || '待检查') === '待检查');
  m.hasPendingInspection = hasPending;
  if (result === '异常') {
    m.status = 'error';
  } else if (result === '正常' && !hasPending) {
    m.status = 'normal';
  }
  if (m.status) {
    m.statusTime = new Date().toLocaleString('zh-CN', { hour12: false });
    m.isChecked = true;
    m.lastCheck = m.statusTime;
    m.checkTime = m.statusTime;
  }

  saveMachines();
  addHistoryLog({
    action: '检查项目',
    machineName: m.displayName || m.name,
    areaName: m.area || '',
    remark: `${it.name}：${result}`
  });
  render();
  wx.showToast({ title: `${it.name}：${result}` });
}

// =========== 选配模式：选择要确认的检查项 ===========
function openInspectionPicker(machineId) {
  const m = state.machines.find(x => x.id === machineId);
  if (!m) return;
  const items = ensureMachineInspectionItems(m);
  const selectedCount = items.filter(it => it.result && it.result !== '待检查').length;
  if (selectedCount >= state.inspectionMaxSelect) {
    wx.showToast({ title: '已选满，请先重置再选择', icon: 'none' });
    return;
  }
  closeMachineSheets();
  document.getElementById('inspPickTitle').textContent =
    '选择检查项（最多 ' + state.inspectionMaxSelect + ' 项）';
  document.getElementById('inspPickList').innerHTML = items.map(function (it, i) {
    const dot = '<span style="color:' + getRainbowColor(i) + '">● </span>';
    return '<div class="action-item normal" onclick="selectInspectionPick(\'' +
      escapeAttr(machineId) + '\',' + i + ')">' + dot +
      escapeHtml(getInspectionDisplayName(it.name || ('第' + (i + 1) + '项'))) + '</div>';
  }).join('');
  document.getElementById('inspPickMask').classList.add('active');
  document.getElementById('inspPickSheet').classList.add('active');
}

function hideInspectionPicker() {
  document.getElementById('inspPickMask').classList.remove('active');
  document.getElementById('inspPickSheet').classList.remove('active');
}

function selectInspectionPick(machineId, index) {
  hideInspectionPicker();
  showInspectionResultModal(machineId, index);
}

// =========== 备注联动：把检查项的数值/名称写入备注 ===========
function parseInspectionValue(name) {
  const s = String(name || '');
  const m = s.match(/^(.+?)([+-])([\d.]+[a-zA-Z\u4e00-\u9fa5]*)$/);
  if (m) return { name: m[1], value: m[2] + m[3] };
  return { name: s, value: null };
}

function appendLinkedRemark(m, itemName) {
  const p = parseInspectionValue(itemName);
  let seg = '';
  if (state.inspectionRemarkLink === 1) seg = p.value || '';
  else seg = p.value ? (p.name + p.value) : p.name;
  if (!seg) return;
  m.remark = ((m.remark || '') + ' ' + seg).trim();
}

function stripLinkedRemark(m, itemName) {
  const p = parseInspectionValue(itemName);
  let r = String(m.remark || '').replace(/\s*[+-][\d.]+[a-zA-Z\u4e00-\u9fa5]*/g, '');
  if (p.name) {
    const esc = p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    r = r.replace(new RegExp('\\s*' + esc, 'g'), '');
  }
  m.remark = r.trim();
}

// =========== 检查项目设置弹窗（增删改 + 模式 + 联动） ===========
function openInspectionManager() {
  document.getElementById('inspEnabled').checked = !!state.inspectionEnabled;
  document.getElementById('inspShowInList').checked = !!state.showInspectionInList;
  document.getElementById('inspAutoMark').checked = !!state.autoMarkInspectionItems;
  document.getElementById('inspHideRemarkValue').checked = !!state.inspectionHideRemarkValue;
  document.getElementById('inspMaxSelectInput').value = state.inspectionMaxSelect;
  renderInspectionModeUI();
  renderInspectionItemRows();
  document.getElementById('inspMask').classList.add('active');
}

function hideInspectionManager() {
  document.getElementById('inspMask').classList.remove('active');
}

function renderInspectionModeUI() {
  document.getElementById('inspModeAll').classList.toggle('active', state.inspectionDisplayMode === 'all');
  document.getElementById('inspModeExpand').classList.toggle('active', state.inspectionDisplayMode === 'expand');
  const linkBtns = document.querySelectorAll('#inspMask .insp-mode-btn[data-link]');
  for (let i = 0; i < linkBtns.length; i++) {
    linkBtns[i].classList.toggle('active', parseInt(linkBtns[i].getAttribute('data-link'), 10) === state.inspectionRemarkLink);
  }
}

function renderInspectionItemRows() {
  const box = document.getElementById('inspItemList');
  const names = state.inspectionItemNames.length ? state.inspectionItemNames : [''];
  box.innerHTML = names.map(function (n, i) {
    return '<div class="insp-item-row">' +
      '<input class="insp-item-input" data-index="' + i + '" value="' + escapeAttr(n) + '" placeholder="如：外观检查">' +
      '<span class="insp-item-del" onclick="removeInspectionItemRow(' + i + ')">✕</span>' +
      '</div>';
  }).join('');
}

function collectInspectionItemRows() {
  const inputs = document.querySelectorAll('#inspItemList .insp-item-input');
  const out = [];
  for (let i = 0; i < inputs.length; i++) {
    const v = (inputs[i].value || '').trim();
    if (v) out.push(v);
  }
  return out;
}

function addInspectionItemRow() {
  state.inspectionItemNames = collectInspectionItemRows().concat(['']);
  renderInspectionItemRows();
}

function removeInspectionItemRow(index) {
  const names = collectInspectionItemRows();
  if (names.length <= 1) {
    wx.showToast({ title: '至少保留1个项目', icon: 'none' });
    return;
  }
  names.splice(index, 1);
  state.inspectionItemNames = names;
  renderInspectionItemRows();
}

// 只保存为默认项目，不下发给设备
function saveDefaultInspectionItems() {
  const names = collectInspectionItemRows();
  state.inspectionItemNames = names;
  wx.setStorageSync('defaultInspectionItems', names);
  wx.setStorageSync('isInspectionItemsEnabled', !!state.inspectionEnabled);
  renderInspectionModeUI();
  wx.showToast({ title: '已保存为默认项目', icon: 'success' });
}

// 保存并应用到所有设备（同名保留已有结果）
function applyInspectionItems() {
  const names = collectInspectionItemRows();
  const uniq = [...new Set(names)];
  state.inspectionItemNames = uniq;
  wx.setStorageSync('defaultInspectionItems', uniq);
  wx.setStorageSync('isInspectionItemsEnabled', !!state.inspectionEnabled);
  state.machines.forEach(function (m) {
    const oldByName = {};
    (Array.isArray(m.inspectionItems) ? m.inspectionItems : []).forEach(function (it) {
      if (it && it.name) oldByName[it.name] = it;
    });
    m.inspectionItems = uniq.map(function (n) {
      return oldByName[n] || { name: n, result: '待检查', checkTime: '' };
    });
    m.hasPendingInspection = m.inspectionItems.length > 0;
    m.selectedInspectionIndex = 0;
  });
  saveMachines();
  hideInspectionManager();
  render();
  wx.showToast({
    title: uniq.length === 0 ? '已清空检查项目' : '已应用，共' + uniq.length + '项',
    icon: 'success'
  });
}

function setInspectionDisplayMode(mode) {
  state.inspectionDisplayMode = mode === 'expand' ? 'expand' : 'all';
  wx.setStorageSync('inspectionDisplayMode', state.inspectionDisplayMode);
  renderInspectionModeUI();
  render();
  wx.showToast({
    title: state.inspectionDisplayMode === 'expand' ? '已切换为选配模式' : '已切换为全部显示',
    icon: 'none'
  });
}

function setInspectionRemarkLink(value) {
  const n = parseInt(value, 10);
  state.inspectionRemarkLink = (state.inspectionRemarkLink === n) ? 0 : n;
  wx.setStorageSync('inspectionRemarkLink', state.inspectionRemarkLink);
  renderInspectionModeUI();
  wx.showToast({
    title: state.inspectionRemarkLink === 1 ? '备注联动：仅数值'
      : state.inspectionRemarkLink === 2 ? '备注联动：所有值' : '已关闭备注联动',
    icon: 'none'
  });
}

function onInspectionMaxSelectChange() {
  let v = parseInt(document.getElementById('inspMaxSelectInput').value, 10);
  if (isNaN(v) || v < 1) v = 1;
  if (v > 10) v = 10;
  state.inspectionMaxSelect = v;
  document.getElementById('inspMaxSelectInput').value = v;
  wx.setStorageSync('inspectionMaxSelect', v);
}

function toggleInspectionFlag(key) {
  if (key === 'enabled') {
    state.inspectionEnabled = document.getElementById('inspEnabled').checked;
    wx.setStorageSync('isInspectionItemsEnabled', state.inspectionEnabled);
  } else if (key === 'showInList') {
    state.showInspectionInList = document.getElementById('inspShowInList').checked;
    wx.setStorageSync('showInspectionInList', state.showInspectionInList);
  } else if (key === 'autoMark') {
    state.autoMarkInspectionItems = document.getElementById('inspAutoMark').checked;
    wx.setStorageSync('autoMarkInspectionItems', state.autoMarkInspectionItems);
  } else if (key === 'hideRemarkValue') {
    state.inspectionHideRemarkValue = document.getElementById('inspHideRemarkValue').checked;
    wx.setStorageSync('inspectionHideRemarkValue', state.inspectionHideRemarkValue);
  }
  render();
}

// =============== 进度 ===============
function showProgress(text) {
  document.getElementById('progressText').textContent = text;
  document.getElementById('progressOverlay').classList.add('active');
}
function hideProgress() {
  document.getElementById('progressOverlay').classList.remove('active');
}

// =============== 导出 JSON ===============
async function exportJSON() {
  const data = {
    _version: '2.0',
    _exportTime: new Date().toISOString(),
    projectName: wx.getStorageSync('projectName') || '呆子记录表',
    statusNames: state.globalData.statusNames,
    isInspectionItemsEnabled: !!state.inspectionEnabled,
    defaultInspectionItems: state.inspectionItemNames || [],
    machineCount: state.machines.length,
    totalImages: 0,
    machines: []
  };

  state.machines.forEach(m => {
    const imgs = m.images || [];
    data.totalImages += imgs.length;
    data.machines.push({
      id: m.id, name: m.name, displayName: m.displayName,
      area: m.area, status: m.status || '', remark: m.remark || '',
      statusTime: m.statusTime || '',
      isChecked: m.isChecked === true || !!m.status,
      lastCheck: m.lastCheck || m.statusTime || '',
      checkTime: m.checkTime || m.statusTime || '',
      inspectionItems: Array.isArray(m.inspectionItems) ? m.inspectionItems : [],
      images: []
    });
  });

  showProgress('正在转换图片...');
  for (let i = 0; i < state.machines.length; i++) {
    const m = state.machines[i];
    for (const path of (m.images || [])) {
      try {
        const b64 = fs.readFileSync(path, 'base64');
        data.machines[i].images.push(b64);
      } catch (e) {
        data.machines[i].images.push(path);
      }
    }
    showProgress(`正在转换图片... (${i + 1}/${state.machines.length})`);
  }
  hideProgress();

  const jsonStr = JSON.stringify(data);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `呆子记录表_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  const kb = Math.round(jsonStr.length / 1024);
  wx.showToast({
    title: `已导出 ${data.machines.length}台${data.totalImages > 0 ? '·' + data.totalImages + '图' : ''} (${kb >= 1024 ? (kb / 1024).toFixed(1) + 'MB' : kb + 'KB'})`,
    duration: 2000
  });
}

// =============== 启动 ===============
document.addEventListener('DOMContentLoaded', () => {
  const settings = wx.getStorageSync('machineSettings') || {};
  state.globalData.showProjectHeader = !!settings.showProjectHeader;
  state.globalData.projectContent = settings.projectContent || '';
  // 恢复持久化状态：状态筛选按钮显隐、区域锁定模式
  const savedFilterBtn = wx.getStorageSync('showStatusFilterBtn');
  state.showStatusFilterBtn = savedFilterBtn === '' || savedFilterBtn === null || savedFilterBtn === undefined ? true : !!savedFilterBtn;
  state.isLockedMode = !!wx.getStorageSync('isLockedMode');
  if (settings.statusNames && settings.statusNames.normal) {
    state.globalData.statusNames = settings.statusNames;
  } else {
    const sn = wx.getStorageSync('statusNames');
    if (sn && sn.normal) state.globalData.statusNames = sn;
  }

  loadInspectionSettings();
  loadMachines();

  document.getElementById('cameraBtn').onclick = takePhoto;
  document.getElementById('albumBtn').onclick = pickFromAlbum;

  bindDeviceLongPress();
  bindAreaLongPress();
  bindRemarkBtnLongPress();
  bindXBtnLongPress();
  bindAreaBtnLongPress();
  bindSearchBarLongPress();
  bindSMenuOutsideClick();
  updateStatusFilterUI();
  handleUrlAction();
  maybeAutoBackup();

  console.log('[PWA] work.js 初始化完成');
});

// 从导入导出页跳转过来时自动打开对应操作：?action=addDevice / recycleBin
function handleUrlAction() {
  const act = new URLSearchParams(location.search).get('action');
  if (act === 'addDevice') setTimeout(openAddDevice, 200);
  else if (act === 'recycleBin') setTimeout(openRecycleBin, 400);
}

// 暴露给 HTML onclick（所有 HTML 中 onclick 引用的函数都显式挂载）
Object.assign(window, {
  onMachineTap, setStatus, hideActionSheet,
  openRemark, hideRemark, confirmRemark,
  openEdit, hideEdit, confirmEdit,
  openAddDevice, hideAddDevice, confirmAddDevice,
  deleteMachine, openRecycleBin, hideRecycleBin,
  toggleRecycleItem, toggleRecycleSelectAll, restoreSelected, emptyRecycleBin,
  openInspectionManager, hideInspectionManager, saveDefaultInspectionItems, applyInspectionItems,
  setInspectionDisplayMode, setInspectionRemarkLink, onInspectionMaxSelectChange,
  toggleInspectionFlag, addInspectionItemRow, removeInspectionItemRow,
  showInspectionResultModal, hideInspectionResultModal, pickInspectionResult, confirmInspectionResult,
  openInspectionPicker, hideInspectionPicker, selectInspectionPick, cycleInspection, onInspectionItemTap,
  deleteImg, previewImg, onSearch, clearSearch,
  takePhoto, pickFromAlbum, exportJSON,
  // 小程序式布局交互
  toggleAreaList, selectArea, toggleSButtonMenu, toggleMachineInfoExpand, toggleAutoCollapse,
  clearSelectedMachine, toggleImagesSection, openRemarkForSelected, goPage,
  openBatchRemark, hideBatchRemark, confirmBatchRemark, toggleBatchRemarkAppend,
  showAllRemarkSheet, hideAllRemarkSheet, onAllRemarkSelect, batchAddRemark,
  toggleSButtonMenu, hideSMenu, enableInspectionFromMenu, disableInspectionFromMenu,
  onRemarkSectionTap, filterRemark, hasVisibleRemark, getInspectionDisplayName,
  onMachineTap, checkMachineNormal, selectMachineOnly, toggleClickMode,
  openEditForSelected, deleteSelectedMachine,
  // 状态筛选 + 长按快速操作
  showStatusFilter, setStatusFilter, showQuickAction, hideQuickAction,
  quickSetStatus, quickUpload,
  insertRemarkSymbol, fillExistingRemark
});
