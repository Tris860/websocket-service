const https = require("https");

const HEALTH_URLS = [
  "https://iot-gateway-85pq.onrender.com/health",
  "https://webserver-ft8c.onrender.com/health", // Server B
];

function pingHealthEndpoints() {
  HEALTH_URLS.forEach((url) => {
    https
      .get(url, (res) => {
        console.log(
          `[${new Date().toISOString()}] Pinged ${url} → Status: ${
            res.statusCode
          }`
        );
      })
      .on("error", (err) => {
        console.error(
          `[${new Date().toISOString()}] Ping failed for ${url}:`,
          err.message
        );
      });
  });
}

// Start pinging every 5 minutes
setInterval(pingHealthEndpoints, 5 * 60 * 1000);

// Optional: immediate ping on startup
pingHealthEndpoints();
