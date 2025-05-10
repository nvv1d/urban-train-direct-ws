import express from 'express';
import path from 'path';
import { captureWebSocketUrl } from './services/websocketCapture';

const DEBUG = true;
const app = express();
const PORT = process.env.PORT || 3000;

function debugLog(msg: string, obj?: any) {
  if (DEBUG) {
    if (obj) {
      // eslint-disable-next-line no-console
      console.log(`[index.ts DEBUG] ${msg}`, obj);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[index.ts DEBUG] ${msg}`);
    }
  }
}

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

app.use((req, res, next) => {
  debugLog(`Incoming request: ${req.method} ${req.url}`);
  next();
});

/**
 * API endpoint to capture WebSocket URL for a specified character
 */
app.get('/capture-websocket/:character', async (req, res) => {
  const character = req.params.character.toLowerCase();

  debugLog('Requested WebSocket for character', character);

  if (character !== 'miles' && character !== 'maya') {
    debugLog('Invalid character requested', character);
    return res.status(400).json({
      success: false,
      error: 'Invalid character. Must be "miles" or "maya".'
    });
  }

  try {
    const websocketUrl = await captureWebSocketUrl({
      character: character as 'miles' | 'maya'
    });

    if (websocketUrl) {
      debugLog('WebSocket URL generated', websocketUrl);
      return res.json({ 
        success: true, 
        websocketUrl,
        character: character.charAt(0).toUpperCase() + character.slice(1),
        timestamp: new Date().toISOString()
      });
    } else {
      debugLog('Failed to generate WebSocket URL');
      return res.json({ 
        success: false, 
        error: 'Failed to capture WebSocket URL' 
      });
    }
  } catch (error: any) {
    debugLog('Error capturing WebSocket URL:', error);
    return res.json({
      success: false,
      error: error?.message || 'An unexpected error occurred',
      timestamp: new Date().toISOString()
    });
  }
});

// Test endpoint for verifying the service is running
app.get('/health', (_req, res) => {
  debugLog('Health check endpoint hit');
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Catch-all route to serve index.html for any unmatched routes
app.get('*', (req, res) => {
  debugLog('Catch-all route hit, serving index.html');
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Start the server
const server = app.listen(
  typeof PORT === 'string' ? parseInt(PORT) : PORT,
  '0.0.0.0',
  () => {
    debugLog('Server started and listening', { port: PORT, env: process.env.NODE_ENV });
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Available endpoints:`);
    console.log(`- GET /capture-websocket/:character - Generate WebSocket URL for Maya or Miles`);
    console.log(`- GET /health - Check service health`);
  }
);

// Graceful shutdown
function shutdown() {
  debugLog('Shutting down server...');
  server.close(() => {
    debugLog('HTTP server closed.');
    process.exit(0);
  });
  setTimeout(() => {
    debugLog('Forcefully exiting after timeout.');
    process.exit(1);
  }, 10000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle unhandled promise rejections and uncaught exceptions
process.on('unhandledRejection', (reason, promise) => {
  debugLog('Unhandled Rejection at:', { promise, reason });
});
process.on('uncaughtException', (err) => {
  debugLog('Uncaught Exception thrown:', err);
  process.exit(1);
});
