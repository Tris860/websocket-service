// server.js
const http = require('http');
const url = require('url');
const WebSocket = require('ws');

// Render sets PORT automatically
const PORT = process.env.PORT || 4000;
const PHP_BACKEND_URL = 'http://localhost/backend/main.php?action=is_current_time_in_period';

async function checkPhpBackend() {
  try {
    const resp = await fetch(PHP_BACKEND_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const raw = await resp.text();
    let data;
    try { data = JSON.parse(raw); } catch (e) { return; }
    console.log('checkPhpBackend response:', data);
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