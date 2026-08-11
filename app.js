/**
 * Pharmacist Leave Management System - GitHub Pages Frontend JavaScript
 * COMPLETE BOOKING FIX VERSION
 *
 * Compatible with the current BHH Pharmacist Leave frontend structure.
 *
 * Main fixes included:
 * - Preserve backend error.code / error.details.
 * - Server-side pre-validation before opening booking confirmation.
 * - Correctly detect full dates inside a selected date range.
 * - Backend remains source of truth and re-validates again on create.
 * - Bangkok-date-safe YYYY-MM-DD handling.
 * - Calendar request race protection.
 * - INACTIVE status compatibility with Apps Script backend.
 * - Safer DOM rendering for user/admin/audit data.
 * - Loading overlay request counter.
 * - CSV object URL cleanup.
 */

const FALLBACK_GAS_API_URL =
  "https://script.google.com/macros/s/AKfycbwzhBI3vd2qElmSBlzn2m98gjo3PCSbUh7efDaRmeerJ_Pf53P3jy-jytMrZYkwUD3A8g/exec";


/* =========================================================
 * DATE / TIME HELPERS
 * ========================================================= */

function getBangkokTodayParts() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(new Date());

  const map = {};
  parts.forEach(part => {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  });

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day)
  };
}


function getTodayYMD() {
  const p = getBangkokTodayParts();

  return (
    String(p.year).padStart(4, '0') +
    '-' +
    String(p.month).padStart(2, '0') +
    '-' +
    String(p.day).padStart(2, '0')
  );
}


function isYmd(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(
    String(value || '').trim()
  );
}


function normalizeFrontendYmd(value) {
  const text = String(value || '').trim();

  // Already correct.
  if (isYmd(text)) {
    return text;
  }

  // Backend may occasionally return datetime text.
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);

  if (match) {
    return match[1];
  }

  return text;
}


function generateDateList(startStr, endStr) {
  const start = normalizeFrontendYmd(startStr);
  const end = normalizeFrontendYmd(endStr);

  if (!isYmd(start) || !isYmd(end)) {
    throw new Error('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  }

  if (end < start) {
    throw new Error('วันที่สิ้นสุดต้องไม่น้อยกว่าวันที่เริ่มต้น');
  }

  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);

  let currentMs = Date.UTC(sy, sm - 1, sd);
  const endMs = Date.UTC(ey, em - 1, ed);

  const list = [];

  while (currentMs <= endMs) {
    const current = new Date(currentMs);
    list.push(current.toISOString().slice(0, 10));
    currentMs += 24 * 60 * 60 * 1000;
  }

  return list;
}


/* =========================================================
 * API / APP STATE
 * ========================================================= */

function getEffectiveApiUrl() {
  if (
    typeof GAS_API_URL !== 'undefined' &&
    GAS_API_URL &&
    String(GAS_API_URL).trim()
  ) {
    return String(GAS_API_URL).trim();
  }

  if (
    typeof window !== 'undefined' &&
    window.GAS_API_URL &&
    String(window.GAS_API_URL).trim()
  ) {
    return String(window.GAS_API_URL).trim();
  }

  return FALLBACK_GAS_API_URL;
}


const initialBangkokDate = getBangkokTodayParts();

const AppState = {
  token: localStorage.getItem('SESSION_TOKEN') || '',
  user: null,
  currentView: 'login',
  calendarMonth: initialBangkokDate.month,
  calendarYear: initialBangkokDate.year,
  selectedStartDate: null,
  selectedEndDate: null
};


let calendarDataCache = null;
const clientCalendarCache = {};

let selectedTargetUserId = null;
let calendarRequestSeq = 0;
let loadingRequestCount = 0;

// Near-real-time calendar synchronization.
// Poll a lightweight revision only while the Calendar view is visible.
 // 15 seconds reduces Apps Script request volume by ~67% vs 5-second polling.
const CALENDAR_SYNC_INTERVAL_MS = 15000;
let calendarKnownRevision = null;
let calendarSyncTimer = null;
let calendarSyncBusy = false;


const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม'
];


function createApiError(data, fallbackMessage) {
  const message =
    data && (data.error || data.message)
      ? String(data.error || data.message)
      : fallbackMessage;

  const error = new Error(message);

  error.code =
    data && data.code
      ? String(data.code)
      : 'API_ERROR';

  error.details =
    data && data.details !== undefined
      ? data.details
      : null;

  return error;
}


function isSessionError(err) {
  const code = String(
    (err && err.code) || ''
  ).toUpperCase();

  const message = String(
    (err && err.message) || ''
  );

  return (
    code === 'SESSION_EXPIRED' ||
    code === 'INVALID_SESSION' ||
    code === 'UNAUTHORIZED' ||
    message.includes('เซสชันหมดอายุ') ||
    message.includes('การเชื่อมต่อหมดอายุ') ||
    message.includes('กรุณาเข้าสู่ระบบ')
  );
}


async function callApi(action, payload = {}) {
  const targetUrl = getEffectiveApiUrl();

  showLoading(true);

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        /*
         * Intentionally text/plain.
         * Google Apps Script reads e.postData.contents and JSON.parse()s it.
         * Keeping this a CORS simple request avoids an application/json preflight.
         */
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify({
        action: action,
        token: AppState.token,
        payload: payload
      })
    });

    const data = await response.json();

    if (data && data.success) {
      return data;
    }

    const error = createApiError(
      data,
      'เกิดข้อผิดพลาดในการประมวลผล'
    );

    if (isSessionError(error)) {
      // Do not recursively call callApi('apiLogout') here.
      void handleLogout({
        notify: false,
        callBackend: false
      });
    }

    throw error;

  } catch (err) {
    console.error(
      `API Error [${action}]:`,
      err
    );

    throw err;

  } finally {
    showLoading(false);
  }
}


async function callApiSilent(action, payload = {}) {
  const targetUrl = getEffectiveApiUrl();

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        /*
         * Intentionally text/plain.
         * Google Apps Script reads e.postData.contents and JSON.parse()s it.
         * Keeping this a CORS simple request avoids an application/json preflight.
         */
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify({
        action: action,
        token: AppState.token,
        payload: payload
      })
    });

    const data = await response.json();

    if (data && data.success) {
      return data;
    }

    if (data) {
      const error = createApiError(
        data,
        'เกิดข้อผิดพลาดในการประมวลผล'
      );

      if (isSessionError(error)) {
        void handleLogout({
          notify: false,
          callBackend: false
        });
      }
    }

  } catch (err) {
    console.warn(
      `Silent API error [${action}]:`,
      err
    );
  }

  return null;
}


/* =========================================================
 * UI HELPERS
 * ========================================================= */

function showLoading(show) {
  const overlay =
    document.getElementById('spinnerOverlay');

  if (show) {
    loadingRequestCount += 1;
  } else {
    loadingRequestCount =
      Math.max(
        0,
        loadingRequestCount - 1
      );
  }

  if (!overlay) {
    return;
  }

  overlay.classList.toggle(
    'show',
    loadingRequestCount > 0
  );
}


function showToast(message, type = 'info') {
  const safeMessage = String(
    message || ''
  );

  if (window.Swal) {
    const icon =
      type === 'success'
        ? 'success'
        : type === 'error'
          ? 'error'
          : type === 'warning'
            ? 'warning'
            : 'info';

    Swal.fire({
      toast: true,
      position: 'top-end',
      icon: icon,
      title: safeMessage,
      showConfirmButton: false,
      timer: 3000
    });

    return;
  }

  const container =
    document.getElementById(
      'toastContainer'
    );

  if (!container) {
    return;
  }

  const toast =
    document.createElement('div');

  toast.className =
    `toast toast-${type}`;

  let icon = 'ℹ️';

  if (type === 'success') {
    icon = '✅';
  } else if (type === 'error') {
    icon = '❌';
  } else if (type === 'warning') {
    icon = '⚠️';
  }

  const iconEl =
    document.createElement('span');

  iconEl.textContent = icon;

  const textEl =
    document.createElement('div');

  textEl.textContent =
    safeMessage;

  toast.appendChild(iconEl);
  toast.appendChild(textEl);
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform =
      'translateX(100%)';

    setTimeout(
      () => toast.remove(),
      300
    );
  }, 4000);
}


