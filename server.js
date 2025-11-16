// server.js
const http = require('http');
const url = require('url');
const WebSocket = require('ws');

// Render sets PORT automatically
const PORT = process.env.PORT || 4000;

// PHP backend endpoints
const WEMOS_AUTH_URL = 'https://tristechhub.org.rw/projects/ATS/backend/main.php?action=wemos_auth';
const PHP_BACKEND_URL = 'https://tristechhub.org.rw/projects/ATS/backend/main.php?action=is_current_time_in_period';
const USER_DEVICE_LOOKUP_URL = 'https://tristechhub.org.rw/projects/ATS/backend/main.php?action=get_user_device';

// WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// Maps
const authenticatedWemos = new Map(); // deviceName -> WebSocket
const userWebClients = new Map();     // userEmail -> Set(WebSocket)
const userToWemosCache = new Map();   // userEmail -> deviceName

// Normalize headers
function headerFirst(request, name) {
  const v = request.headers[name.toLowerCase()];
  if (!v) return null;
  if (Array.isArray(v)) return (v[0] || '').trim();
  return String(v).split(',')[0].trim();
}

// Cached device lookup
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
    console.log("RAW PHP RESPONSE (device lookup):", raw);
    let data;
    try { data = JSON.parse(raw); } catch (e) { return null; }
    if (data.success && data.device_name) {
      userToWemosCache.set(userEmail, data.device_name);
      return data.device_name;
    }
    return null;
  } catch (err) {
    console.error('getCachedWemosDeviceNameForUser error:', err.message);
    return null;
  }
}

// Web client management
function addWebClientForUser(email, ws) {
  if (!email) return;
  let set = userWebClients.get(email);
  if (!set) { set = new Set(); userWebClients.set(email, set); }
  set.add(ws);
}
function removeWebClientForUser(email, ws) {
  if (!email) return;
  const set = userWebClients.get(email);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userWebClients.delete(email);
}

// Wemos Authentication & Upgrade (NO async/await)
function authenticateAndUpgradeWemos(request, socket, head) {
  const usernameHeader = headerFirst(request, 'x-username');
  const passwordHeader = headerFirst(request, 'x-password');
  console.log(`Authenticating Wemos. username=${usernameHeader}`);

  if (!usernameHeader || !passwordHeader) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  const postData = new URLSearchParams();
  postData.append('action', 'wemos_auth');
  postData.append('username', usernameHeader);
  postData.append('password', passwordHeader);

  fetch(WEMOS_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: postData.toString()
  })
  .then(resp => resp.text())
  .then(raw => {
    console.log("RAW PHP RESPONSE:", raw);
    let data;
    try { data = JSON.parse(raw); } catch (e) { data = null; }

    if (!data || data.success !== true) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      console.log("Authentication failed for Wemos");
      socket.destroy();
      return;
    }

    const deviceName = data.data?.device_name || usernameHeader;
    const initialCommand = data.data?.hard_switch_enabled ? 'HARD_ON' : 'HARD_OFF';

    // UPGRADE NOW — socket still alive
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isWemos = true;
      ws.wemosName = deviceName;
      ws.isAlive = true;
      ws.initialCommand = initialCommand;
      console.log(`Wemos client '${deviceName}' authenticated and connected.`);
    });
  })
  .catch(err => {
    console.error(`Auth error:`, err.message);
    socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
    socket.destroy();
  });

  // DO NOT return or destroy here
}

// HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server running\n');
});

// Upgrade handler
server.on('upgrade', (request, socket, head) => {
  const parsed = url.parse(request.url, true);
  const webUserQuery = parsed.query.user || null;

  const xUsername = headerFirst(request, 'x-username');
  const xPassword = headerFirst(request, 'x-password');

  if (xUsername && xPassword) {
    authenticateAndUpgradeWemos(request, socket, head);
    // ← DO NOT return here
  } else {
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isWemos = false;
      ws.webUsername = webUserQuery;
      ws.assignedWemosName = null;
      ws.isAlive = true;
      console.log(`Webpage client connected. user=${ws.webUsername}`);
    });
  }
});

