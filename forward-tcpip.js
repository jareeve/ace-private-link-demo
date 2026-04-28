#!/usr/bin/env node

/**
 * TCP Proxy - Forwards raw TCP/IP traffic without TLS termination
 * 
 * Usage:
 *   sudo node tcp-proxy.js                    # For port 443
 *   LOCAL_PORT=8443 node tcp-proxy.js         # For non-privileged port
 * 
 * Environment Variables:
 *   LOCAL_PORT   - Port to listen on (default: 8443)
 *   REMOTE_HOST  - Remote host to forward to (default: httpbin.org)
 *   REMOTE_PORT  - Remote port (default: 443)
 *   TIMEOUT      - Connection timeout in ms (default: 60000)
 *   LOG_LEVEL    - Logging level: debug, info, error (default: info)
 */

const net = require('net');
const dns = require('dns').promises;

// Configuration from environment variables
const CONFIG = {
  localPort: parseInt(process.env.LOCAL_PORT || '3001', 10),  // Changed default to 8443
  remoteHost: process.env.REMOTE_HOST || 'httpbin.org',
  remotePort: parseInt(process.env.REMOTE_PORT || '443', 10),
  timeout: parseInt(process.env.TIMEOUT || '60000', 10),
  logLevel: process.env.LOG_LEVEL || 'info'
};

// Statistics
const STATS = {
  activeConnections: 0,
  totalConnections: 0,
  totalBytesReceived: 0,
  totalBytesSent: 0,
  errors: 0,
  startTime: Date.now()
};

// Logger
const LOG_LEVELS = { debug: 0, info: 1, error: 2 };
const currentLogLevel = LOG_LEVELS[CONFIG.logLevel] || LOG_LEVELS.info;

