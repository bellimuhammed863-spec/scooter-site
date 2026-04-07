const API = '';
let scooters = {};
let fence = null;
let map = null;
let markers = {};
let fenceCircle = null;
let ws = null;

// ====== MAP INIT ======
function initMap() {
  map = L.map('map', {
    center: [41.0082, 28.9784],
    zoom: 16,
    zoomControl: true,
  });

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap © CARTO',
    maxZoom: 20,
  }).addTo(map);

  map.on('contextmenu', (e) => {
    if (confirm(`Park merkezi buraya taşınsın mı?\n${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`)) {
      updateGeofenceCenter(e.latlng.lat, e.latlng.lng);
    }
  });
}

function drawFence(f) {
  if (fenceCircle) map.removeLayer(fenceCircle);
  fenceCircle = L.circle([f.lat, f.lng], {
    radius: f.radius,
    color: '#6c63ff',
    fillColor: '#6c63ff',
    fillOpacity: 0.07,
    weight: 2,
    dashArray: '6,4',
  }).addTo(map);

  fenceCircle.bindPopup(`
    <div style="font-size:13px;padding:4px">
      <strong>🗺️ Park Sınırı</strong><br>
      Merkez: ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}<br>
      Yarıçap: ${f.radius}m
    </div>
  `);
}