// SINGLE CONNECTION HANDLER
wss.on('connection', (ws, request) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // ——— WEB CLIENT ———
  if (!ws.isWemos) {
    const userEmail = ws.webUsername;
    if (userEmail) addWebClientForUser(userEmail, ws);

    ws.on('message', async (msg) => {
      const text = msg.toString();
      ws.isAlive = true;

      if (!userEmail) {
        try { ws.send('MESSAGE_FAILED:NoUserIdentity'); } catch (e) {}
        return;
      }

      let deviceName = ws.assignedWemosName;
      if (!deviceName) {
        deviceName = await getCachedWemosDeviceNameForUser(userEmail);
        ws.assignedWemosName = deviceName;
      }
      if (!deviceName) {
        try { ws.send('MESSAGE_FAILED:NoDeviceAssigned'); } catch (e) {}
        return;
      }

      const target = authenticatedWemos.get(deviceName);
      if (target && target.readyState === WebSocket.OPEN) {
        try {
          target.send(text);
          ws.send('MESSAGE_DELIVERED');
        } catch (e) {
          ws.send('MESSAGE_FAILED');
        }
      } else {
        try { ws.send('WEMOS_STATUS:DISCONNECTED'); } catch (e) {}
      }
    });

    ws.on('close', () => {
      if (userEmail) {
        removeWebClientForUser(userEmail, ws);
        console.log(`Webpage client disconnected. user=${userEmail}`);
      }
    });

    ws.on('error', (err) => console.error('Web client error:', err.message));
    return;
  }

  // ——— WEMOS CLIENT ———
  const deviceName = ws.wemosName;
  const initialCommand = ws.initialCommand;

  // Replace old connection
  const existing = authenticatedWemos.get(deviceName);
  if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
    setTimeout(() => { try { existing.terminate(); } catch (e) {} }, 250);
  }
  authenticatedWemos.set(deviceName, ws);

  // Send initial command
  if (ws.readyState === WebSocket.OPEN && initialCommand) {
    setTimeout(() => {
      try { ws.send(initialCommand); } catch (e) {}
    }, 100);
  }

  ws.on('message', (msg) => {
    const text = msg.toString();
    ws.isAlive = true;
    console.log(`Message from Wemos '${deviceName}': ${text}`);

    userWebClients.forEach((set, email) => {
      if (userToWemosCache.get(email) === deviceName) {
        set.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            try { client.send(`WEMOS_MSG:${text}`); } catch (e) {}
          }
        });
      }
    });
  });

  ws.on('close', () => {
    if (authenticatedWemos.get(deviceName) === ws) {
      authenticatedWemos.delete(deviceName);
    }
    console.log(`Wemos '${deviceName}' disconnected.`);

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

  ws.on('error', (err) => {
    console.error(`WebSocket error for '${deviceName}':`, err.message);
  });
});

// Heartbeat
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      const id = ws.isWemos ? ws.wemosName : ws.webUsername || 'unknown';
      console.log(`Terminating dead socket for '${id}'`);
      try { ws.terminate(); } catch (e) {}
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 30000);

// PHP backend check
async function checkPhpBackend() {
  try {
    const resp = await fetch(PHP_BACKEND_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }

    if (data.success === true) {
      const messageToWemos = 'AUTO_ON';
      const messageToWeb = 'TIME_MATCHED: ' + data.message + ": " + data.id;

      authenticatedWemos.forEach((client, deviceName) => {
        if (client.readyState === WebSocket.OPEN) {
          try { client.send(messageToWemos); console.log(`Sent ${messageToWemos} to ${deviceName}`); } catch (e) {}
        }
      });

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
  console.log(`Server listening on port ${PORT}.`);
  checkPhpBackend();
  setInterval(checkPhpBackend, 60000);
});