function log(level, ...args) {
  if (LOG_LEVELS[level] >= currentLogLevel) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}]`, ...args);
  }
}

// DNS cache to reduce lookups
const dnsCache = new Map();
const DNS_CACHE_TTL = 300000; // 5 minutes

async function resolveHost(hostname) {
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
    log('debug', `DNS cache hit for ${hostname}: ${cached.ip}`);
    return cached.ip;
  }

  try {
    const addresses = await dns.resolve4(hostname);
    const ip = addresses[0];
    dnsCache.set(hostname, { ip, timestamp: Date.now() });
    log('debug', `Resolved ${hostname} to ${ip}`);
    return ip;
  } catch (err) {
    log('error', `DNS resolution failed for ${hostname}:`, err.message);
    throw err;
  }
}

// Handle individual client connection
async function handleConnection(clientSocket) {
  STATS.activeConnections++;
  STATS.totalConnections++;

  const clientId = `${clientSocket.remoteAddress}:${clientSocket.remotePort}`;
  log('info', `New connection from ${clientId} (Active: ${STATS.activeConnections})`);

  // Set socket options
  clientSocket.setTimeout(CONFIG.timeout);
  clientSocket.setKeepAlive(true, 30000);
  clientSocket.setNoDelay(true);

  let remoteSocket = null;
  let bytesReceived = 0;
  let bytesSent = 0;

  const cleanup = () => {
    STATS.activeConnections--;
    STATS.totalBytesReceived += bytesReceived;
    STATS.totalBytesSent += bytesSent;
    
    log('info', `Connection closed ${clientId} (Received: ${bytesReceived}, Sent: ${bytesSent}, Active: ${STATS.activeConnections})`);
    
    if (clientSocket && !clientSocket.destroyed) {
      clientSocket.destroy();
    }
    if (remoteSocket && !remoteSocket.destroyed) {
      remoteSocket.destroy();
    }
  };

  try {
    // Resolve remote host
    const remoteIp = await resolveHost(CONFIG.remoteHost);

    // Create connection to remote server
    remoteSocket = net.createConnection({
      host: remoteIp,
      port: CONFIG.remotePort,
      timeout: CONFIG.timeout
    });

    // Set remote socket options
    remoteSocket.setKeepAlive(true, 30000);
    remoteSocket.setNoDelay(true);

    // Wait for remote connection
    await new Promise((resolve, reject) => {
      remoteSocket.once('connect', resolve);
      remoteSocket.once('error', reject);
      setTimeout(() => reject(new Error('Connection timeout')), CONFIG.timeout);
    });

    log('debug', `Tunnel established for ${clientId} -> ${CONFIG.remoteHost}:${CONFIG.remotePort}`);

    // Track bytes transferred
    clientSocket.on('data', (chunk) => {
      bytesReceived += chunk.length;
      log('debug', `${clientId} -> Remote: ${chunk.length} bytes`);
    });

    remoteSocket.on('data', (chunk) => {
      bytesSent += chunk.length;
      log('debug', `Remote -> ${clientId}: ${chunk.length} bytes`);
    });

    // Bidirectional pipe (no inspection, pure TCP forwarding)
    clientSocket.pipe(remoteSocket);
    remoteSocket.pipe(clientSocket);

    // Error handlers
    clientSocket.on('error', (err) => {
      log('error', `Client socket error for ${clientId}:`, err.message);
      STATS.errors++;
      cleanup();
    });

    remoteSocket.on('error', (err) => {
      log('error', `Remote socket error for ${clientId}:`, err.message);
      STATS.errors++;
      cleanup();
    });

    // Timeout handlers
    clientSocket.on('timeout', () => {
      log('info', `Client timeout for ${clientId}`);
      cleanup();
    });

    remoteSocket.on('timeout', () => {
      log('info', `Remote timeout for ${clientId}`);
      cleanup();
    });

    // Close handlers
    clientSocket.on('close', () => {
      log('debug', `Client closed connection ${clientId}`);
      cleanup();
    });

    remoteSocket.on('close', () => {
      log('debug', `Remote closed connection for ${clientId}`);
      cleanup();
    });

  } catch (err) {
    log('error', `Connection error for ${clientId}:`, err.message);
    STATS.errors++;
    cleanup();
  }
}

// Create TCP server
const server = net.createServer((clientSocket) => {
  handleConnection(clientSocket).catch((err) => {
    log('error', 'Unhandled connection error:', err);
  });
});

// Server error handler
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('error', `Port ${CONFIG.localPort} is already in use`);
    log('error', 'Try a different port: LOCAL_PORT=8443 node tcp-proxy.js');
  } else if (err.code === 'EACCES') {
    log('error', `Permission denied to bind to port ${CONFIG.localPort}`);
    log('error', 'Ports below 1024 require root privileges');
    log('error', 'Solutions:');
    log('error', '  1. Use a non-privileged port: LOCAL_PORT=8443 node tcp-proxy.js');
    log('error', '  2. Run with sudo: sudo node tcp-proxy.js');
    log('error', '  3. Use setcap: sudo setcap cap_net_bind_service=+ep $(which node)');
  } else {
    log('error', 'Server error:', err);
  }
  process.exit(1);
});

// Start server
server.listen(CONFIG.localPort, '0.0.0.0', () => {
  log('info', '='.repeat(60));
  log('info', 'TCP Proxy Server Started');
  log('info', '='.repeat(60));
  log('info', `Listening on: 0.0.0.0:${CONFIG.localPort}`);
  log('info', `Forwarding to: ${CONFIG.remoteHost}:${CONFIG.remotePort}`);
  log('info', `Timeout: ${CONFIG.timeout}ms`);
  log('info', `Log Level: ${CONFIG.logLevel}`);
  log('info', '='.repeat(60));
  
  if (CONFIG.localPort < 1024) {
    log('info', 'NOTE: Running on privileged port (<1024)');
  }
});

// Statistics reporting
setInterval(() => {
  const uptime = Math.floor((Date.now() - STATS.startTime) / 1000);
  const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;
  
  log('info', 'Statistics:', {
    uptime: uptimeStr,
    active: STATS.activeConnections,
    total: STATS.totalConnections,
    received: `${(STATS.totalBytesReceived / 1024 / 1024).toFixed(2)} MB`,
    sent: `${(STATS.totalBytesSent / 1024 / 1024).toFixed(2)} MB`,
    errors: STATS.errors
  });
}, 60000); // Every minute

// Graceful shutdown
function shutdown(signal) {
  log('info', `Received ${signal}, shutting down gracefully...`);
  
  server.close(() => {
    log('info', 'Server closed');
    log('info', 'Final statistics:', {
      totalConnections: STATS.totalConnections,
      totalBytesReceived: STATS.totalBytesReceived,
      totalBytesSent: STATS.totalBytesSent,
      errors: STATS.errors
    });
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    log('error', 'Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Uncaught exception handler
process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log('error', 'Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});
