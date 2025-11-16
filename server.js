// server.js
const http = require('http');
const url = require('url');
const WebSocket = require('ws');

// Render automatically sets the PORT environment variable.
const PORT = process.env.PORT || 4000;

// PHP backend endpoints
const WEMOS_AUTH_URL = 'https://tristechhub.org.rw/projects/ATS/backend/main.php?action=wemos_auth';
const PHP_BACKEND_URL = 'https://tristechhub.org.rw/projects/ATS/backend/main.php?action=is_current_time_in_period';
const USER_DEVICE_LOOKUP_URL = 'https://tristechhub.org.rw/projects/ATS/backend/main.php?action=get_user_device';

// WebSocket server (manual upgrade mode)
const wss = new WebSocket.Server({ noServer: true });

// Maps
const authenticatedWemos = new Map(); // deviceName -> WebSocket
const userWebClients = new Map();     // userEmail -> Set(WebSocket)
const userToWemosCache = new Map();   // userEmail -> deviceName

// Utility: normalize headers (avoid "wemos_user, wemos_user")
function headerFirst(request, name) {
  const v = request.headers[name.toLowerCase()];
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] || '').trim();
  return String(v).split(',')[0].trim();
}

// Lookup device for user (cached)
async function getCachedWemosDeviceNameForUser(userEmail) {
  if (!userEmail) return null;
  if (userToWemosCache.has(userEmail)) return userToWemosCache.get(userEmail);

  const postData = new URLSearchParams();
  postData.append('action', 'get_user_device');
  postData.append('email', userEmail);

  try {
    const resp = await fetch(USER_DEVICE_LOOKUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: postData.toString()
    });

    const raw = await resp.text();
    console.log("RAW PHP RESPONSE:", raw);

    let data;
    try { data = JSON.parse(raw); } catch (e) { return null; }

    if (data.success === true && data.device_name) {
      userToWemosCache.set(userEmail, data.device_name);
      return data.device_name;
    }
    return null;
  } catch (err) {
    console.error('getCachedWemosDeviceNameForUser error:', err.message);
    return null;
  }
}

// Add/remove web clients
function addWebClientForUser(email, ws) {
  if (!email) return;
  let set = userWebClients.get(email);
  if (!set) {
    set = new Set();
    userWebClients.set(email, set);
  }
  set.add(ws);
}
function removeWebClientForUser(email, ws) {
  if (!email) return;
  const set = userWebClients.get(email);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userWebClients.delete(email);
}

// Authenticate Wemos and upgrade socket
async function authenticateAndUpgradeWemos(request, socket, head) {
  const usernameHeader = headerFirst(request, 'x-username');
  const passwordHeader = headerFirst(request, 'x-password');
  console.log(`Authenticating Wemos. username=${usernameHeader}`);

  if (!usernameHeader || !passwordHeader) {
    try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {}
    socket.destroy();
    return;
  }

  try {
    const postData = new URLSearchParams();
    postData.append('action', 'wemos_auth');
    postData.append('username', usernameHeader);
    postData.append('password', passwordHeader);

    const resp = await fetch(WEMOS_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: postData.toString()
    });

    const raw = await resp.text();
    console.log("RAW PHP RESPONSE:", raw);

    let data;
    try { data = JSON.parse(raw); } catch (e) { data = null; }

    if (!data || data.success !== true) {
      try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch (e) {}
      console.log("Authentication failed for Wemos");
      socket.destroy();
      return;
    }

    const deviceName = data.data?.device_name || usernameHeader;
    const initialCommand = data.data?.hard_switch_enabled ? 'HARD_ON' : 'HARD_OFF';

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isWemos = true;
      ws.wemosName = deviceName;
      ws.isAlive = true;

      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', (err) => console.error(`WebSocket error for '${deviceName}':`, err.message));
      ws.on('close', () => {
        const current = authenticatedWemos.get(deviceName);
        if (current === ws) authenticatedWemos.delete(deviceName);
        console.log(`Wemos '${deviceName}' disconnected.`);
        // Notify web clients
        userWebClients.forEach((set, email) => {
          if (userToWemosCache.get(email) === deviceName) {
            set.forEach(client => {
              if (client.readyState === WebSocket.OPEN) {
                try { client.send('WEMOS_STATUS:DISCONNECTED'); } catch (e) {}
              }
            });
          }
        });
      });

      // Replace existing safely
      const existing = authenticatedWemos.get(deviceName);
      if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
        setTimeout(() => { try { existing.terminate(); } catch (e) {} }, 250);
      }
      authenticatedWemos.set(deviceName, ws);

      console.log(`Wemos client '${deviceName}' authenticated and connected.`);

      if (ws.readyState === WebSocket.OPEN && initialCommand) {
        try { ws.send(initialCommand); } catch (e) {}
      }

      wss.emit('connection', ws, request);
    });

  } catch (err) {
    console.error(`Authentication error for Wemos '${usernameHeader}':`, err.message);
    try { socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n'); } catch (e) {}
    socket.destroy();
  }
}

// HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server running\n');
});

// Upgrade handling
server.on('upgrade', async (request, socket, head) => {
  const parsed = url.parse(request.url, true);
  const webUserQuery = parsed.query.user || null;

  const xUsername = headerFirst(request, 'x-username');
  const xPassword = headerFirst(request, 'x-password');

  if (xUsername && xPassword) {
    await authenticateAndUpgradeWemos(request, socket, head);
    return;
  }

  // Browser/web client
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.isWemos = false;
    ws.webUsername = webUserQuery;
    ws.assignedWemosName = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    console.log(`Webpage client connected. user=${ws.webUsername}`);
    wss.emit('connection', ws, request);
  });
});

// Connection handling
wss.on('connection', (ws, request) => {
  ws.isAlive = true;

  ws.on('message', async (msg) => {
    const text = msg.toString();
    ws.isAlive = true; // mark alive on any message

    if (!ws.isWemos) {
      const userEmail = ws.webUsername;
      if (!userEmail) { try { ws.send('MESSAGE_FAILED:NoUserIdentity'); } catch (e) {} return; }

      let deviceName = ws.assignedWemosName;
      if (!deviceName) {
        deviceName = await getCachedWemosDeviceNameForUser(userEmail);
        ws.assignedWemosName = deviceName;
      }
      if (!deviceName) { try { ws.send('MESSAGE_FAILED:NoDeviceAssigned'); } catch (e) {} return; }

      const target = authenticatedWemos.get(deviceName);
      if (target && target.readyState === WebSocket.OPEN) {
        try { target.send(text); ws.send('MESSAGE_DELIVERED'); } catch (e) { ws.send('MESSAGE_FAILED'); }
      } else {
        try { ws.send('WEMOS_STATUS:DISCONNECTED'); } catch (e) {}
      }
    } else {
            // …continuation inside wss.on('connection')

      // Wemos -> server: forward to all webpage clients for mapped user(s)
      const fromDevice = ws.wemosName;
      console.log(`Message from Wemos '${fromDevice}': ${text}`);

      userWebClients.forEach((set, email) => {
        if (userToWemosCache.get(email) === fromDevice) {
          set.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              try { client.send(`WEMOS_MSG:${text}`); } catch (e) {}
            }
          });
        }
      });
    }
  });

  ws.on('close', () => {
    if (ws.isWemos && ws.wemosName) {
      const name = ws.wemosName;
      const current = authenticatedWemos.get(name);
      if (current === ws) authenticatedWemos.delete(name);

      console.log(`Wemos '${name}' disconnected.`);
      // Notify pages mapping to this device
      userWebClients.forEach((set, email) => {
        if (userToWemosCache.get(email) === name) {
          set.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              try { client.send('WEMOS_STATUS:DISCONNECTED'); } catch (e) {}
            }
          });
        }
      });
    } else {
      const email = ws.webUsername;
      if (email) {
        removeWebClientForUser(email, ws);
        console.log(`Webpage client disconnected. user=${email}`);
      } else {
        console.log('Webpage client disconnected. user=[unknown]');
      }
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// Heartbeat: detect dead sockets
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`Terminating dead socket for '${ws.wemosName || ws.webUsername || 'unknown'}'`);
      try { ws.terminate(); } catch (e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

// Periodic PHP backend check and broadcast
async function checkPhpBackend() {
  try {
    const resp = await fetch(PHP_BACKEND_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.success === true) {
      const messageToWemos = 'AUTO_ON';
      const messageToWeb = 'TIME_MATCHED: ' + data.message + ": " + data.id;

      // Broadcast AUTO_ON to all connected Wemos
      authenticatedWemos.forEach((client, deviceName) => {
        if (client && client.readyState === WebSocket.OPEN) {
          try { client.send(messageToWemos); console.log(`Sent ${messageToWemos} to ${deviceName}`); } catch (e) {}
        }
      });

      // Notify webpages
      userWebClients.forEach((set) => {
        set.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            try { client.send(messageToWeb); } catch (e) {}
          }
        });
      });
    }
  } catch (err) {
    console.error('checkPhpBackend error:', err.message);
  }
}

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}. Render proxy handles WSS encryption.`);
  checkPhpBackend();
  setInterval(checkPhpBackend, 60000);
});