function escapeHtml(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
    .replace(/`/g, '&#96;');
}


function openModal(modalId) {
  const modal =
    document.getElementById(modalId);

  if (modal) {
    modal.classList.add('show');
  }
}


function closeModal(modalId) {
  const modal =
    document.getElementById(modalId);

  if (modal) {
    modal.classList.remove('show');
  }

  // Prevent a stale target user ID from surviving after the reset modal closes.
  if (modalId === 'modalResetPassword') {
    selectedTargetUserId = null;
  }
}


function clearElement(element) {
  while (
    element &&
    element.firstChild
  ) {
    element.removeChild(
      element.firstChild
    );
  }
}


function createCell(text) {
  const td =
    document.createElement('td');

  td.textContent =
    text === null ||
    text === undefined
      ? ''
      : String(text);

  return td;
}


function createBadge(text, className, styleText) {
  const span =
    document.createElement('span');

  span.className =
    className || 'role-tag';

  span.textContent =
    String(text || '');

  if (styleText) {
    span.style.cssText =
      styleText;
  }

  return span;
}


/* =========================================================
 * LOGIN / SESSION / NAVIGATION
 * ========================================================= */

/**
 * Return Staff ID of logged-in user.
 * Supports both staff_id and staffId.
 */
function getLoggedInStaffId(user) {
  const savedStaffId =
    localStorage.getItem(
      'SESSION_STAFF_ID'
    ) || '';

  return String(
    (
      user &&
      (
        user.staff_id ||
        user.staffId
      )
    ) ||
    savedStaffId ||
    '-'
  ).trim();
}


function isAdminUser() {
  return String(
    AppState.user && AppState.user.role
      ? AppState.user.role
      : ''
  )
    .trim()
    .toUpperCase() === 'ADMIN';
}


function rememberCalendarRevision(revision) {
  if (
    revision !== undefined &&
    revision !== null &&
    String(revision).trim()
  ) {
    calendarKnownRevision = String(revision);
  }
}


function clearCalendarClientCache() {
  Object
    .keys(clientCalendarCache)
    .forEach(key => {
      delete clientCalendarCache[key];
    });
}


function stopCalendarAutoSync() {
  if (calendarSyncTimer) {
    clearInterval(calendarSyncTimer);
    calendarSyncTimer = null;
  }

  calendarSyncBusy = false;
}


function shouldCheckCalendarSync() {
  return Boolean(
    AppState.token &&
    AppState.user &&
    AppState.currentView === 'calendar' &&
    document.visibilityState === 'visible'
  );
}


function startCalendarAutoSync() {
  stopCalendarAutoSync();

  if (!AppState.token) {
    return;
  }

  calendarSyncTimer = setInterval(
    () => {
      void checkCalendarRevisionAndRefresh();
    },
    CALENDAR_SYNC_INTERVAL_MS
  );

  // Check once immediately after login/session restore.
  void checkCalendarRevisionAndRefresh();
}


async function refreshCurrentCalendarSilently() {
  if (!AppState.token) {
    return;
  }

  const year = AppState.calendarYear;
  const month = AppState.calendarMonth;
  const cacheKey = `${year}_${month}`;
  const requestSeq = ++calendarRequestSeq;

  const res = await callApiSilent(
    'apiGetCalendarData',
    {
      year: year,
      month: month
    }
  );

  if (!res || !res.data) {
    return;
  }

  rememberCalendarRevision(res.revision);
  clientCalendarCache[cacheKey] = res.data;

  if (
    !isCurrentCalendarRequest(
      requestSeq,
      year,
      month
    )
  ) {
    return;
  }

  calendarDataCache = res.data;

  if (AppState.currentView === 'calendar') {
    renderCalendarGrid(res.data);
  }
}


async function checkCalendarRevisionAndRefresh() {
  if (
    !shouldCheckCalendarSync() ||
    calendarSyncBusy
  ) {
    return;
  }

  calendarSyncBusy = true;

  try {
    const res = await callApiSilent(
      'apiGetCalendarRevision'
    );

    if (
      !res ||
      res.revision === undefined ||
      res.revision === null
    ) {
      return;
    }

    const latestRevision = String(res.revision);

    if (calendarKnownRevision === null) {
      calendarKnownRevision = latestRevision;
      return;
    }

    if (latestRevision === calendarKnownRevision) {
      return;
    }

    calendarKnownRevision = latestRevision;
    clearCalendarClientCache();

    // The server revision changed because another leave was created,
    // edited, or cancelled. Reload the visible month without a spinner.
    if (AppState.currentView === 'calendar') {
      await refreshCurrentCalendarSilently();
    }

  } finally {
    calendarSyncBusy = false;
  }
}


function switchView(viewName) {
  AppState.currentView =
    viewName;

  document
    .querySelectorAll(
      '.view-panel'
    )
    .forEach(el => {
      el.style.display = 'none';
    });

  document
    .querySelectorAll(
      '.tab-btn'
    )
    .forEach(el => {
      el.classList.remove(
        'active'
      );
    });

  const targetView =
    document.getElementById(
      `view-${viewName}`
    );

  if (targetView) {
    targetView.style.display =
      'block';
  }

  const targetTab =
    document.getElementById(
      `tab-${viewName}`
    );

  if (targetTab) {
    targetTab.classList.add(
      'active'
    );
  }

  if (viewName === 'calendar') {
    void loadCalendar();
  }

  if (viewName === 'my-leaves') {
    void loadMyLeaves();
  }

  if (viewName === 'admin') {
    loadAdminDashboard();
  }
}


async function handleLogin(e) {
  if (e) {
    e.preventDefault();
  }

  const staffId =
    document
      .getElementById(
        'loginStaffId'
      )
      .value
      .trim();

  const password =
    document
      .getElementById(
        'loginPassword'
      )
      .value
      .trim();

  if (!staffId || !password) {
    showToast(
      'กรุณากรอกรหัสเจ้าหน้าที่และรหัสผ่าน',
      'warning'
    );
    return;
  }

  try {
    const res =
      await callApi(
        'apiLogin',
        {
          staffId,
          password
        }
      );

    AppState.token =
      res.token;

    AppState.user =
      res.user || {};

    if (
      !AppState.user.staff_id &&
      !AppState.user.staffId
    ) {
      AppState.user.staff_id =
        staffId;
    }

    const loggedInStaffId =
      getLoggedInStaffId(
        AppState.user
      );

    localStorage.setItem(
      'SESSION_TOKEN',
      res.token
    );

    localStorage.setItem(
      'SESSION_STAFF_ID',
      loggedInStaffId
    );

    updateNavbarUser();

    showToast(
      `เข้าสู่ระบบสำเร็จ ยินดีต้อนรับ ${loggedInStaffId}`,
      'success'
    );

    document
      .getElementById(
        'loginPassword'
      )
      .value = '';

    switchView('calendar');
    startCalendarAutoSync();

  } catch (err) {
    showToast(
      err.message ||
      'ไม่สามารถเข้าสู่ระบบได้',
      'error'
    );
  }
}


async function handleLogout(options = {}) {
  const notify =
    options.notify !== false;

  const callBackend =
    options.callBackend !== false;

  if (
    callBackend &&
    AppState.token
  ) {
    try {
      await callApiSilent(
        'apiLogout'
      );
    } catch (_) {
      // Logout should always clear local state.
    }
  }

  stopCalendarAutoSync();
  calendarKnownRevision = null;

  AppState.token = '';
  AppState.user = null;

  localStorage.removeItem(
    'SESSION_TOKEN'
  );

  localStorage.removeItem(
    'SESSION_STAFF_ID'
  );

  Object
    .keys(clientCalendarCache)
    .forEach(key => {
      delete clientCalendarCache[key];
    });

  calendarDataCache = null;
  calendarRequestSeq += 1;

  AppState.selectedStartDate = null;
  AppState.selectedEndDate = null;

  updateNavbarUser();
  switchView('login');

  if (notify) {
    showToast(
      'ออกจากระบบเรียบร้อยแล้ว',
      'info'
    );
  }
}


function updateNavbarUser() {
  const navUserBox =
    document.getElementById(
      'navUserBox'
    );

  const navTabs =
    document.getElementById(
      'navTabs'
    );

  const adminTab =
    document.getElementById(
      'tab-admin'
    );

  const navUserName =
    document.getElementById(
      'navUserName'
    );

  const roleTag =
    document.getElementById(
      'navUserRole'
    );

  if (AppState.user) {
    if (navUserBox) {
      navUserBox.style.display =
        'flex';
    }

    if (navTabs) {
      navTabs.style.display =
        'flex';
    }

    if (navUserName) {
      navUserName.textContent =
        getLoggedInStaffId(
          AppState.user
        );
    }

    const role =
      String(
        AppState.user.role ||
        'PHARMACIST'
      )
        .trim()
        .toUpperCase();

    if (roleTag) {
      roleTag.textContent =
        role === 'ADMIN'
          ? 'ผู้ดูแลระบบ (ADMIN)'
          : 'เภสัชกร (PHARMACIST)';

      roleTag.className =
        `role-tag role-${role.toLowerCase()}`;
    }

    if (adminTab) {
      adminTab.style.display =
        role === 'ADMIN'
          ? 'block'
          : 'none';
    }

  } else {
    if (navUserBox) {
      navUserBox.style.display =
        'none';
    }

    if (navTabs) {
      navTabs.style.display =
        'none';
    }

    if (adminTab) {
      adminTab.style.display =
        'none';
    }

    if (navUserName) {
      navUserName.textContent =
        '-';
    }
  }
}


async function initApp() {
  if (!AppState.token) {
    switchView('login');
    return;
  }

  try {
    const res =
      await callApi(
        'apiGetSessionUser'
      );

    AppState.user =
      res.user || {};

    if (
      !AppState.user.staff_id &&
      !AppState.user.staffId
    ) {
      const savedStaffId =
        localStorage.getItem(
          'SESSION_STAFF_ID'
        );

      if (savedStaffId) {
        AppState.user.staff_id =
          savedStaffId;
      }
    }

    updateNavbarUser();
    switchView('calendar');
    startCalendarAutoSync();

  } catch (_) {
    await handleLogout({
      notify: false,
      callBackend: false
    });
  }
}


/* =========================================================
 * CALENDAR
 * ========================================================= */

function isCurrentCalendarRequest(
  seq,
  year,
  month
) {
  return (
    seq === calendarRequestSeq &&
    year === AppState.calendarYear &&
    month === AppState.calendarMonth
  );
}


async function loadCalendar(
  forceRefresh = false
) {
  const year =
    AppState.calendarYear;

  const month =
    AppState.calendarMonth;

  const cacheKey =
    `${year}_${month}`;

  const requestSeq =
    ++calendarRequestSeq;

  if (
    !forceRefresh &&
    clientCalendarCache[cacheKey]
  ) {
    calendarDataCache =
      clientCalendarCache[cacheKey];

    renderCalendarGrid(
      calendarDataCache
    );

    void fetchCalendarDataInBackground(
      cacheKey,
      year,
      month,
      requestSeq
    );

    return;
  }

  try {
    const res =
      await callApi(
        'apiGetCalendarData',
        {
          year: year,
          month: month
        }
      );

    if (!res || !res.data) {
      throw new Error(
        'ไม่พบข้อมูลปฏิทิน'
      );
    }

    rememberCalendarRevision(
      res.revision
    );

    clientCalendarCache[cacheKey] =
      res.data;

    if (
      !isCurrentCalendarRequest(
        requestSeq,
        year,
        month
      )
    ) {
      return;
    }

    calendarDataCache =
      res.data;

    renderCalendarGrid(
      res.data
    );

  } catch (err) {
    if (
      isCurrentCalendarRequest(
        requestSeq,
        year,
        month
      )
    ) {
      showToast(
        err.message,
        'error'
      );
    }
  }
}


async function fetchCalendarDataInBackground(
  cacheKey,
  year,
  month,
  requestSeq
) {
  const res =
    await callApiSilent(
      'apiGetCalendarData',
      {
        year: year,
        month: month
      }
    );

  if (
    !res ||
    !res.data
  ) {
    return;
  }

  rememberCalendarRevision(
    res.revision
  );

  clientCalendarCache[cacheKey] =
    res.data;

  if (
    !isCurrentCalendarRequest(
      requestSeq,
      year,
      month
    )
  ) {
    return;
  }

  calendarDataCache =
    res.data;

  renderCalendarGrid(
    res.data
  );
}


function changeMonth(delta) {
  AppState.calendarMonth +=
    Number(delta || 0);

  if (
    AppState.calendarMonth > 12
  ) {
    AppState.calendarMonth = 1;
    AppState.calendarYear += 1;

  } else if (
    AppState.calendarMonth < 1
  ) {
    AppState.calendarMonth = 12;
    AppState.calendarYear -= 1;
  }

  void loadCalendar();
}


function goToToday() {
  const today =
    getBangkokTodayParts();

  AppState.calendarYear =
    today.year;

  AppState.calendarMonth =
    today.month;

  void loadCalendar();
}


function renderCalendarGrid(data) {
  const grid =
    document.getElementById(
      'calendarGrid'
    );

  const monthTitle =
    document.getElementById(
      'calendarMonthTitle'
    );

  if (
    !grid ||
    !monthTitle ||
    !data
  ) {
    return;
  }

  const year =
    Number(data.year);

  const month =
    Number(data.month);

  const daysMap =
    data.daysMap || {};

  const dailyCap =
    Number(data.dailyCap || 3);

  const wednesdayCap =
    Number(
      data.wednesdayCap || 2
    );

  monthTitle.textContent =
    `${THAI_MONTHS[month - 1]} ${year + 543}`;

  grid.innerHTML = '';

  const dayLabels = [
    'อา',
    'จ',
    'อ',
    'พ',
    'พฤ',
    'ศ',
    'ส'
  ];

  dayLabels.forEach(label => {
    const el =
      document.createElement(
        'div'
      );

    el.className =
      'day-label';

    el.textContent =
      label;

    grid.appendChild(el);
  });

  const firstDay =
    new Date(
      year,
      month - 1,
      1
    ).getDay();

  const daysInMonth =
    new Date(
      year,
      month,
      0
    ).getDate();

  for (
    let i = 0;
    i < firstDay;
    i += 1
  ) {
    const emptyCell =
      document.createElement(
        'div'
      );

    emptyCell.className =
      'day-cell empty-cell';

    grid.appendChild(
      emptyCell
    );
  }

  const todayYMD =
    getTodayYMD();

  for (
    let day = 1;
    day <= daysInMonth;
    day += 1
  ) {
    const dateStr =
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const dateObj =
      new Date(
        year,
        month - 1,
        day
      );

    const dayOfWeek =
      dateObj.getDay();

    const dateCap =
      dayOfWeek === 3
        ? wednesdayCap
        : dailyCap;

    const dayData =
      daysMap[dateStr] || {
        bookedCount: 0,
        bookedUsers: [],
        isUserBooked: false,
        color: 'green'
      };

    const bookedCount =
      Number(
        dayData.bookedCount || 0
      );

    const bookedUsers =
      Array.isArray(
        dayData.bookedUsers
      )
        ? dayData.bookedUsers
        : [];

    const isUserBooked =
      Boolean(
        dayData.isUserBooked
      );

    const cell =
      document.createElement(
        'div'
      );

    cell.className =
      'day-cell';

    if (dayOfWeek === 0) {
      cell.classList.add(
        'weekend-sun'
      );

    } else if (
      dayOfWeek === 6
    ) {
      cell.classList.add(
        'weekend-sat'
      );
    }

    const isPast =
      dateStr < todayYMD;

    if (isPast) {
      cell.classList.add(
        'past-cell'
      );

      if (!isAdminUser()) {
        cell.setAttribute(
          'disabled',
          'disabled'
        );

        cell.style.pointerEvents =
          'none';

        cell.style.opacity =
          '0.55';
      } else {
        // Admin still needs the management button on historical ACTIVE rows.
        cell.style.opacity =
          '0.75';
      }

    } else if (
      AppState.selectedStartDate &&
      AppState.selectedEndDate &&
      dateStr >=
        AppState.selectedStartDate &&
      dateStr <=
        AppState.selectedEndDate
    ) {
      cell.classList.add(
        'selected'
      );

    } else if (
      AppState.selectedStartDate &&
      dateStr ===
        AppState.selectedStartDate
    ) {
      cell.classList.add(
        'selected'
      );
    }

    let badgeClass =
      isPast
        ? 'status-gray'
        : `status-${dayData.color || 'green'}`;

    let badgeText =
      isPast
        ? 'ผ่านแล้ว'
        : `${bookedCount}/${dateCap} คน`;

    if (isUserBooked) {
      badgeText =
        `ท่านจองแล้ว (${bookedCount}/${dateCap})`;

      badgeClass =
        'status-blue';

    } else if (
      !isPast &&
      bookedCount >= dateCap
    ) {
      badgeText =
        `เต็มแล้ว (${bookedCount}/${dateCap})`;

      badgeClass =
        'status-red';
    }

    const dayNumber =
      document.createElement(
        'div'
      );

    dayNumber.className =
      'day-number';

    if (
      dateStr === todayYMD
    ) {
      dayNumber.style.color =
        'var(--primary)';

      dayNumber.style.fontWeight =
        '700';
    }

    dayNumber.textContent =
      `${day}${dateStr === todayYMD ? ' (วันนี้)' : ''}`;

    const usersContainer =
      document.createElement(
        'div'
      );

    usersContainer.className =
      'day-users-container';

    bookedUsers.forEach(name => {
      const preview =
        document.createElement(
          'div'
        );

      preview.className =
        'day-users-preview';

      preview.title =
        String(name || '');

      preview.textContent =
        `💊 ${String(name || '')}`;

      usersContainer.appendChild(
        preview
      );
    });

    const statusEl =
      document.createElement(
        'div'
      );

    statusEl.className =
      `day-status ${badgeClass}`;

    statusEl.textContent =
      badgeText;

    cell.appendChild(
      dayNumber
    );

    cell.appendChild(
      usersContainer
    );

    cell.appendChild(
      statusEl
    );

    if (
      isAdminUser() &&
      bookedCount > 0
    ) {
      const adminManageBtn =
        document.createElement(
          'button'
        );

      adminManageBtn.type =
        'button';

      adminManageBtn.className =
        'btn btn-secondary btn-sm';

      adminManageBtn.textContent =
        '⚙ จัดการ';

      adminManageBtn.title =
        'Admin: แก้ไขหรือยกเลิกรายการลาในวันนี้';

      adminManageBtn.style.marginTop =
        '0.35rem';

      adminManageBtn.style.width =
        '100%';

      adminManageBtn.addEventListener(
        'click',
        event => {
          event.preventDefault();
          event.stopPropagation();
          void openAdminCalendarDay(
            dateStr
          );
        }
      );

      cell.appendChild(
        adminManageBtn
      );
    }

    if (!isPast) {
      cell.addEventListener(
        'click',
        () => {
          handleDayClick(
            dateStr,
            {
              ...dayData,
              bookedCount,
              bookedUsers,
              isUserBooked
            },
            dateCap
          );
        }
      );
    }

    grid.appendChild(cell);
  }
}


function showFullDateAlert(
  dateStr,
  dayData,
  limitCap
) {
  const bookedUsers =
    Array.isArray(
      dayData.bookedUsers
    )
      ? dayData.bookedUsers
      : [];

  if (window.Swal) {
    const usersListHtml =
      bookedUsers.length > 0
        ? bookedUsers
            .map(
              user =>
                `<div style="font-size:0.9rem; color:#f8fafc; margin-top:0.25rem;">💊 ${escapeHtml(user)}</div>`
            )
            .join('')
        : '<div style="color:#94a3b8; font-size:0.85rem;">ไม่พบข้อมูลรายชื่อ</div>';

    Swal.fire({
      title:
        'วันที่นี้มีผู้จองเต็มแล้ว',
      html: `
        <div style="text-align:center; font-family:'Prompt', sans-serif;">
          <div style="font-size:1.1rem; margin-bottom:0.8rem; color:#ef4444; font-weight:600;">
            🚫 ไม่สามารถเลือกวันที่ ${escapeHtml(dateStr)} ได้
          </div>

          <div style="font-size:0.95rem; color:#cbd5e1; line-height:1.6; margin-bottom:0.8rem;">
            วันที่นี้มีผู้จองวันลาครบกำหนดแล้ว
            <strong>(${Number(dayData.bookedCount || 0)}/${Number(limitCap)} คน)</strong>
          </div>

          <div style="background:rgba(255,255,255,0.05); padding:0.8rem; border-radius:8px; text-align:left;">
            <div style="font-size:0.85rem; color:#94a3b8; margin-bottom:0.4rem;">
              รายชื่อผู้จองวันลาในวันนี้:
            </div>
            ${usersListHtml}
          </div>
        </div>
      `,
      icon: 'error',
      background: '#1e293b',
      color: '#f8fafc',
      confirmButtonColor:
        '#3b82f6',
      confirmButtonText:
        'ตกลง'
    });

  } else {
    showToast(
      `วันที่ ${dateStr} มีผู้จองเต็มแล้ว (${Number(dayData.bookedCount || 0)}/${Number(limitCap)} คน)`,
      'warning'
    );
  }
}


function handleDayClick(
  dateStr,
  dayData,
  dateCap
) {
  const todayYMD =
    getTodayYMD();

  if (dateStr < todayYMD) {
    if (window.Swal) {
      Swal.fire({
        title:
          'วันที่ในอดีต',
        text:
          `ไม่สามารถเลือกวันที่ในอดีตได้ (${dateStr})`,
        icon: 'warning',
        background:
          '#1e293b',
        color:
          '#f8fafc',
        confirmButtonColor:
          '#3b82f6',
        confirmButtonText:
          'ตกลง'
      });

    } else {
      showToast(
        `ไม่สามารถเลือกวันที่ในอดีตได้ (${dateStr})`,
        'warning'
      );
    }

    return;
  }

  const limitCap =
    Number(
      dateCap ||
      (
        calendarDataCache &&
        calendarDataCache.dailyCap
      ) ||
      3
    );

  if (
    Number(
      dayData.bookedCount || 0
    ) >= limitCap &&
    !dayData.isUserBooked
  ) {
    showFullDateAlert(
      dateStr,
      dayData,
      limitCap
    );
    return;
  }

  if (dayData.isUserBooked) {
    showToast(
      `วันที่ ${dateStr} ท่านมีรายการลาอยู่แล้ว`,
      'warning'
    );
    return;
  }

  if (
    !AppState.selectedStartDate ||
    (
      AppState.selectedStartDate &&
      AppState.selectedEndDate
    )
  ) {
    AppState.selectedStartDate =
      dateStr;

    AppState.selectedEndDate =
      null;

  } else if (
    AppState.selectedStartDate &&
    !AppState.selectedEndDate
  ) {
    if (
      dateStr >=
      AppState.selectedStartDate
    ) {
      AppState.selectedEndDate =
        dateStr;

    } else {
      AppState.selectedStartDate =
        dateStr;

      AppState.selectedEndDate =
        null;
    }
  }

  renderCalendarGrid(
    calendarDataCache
  );

  updateSelectionUI();
}


function updateSelectionUI() {
  const infoBox =
    document.getElementById(
      'selectionInfo'
    );

  const btnBook =
    document.getElementById(
      'btnOpenBookingModal'
    );

  if (
    !infoBox ||
    !btnBook
  ) {
    return;
  }

  if (
    AppState.selectedStartDate &&
    AppState.selectedEndDate
  ) {
    infoBox.textContent =
      `ช่วงวันที่เลือก: ${AppState.selectedStartDate} ถึง ${AppState.selectedEndDate}`;

    btnBook.style.display =
      'inline-flex';

  } else if (
    AppState.selectedStartDate
  ) {
    infoBox.textContent =
      `วันที่เลือก: ${AppState.selectedStartDate} (คลิกเลือกวันสิ้นสุด หรือกดยืนยันเพื่อเลือกวันเดียว)`;

    btnBook.style.display =
      'inline-flex';

  } else {
    infoBox.textContent =
      'กรุณาคลิกเลือกวันที่บนปฏิทินเพื่อจองวันลา';

    btnBook.style.display =
      'none';
  }
}


function clearSelection() {
  AppState.selectedStartDate =
    null;

  AppState.selectedEndDate =
    null;

  if (calendarDataCache) {
    renderCalendarGrid(
      calendarDataCache
    );
  }

  updateSelectionUI();
}


/* =========================================================
 * LEAVE VALIDATION / BOOKING
 * ========================================================= */

function getValidationObjectFromResponse(res) {
  if (!res) {
    return null;
  }

  if (
    res.validation &&
    typeof res.validation === 'object'
  ) {
    return res.validation;
  }

  if (
    res.data &&
    res.data.validation &&
    typeof res.data.validation === 'object'
  ) {
    return res.data.validation;
  }

  if (
    res.data &&
    typeof res.data === 'object' &&
    typeof res.data.valid === 'boolean'
  ) {
    return res.data;
  }

  return null;
}


function getValidationObjectFromError(err) {
  if (
    !err ||
    !err.details
  ) {
    return null;
  }

  if (
    typeof err.details.valid ===
      'boolean'
  ) {
    return err.details;
  }

  if (
    err.details.validation &&
    typeof err.details.validation ===
      'object'
  ) {
    return err.details.validation;
  }

  if (
    err.details.checks &&
    typeof err.details.checks ===
      'object'
  ) {
    return {
      valid: false,
      checks:
        err.details.checks
    };
  }

  return null;
}


function buildLeaveValidationMessages(
  validation
) {
  if (!validation) {
    return [];
  }

  const checks =
    validation.checks || {};

  const messages = [];

  if (
    checks.duplicate &&
    !checks.duplicate.passed &&
    Array.isArray(
      checks.duplicate.dates
    )
  ) {
    checks.duplicate.dates
      .forEach(date => {
        messages.push(
          `วันที่ ${date} ท่านมีรายการลาอยู่แล้ว`
        );
      });
  }

  if (
    checks.dailyCap &&
    !checks.dailyCap.passed &&
    Array.isArray(
      checks.dailyCap.conflicts
    )
  ) {
    checks.dailyCap.conflicts
      .forEach(item => {
        messages.push(
          `วันที่ ${item.date} มีผู้จองเต็มแล้ว (${item.bookedCount}/${item.limit} คน)`
        );
      });
  }

  if (
    checks.monthlyQuota &&
    !checks.monthlyQuota.passed &&
    checks.monthlyQuota.months
  ) {
    Object.keys(
      checks.monthlyQuota.months
    ).forEach(month => {
      const info =
        checks.monthlyQuota
          .months[month];

      if (
        !info ||
        info.passed
      ) {
        return;
      }

      const total =
        info.totalAfterRequest !==
        undefined
          ? Number(
              info.totalAfterRequest
            )
          : Number(
              info.used || 0
            ) +
            Number(
              info.requested || 0
            );

      messages.push(
        `เดือน ${month} จะมีวันลารวม ${total} วัน เกินโควต้า ${info.limit} วัน`
      );
    });
  }

  if (
    checks.consecutiveDays &&
    !checks.consecutiveDays.passed
  ) {
    messages.push(
      `มีวันลาต่อเนื่องเกิน ${checks.consecutiveDays.limit} วันภายในเดือนเดียวกัน`
    );
  }

  return messages;
}


function showLeaveValidationError(
  validation,
  fallbackMessage
) {
  const messages =
    buildLeaveValidationMessages(
      validation
    );

  const message =
    messages.length > 0
      ? messages.join('\n')
      : (
          fallbackMessage ||
          'ไม่สามารถจองช่วงวันที่ที่เลือกได้'
        );

  if (window.Swal) {
    Swal.fire({
      title:
        'ไม่สามารถจองวันลาได้',
      text: message,
      icon: 'warning',
      background:
        '#1e293b',
      color:
        '#f8fafc',
      confirmButtonColor:
        '#3b82f6',
      confirmButtonText:
        'ตกลง'
    });

  } else {
    showToast(
      message,
      'warning'
    );
  }
}


async function openBookingConfirmModal() {
  if (
    !AppState.selectedStartDate
  ) {
    showToast(
      'กรุณาเลือกวันที่ต้องการลาก่อน',
      'warning'
    );
    return;
  }

  const start =
    normalizeFrontendYmd(
      AppState.selectedStartDate
    );

  const end =
    normalizeFrontendYmd(
      AppState.selectedEndDate ||
      AppState.selectedStartDate
    );

  let requestedDates;

  try {
    requestedDates =
      generateDateList(
        start,
        end
      );
  } catch (err) {
    showToast(
      err.message,
      'error'
    );
    return;
  }

  try {
    /*
     * IMPORTANT:
     * Ask backend to validate ALL candidate dates before the
     * confirmation modal is opened.
     *
     * This catches a full date in the middle of a selected range.
     */
    const res =
      await callApi(
        'apiValidateLeaveRequest',
        {
          startDate: start,
          endDate: end
        }
      );

    const validation =
      getValidationObjectFromResponse(
        res
      );

    if (!validation) {
      throw new Error(
        'ไม่พบผลการตรวจสอบวันลาจากระบบ'
      );
    }

    if (!validation.valid) {
      showLeaveValidationError(
        validation
      );
      return;
    }

    const startEl =
      document.getElementById(
        'bookStartDate'
      );

    const endEl =
      document.getElementById(
        'bookEndDate'
      );

    const totalEl =
      document.getElementById(
        'bookTotalDays'
      );

    const reasonEl =
      document.getElementById(
        'bookReasonInput'
      );

    if (startEl) {
      startEl.textContent =
        start;
    }

    if (endEl) {
      endEl.textContent =
        end;
    }

    if (totalEl) {
      totalEl.textContent =
        `${requestedDates.length} วัน`;
    }

    if (reasonEl) {
      reasonEl.value = '';
      reasonEl.maxLength = 500;
    }

    openModal(
      'modalBookingConfirm'
    );

  } catch (err) {
    const validation =
      getValidationObjectFromError(
        err
      );

    if (validation) {
      showLeaveValidationError(
        validation,
        err.message
      );
      return;
    }

    if (window.Swal) {
      Swal.fire({
        title:
          'ไม่สามารถตรวจสอบวันลาได้',
        text:
          err.message ||
          'กรุณาลองใหม่อีกครั้ง',
        icon: 'error',
        background:
          '#1e293b',
        color:
          '#f8fafc',
        confirmButtonColor:
          '#3b82f6',
        confirmButtonText:
          'ตกลง'
      });

    } else {
      showToast(
        err.message ||
        'ไม่สามารถตรวจสอบวันลาได้',
        'error'
      );
    }
  }
}


async function submitLeaveRequest() {
  const start =
    normalizeFrontendYmd(
      AppState.selectedStartDate
    );

  const end =
    normalizeFrontendYmd(
      AppState.selectedEndDate ||
      AppState.selectedStartDate
    );

  if (
    !isYmd(start) ||
    !isYmd(end)
  ) {
    showToast(
      'รูปแบบวันที่ต้องเป็น YYYY-MM-DD',
      'error'
    );
    return;
  }

  const reasonEl =
    document.getElementById(
      'bookReasonInput'
    );

  const reason =
    reasonEl
      ? reasonEl.value.trim()
      : '';

  if (reason.length > 500) {
    showToast(
      'เหตุผลการลาต้องไม่เกิน 500 ตัวอักษร',
      'warning'
    );
    return;
  }

  const clientRequestId =
    'req_' +
    Date.now() +
    '_' +
    Math.random()
      .toString(36)
      .slice(2, 8);

  try {
    /*
     * Backend createLeave_ must validate AGAIN under LockService.
     * The pre-validation above is UX only.
     */
    const res =
      await callApi(
        'apiCreateLeave',
        {
          startDate: start,
          endDate: end,
          reason: reason,
          clientRequestId:
            clientRequestId
        }
      );

    rememberCalendarRevision(
      res.revision
    );

    showToast(
      res.message ||
      'บันทึกการลางานสำเร็จ',
      'success'
    );

    closeModal(
      'modalBookingConfirm'
    );

    clearSelection();

    Object
      .keys(clientCalendarCache)
      .forEach(key => {
        delete clientCalendarCache[key];
      });

    await loadCalendar(true);

    if (
      AppState.currentView ===
      'my-leaves'
    ) {
      await loadMyLeaves();
    }

  } catch (err) {
    const validation =
      getValidationObjectFromError(
        err
      );

    if (validation) {
      showLeaveValidationError(
        validation,
        err.message
      );
      return;
    }

    if (
      window.Swal &&
      (
        String(err.message)
          .includes('เกินโควต้า') ||
        String(err.message)
          .includes('5 วัน') ||
        String(err.message)
          .includes('เต็ม')
      )
    ) {
      Swal.fire({
        title:
          'ไม่สามารถจองวันลาได้',
        text:
          err.message,
        icon: 'warning',
        background:
          '#1e293b',
        color:
          '#f8fafc',
        confirmButtonColor:
          '#3b82f6',
        confirmButtonText:
          'ตกลง'
      });

    } else {
      showToast(
        err.message ||
        'ไม่สามารถบันทึกวันลาได้',
        'error'
      );
    }
  }
}



/* =========================================================
 * ADMIN CALENDAR MANAGEMENT
 * ========================================================= */

async function openAdminCalendarDay(dateStr) {
  if (!isAdminUser()) {
    showToast(
      'เฉพาะ Admin เท่านั้นที่สามารถจัดการรายการลาจาก Calendar ได้',
      'error'
    );
    return;
  }

  try {
    const res = await callApi(
      'apiAdminGetDayLeaveDetails',
      {
        date: dateStr
      }
    );

    rememberCalendarRevision(
      res.revision
    );

    const items = Array.isArray(res.data)
      ? res.data
      : [];

    showAdminCalendarDayDialog(
      dateStr,
      items,
      {
        bookedCount: Number(res.bookedCount || items.length),
        limit: Number(res.limit || 0),
        exceededBy: Number(res.exceededBy || 0)
      }
    );

  } catch (err) {
    showToast(
      err.message ||
      'ไม่สามารถโหลดรายละเอียดวันลาได้',
      'error'
    );
  }
}


function showAdminCalendarDayDialog(
  dateStr,
  items,
  summary
) {
  if (!window.Swal) {
    showToast(
      `วันที่ ${dateStr} มีรายการลา ${items.length} รายการ`,
      'info'
    );
    return;
  }

  const itemMap = {};

  items.forEach(item => {
    itemMap[String(item.requestId)] = item;
  });

  const overbookHtml =
    summary.exceededBy > 0
      ? `
        <div style="margin-bottom:0.9rem; padding:0.75rem; border-radius:8px; background:rgba(239,68,68,0.12); color:#fecaca; text-align:left;">
          ⚠️ วันที่นี้เกินจำนวนที่กำหนด
          <strong>${summary.bookedCount}/${summary.limit} คน</strong>
          (เกิน ${summary.exceededBy} คน)
        </div>
      `
      : `
        <div style="margin-bottom:0.9rem; color:#cbd5e1; text-align:left;">
          จำนวนผู้ลา: <strong>${summary.bookedCount}/${summary.limit} คน</strong>
        </div>
      `;

  const rowsHtml = items.length > 0
    ? items.map(item => {
        const requestId = escapeHtml(item.requestId);
        const staffId = escapeHtml(item.staffId || '-');
        const fullName = escapeHtml(item.fullName || '-');
        const startDate = escapeHtml(item.startDate || '-');
        const endDate = escapeHtml(item.endDate || '-');
        const reason = escapeHtml(item.reason || '-');
        const createdAt = escapeHtml(item.createdAt || '-');

        return `
          <div style="padding:0.85rem; margin-bottom:0.7rem; border:1px solid rgba(148,163,184,0.25); border-radius:10px; text-align:left; background:rgba(15,23,42,0.45);">
            <div style="font-weight:700; color:#f8fafc; margin-bottom:0.35rem;">
              ${staffId} — ${fullName}
            </div>
            <div style="font-size:0.88rem; color:#cbd5e1; line-height:1.55;">
              ช่วงลา: <strong>${startDate}</strong> ถึง <strong>${endDate}</strong><br>
              เหตุผล: ${reason}<br>
              สร้างเมื่อ: ${createdAt}
            </div>
            <div style="display:flex; gap:0.5rem; margin-top:0.7rem; flex-wrap:wrap;">
              <button type="button" class="btn btn-primary btn-sm admin-edit-leave-btn" data-request-id="${requestId}">
                ✏️ แก้ไข
              </button>
              <button type="button" class="btn btn-danger btn-sm admin-cancel-leave-btn" data-request-id="${requestId}">
                🗑 ยกเลิก
              </button>
            </div>
          </div>
        `;
      }).join('')
    : `
      <div style="padding:1rem; color:#94a3b8;">
        ไม่พบรายการลา ACTIVE ในวันที่นี้
      </div>
    `;

  Swal.fire({
    title: `จัดการวันลา ${dateStr}`,
    html: `
      <div style="font-family:'Prompt',sans-serif;">
        ${overbookHtml}
        <div style="max-height:55vh; overflow-y:auto; padding-right:0.25rem;">
          ${rowsHtml}
        </div>
      </div>
    `,
    width: 720,
    background: '#1e293b',
    color: '#f8fafc',
    confirmButtonColor: '#64748b',
    confirmButtonText: 'ปิด',
    didOpen: popup => {
      popup
        .querySelectorAll('.admin-edit-leave-btn')
        .forEach(button => {
          button.addEventListener('click', () => {
            const requestId = String(
              button.dataset.requestId || ''
            );

            const item = itemMap[requestId];

            if (!item) {
              return;
            }

            Swal.close();
            void openAdminEditLeave(
              item,
              dateStr
            );
          });
        });

      popup
        .querySelectorAll('.admin-cancel-leave-btn')
        .forEach(button => {
          button.addEventListener('click', () => {
            const requestId = String(
              button.dataset.requestId || ''
            );

            const item = itemMap[requestId];

            if (!item) {
              return;
            }

            Swal.close();
            void adminCancelLeaveFromCalendar(
              item,
              dateStr
            );
          });
        });
    }
  });
}


async function openAdminEditLeave(
  item,
  sourceDate
) {
  if (!window.Swal) {
    showToast(
      'ต้องใช้ SweetAlert2 สำหรับหน้าจอแก้ไขรายการลา',
      'error'
    );
    return;
  }

  const result = await Swal.fire({
    title: 'Admin แก้ไขรายการลา',
    html: `
      <div style="text-align:left; font-family:'Prompt',sans-serif;">
        <div style="margin-bottom:0.8rem; color:#cbd5e1;">
          <strong>${escapeHtml(item.staffId || '-')}</strong>
          — ${escapeHtml(item.fullName || '-')}
        </div>

        <label style="display:block; margin:0.55rem 0 0.25rem;">วันที่เริ่มลา</label>
        <input id="adminEditLeaveStart" type="date" class="swal2-input" value="${escapeHtml(item.startDate || '')}" style="width:100%; margin:0;">

        <label style="display:block; margin:0.75rem 0 0.25rem;">วันที่สิ้นสุด</label>
        <input id="adminEditLeaveEnd" type="date" class="swal2-input" value="${escapeHtml(item.endDate || '')}" style="width:100%; margin:0;">

        <label style="display:block; margin:0.75rem 0 0.25rem;">เหตุผลการลา</label>
        <textarea id="adminEditLeaveReason" class="swal2-textarea" maxlength="500" style="width:100%; margin:0; min-height:90px;">${escapeHtml(item.reason || '')}</textarea>

        <div style="margin-top:0.75rem; font-size:0.82rem; color:#94a3b8; line-height:1.5;">
          การเปลี่ยนช่วงวันที่จะถูกตรวจ Daily Cap, Wednesday Cap,
          Monthly Quota, Duplicate และ Consecutive Days ใหม่ทั้งหมด
        </div>
      </div>
    `,
    background: '#1e293b',
    color: '#f8fafc',
    showCancelButton: true,
    confirmButtonColor: '#3b82f6',
    cancelButtonColor: '#64748b',
    confirmButtonText: 'บันทึกการแก้ไข',
    cancelButtonText: 'ยกเลิก',
    focusConfirm: false,
    preConfirm: () => {
      const startDate = String(
        document.getElementById('adminEditLeaveStart').value || ''
      );

      const endDate = String(
        document.getElementById('adminEditLeaveEnd').value || ''
      );

      const reason = String(
        document.getElementById('adminEditLeaveReason').value || ''
      ).trim();

      if (!isYmd(startDate) || !isYmd(endDate)) {
        Swal.showValidationMessage(
          'กรุณาระบุวันที่ให้ครบถ้วน'
        );
        return false;
      }

      if (endDate < startDate) {
        Swal.showValidationMessage(
          'วันที่สิ้นสุดต้องไม่น้อยกว่าวันที่เริ่มต้น'
        );
        return false;
      }

      if (reason.length > 500) {
        Swal.showValidationMessage(
          'เหตุผลการลาต้องไม่เกิน 500 ตัวอักษร'
        );
        return false;
      }

      return {
        startDate,
        endDate,
        reason
      };
    }
  });

  if (!result.isConfirmed || !result.value) {
    return;
  }

  try {
    const res = await callApi(
      'apiAdminUpdateLeave',
      {
        requestId: item.requestId,
        startDate: result.value.startDate,
        endDate: result.value.endDate,
        reason: result.value.reason
      }
    );

    rememberCalendarRevision(
      res.revision
    );

    clearCalendarClientCache();
    await refreshCurrentCalendarSilently();

    showToast(
      res.message ||
      'แก้ไขรายการลาเรียบร้อยแล้ว',
      'success'
    );

  } catch (err) {
    const validation =
      getValidationObjectFromError(err);

    if (validation) {
      showLeaveValidationError(
        validation,
        err.message
      );
      return;
    }

    showToast(
      err.message ||
      'ไม่สามารถแก้ไขรายการลาได้',
      'error'
    );
  }
}


async function adminCancelLeaveFromCalendar(
  item,
  sourceDate
) {
  let confirmed = true;

  if (window.Swal) {
    const result = await Swal.fire({
      title: 'Admin ยืนยันยกเลิกรายการลา?',
      html: `
        <div style="font-family:'Prompt',sans-serif; line-height:1.6;">
          <strong>${escapeHtml(item.staffId || '-')}</strong>
          — ${escapeHtml(item.fullName || '-')}<br>
          ช่วงลา ${escapeHtml(item.startDate || '-')} ถึง ${escapeHtml(item.endDate || '-')}
        </div>
      `,
      icon: 'warning',
      background: '#1e293b',
      color: '#f8fafc',
      showCancelButton: true,
      confirmButtonColor: '#ef4444',
      cancelButtonColor: '#64748b',
      confirmButtonText: 'ยืนยันยกเลิก',
      cancelButtonText: 'ไม่ยกเลิก'
    });

    confirmed = result.isConfirmed;
  } else {
    confirmed = window.confirm(
      `ยืนยันยกเลิกรายการลาของ ${item.fullName || item.staffId || ''}?`
    );
  }

  if (!confirmed) {
    return;
  }

  try {
    const res = await callApi(
      'apiAdminCancelLeave',
      {
        requestId: item.requestId
      }
    );

    rememberCalendarRevision(
      res.revision
    );

    clearCalendarClientCache();
    await refreshCurrentCalendarSilently();

    showToast(
      res.message ||
      'ยกเลิกรายการลาเรียบร้อยแล้ว',
      'success'
    );

  } catch (err) {
    showToast(
      err.message ||
      'ไม่สามารถยกเลิกรายการลาได้',
      'error'
    );
  }
}


/* =========================================================
 * MY LEAVES
 * ========================================================= */

async function loadMyLeaves() {
  const tableBody =
    document.getElementById(
      'myLeavesTableBody'
    );

  if (!tableBody) {
    return;
  }

  try {
    const res =
      await callApi(
        'apiGetMyLeaves'
      );

    const requests =
      Array.isArray(res.data)
        ? res.data
        : [];

    clearElement(
      tableBody
    );

    if (
      requests.length === 0
    ) {
      const tr =
        document.createElement(
          'tr'
        );

      const td =
        document.createElement(
          'td'
        );

      td.colSpan = 7;
      td.style.textAlign =
        'center';

      td.style.color =
        'var(--text-muted)';

      td.textContent =
        'ยังไม่มีประวัติการลางาน';

      tr.appendChild(td);
      tableBody.appendChild(tr);

      return;
    }

    const today =
      getTodayYMD();

    requests.forEach(record => {
      const tr =
        document.createElement(
          'tr'
        );

      const status =
        String(
          record.status || ''
        )
          .trim()
          .toUpperCase();

      const isCancelled =
        status === 'CANCELLED';

      const startDate =
        normalizeFrontendYmd(
          record.start_date ||
          record.startDate
        );

      const endDate =
        normalizeFrontendYmd(
          record.end_date ||
          record.endDate
        );

      const totalDays =
        record.total_days !==
        undefined
          ? record.total_days
          : record.totalDays;

      const createdAt =
        record.created_at ||
        record.createdAt ||
        '';

      tr.appendChild(
        createCell(
          startDate
        )
      );

      tr.appendChild(
        createCell(
          endDate
        )
      );

      const totalTd =
        document.createElement(
          'td'
        );

      const strong =
        document.createElement(
          'strong'
        );

      strong.textContent =
        `${totalDays || 0} วัน`;

      totalTd.appendChild(
        strong
      );

      tr.appendChild(
        totalTd
      );

      tr.appendChild(
        createCell(
          record.reason || '-'
        )
      );

      const statusTd =
        document.createElement(
          'td'
        );

      if (isCancelled) {
        statusTd.appendChild(
          createBadge(
            'ยกเลิกแล้ว',
            'role-tag',
            'background:rgba(239,68,68,0.2); color:#fca5a5;'
          )
        );

      } else {
        statusTd.appendChild(
          createBadge(
            'อนุมัติ/ใช้งาน',
            'role-tag',
            'background:rgba(16,185,129,0.2); color:#6ee7b7;'
          )
        );
      }

      tr.appendChild(
        statusTd
      );

      tr.appendChild(
        createCell(
          createdAt
        )
      );

      const actionTd =
        document.createElement(
          'td'
        );

      const backendCanCancel =
        record.can_cancel !==
        undefined
          ? Boolean(
              record.can_cancel
            )
          : record.canCancel !==
            undefined
            ? Boolean(
                record.canCancel
              )
            : null;

      const legacyCanCancel =
        !isCancelled &&
        isYmd(startDate) &&
        startDate > today;

      const canCancel =
        backendCanCancel === null
          ? legacyCanCancel
          : (
              !isCancelled &&
              backendCanCancel
            );

      if (canCancel) {
        const btn =
          document.createElement(
            'button'
          );

        btn.className =
          'btn btn-danger btn-sm';

        btn.textContent =
          'ยกเลิกการลา';

        btn.addEventListener(
          'click',
          () => {
            void cancelLeave(
              record.id
            );
          }
        );

        actionTd.appendChild(
          btn
        );

      } else {
        actionTd.textContent =
          '-';
      }

      tr.appendChild(
        actionTd
      );

      tableBody.appendChild(
        tr
      );
    });

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}


async function cancelLeave(
  requestId
) {
  if (window.Swal) {
    const result =
      await Swal.fire({
        title:
          'ยืนยันการยกเลิก?',
        text:
          'คุณแน่ใจหรือไม่ว่าต้องการยกเลิกรายการลานี้',
        icon:
          'warning',
        background:
          '#1e293b',
        color:
          '#f8fafc',
        showCancelButton:
          true,
        confirmButtonColor:
          '#ef4444',
        cancelButtonColor:
          '#64748b',
        confirmButtonText:
          'ยืนยันยกเลิก',
        cancelButtonText:
          'ถอยกลับ'
      });

    if (!result.isConfirmed) {
      return;
    }

  } else if (
    !confirm(
      'คุณแน่ใจหรือไม่ว่าต้องการยกเลิกรายการลานี้?'
    )
  ) {
    return;
  }

  try {
    const res =
      await callApi(
        'apiCancelLeave',
        {
          requestId:
            requestId
        }
      );

    rememberCalendarRevision(
      res.revision
    );

    showToast(
      res.message ||
      'ยกเลิกการลาเรียบร้อยแล้ว',
      'success'
    );

    Object
      .keys(clientCalendarCache)
      .forEach(key => {
        delete clientCalendarCache[key];
      });

    await loadMyLeaves();

    if (
      AppState.currentView ===
      'calendar'
    ) {
      await loadCalendar(true);
    }

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}


/* =========================================================
 * ADMIN DASHBOARD
 * ========================================================= */

function loadAdminDashboard() {
  const role =
    String(
      AppState.user &&
      AppState.user.role
        ? AppState.user.role
        : ''
    )
      .trim()
      .toUpperCase();

  if (role !== 'ADMIN') {
    return;
  }

  void loadStaffList();
  void loadAuditLogs();
}


async function loadStaffList() {
  const tbody =
    document.getElementById(
      'adminStaffTableBody'
    );

  if (!tbody) {
    return;
  }

  try {
    const res =
      await callApi(
        'apiGetStaffList'
      );

    const users =
      Array.isArray(res.data)
        ? res.data
        : [];

    clearElement(tbody);

    users.forEach(user => {
      const tr =
        document.createElement(
          'tr'
        );

      const id =
        String(
          user.id || ''
        );

      const staffId =
        String(
          user.staff_id ||
          user.staffId ||
          ''
        );

      const fullName =
        String(
          user.full_name ||
          user.fullName ||
          ''
        );

      const role =
        String(
          user.role ||
          'PHARMACIST'
        )
          .trim()
          .toUpperCase();

      const status =
        String(
          user.status ||
          'ACTIVE'
        )
          .trim()
          .toUpperCase();

      const failed =
        Number(
          user.failed_login_attempts ||
          user.failedLoginAttempts ||
          0
        );

      const staffTd =
        document.createElement(
          'td'
        );

      const staffStrong =
        document.createElement(
          'strong'
        );

      staffStrong.textContent =
        staffId;

      staffTd.appendChild(
        staffStrong
      );

      tr.appendChild(
        staffTd
      );

      tr.appendChild(
        createCell(
          fullName
        )
      );

      const roleTd =
        document.createElement(
          'td'
        );

      roleTd.appendChild(
        createBadge(
          role,
          `role-tag role-${role.toLowerCase()}`
        )
      );

      tr.appendChild(
        roleTd
      );

      const statusTd =
        document.createElement(
          'td'
        );

      if (
        status === 'LOCKED'
      ) {
        statusTd.appendChild(
          createBadge(
            'ถูกล็อค (LOCKED - ผิด 5 ครั้ง)',
            'role-tag',
            'background:rgba(239,68,68,0.2); color:#fca5a5;'
          )
        );

      } else if (
        status === 'INACTIVE' ||
        status === 'DISABLED'
      ) {
        statusTd.appendChild(
          createBadge(
            'ปิดใช้งาน (INACTIVE)',
            'role-tag',
            'background:rgba(148,163,184,0.2); color:#cbd5e1;'
          )
        );

      } else {
        statusTd.appendChild(
          createBadge(
            'เปิดใช้งาน (ACTIVE)',
            'role-tag',
            'background:rgba(16,185,129,0.2); color:#6ee7b7;'
          )
        );
      }

      tr.appendChild(
        statusTd
      );

      tr.appendChild(
        createCell(
          `${failed} / 5`
        )
      );

      const actionTd =
        document.createElement(
          'td'
        );

      actionTd.style.display =
        'flex';

      actionTd.style.gap =
        '0.4rem';

      actionTd.style.flexWrap =
        'wrap';

      const currentUserId =
        String(
          AppState.user &&
          AppState.user.id
            ? AppState.user.id
            : ''
        );

      const isSelf =
        id === currentUserId;

      if (isSelf) {
        const selfLabel =
          document.createElement(
            'span'
          );

        selfLabel.style.color =
          'var(--text-muted)';

        selfLabel.style.fontSize =
          '0.8rem';

        selfLabel.textContent =
          '(บัญชีตนเอง)';

        actionTd.appendChild(
          selfLabel
        );

      } else {
        const toggleBtn =
          document.createElement(
            'button'
          );

        toggleBtn.className =
          status === 'ACTIVE'
            ? 'btn btn-danger btn-sm'
            : 'btn btn-secondary btn-sm';

        if (
          status === 'ACTIVE'
        ) {
          toggleBtn.textContent =
            'ปิดบัญชี';

          toggleBtn.addEventListener(
            'click',
            () => {
              void handleToggleUserStatus(
                id,
                'INACTIVE'
              );
            }
          );

        } else {
          toggleBtn.textContent =
            'ปลดล็อค/เปิดบัญชี';

          toggleBtn.addEventListener(
            'click',
            () => {
              void handleToggleUserStatus(
                id,
                'ACTIVE'
              );
            }
          );
        }

        actionTd.appendChild(
          toggleBtn
        );
      }

      const resetBtn =
        document.createElement(
          'button'
        );

      resetBtn.className =
        'btn btn-secondary btn-sm';

      resetBtn.textContent =
        'รีเซ็ตรหัสผ่าน';

      resetBtn.addEventListener(
        'click',
        () => {
          openResetPasswordModal(
            id,
            fullName
          );
        }
      );

      actionTd.appendChild(
        resetBtn
      );

      tr.appendChild(
        actionTd
      );

      tbody.appendChild(
        tr
      );
    });

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}


async function handleToggleUserStatus(
  targetUserId,
  newStatus
) {
  const normalizedStatus =
    String(newStatus || '')
      .trim()
      .toUpperCase();

  if (
    normalizedStatus ===
    'INACTIVE'
  ) {
    const confirmed =
      window.confirm(
        'คุณแน่ใจหรือไม่ว่าต้องการปิดใช้งานบัญชีผู้ใช้ท่านนี้?'
      );

    if (!confirmed) {
      return;
    }
  }

  try {
    const res =
      await callApi(
        'apiToggleUserStatus',
        {
          targetUserId:
            targetUserId,
          newStatus:
            normalizedStatus
        }
      );

    showToast(
      res.message ||
      'อัปเดตสถานะเรียบร้อยแล้ว',
      'success'
    );

    await loadStaffList();

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}


function openAddStaffModal() {
  document
    .getElementById(
      'addStaffId'
    )
    .value = '';

  document
    .getElementById(
      'addFullName'
    )
    .value = '';

  document
    .getElementById(
      'addRole'
    )
    .value =
      'PHARMACIST';

  document
    .getElementById(
      'addPassword'
    )
    .value = '';

  openModal(
    'modalAddStaff'
  );
}


async function submitAddStaff() {
  const staffId =
    document
      .getElementById(
        'addStaffId'
      )
      .value
      .trim();

  const fullName =
    document
      .getElementById(
        'addFullName'
      )
      .value
      .trim();

  const role =
    document
      .getElementById(
        'addRole'
      )
      .value;

  const password =
    document
      .getElementById(
        'addPassword'
      )
      .value
      .trim();

  if (
    !staffId ||
    !fullName ||
    !password
  ) {
    showToast(
      'กรุณากรอกข้อมูลให้ครบถ้วน',
      'warning'
    );
    return;
  }

  try {
    const res =
      await callApi(
        'apiCreateStaff',
        {
          staffId,
          fullName,
          role,
          password
        }
      );

    showToast(
      res.message ||
      'เพิ่มบุคลากรเรียบร้อยแล้ว',
      'success'
    );

    closeModal(
      'modalAddStaff'
    );

    await loadStaffList();

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}


function openResetPasswordModal(
  userId,
  fullName
) {
  selectedTargetUserId =
    userId;

  const targetName =
    document.getElementById(
      'resetTargetName'
    );

  const input =
    document.getElementById(
      'resetNewPassword'
    );

  if (targetName) {
    targetName.textContent =
      String(fullName || '');
  }

  if (input) {
    input.value = '';
  }

  openModal(
    'modalResetPassword'
  );
}


async function submitResetPassword() {
  // Capture the target once so a later modal state change cannot redirect the request.
  const targetUserId =
    String(
      selectedTargetUserId || ''
    ).trim();

  if (!targetUserId) {
    showToast(
      'ไม่พบผู้ใช้ที่ต้องการรีเซ็ตรหัสผ่าน กรุณาเลือกผู้ใช้อีกครั้ง',
      'error'
    );
    return;
  }

  const input =
    document.getElementById(
      'resetNewPassword'
    );

  const newPassword =
    input
      ? input.value.trim()
      : '';

  if (
    !newPassword ||
    newPassword.length < 6
  ) {
    showToast(
      'รหัสผ่านต้องมีความยาวอย่างน้อย 6 ตัวอักษร',
      'warning'
    );
    return;
  }

  try {
    const res =
      await callApi(
        'apiResetUserPassword',
        {
          targetUserId:
            targetUserId,
          newPassword:
            newPassword
        }
      );

    // Clear state before any later UI work.
    selectedTargetUserId = null;

    showToast(
      res.message ||
      'รีเซ็ตรหัสผ่านสำเร็จ',
      'success'
    );

    closeModal(
      'modalResetPassword'
    );

    await loadStaffList();

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}


async function loadAuditLogs() {
  const tbody =
    document.getElementById(
      'adminAuditTableBody'
    );

  if (!tbody) {
    return;
  }

  try {
    const res =
      await callApi(
        'apiGetAuditLogs'
      );

    const logs =
      Array.isArray(res.data)
        ? res.data
        : [];

    clearElement(tbody);

    if (
      logs.length === 0
    ) {
      const tr =
        document.createElement(
          'tr'
        );

      const td =
        document.createElement(
          'td'
        );

      td.colSpan = 5;

      td.style.textAlign =
        'center';

      td.style.color =
        'var(--text-muted)';

      td.textContent =
        'ยังไม่มีประวัติ Audit Log';

      tr.appendChild(td);
      tbody.appendChild(tr);

      return;
    }

    logs.forEach(log => {
      const tr =
        document.createElement(
          'tr'
        );

      const timeTd =
        createCell(
          log.timestamp || ''
        );

      timeTd.style.fontSize =
        '0.8rem';

      timeTd.style.color =
        'var(--text-muted)';

      tr.appendChild(
        timeTd
      );

      tr.appendChild(
        createCell(
          log.user_name ||
          log.userName ||
          ''
        )
      );

      const actionTd =
        document.createElement(
          'td'
        );

      actionTd.appendChild(
        createBadge(
          log.action || '',
          'role-tag',
          'background:rgba(59,130,246,0.15); color:#93c5fd;'
        )
      );

      tr.appendChild(
        actionTd
      );

      const detailsTd =
        createCell(
          log.details || ''
        );

      detailsTd.style.fontSize =
        '0.85rem';

      tr.appendChild(
        detailsTd
      );

      const sourceTd =
        createCell(
          log.ip_address ||
          log.ipAddress ||
          ''
        );

      sourceTd.style.fontSize =
        '0.8rem';

      sourceTd.style.color =
        'var(--text-muted)';

      tr.appendChild(
        sourceTd
      );

      tbody.appendChild(
        tr
      );
    });

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}


/* =========================================================
 * EXPORT
 * ========================================================= */

async function exportLeaveCSV() {
  try {
    const res =
      await callApi(
        'apiExportLeaveReportCSV'
      );

    triggerCSVDownload(
      res.csvData,
      `leave_report_${getTodayYMD()}.csv`
    );

    showToast(
      'ดาวน์โหลดรายงานการลางาน (CSV UTF-8 BOM) เรียบร้อยแล้ว',
      'success'
    );

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}


async function exportAuditLogsCSV() {
  try {
    const res =
      await callApi(
        'apiExportAuditLogsCSV'
      );

    triggerCSVDownload(
      res.csvData,
      `audit_logs_${getTodayYMD()}.csv`
    );

    showToast(
      'ดาวน์โหลด Audit Logs (CSV UTF-8 BOM) เรียบร้อยแล้ว',
      'success'
    );

  } catch (err) {
    showToast(
      err.message,
      'error'
    );
  }
}


function triggerCSVDownload(
  csvContent,
  filename
) {
  const blob =
    new Blob(
      [
        '\uFEFF' +
        String(
          csvContent || ''
        )
      ],
      {
        type:
          'text/csv;charset=utf-8;'
      }
    );

  const url =
    URL.createObjectURL(
      blob
    );

  const link =
    document.createElement(
      'a'
    );

  link.href =
    url;

  link.download =
    filename;

  link.style.visibility =
    'hidden';

  document.body.appendChild(
    link
  );

  link.click();
  link.remove();

  setTimeout(
    () => {
      URL.revokeObjectURL(
        url
      );
    },
    0
  );
}


/* =========================================================
 * VALIDATION TEST UI
 * ========================================================= */

async function runValidationTestsFromUI() {
  const box =
    document.getElementById(
      'testResultsBox'
    );

  if (!box) {
    return;
  }

  box.style.display =
    'block';

  box.innerHTML =
    '<div style="padding:1rem;">⏳ กำลังทดสอบกฎ Validation ทั้งหมด...</div>';

  try {
    const res =
      await callApi(
        'apiRunValidationTests'
      );

    const report =
      res.report || {
        passed: 0,
        total: 0,
        failed: 0,
        details: []
      };

    const details =
      Array.isArray(
        report.details
      )
        ? report.details
        : [];

    let html =
      `<div style="font-weight:700; margin-bottom:0.75rem; font-size:1.1rem;">
        ผลการทดสอบ: ${Number(report.passed || 0)}/${Number(report.total || 0)} ผ่าน (${Number(report.failed || 0)} ล้มเหลว)
      </div>`;

    details.forEach(item => {
      const color =
        item.passed
          ? 'var(--success)'
          : 'var(--danger)';

      const icon =
        item.passed
          ? '✅ [PASS]'
          : '❌ [FAIL]';

      html += `
        <div style="padding:0.5rem; margin-bottom:0.4rem; border-radius:6px; background:rgba(15,23,42,0.6); border-left:4px solid ${color};">
          <strong>${icon} ${escapeHtml(item.name || '')}</strong>
          <div style="font-size:0.85rem; color:var(--text-muted); margin-top:0.2rem;">
            ${escapeHtml(item.message || '')}
          </div>
        </div>
      `;
    });

    box.innerHTML =
      html;

  } catch (err) {
    box.innerHTML =
      `<div style="color:var(--danger); padding:1rem;">เกิดข้อผิดพลาด: ${escapeHtml(err.message)}</div>`;
  }
}


/* =========================================================
 * START APPLICATION
 * ========================================================= */

document.addEventListener(
  'visibilitychange',
  () => {
    if (shouldCheckCalendarSync()) {
      void checkCalendarRevisionAndRefresh();
    }
  }
);

window.addEventListener(
  'focus',
  () => {
    if (shouldCheckCalendarSync()) {
      void checkCalendarRevisionAndRefresh();
    }
  }
);


/*
 * Robust application boot:
 * - Normal script: waits for DOMContentLoaded.
 * - async/dynamically injected script loaded after DOMContentLoaded:
 *   starts immediately.
 * - once/idempotent guard prevents double initialization.
 */
let applicationBootStarted = false;

function bootApplication() {
  if (applicationBootStarted) {
    return;
  }

  applicationBootStarted = true;
  void initApp();
}

if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    bootApplication,
    { once: true }
  );
} else {
  bootApplication();
}
