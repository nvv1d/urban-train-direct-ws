import express from 'express';
import path from 'path';
import { captureWebSocketUrl } from './services/websocketCapture';

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

/**
 * API endpoint to capture WebSocket URL for a specified character
 */
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
      // Minimal logging for performance
      
      return res.json({ 
        success: true, 
        websocketUrl,
        character: character.charAt(0).toUpperCase() + character.slice(1),
        timestamp: new Date().toISOString()
      });
    } else {
      console.error('Failed to generate WebSocket URL');
      return res.json({ 
        success: false, 
        error: 'Failed to capture WebSocket URL' 
      });
    }
  } catch (error: any) {
    console.error('Error capturing WebSocket URL:', error);
    return res.json({ 
      success: false, 
      error: error?.message || 'An unexpected error occurred',
      timestamp: new Date().toISOString()
    });
  }
});

// Test endpoint for verifying the service is running
app.get('/health', (_req, res) => {
  res.json({ 
    status: 'ok',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Start the server
app.listen(typeof PORT === 'string' ? parseInt(PORT) : PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Available endpoints:`);
  console.log(`- GET /capture-websocket/:character - Generate WebSocket URL for Maya or Miles`);
  console.log(`- GET /health - Check service health`);
});
