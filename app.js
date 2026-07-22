/**
 * Pharmacist Leave Management System - GitHub Pages Frontend JavaScript
 * Uses REST API HTTP POST calls to communicate with Google Apps Script Backend.
 */

const AppState = {
  token: localStorage.getItem('SESSION_TOKEN') || '',
  user: null,
  currentView: 'login',
  calendarMonth: new Date().getMonth() + 1,
  calendarYear: new Date().getFullYear(),
  selectedStartDate: null,
  selectedEndDate: null
};

let calendarDataCache = null;
let selectedTargetUserId = null;

const THAI_MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'
];

/**
 * Executes REST API HTTP POST calls to GAS Backend.
 */
async function callApi(action, payload = {}) {
  if (!GAS_API_URL || GAS_API_URL === "YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE") {
    showToast('กรุณาระบุ GAS_API_URL ในไฟล์ config.js ก่อนเริ่มใช้งาน', 'error');
    throw new Error('GAS_API_URL is not configured');
  }

  showLoading(true);
  try {
    const response = await fetch(GAS_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify({
        action: action,
        token: AppState.token,
        payload: payload
      })
    });

    showLoading(false);
    const data = await response.json();

    if (data && data.success) {
      return data;
    } else {
      const errorMsg = data && data.error ? data.error : 'เกิดข้อผิดพลาดในการประมวลผล';
      if (errorMsg.includes('เซสชันหมดอายุ') || errorMsg.includes('การเชื่อมต่อหมดอายุ')) {
        handleLogout();
      }
      throw new Error(errorMsg);
    }
  } catch (err) {
    showLoading(false);
    console.error(`API Error [${action}]:`, err);
    throw err;
  }
}

/**
 * Show / Hide Global Spinner Loading Overlay.
 */
function showLoading(show) {
  const overlay = document.getElementById('spinnerOverlay');
  if (overlay) {
    if (show) overlay.classList.add('show');
    else overlay.classList.remove('show');
  }
}

