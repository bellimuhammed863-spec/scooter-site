const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const net = require('net');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const Gt06 = require('gt06');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database('scooters.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS scooters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plate TEXT,
    imei TEXT,
    lat REAL,
    lng REAL,
    battery INTEGER DEFAULT 100,
    status TEXT DEFAULT 'active',
    last_seen TEXT,
    inside_zone INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS geofence (
    id INTEGER PRIMARY KEY,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    radius REAL NOT NULL DEFAULT 200
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scooter_id TEXT,
    scooter_name TEXT,
    message TEXT,
    type TEXT DEFAULT 'warning',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

try {
  db.exec(`ALTER TABLE scooters ADD COLUMN imei TEXT`);
} catch (e) {}

const existingFence = db.prepare('SELECT * FROM geofence WHERE id = 1').get();
if (!existingFence) {
  db.prepare('INSERT INTO geofence (id, lat, lng, radius) VALUES (1, 41.0082, 28.9784, 300)').run();
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateScooterLocation(scooterId, lat, lng, battery) {
  const scooter = db.prepare('SELECT * FROM scooters WHERE id = ?').get(scooterId);
  if (!scooter) return null;

  const fence = db.prepare('SELECT * FROM geofence WHERE id = 1').get();
  const distance = getDistance(lat, lng, fence.lat, fence.lng);
  const insideZone = distance <= fence.radius ? 1 : 0;
  const wasInside = scooter.inside_zone;
  const batVal = battery !== undefined && battery !== null ? battery : scooter.battery;

  db.prepare(`
    UPDATE scooters SET lat = ?, lng = ?, battery = ?, last_seen = datetime('now'), inside_zone = ? WHERE id = ?
  `).run(lat, lng, batVal, insideZone, scooterId);

  const updated = db.prepare('SELECT * FROM scooters WHERE id = ?').get(scooterId);

  if (wasInside && !insideZone) {
    const msg = `⚠️ ${scooter.name} park dışına çıktı! Mesafe: ${Math.round(distance)}m`;
    db.prepare(`INSERT INTO alerts (scooter_id, scooter_name, message, type) VALUES (?, ?, ?, 'danger')`).run(scooterId, scooter.name, msg);
    broadcast({ type: 'alert', scooter: updated, message: msg, alertType: 'danger' });
  } else if (!wasInside && insideZone) {
    const msg = `✅ ${scooter.name} parka geri döndü`;
    db.prepare(`INSERT INTO alerts (scooter_id, scooter_name, message, type) VALUES (?, ?, ?, 'success')`).run(scooterId, scooter.name, msg);
    broadcast({ type: 'alert', scooter: updated, message: msg, alertType: 'success' });
  }

  broadcast({ type: 'location_update', scooter: updated });
  return updated;
}

// ====== GT06 TCP SERVER (GPS Cihazları için) ======
try {
  db.exec(`ALTER TABLE scooters ADD COLUMN engine_cut INTEGER DEFAULT 0`);
} catch (e) {}

const deviceSockets = new Map();

function crc16(buf) {
  let crc = 0xFFFF;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
  }
  return crc & 0xFFFF;
}

function buildRelayPacket(serial, cutPower) {
  const cmd = cutPower ? 0x01 : 0x02;
  const body = Buffer.from([0x80, (serial >> 8) & 0xFF, serial & 0xFF, cmd]);
  const checksum = crc16(body);
  return Buffer.concat([
    Buffer.from([0x78, 0x78, body.length]),
    body,
    Buffer.from([(checksum >> 8) & 0xFF, checksum & 0xFF, 0x0D, 0x0A])
  ]);
}

const GPS_PORT = 6000;

const tcpServer = net.createServer((socket) => {
  const gt06 = new Gt06();
  let deviceImei = null;
  let cmdSerial = 1;

  console.log(`[GPS] Yeni cihaz bağlandı: ${socket.remoteAddress}`);

  socket.on('data', (data) => {
    try {
      gt06.parse(data);
    } catch (e) {
      console.log('[GPS] Parse hatası:', e.message);
      return;
    }

    if (gt06.expectsResponse) {
      socket.write(gt06.responseMsg);
    }

    gt06.msgBuffer.forEach(msg => {
      if (msg.messageType === 'LOGIN') {
        deviceImei = msg.deviceId || msg.imei;
        console.log(`[GPS] Cihaz giriş yaptı — IMEI: ${deviceImei}`);

        const scooter = db.prepare('SELECT * FROM scooters WHERE imei = ?').get(deviceImei);
        deviceSockets.set(deviceImei, { socket, serial: cmdSerial });
        if (scooter) {
          console.log(`[GPS] Eşleşti: ${scooter.name}`);
          broadcast({ type: 'gps_connected', scooterId: scooter.id, imei: deviceImei });
        } else {
          console.log(`[GPS] Bu IMEI kayıtlı değil: ${deviceImei}`);
          broadcast({ type: 'gps_unknown', imei: deviceImei });
        }
      }

      if (msg.messageType === 'GPS_LBS_STATUS' || msg.messageType === 'GPS') {
        if (!deviceImei) return;

        const scooter = db.prepare('SELECT * FROM scooters WHERE imei = ?').get(deviceImei);
        if (!scooter) return;

        const lat = msg.latitude || msg.lat;
        const lng = msg.longitude || msg.lng || msg.lon;
        if (!lat || !lng) return;

        console.log(`[GPS] Konum — ${scooter.name}: ${lat}, ${lng}`);
        updateScooterLocation(scooter.id, lat, lng, null);
      }
    });

    gt06.clearMsgBuffer();
  });

  socket.on('error', (err) => {
    console.log(`[GPS] Bağlantı hatası: ${err.message}`);
  });

  socket.on('close', () => {
    console.log(`[GPS] Cihaz bağlantısı kesildi — IMEI: ${deviceImei}`);
    if (deviceImei) {
      deviceSockets.delete(deviceImei);
      const scooter = db.prepare('SELECT * FROM scooters WHERE imei = ?').get(deviceImei);
      if (scooter) {
        broadcast({ type: 'gps_disconnected', scooterId: scooter.id });
      }
    }
  });
});

tcpServer.listen(GPS_PORT, '0.0.0.0', () => {
  console.log(`[GPS] TCP sunucu ayakta — Port: ${GPS_PORT} (GT06 cihazları buraya bağlanır)`);
});

// ====== REST API ======

app.get('/api/scooters', (req, res) => {
  const scooters = db.prepare('SELECT * FROM scooters ORDER BY created_at DESC').all();
  res.json(scooters);
});

app.post('/api/scooters', (req, res) => {
  const { name, plate, imei } = req.body;
  if (!name) return res.status(400).json({ error: 'Scooter adı zorunludur' });

  const fence = db.prepare('SELECT * FROM geofence WHERE id = 1').get();
  const id = uuidv4();

  const lat = fence.lat + (Math.random() - 0.5) * 0.002;
  const lng = fence.lng + (Math.random() - 0.5) * 0.002;

  db.prepare(`
    INSERT INTO scooters (id, name, plate, imei, lat, lng, last_seen, inside_zone)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 1)
  `).run(id, name, plate || '', imei || null, lat, lng);

  const scooter = db.prepare('SELECT * FROM scooters WHERE id = ?').get(id);
  broadcast({ type: 'scooter_added', scooter });
  res.json(scooter);
});

app.put('/api/scooters/:id', (req, res) => {
  const { id } = req.params;
  const { imei, name, plate } = req.body;

  const scooter = db.prepare('SELECT * FROM scooters WHERE id = ?').get(id);
  if (!scooter) return res.status(404).json({ error: 'Scooter bulunamadı' });

  if (imei !== undefined) {
    db.prepare('UPDATE scooters SET imei = ? WHERE id = ?').run(imei || null, id);
  }
  if (name) db.prepare('UPDATE scooters SET name = ? WHERE id = ?').run(name, id);
  if (plate !== undefined) db.prepare('UPDATE scooters SET plate = ? WHERE id = ?').run(plate, id);

  const updated = db.prepare('SELECT * FROM scooters WHERE id = ?').get(id);
  broadcast({ type: 'scooter_updated', scooter: updated });
  res.json(updated);
});

app.post('/api/scooters/:id/relay', (req, res) => {
  const { id } = req.params;
  const { action } = req.body;

  const scooter = db.prepare('SELECT * FROM scooters WHERE id = ?').get(id);
  if (!scooter) return res.status(404).json({ error: 'Scooter bulunamadı' });
  if (!scooter.imei) return res.status(400).json({ error: 'Bu scootere IMEI atanmamış. Önce IMEI girin.' });

  const conn = deviceSockets.get(scooter.imei);
  if (!conn) return res.status(503).json({ error: 'GPS cihazı şu an bağlı değil. Cihaz aktif olduğunda tekrar deneyin.' });

  const cutPower = action === 'cut';
  const packet = buildRelayPacket(conn.serial++, cutPower);

  try {
    conn.socket.write(packet);
    db.prepare('UPDATE scooters SET engine_cut = ? WHERE id = ?').run(cutPower ? 1 : 0, id);
    const updated = db.prepare('SELECT * FROM scooters WHERE id = ?').get(id);
    broadcast({ type: 'scooter_updated', scooter: updated });
    console.log(`[GPS] Röle komutu gönderildi — ${scooter.name}: ${cutPower ? 'DURDUR' : 'BAŞLAT'}`);
    res.json({ success: true, engine_cut: cutPower ? 1 : 0 });
  } catch (e) {
    res.status(500).json({ error: 'Komut gönderilemedi: ' + e.message });
  }
});

app.delete('/api/scooters/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM scooters WHERE id = ?').run(id);
  broadcast({ type: 'scooter_removed', id });
  res.json({ success: true });
});

