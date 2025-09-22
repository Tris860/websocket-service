// server.js
const WebSocket = require('ws');
const http = require('http');
const fetch = require('node-fetch'); // Import the fetch library

// Define your Wemos's authentication credentials
const WEMOS_USERNAME = 'wemos_user';
const WEMOS_PASSWORD = 'wemos_pass';
// URL for the PHP backend script
const PHP_BACKEND_URL = 'https://atsdeploy.infinityfreeapp.com/backend/main.php?action=is_current_time_in_period';

const wss = new WebSocket.Server({ noServer: true });

const server = http.createServer((req, res) => {
  // This is a simple HTTP server that can be used for things like serving the HTML file.
  // It's separate from the WebSocket server.
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebSocket server is running. Please connect via a WebSocket client.');
});

server.on('upgrade', (request, socket, head) => {
  // Check for the Wemos's authentication headers
  const username = request.headers['x-username'];
  const password = request.headers['x-password'];

  if (username === WEMOS_USERNAME && password === WEMOS_PASSWORD) {
    console.log('Wemos client attempting to authenticate...');
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    // If headers are missing or incorrect, it's not the Wemos.
    // We can allow the connection for other clients (like the webpage).
    console.log('Unauthenticated client attempting to connect.');
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

wss.on('connection', function connection(ws) {
  console.log('A client connected!');

  ws.on('message', function incoming(message) {
    console.log('Received from client: %s', message);
    
    // Broadcast the message to all other connected clients
    wss.clients.forEach(function each(client) {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message.toString());
      }
    });
  });
  
  ws.on('close', function close() {
    console.log('Client disconnected.');
  });
});

server.listen(4000, '0.0.0.0', () => {
  console.log('Server is listening on port 3000');
  // Start the periodic check to the PHP backend
  setInterval(checkPhpBackend, 60000); // Check every 60 seconds (1 minute)
});

/**
 * Periodically checks the PHP backend for a time-based message.
 */
async function checkPhpBackend() {
  console.log('Checking PHP backend for a new message...');
  try {
    const response = await fetch(PHP_BACKEND_URL);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();

    // Check if the PHP response indicates a message should be sent
    if (data.success === true) {
      console.log('PHP backend triggered a message:', data.message);
      // Broadcast the message to all connected WebSocket clients
      wss.clients.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN) {
          client.send("AUTO_ON");
        }
      });
    } else {
      console.log('PHP backend did not return a message to broadcast.',data.success);
    }
  } catch (error) {
    console.error('Failed to fetch from PHP backend:', error);
  }
}