function createMarkerIcon(scooter) {
  const color = scooter.inside_zone ? '#22c55e' : '#ef4444';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
    <circle cx="18" cy="18" r="16" fill="${color}" fill-opacity="0.2" stroke="${color}" stroke-width="2"/>
    <text x="18" y="23" text-anchor="middle" font-size="16">🛴</text>
  </svg>`;

  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -20],
  });
}

function addOrUpdateMarker(scooter) {
  if (!scooter.lat || !scooter.lng) return;

  const popupContent = `
    <div style="font-size:13px;padding:4px;min-width:160px">
      <strong>🛴 ${scooter.name}</strong><br>
      ${scooter.plate ? `<span style="opacity:0.7">${scooter.plate}</span><br>` : ''}
      <hr style="border-color:#2a2a38;margin:6px 0">
      Durum: <strong style="color:${scooter.inside_zone ? '#22c55e' : '#ef4444'}">${scooter.inside_zone ? 'Parkta ✓' : 'Park Dışında ⚠️'}</strong><br>
      Batarya: ${scooter.battery}%<br>
      Son Güncelleme: ${formatTime(scooter.last_seen)}
    </div>
  `;

  if (markers[scooter.id]) {
    markers[scooter.id].setLatLng([scooter.lat, scooter.lng]);
    markers[scooter.id].setIcon(createMarkerIcon(scooter));
    markers[scooter.id].setPopupContent(popupContent);
  } else {
    const marker = L.marker([scooter.lat, scooter.lng], {
      icon: createMarkerIcon(scooter),
    }).addTo(map).bindPopup(popupContent);
    markers[scooter.id] = marker;
  }
}

function removeMarker(id) {
  if (markers[id]) {
    map.removeLayer(markers[id]);
    delete markers[id];
  }
}

// ====== WEBSOCKET ======
function initWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onmessage = (e) => {
    const data = JSON.parse(e.data);
    handleWSMessage(data);
  };

  ws.onclose = () => {
    setTimeout(initWS, 2000);
  };
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'init':
      fence = data.fence;
      drawFence(fence);
      data.scooters.forEach(s => {
        scooters[s.id] = s;
        addOrUpdateMarker(s);
      });
      updateSidebar();
      updateStats();
      loadAlerts();
      break;

    case 'scooter_added':
      scooters[data.scooter.id] = data.scooter;
      addOrUpdateMarker(data.scooter);
      updateSidebar();
      updateStats();
      showToast(`🛴 ${data.scooter.name} sisteme eklendi`, 'info');
      break;

    case 'scooter_updated':
      scooters[data.scooter.id] = data.scooter;
      updateSidebarItem(data.scooter);
      break;

    case 'gps_connected':
      showToast(`📡 GPS cihazı bağlandı`, 'success');
      break;

    case 'gps_disconnected':
      showToast(`📡 GPS cihazı bağlantısı kesildi`, 'info');
      break;

    case 'gps_unknown':
      showToast(`⚠️ Tanınmayan GPS cihazı bağlandı — IMEI: ${data.imei}. "API Bilgisi"nden kaydedin.`, 'danger');
      break;

    case 'scooter_removed':
      delete scooters[data.id];
      removeMarker(data.id);
      updateSidebar();
      updateStats();
      break;

    case 'location_update':
      scooters[data.scooter.id] = data.scooter;
      addOrUpdateMarker(data.scooter);
      updateSidebarItem(data.scooter);
      updateStats();
      break;

    case 'alert':
      scooters[data.scooter.id] = data.scooter;
      addOrUpdateMarker(data.scooter);
      updateSidebarItem(data.scooter);
      updateStats();
      showToast(data.message, data.alertType);
      loadAlerts();
      if (data.alertType === 'danger') {
        playAlert();
      }
      break;

    case 'geofence_updated':
      fence = data.fence;
      drawFence(fence);
      showToast('Park sınırı güncellendi', 'info');
      break;
  }
}

// ====== API ======
async function loadAlerts() {
  try {
    const res = await fetch('/api/alerts');
    const alerts = await res.json();
    renderAlerts(alerts);
  } catch (e) {}
}

async function addScooter() {
  const name = document.getElementById('scooter-name').value.trim();
  const plate = document.getElementById('scooter-plate').value.trim();
  const imei = document.getElementById('scooter-imei').value.trim();

  if (!name) {
    showToast('Scooter adı girin', 'danger');
    return;
  }

  try {
    const res = await fetch('/api/scooters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, plate, imei: imei || null }),
    });

    if (res.ok) {
      closeModal('add-modal');
      document.getElementById('scooter-name').value = '';
      document.getElementById('scooter-plate').value = '';
      document.getElementById('scooter-imei').value = '';
    }
  } catch (e) {
    showToast('Hata oluştu', 'danger');
  }
}

async function deleteScooter(id) {
  if (!confirm('Bu scooteri silmek istediğinizden emin misiniz?')) return;
  await fetch(`/api/scooters/${id}`, { method: 'DELETE' });
}

async function updateGeofence() {
  const lat = parseFloat(document.getElementById('fence-lat').value);
  const lng = parseFloat(document.getElementById('fence-lng').value);
  const radius = parseFloat(document.getElementById('fence-radius').value);

  if (!lat || !lng || !radius) {
    showToast('Tüm alanları doldurun', 'danger');
    return;
  }

  await fetch('/api/geofence', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng, radius }),
  });

  closeModal('geofence-modal');
}

async function updateGeofenceCenter(lat, lng) {
  if (!fence) return;
  await fetch('/api/geofence', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lng, radius: fence.radius }),
  });
}

async function clearAlerts() {
  await fetch('/api/alerts', { method: 'DELETE' });
  document.getElementById('alert-list').innerHTML = '<div class="empty-state">Uyarı yok</div>';
}

// ====== UI UPDATES ======
function updateStats() {
  const all = Object.values(scooters);
  const inside = all.filter(s => s.inside_zone).length;
  document.getElementById('total-count').textContent = all.length;
  document.getElementById('inside-count').textContent = inside;
  document.getElementById('outside-count').textContent = all.length - inside;
}

function updateSidebar() {
  const list = document.getElementById('scooter-list');
  const all = Object.values(scooters);

  if (all.length === 0) {
    list.innerHTML = '<div class="empty-state">Henüz scooter eklenmedi</div>';
    return;
  }

  list.innerHTML = all.map(s => renderScooterItem(s)).join('');
}

function updateSidebarItem(scooter) {
  const el = document.getElementById(`si-${scooter.id}`);
  if (el) {
    el.outerHTML = renderScooterItem(scooter);
  }
}

function renderScooterItem(s) {
  return `
    <div class="scooter-item ${s.inside_zone ? '' : 'outside'}" id="si-${s.id}" onclick="focusScooter('${s.id}')">
      <div class="scooter-item-header">
        <div>
          <div class="scooter-item-name">🛴 ${s.name}</div>
          ${s.plate ? `<div class="scooter-item-plate">${s.plate}</div>` : ''}
        </div>
        <div class="scooter-badges">
          <span class="badge ${s.inside_zone ? 'badge-inside' : 'badge-outside'}">
            ${s.inside_zone ? 'Parkta' : 'DIŞARIDA'}
          </span>
          <span class="badge badge-battery">🔋${s.battery}%</span>
        </div>
      </div>
      <div class="scooter-item-footer">
        <div class="scooter-coords">
          ${s.lat ? s.lat.toFixed(5) + ', ' + s.lng.toFixed(5) : 'Konum yok'}
        </div>
        <button class="btn-delete" onclick="event.stopPropagation(); deleteScooter('${s.id}')">Sil</button>
      </div>
    </div>
  `;
}

function renderAlerts(alerts) {
  const list = document.getElementById('alert-list');
  if (!alerts || alerts.length === 0) {
    list.innerHTML = '<div class="empty-state">Uyarı yok</div>';
    return;
  }

  list.innerHTML = alerts.slice(0, 20).map(a => `
    <div class="alert-item ${a.type}">
      ${a.message}
      <div class="alert-time">${formatTime(a.created_at)}</div>
    </div>
  `).join('');
}

function focusScooter(id) {
  const s = scooters[id];
  if (s && s.lat && s.lng) {
    map.setView([s.lat, s.lng], 18, { animate: true });
    if (markers[id]) markers[id].openPopup();
  }
}

// ====== MODALS ======
function showAddModal() {
  document.getElementById('add-modal').classList.add('active');
  setTimeout(() => document.getElementById('scooter-name').focus(), 100);
}

function showGeofenceModal() {
  if (fence) {
    document.getElementById('fence-lat').value = fence.lat;
    document.getElementById('fence-lng').value = fence.lng;
    document.getElementById('fence-radius').value = fence.radius;
  }
  document.getElementById('geofence-modal').classList.add('active');
}

function showApiModal() {
  const baseUrl = `${location.protocol}//${location.host}`;
  document.getElementById('api-url-display').textContent = `${baseUrl}/api/location`;

  const host = location.hostname;
  const gpsCmd = document.getElementById('gps-sms-command');
  if (gpsCmd) {
    gpsCmd.textContent = `SINOTRACK için:\n804000  ${host}  6000\n\nDiğer GT06 cihazlar için:\n#IP#123456#${host}#6000#`;
  }

  const all = Object.values(scooters);

  const idList = document.getElementById('scooter-ids');
  if (all.length === 0) {
    idList.innerHTML = '<div style="padding:14px;font-size:12px;color:#6b6b80">Henüz scooter eklenmedi. Önce scooter ekleyin.</div>';
  } else {
    idList.innerHTML = all.map(s => `
      <div class="scooter-id-row" style="flex-direction:column;align-items:flex-start;gap:6px">
        <span class="scooter-id-name">🛴 ${s.name}</span>
        <div class="imei-input-row">
          <input type="text" id="imei-${s.id}" value="${s.imei || ''}" placeholder="IMEI numarasını girin (15 hane)" maxlength="20" />
          <button class="btn-save-imei" onclick="saveImei('${s.id}')">Kaydet</button>
        </div>
      </div>
    `).join('');
  }

  const idListHttp = document.getElementById('scooter-ids-http');
  if (idListHttp) {
    if (all.length === 0) {
      idListHttp.innerHTML = '<div style="padding:14px;font-size:12px;color:#6b6b80">Henüz scooter eklenmedi.</div>';
    } else {
      idListHttp.innerHTML = all.map(s => `
        <div class="scooter-id-row">
          <span class="scooter-id-name">${s.name}</span>
          <span class="scooter-id-val" onclick="copyText('${s.id}', this)" title="Kopyalamak için tıkla">${s.id.substring(0, 8)}...</span>
        </div>
      `).join('');
    }
  }

  document.getElementById('api-modal').classList.add('active');
}