app.post('/api/location', (req, res) => {
  const { id, lat, lng, battery } = req.body;
  if (!id || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'id, lat ve lng zorunludur' });
  }

  const updated = updateScooterLocation(id, lat, lng, battery);
  if (!updated) return res.status(404).json({ error: 'Scooter bulunamadı' });

  const fence = db.prepare('SELECT * FROM geofence WHERE id = 1').get();
  const distance = getDistance(lat, lng, fence.lat, fence.lng);
  res.json({ success: true, inside_zone: updated.inside_zone, distance: Math.round(distance) });
});

app.get('/api/geofence', (req, res) => {
  const fence = db.prepare('SELECT * FROM geofence WHERE id = 1').get();
  res.json(fence);
});

app.put('/api/geofence', (req, res) => {
  const { lat, lng, radius } = req.body;
  if (!lat || !lng || !radius) return res.status(400).json({ error: 'lat, lng ve radius zorunludur' });

  db.prepare('UPDATE geofence SET lat = ?, lng = ?, radius = ? WHERE id = 1').run(lat, lng, radius);

  const scooters = db.prepare('SELECT * FROM scooters').all();
  scooters.forEach(s => {
    if (s.lat && s.lng) {
      const d = getDistance(s.lat, s.lng, lat, lng);
      db.prepare('UPDATE scooters SET inside_zone = ? WHERE id = ?').run(d <= radius ? 1 : 0, s.id);
    }
  });

  const fence = db.prepare('SELECT * FROM geofence WHERE id = 1').get();
  broadcast({ type: 'geofence_updated', fence });
  res.json(fence);
});

app.get('/api/alerts', (req, res) => {
  const alerts = db.prepare('SELECT * FROM alerts ORDER BY created_at DESC LIMIT 50').all();
  res.json(alerts);
});

app.delete('/api/alerts', (req, res) => {
  db.prepare('DELETE FROM alerts').run();
  res.json({ success: true });
});

wss.on('connection', (ws) => {
  const scooters = db.prepare('SELECT * FROM scooters').all();
  const fence = db.prepare('SELECT * FROM geofence WHERE id = 1').get();
  ws.send(JSON.stringify({ type: 'init', scooters, fence }));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Scooter Takip Sistemi çalışıyor: http://0.0.0.0:${PORT}`);
});