/**
 * Toast Notification System.
 */
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'ℹ️';
  if (type === 'success') icon = '✅';
  if (type === 'error') icon = '❌';
  if (type === 'warning') icon = '⚠️';

  toast.innerHTML = `<span>${icon}</span><div>${escapeHtml(message)}</div>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

/**
 * Escapes unsafe HTML characters.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Navigation View Router.
 */
function switchView(viewName) {
  AppState.currentView = viewName;

  document.querySelectorAll('.view-panel').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

  const targetView = document.getElementById(`view-${viewName}`);
  if (targetView) targetView.style.display = 'block';

  const targetTab = document.getElementById(`tab-${viewName}`);
  if (targetTab) targetTab.classList.add('active');

  if (viewName === 'calendar') loadCalendar();
  if (viewName === 'my-leaves') loadMyLeaves();
  if (viewName === 'admin') loadAdminDashboard();
}

/**
 * Login Handler.
 */
async function handleLogin(e) {
  if (e) e.preventDefault();
  const staffId = document.getElementById('loginStaffId').value.trim();
  const password = document.getElementById('loginPassword').value.trim();

  if (!staffId || !password) {
    showToast('กรุณากรอกรหัสเจ้าหน้าที่และรหัสผ่าน', 'warning');
    return;
  }

  try {
    const res = await callApi('apiLogin', { staffId, password });
    AppState.token = res.token;
    AppState.user = res.user;
    localStorage.setItem('SESSION_TOKEN', res.token);
    
    updateNavbarUser();
    showToast(`เข้าสู่ระบบสำเร็จ ยินดีต้อนรับ ${res.user.full_name}`, 'success');

    document.getElementById('loginPassword').value = '';
    switchView('calendar');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/**
 * Logout Handler.
 */
async function handleLogout() {
  if (AppState.token) {
    try {
      callApi('apiLogout');
    } catch (e) { /* ignore */ }
  }
  AppState.token = '';
  AppState.user = null;
  localStorage.removeItem('SESSION_TOKEN');

  updateNavbarUser();
  switchView('login');
  showToast('ออกจากระบบเรียบร้อยแล้ว', 'info');
}

/**
 * Update Navbar User Status Tag.
 */
function updateNavbarUser() {
  const navUserBox = document.getElementById('navUserBox');
  const navTabs = document.getElementById('navTabs');
  const adminTab = document.getElementById('tab-admin');

  if (AppState.user) {
    navUserBox.style.display = 'flex';
    navTabs.style.display = 'flex';

    document.getElementById('navUserName').textContent = AppState.user.full_name;
    const roleTag = document.getElementById('navUserRole');
    roleTag.textContent = AppState.user.role === 'ADMIN' ? 'ผู้ดูแลระบบ (ADMIN)' : 'เภสัชกร (PHARMACIST)';
    roleTag.className = `role-tag role-${AppState.user.role.toLowerCase()}`;

    if (AppState.user.role === 'ADMIN') {
      if (adminTab) adminTab.style.display = 'block';
    } else {
      if (adminTab) adminTab.style.display = 'none';
    }
  } else {
    navUserBox.style.display = 'none';
    navTabs.style.display = 'none';
  }
}

/**
 * Application Initializer.
 */
async function initApp() {
  if (AppState.token) {
    try {
      const res = await callApi('apiGetSessionUser');
      AppState.user = res.user;
      updateNavbarUser();
      switchView('calendar');
    } catch (e) {
      handleLogout();
    }
  } else {
    switchView('login');
  }
}

// Modal Helpers
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('show');
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.remove('show');
}

/* ================= CALENDAR & LEAVE BOOKING ================= */

async function loadCalendar() {
  try {
    const res = await callApi('apiGetCalendarData', {
      year: AppState.calendarYear,
      month: AppState.calendarMonth
    });
    calendarDataCache = res.data;
    renderCalendarGrid(res.data);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function changeMonth(delta) {
  AppState.calendarMonth += delta;
  if (AppState.calendarMonth > 12) {
    AppState.calendarMonth = 1;
    AppState.calendarYear++;
  } else if (AppState.calendarMonth < 1) {
    AppState.calendarMonth = 12;
    AppState.calendarYear--;
  }
  loadCalendar();
}

function goToToday() {
  const now = new Date();
  AppState.calendarYear = now.getFullYear();
  AppState.calendarMonth = now.getMonth() + 1;
  loadCalendar();
}

function renderCalendarGrid(data) {
  const grid = document.getElementById('calendarGrid');
  const monthTitle = document.getElementById('calendarMonthTitle');
  if (!grid || !monthTitle) return;

  monthTitle.textContent = `${THAI_MONTHS[data.month - 1]} ${data.year + 543}`;
  grid.innerHTML = '';

  const dayLabels = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  dayLabels.forEach(lbl => {
    const el = document.createElement('div');
    el.className = 'day-label';
    el.textContent = lbl;
    grid.appendChild(el);
  });

  const firstDay = new Date(data.year, data.month - 1, 1).getDay();
  const daysInMonth = new Date(data.year, data.month, 0).getDate();

  for (let i = 0; i < firstDay; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'day-cell empty-cell';
    grid.appendChild(emptyCell);
  }

  const todayYMD = getTodayYMD();

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${data.year}-${String(data.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dayData = data.daysMap[dateStr] || { bookedCount: 0, bookedUsers: [], isUserBooked: false, color: 'green' };

    const cell = document.createElement('div');
    cell.className = `day-cell`;

    const isPast = dateStr < todayYMD;

    if (isPast) {
      cell.classList.add('past-cell');
    } else if (AppState.selectedStartDate && AppState.selectedEndDate) {
      if (dateStr >= AppState.selectedStartDate && dateStr <= AppState.selectedEndDate) {
        cell.classList.add('selected');
      }
    } else if (AppState.selectedStartDate && dateStr === AppState.selectedStartDate) {
      cell.classList.add('selected');
    }

    let badgeClass = isPast ? 'status-gray' : `status-${dayData.color || 'green'}`;
    let badgeText = isPast ? 'ผ่านแล้ว' : `${dayData.bookedCount}/${data.dailyCap} คน`;
    if (dayData.isUserBooked) {
      badgeText = `ท่านจองแล้ว (${dayData.bookedCount}/${data.dailyCap})`;
      badgeClass = 'status-blue';
    } else if (!isPast && dayData.bookedCount >= data.dailyCap) {
      badgeText = `เต็มแล้ว (${dayData.bookedCount}/${data.dailyCap})`;
      badgeClass = 'status-red';
    }

    // Generate names preview inside calendar cell
    let usersHtml = '';
    if (dayData.bookedUsers && dayData.bookedUsers.length > 0) {
      dayData.bookedUsers.forEach(name => {
        usersHtml += `<div class="day-users-preview" title="${escapeHtml(name)}">💊 ${escapeHtml(name)}</div>`;
      });
    }

    cell.innerHTML = `
      <div class="day-number" style="${dateStr === todayYMD ? 'color: var(--primary); font-weight:700;' : ''}">
        ${day} ${dateStr === todayYMD ? '(วันนี้)' : ''}
      </div>
      <div class="day-users-container">
        ${usersHtml}
      </div>
      <div class="day-status ${badgeClass}">
        ${badgeText}
      </div>
    `;

    cell.onclick = () => handleDayClick(dateStr, dayData);
    grid.appendChild(cell);
  }
}

function getTodayYMD() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function handleDayClick(dateStr, dayData) {
  const todayYMD = getTodayYMD();

  if (dateStr < todayYMD) {
    showToast(`ไม่สามารถเลือกวันที่ในอดีตได้ (${dateStr})`, 'warning');
    return;
  }

  if (!AppState.selectedStartDate || (AppState.selectedStartDate && AppState.selectedEndDate)) {
    AppState.selectedStartDate = dateStr;
    AppState.selectedEndDate = null;
  } else if (AppState.selectedStartDate && !AppState.selectedEndDate) {
    if (dateStr >= AppState.selectedStartDate) {
      AppState.selectedEndDate = dateStr;
    } else {
      AppState.selectedStartDate = dateStr;
      AppState.selectedEndDate = null;
    }
  }

  renderCalendarGrid(calendarDataCache);
  updateSelectionUI();

  if (dayData.bookedUsers && dayData.bookedUsers.length > 0) {
    showDayDetailsModal(dateStr, dayData);
  }
}

function updateSelectionUI() {
  const infoBox = document.getElementById('selectionInfo');
  const btnBook = document.getElementById('btnOpenBookingModal');
  if (!infoBox || !btnBook) return;

  if (AppState.selectedStartDate && AppState.selectedEndDate) {
    infoBox.textContent = `ช่วงวันที่เลือก: ${AppState.selectedStartDate} ถึง ${AppState.selectedEndDate}`;
    btnBook.style.display = 'inline-flex';
  } else if (AppState.selectedStartDate) {
    infoBox.textContent = `วันที่เลือก: ${AppState.selectedStartDate} (คลิกเลือกวันสิ้นสุด หรือกดยืนยันเพื่อเลือกวันเดียว)`;
    btnBook.style.display = 'inline-flex';
  } else {
    infoBox.textContent = 'กรุณาคลิกเลือกวันที่บนปฏิทินเพื่อจองวันลา';
    btnBook.style.display = 'none';
  }
}

function clearSelection() {
  AppState.selectedStartDate = null;
  AppState.selectedEndDate = null;
  renderCalendarGrid(calendarDataCache);
  updateSelectionUI();
}

function generateDateList(startStr, endStr) {
  const list = [];
  let curr = new Date(startStr + 'T00:00:00+07:00');
  const end = new Date(endStr + 'T00:00:00+07:00');
  while (curr <= end) {
    const y = curr.getFullYear();
    const m = String(curr.getMonth() + 1).padStart(2, '0');
    const d = String(curr.getDate()).padStart(2, '0');
    list.push(`${y}-${m}-${d}`);
    curr.setDate(curr.getDate() + 1);
  }
  return list;
}

function showDayDetailsModal(dateStr, dayData) {
  const modalTitle = document.getElementById('modalDayTitle');
  const modalList = document.getElementById('modalDayBookedList');

  modalTitle.textContent = `รายชื่อผู้จองวันลาประจำวันที่ ${dateStr}`;
  modalList.innerHTML = '';

  if (dayData.bookedUsers && dayData.bookedUsers.length > 0) {
    dayData.bookedUsers.forEach(fullName => {
      const item = document.createElement('div');
      item.style.padding = '0.6rem 0.8rem';
      item.style.borderBottom = '1px solid var(--border-color)';
      item.style.display = 'flex';
      item.style.alignItems = 'center';
      item.style.gap = '0.5rem';
      item.innerHTML = `<span>💊</span> <strong>${escapeHtml(fullName)}</strong>`;
      modalList.appendChild(item);
    });
  } else {
    modalList.innerHTML = '<div style="color:var(--text-muted); padding:1rem; text-align:center;">ยังไม่มีผู้จองวันลาในวันนี้</div>';
  }

  openModal('modalDayDetails');
}

function openBookingConfirmModal() {
  if (!AppState.selectedStartDate) {
    showToast('กรุณาเลือกวันที่ต้องการลาก่อน', 'warning');
    return;
  }

  const start = AppState.selectedStartDate;
  const end = AppState.selectedEndDate || AppState.selectedStartDate;
  const requestedDates = generateDateList(start, end);
  const monthKey = start.substring(0, 7);

  let existingCountInMonth = 0;
  if (calendarDataCache && calendarDataCache.daysMap) {
    Object.keys(calendarDataCache.daysMap).forEach(d => {
      if (d.startsWith(monthKey) && calendarDataCache.daysMap[d].isUserBooked) {
        existingCountInMonth++;
      }
    });
  }

  const newCountInMonth = requestedDates.filter(d => d.startsWith(monthKey)).length;
  const totalMonthDays = existingCountInMonth + newCountInMonth;

  if (totalMonthDays > 5) {
    if (window.Swal) {
      Swal.fire({
        title: 'แจ้งเตือนโควต้าวันลาเกินกำหนด',
        html: `
          <div style="text-align:center; font-family:'Prompt', sans-serif;">
            <div style="font-size:1.1rem; margin-bottom:0.8rem; color:#f59e0b; font-weight:600;">
              ⚠️ มีการจองวันลาเกิน 5 วัน สำหรับเดือนนี้
            </div>
            <div style="font-size:0.95rem; color:#cbd5e1; line-height:1.6;">
              ท่านมีวันลาเดิมในเดือนนี้ <strong>${existingCountInMonth} วัน</strong><br>
              ต้องการจองเพิ่ม <strong>${newCountInMonth} วัน</strong> (รวมเป็น <strong>${totalMonthDays} วัน</strong>)<br>
              <span style="color:#ef4444; font-weight:600;">(ระบบอนุญาตให้ลางานได้สูงสุด 5 วันต่อเดือน)</span>
            </div>
          </div>
        `,
        icon: 'warning',
        background: '#1e293b',
        color: '#f8fafc',
        confirmButtonColor: '#3b82f6',
        confirmButtonText: 'ตกลง'
      });
    } else {
      showToast(`มีการจองวันลาเกิน 5 วัน สำหรับเดือนนี้ (รวม ${totalMonthDays} วัน / โควต้า 5 วัน)`, 'warning');
    }
    return;
  }

  document.getElementById('bookStartDate').textContent = start;
  document.getElementById('bookEndDate').textContent = end;
  document.getElementById('bookTotalDays').textContent = `${requestedDates.length} วัน`;
  document.getElementById('bookReasonInput').value = '';

  openModal('modalBookingConfirm');
}

async function submitLeaveRequest() {
  const start = AppState.selectedStartDate;
  const end = AppState.selectedEndDate || AppState.selectedStartDate;
  const reason = document.getElementById('bookReasonInput').value.trim();

  const clientRequestId = 'req_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);

  try {
    const res = await callApi('apiCreateLeave', {
      startDate: start,
      endDate: end,
      reason: reason,
      clientRequestId: clientRequestId
    });

    showToast(res.message || 'บันทึกการลางานสำเร็จ', 'success');
    closeModal('modalBookingConfirm');
    clearSelection();
    loadCalendar();
  } catch (err) {
    if (window.Swal && (err.message.includes('เกินโควต้า') || err.message.includes('5 วัน'))) {
      Swal.fire({
        title: 'แจ้งเตือนโควต้าวันลาเกินกำหนด',
        html: `
          <div style="text-align:center; font-family:'Prompt', sans-serif;">
            <div style="font-size:1.1rem; margin-bottom:0.8rem; color:#f59e0b; font-weight:600;">
              ⚠️ มีการจองวันลาเกิน 5 วัน สำหรับเดือนนี้
            </div>
            <div style="font-size:0.95rem; color:#cbd5e1; line-height:1.6;">
              ${escapeHtml(err.message)}
            </div>
          </div>
        `,
        icon: 'warning',
        background: '#1e293b',
        color: '#f8fafc',
        confirmButtonColor: '#3b82f6',
        confirmButtonText: 'ตกลง'
      });
    } else {
      showToast(err.message, 'error');
    }
  }
}

async function loadMyLeaves() {
  const tableBody = document.getElementById('myLeavesTableBody');
  if (!tableBody) return;

  try {
    const res = await callApi('apiGetMyLeaves');
    const requests = res.data;
    tableBody.innerHTML = '';

    if (requests.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">ยังไม่มีประวัติการลางาน</td></tr>';
      return;
    }

    requests.forEach(r => {
      const tr = document.createElement('tr');
      const isCancelled = r.status === 'CANCELLED';
      const statusBadge = isCancelled
        ? '<span class="role-tag" style="background:rgba(239,68,68,0.2); color:#fca5a5;">ยกเลิกแล้ว</span>'
        : '<span class="role-tag" style="background:rgba(16,185,129,0.2); color:#6ee7b7;">อนุมัติ/ใช้งาน</span>';

      const actionBtn = isCancelled
        ? '-'
        : `<button class="btn btn-danger btn-sm" onclick="cancelLeave('${r.id}')">ยกเลิกการลา</button>`;

      tr.innerHTML = `
        <td>${r.start_date}</td>
        <td>${r.end_date}</td>
        <td><strong>${r.total_days} วัน</strong></td>
        <td>${escapeHtml(r.reason || '-')}</td>
        <td>${statusBadge}</td>
        <td>${r.created_at}</td>
        <td>${actionBtn}</td>
      `;
      tableBody.appendChild(tr);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function cancelLeave(requestId) {
  if (!confirm('คุณแน่ใจหรือไม่ว่าต้องการยกเลิกรายการลานี้?')) return;

  try {
    const res = await callApi('apiCancelLeave', { requestId });
    showToast(res.message || 'ยกเลิกการลาเรียบร้อยแล้ว', 'success');
    loadMyLeaves();
    loadCalendar();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ================= ADMIN DASHBOARD ================= */

function loadAdminDashboard() {
  if (!AppState.user || AppState.user.role !== 'ADMIN') return;
  loadStaffList();
  loadAuditLogs();
}

async function loadStaffList() {
  const tbody = document.getElementById('adminStaffTableBody');
  if (!tbody) return;

  try {
    const res = await callApi('apiGetStaffList');
    tbody.innerHTML = '';

    res.data.forEach(u => {
      const tr = document.createElement('tr');

      let statusTag = '<span class="role-tag" style="background:rgba(16,185,129,0.2); color:#6ee7b7;">เปิดใช้งาน (ACTIVE)</span>';
      if (u.status === 'LOCKED') {
        statusTag = '<span class="role-tag" style="background:rgba(239,68,68,0.2); color:#fca5a5;">ถูกล็อค (LOCKED - ผิด 5 ครั้ง)</span>';
      } else if (u.status === 'DISABLED') {
        statusTag = '<span class="role-tag" style="background:rgba(148,163,184,0.2); color:#cbd5e1;">ปิดใช้งาน (DISABLED)</span>';
      }

      const isSelf = String(u.id) === String(AppState.user.id);
      let toggleBtn = '';

      if (!isSelf) {
        if (u.status === 'ACTIVE') {
          toggleBtn = `<button class="btn btn-danger btn-sm" onclick="handleToggleUserStatus('${u.id}', 'DISABLED')">ปิดบัญชี</button>`;
        } else {
          toggleBtn = `<button class="btn btn-secondary btn-sm" onclick="handleToggleUserStatus('${u.id}', 'ACTIVE')">ปลดล็อค/เปิดบัญชี</button>`;
        }
      } else {
        toggleBtn = '<span style="color:var(--text-muted); font-size:0.8rem;">(บัญชีตนเอง)</span>';
      }

      const resetBtn = `<button class="btn btn-secondary btn-sm" onclick="openResetPasswordModal('${u.id}', '${escapeHtml(u.full_name)}')">รีเซ็ตรหัสผ่าน</button>`;

      tr.innerHTML = `
        <td><strong>${u.staff_id}</strong></td>
        <td>${u.full_name}</td>
        <td><span class="role-tag role-${u.role.toLowerCase()}">${u.role}</span></td>
        <td>${statusTag}</td>
        <td>${u.failed_login_attempts} / 5</td>
        <td style="display:flex; gap:0.4rem; flex-wrap:wrap;">${toggleBtn} ${resetBtn}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function handleToggleUserStatus(targetUserId, newStatus) {
  if (newStatus === 'DISABLED' && !confirm('คุณแน่ใจหรือไม่ว่าต้องการปิดใช้งานบัญชีผู้ใช้ท่านนี้?')) {
    return;
  }

  try {
    const res = await callApi('apiToggleUserStatus', { targetUserId, newStatus });
    showToast(res.message || 'อัปเดตสถานะเรียบร้อยแล้ว', 'success');
    loadStaffList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openAddStaffModal() {
  document.getElementById('addStaffId').value = '';
  document.getElementById('addFullName').value = '';
  document.getElementById('addRole').value = 'PHARMACIST';
  document.getElementById('addPassword').value = '';
  openModal('modalAddStaff');
}

async function submitAddStaff() {
  const staffId = document.getElementById('addStaffId').value.trim();
  const fullName = document.getElementById('addFullName').value.trim();
  const role = document.getElementById('addRole').value;
  const password = document.getElementById('addPassword').value.trim();

  if (!staffId || !fullName || !password) {
    showToast('กรุณากรอกข้อมูลให้ครบถ้วน', 'warning');
    return;
  }

  try {
    const res = await callApi('apiCreateStaff', { staffId, fullName, role, password });
    showToast(res.message || 'เพิ่มบุคลากรเรียบร้อยแล้ว', 'success');
    closeModal('modalAddStaff');
    loadStaffList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function openResetPasswordModal(userId, fullName) {
  selectedTargetUserId = userId;
  document.getElementById('resetTargetName').textContent = fullName;
  document.getElementById('resetNewPassword').value = '';
  openModal('modalResetPassword');
}

async function submitResetPassword() {
  const newPassword = document.getElementById('resetNewPassword').value.trim();

  if (!newPassword || newPassword.length < 6) {
    showToast('รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร', 'warning');
    return;
  }

  try {
    const res = await callApi('apiResetUserPassword', {
      targetUserId: selectedTargetUserId,
      newPassword: newPassword
    });
    showToast(res.message || 'รีเซ็ตรหัสผ่านสำเร็จ', 'success');
    closeModal('modalResetPassword');
    loadStaffList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function loadAuditLogs() {
  const tbody = document.getElementById('adminAuditTableBody');
  if (!tbody) return;

  try {
    const res = await callApi('apiGetAuditLogs');
    tbody.innerHTML = '';

    if (res.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-muted);">ยังไม่มีประวัติ Audit Log</td></tr>';
      return;
    }

    res.data.forEach(l => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-size:0.8rem; color:var(--text-muted);">${l.timestamp}</td>
        <td>${l.user_name}</td>
        <td><span class="role-tag" style="background:rgba(59,130,246,0.15); color:#93c5fd;">${l.action}</span></td>
        <td style="font-size:0.85rem;">${escapeHtml(l.details)}</td>
        <td style="font-size:0.8rem; color:var(--text-muted);">${l.ip_address}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function exportLeaveCSV() {
  try {
    const res = await callApi('apiExportLeaveReportCSV');
    triggerCSVDownload(res.csvData, `leave_report_${getTodayYMD()}.csv`);
    showToast('ดาวน์โหลดรายงานการลางาน (CSV UTF-8 BOM) เรียบร้อยแล้ว', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function exportAuditLogsCSV() {
  try {
    const res = await callApi('apiExportAuditLogsCSV');
    triggerCSVDownload(res.csvData, `audit_logs_${getTodayYMD()}.csv`);
    showToast('ดาวน์โหลด Audit Logs (CSV UTF-8 BOM) เรียบร้อยแล้ว', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function triggerCSVDownload(csvContent, filename) {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

async function runValidationTestsFromUI() {
  const box = document.getElementById('testResultsBox');
  if (!box) return;

  box.style.display = 'block';
  box.innerHTML = '<div style="padding:1rem;">⏳ กำลังทดสอบกฎ Validation ทั้งหมด...</div>';

  try {
    const res = await callApi('apiRunValidationTests');
    const report = res.report;

    let html = `<div style="font-weight:700; margin-bottom:0.75rem; font-size:1.1rem;">
      ผลการทดสอบ: ${report.passed}/${report.total} ผ่าน (${report.failed} ล้มเหลว)
    </div>`;

    report.details.forEach(item => {
      const color = item.passed ? 'var(--success)' : 'var(--danger)';
      const icon = item.passed ? '✅ [PASS]' : '❌ [FAIL]';
      html += `<div style="padding:0.5rem; margin-bottom:0.4rem; border-radius:6px; background:rgba(15,23,42,0.6); border-left:4px solid ${color};">
        <strong>${icon} ${item.name}</strong>
        <div style="font-size:0.85rem; color:var(--text-muted); margin-top:0.2rem;">${escapeHtml(item.message)}</div>
      </div>`;
    });

    box.innerHTML = html;
  } catch (err) {
    box.innerHTML = `<div style="color:var(--danger); padding:1rem;">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</div>`;
  }
}

window.addEventListener('DOMContentLoaded', initApp);