function switchApiTab(tab, btn) {
  document.querySelectorAll('.api-tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('api-tab-gps').style.display = tab === 'gps' ? 'block' : 'none';
  document.getElementById('api-tab-http').style.display = tab === 'http' ? 'block' : 'none';
}

async function saveImei(scooterId) {
  const input = document.getElementById(`imei-${scooterId}`);
  if (!input) return;
  const imei = input.value.trim();

  const res = await fetch(`/api/scooters/${scooterId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imei: imei || null }),
  });

  if (res.ok) {
    showToast(imei ? `IMEI kaydedildi: ${imei}` : 'IMEI temizlendi', 'success');
    const data = await res.json();
    scooters[scooterId] = data;
  } else {
    showToast('Kaydetme hatası', 'danger');
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

function copyText(text, el) {
  navigator.clipboard.writeText(text).then(() => {
    el.textContent = 'Kopyalandı!';
    setTimeout(() => { el.textContent = text.substring(0, 8) + '...'; }, 1500);
    showToast('ID kopyalandı', 'info');
  });
}

// ====== TOAST ======
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function playAlert() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 660, 880].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.14);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.14);
    });
  } catch (e) {}
}

// ====== DEMO ======
async function simulateMovement() {
  const all = Object.values(scooters);
  if (all.length === 0) { showToast('Önce bir scooter ekleyin', 'danger'); return; }

  for (const s of all) {
    if (!s.lat || !s.lng) continue;
    const newLat = s.lat + (Math.random() - 0.5) * 0.001;
    const newLng = s.lng + (Math.random() - 0.5) * 0.001;
    await fetch('/api/location', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: s.id, lat: newLat, lng: newLng, battery: Math.max(10, s.battery - 1) }),
    });
  }
  showToast('Scooterlar hareket ettirildi', 'info');
}

async function simulateEscape() {
  const all = Object.values(scooters);
  if (all.length === 0) { showToast('Önce bir scooter ekleyin', 'danger'); return; }
  if (!fence) return;

  const s = all[0];
  const escapeLat = fence.lat + (fence.radius / 111000) * 1.5;
  await fetch('/api/location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.id, lat: escapeLat, lng: fence.lng, battery: s.battery }),
  });
}

async function simulateReturn() {
  const all = Object.values(scooters);
  if (all.length === 0) { showToast('Önce bir scooter ekleyin', 'danger'); return; }
  if (!fence) return;

  const s = all[0];
  await fetch('/api/location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: s.id, lat: fence.lat, lng: fence.lng, battery: s.battery }),
  });
}

// ====== UTILS ======
function formatTime(ts) {
  if (!ts) return 'Bilinmiyor';
  try {
    const d = new Date(ts.replace(' ', 'T') + 'Z');
    return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch (e) {
    return ts;
  }
}

// ====== KEYBOARD ======
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
  }
  if (e.key === 'Enter' && document.getElementById('add-modal').classList.contains('active')) {
    addScooter();
  }
});

// ====== INIT ======
initMap();
initWS();
