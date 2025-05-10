import express from 'express';
import path from 'path';
import { captureWebSocketUrl } from './services/websocketCapture';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../public')));

app.get('/capture-websocket/:character', async (req, res) => {
  const character = req.params.character.toLowerCase();

  if (character !== 'miles' && character !== 'maya') {
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
      return res.json({ 
        success: true, 
        websocketUrl,
        character: character.charAt(0).toUpperCase() + character.slice(1),
        timestamp: new Date().toISOString()
      });
    } else {
      return res.json({ 
        success: false, 
        error: 'Failed to capture WebSocket URL' 
      });
    }
  } catch (error: any) {
    return res.json({
      success: false,
      error: error?.message || 'An unexpected error occurred',
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(typeof PORT === 'string' ? parseInt(PORT) : PORT, '0.0.0.0');
