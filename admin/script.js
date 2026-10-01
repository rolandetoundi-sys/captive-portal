const numberFormat = new Intl.NumberFormat('fr-FR');
const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const dateTimeFormat = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const elements = {
  notice: document.querySelector('#notice'),
  chart: document.querySelector('#chart'),
  usersBody: document.querySelector('#users-body'),
  usersCount: document.querySelector('#users-count'),
  emptyState: document.querySelector('#empty-state'),
  pageLabel: document.querySelector('#page-label'),
  previousPage: document.querySelector('#previous-page'),
  nextPage: document.querySelector('#next-page'),
};
const exportDialog = document.querySelector('#export-dialog');
const exportForm = document.querySelector('#export-form');
const exportStart = document.querySelector('#export-start');
const exportEnd = document.querySelector('#export-end');
const logoutButton = document.querySelector('#logout-button');
let selectedPeriod = 30;
let currentPage = 1;
let totalUsers = 0;
let currentQuery = '';

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(response.status === 401 ? 'Authentification requise.' : 'Une erreur est survenue.');
  return response.json();
}

function showError(message) {
  elements.notice.textContent = message;
  elements.notice.hidden = false;
}

function hideError() {
  elements.notice.hidden = true;
  elements.notice.textContent = '';
}

function dateKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function renderChart(daily) {
  const byDay = new Map(daily.map((row) => [row.day, row]));
  const start = new Date();
  start.setUTCHours(12, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - selectedPeriod + 1);
  const values = Array.from({ length: selectedPeriod }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    return { date, ...(byDay.get(dateKey(date)) || { visits: 0, visitors: 0 }) };
  });
  const max = Math.max(1, ...values.map((row) => Math.max(row.visits, row.visitors)));
  elements.chart.replaceChildren();
  elements.chart.style.gridTemplateColumns = `repeat(${selectedPeriod}, minmax(2px, 1fr))`;
  elements.chart.setAttribute('aria-label', `Activité quotidienne sur ${selectedPeriod} jours`);

  values.forEach((row, index) => {
    const column = document.createElement('div');
    column.className = 'chart-column';
    column.title = `${dateFormat.format(row.date)} : ${row.visits} visite(s), ${row.visitors} visiteur(s)`;
    column.setAttribute('aria-hidden', 'true');
    for (const [kind, value] of [['visits', row.visits], ['visitors', row.visitors]]) {
      const bar = document.createElement('span');
      bar.className = `chart-bar chart-bar-${kind}`;
      bar.style.height = `${Math.max(value ? 2 : 0, (value / max) * 100)}%`;
      column.append(bar);
    }
    if (index === 0 || index === values.length - 1 || index % Math.ceil(selectedPeriod / 6) === 0) {
      const label = document.createElement('span');
      label.className = 'chart-label';
      label.textContent = String(row.date.getUTCDate()).padStart(2, '0');
      column.append(label);
    }
    elements.chart.append(column);
  });
}

async function loadSummary() {
  try {
    const data = await getJson(`/api/admin/summary?days=${selectedPeriod}`);
    document.querySelector('#metric-users').textContent = numberFormat.format(data.summary.userCount);
    document.querySelector('#metric-visits').textContent = numberFormat.format(data.summary.visitCount);
    document.querySelector('#metric-today').textContent = numberFormat.format(data.summary.todayVisitCount);
    renderChart(data.daily);
    hideError();
  } catch (error) {
    showError(error.message);
  }
}

function formatDate(value, formatter) {
  if (!value) return '—';
  const date = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? '—' : formatter.format(date);
}

async function loadUsers() {
  try {
    const params = new URLSearchParams({ page: String(currentPage), q: currentQuery });
    const data = await getJson(`/api/admin/users?${params}`);
    totalUsers = data.total;
    elements.usersBody.replaceChildren();
    for (const guest of data.guests) {
      const row = document.createElement('tr');
      const values = [
        ['name', guest.name || '—'],
        ['phone', guest.phone || '—'],
        ['email', guest.email || '—'],
        ['mac-cell', guest.last_mac || '—'],
        ['', numberFormat.format(guest.visit_count)],
        ['', formatDate(guest.last_seen_at, dateTimeFormat)],
      ];
      for (const [className, value] of values) {
        const cell = document.createElement('td');
        cell.textContent = value;
        if (className) cell.className = className;
        row.append(cell);
      }
      elements.usersBody.append(row);
    }
    elements.emptyState.hidden = data.guests.length !== 0;
    elements.usersCount.textContent = `${numberFormat.format(data.total)} utilisateur${data.total > 1 ? 's' : ''}`;
    const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));
    elements.pageLabel.textContent = `Page ${data.page} sur ${pageCount}`;
    elements.previousPage.disabled = data.page <= 1;
    elements.nextPage.disabled = data.page >= pageCount;
    hideError();
  } catch (error) {
    showError(error.message);
    elements.usersCount.textContent = 'Liste indisponible';
  }
}

document.querySelector('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  currentQuery = document.querySelector('#search-input').value.trim();
  currentPage = 1;
  loadUsers();
});

document.querySelectorAll('[data-period]').forEach((button) => {
  button.addEventListener('click', () => {
    selectedPeriod = Number(button.dataset.period);
    document.querySelectorAll('[data-period]').forEach((periodButton) => {
      periodButton.setAttribute('aria-pressed', String(periodButton === button));
    });
    loadSummary();
  });
});

elements.previousPage.addEventListener('click', () => {
  if (currentPage > 1) {
    currentPage -= 1;
    loadUsers();
  }
});

elements.nextPage.addEventListener('click', () => {
  if (currentPage * 50 < totalUsers) {
    currentPage += 1;
    loadUsers();
  }
});

document.querySelector('#export-open').addEventListener('click', () => {
  const today = new Date().toISOString().slice(0, 10);
  exportStart.value = `${today.slice(0, 7)}-01`;
  exportEnd.value = today;
  exportEnd.setCustomValidity('');
  exportDialog.showModal();
});

document.querySelector('#export-cancel').addEventListener('click', () => exportDialog.close());

exportForm.addEventListener('submit', (event) => {
  event.preventDefault();
  exportEnd.setCustomValidity('');
  if (exportStart.value > exportEnd.value) {
    exportEnd.setCustomValidity('La date de fin doit être postérieure ou égale à la date de début.');
    exportEnd.reportValidity();
    return;
  }

  const params = new URLSearchParams({ from: exportStart.value, to: exportEnd.value });
  exportDialog.close();
  window.location.assign(`/api/admin/export.xlsx?${params}`);
});

logoutButton.addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.assign('/admin/login');
});

loadSummary();
loadUsers();
