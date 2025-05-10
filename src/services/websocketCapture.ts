import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const DEBUG = true;

// Default Firebase API key (from the Python config)
const DEFAULT_API_KEY = "AIzaSyDtC7Uwb5pGAsdmrH2T4Gqdk5Mga07jYPM";

interface CaptureOptions {
  character: 'maya' | 'miles';
  timeout?: number;
}

/**
 * Debug log helper
 */
function debugLog(msg: string, obj?: any) {
  if (DEBUG) {
    if (obj !== undefined) {
      // eslint-disable-next-line no-console
      console.log(`[websocketCapture DEBUG] ${msg}`, obj);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[websocketCapture DEBUG] ${msg}`);
    }
  }
}

// Firebase auth endpoints
const FIREBASE_AUTH_BASE_URL = "https://identitytoolkit.googleapis.com/v1/accounts";
const FIREBASE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";

/**
 * Generate Firebase client header value
 */
function getFirebaseClientHeader(): string {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const xFirebaseClient = {
    version: 2,
    heartbeats: [
      {
        agent: "fire-core/0.11.1 fire-core-esm2017/0.11.1 fire-js/ fire-js-all-app/11.3.1 fire-auth/1.9.0 fire-auth-esm2017/1.9.0",
        dates: [today]
      }
    ]
  };
  const xFirebaseClientJson = JSON.stringify(xFirebaseClient);
  return Buffer.from(xFirebaseClientJson).toString('base64');
}

/**
 * Get headers for Firebase API requests
 */
function getHeaders(requestType: string): Record<string, string> {
  return {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'x-firebase-client': getFirebaseClientHeader(),
    'x-client-data': 'COKQywE=',
    'x-client-version': 'Chrome/JsCore/11.3.1/FirebaseCore-web',
    'x-firebase-gmpid': '1:1072000975600:web:75b0bf3a9bb8d92e767835'
  };
}

/**
 * Get URL for Firebase API endpoints
 */
function getEndpointUrl(requestType: string): string {
  if (requestType === 'refresh') {
    return FIREBASE_TOKEN_URL;
  } else {
    const endpoint = requestType === 'signup' ? 'signUp' : requestType;
    return `${FIREBASE_AUTH_BASE_URL}:${endpoint}`;
  }
}

/**
 * Create an anonymous account with Firebase
 */
export async function createAnonymousAccount(): Promise<{ idToken: string, refreshToken: string }> {
  const url = getEndpointUrl('signup');
  const headers = getHeaders('signup');
  const payload = { returnSecureToken: true };

  debugLog('Creating anonymous Firebase account...', { url, headers, payload });

  try {
    const response = await axios.post(url, payload, {
      headers,
      params: { key: DEFAULT_API_KEY }
    });

    debugLog('Firebase signup response', response.data);

    if (response.data.error) {
      debugLog('API error during Firebase signup', response.data.error);
      throw new Error(`API Error: ${response.data.error.message}`);
    }

    return {
      idToken: response.data.idToken,
      refreshToken: response.data.refreshToken
    };
  } catch (error: any) {
    debugLog('Failed to create anonymous account', error?.response?.data || error);
    throw error;
  }
}

/**
 * Example: function to capture voice stream (add your real-time capture logic here)
 */
export async function captureVoiceStream(options: CaptureOptions) {
  debugLog('captureVoiceStream called', options);
  try {
    // Example: Log when a new capture session starts
    const sessionId = uuidv4();
    debugLog(`Starting capture session`, { sessionId, options });

    // Simulate the process (replace with actual logic)
    // ...

    // Example: Log successful completion
    debugLog(`Completed voice capture for session ${sessionId}`);
  } catch (err: any) {
    debugLog('Error during voice capture stream', err);
    throw err;
  }
}

/**
 * Public: Returns a websocket URL for the given character
 */
export async function captureWebSocketUrl(options: CaptureOptions): Promise<string | null> {
  debugLog('captureWebSocketUrl called', options);
  try {
    // 1. Create anonymous Firebase account (get idToken)
    const { idToken } = await createAnonymousAccount();
    debugLog('Obtained idToken', idToken ? idToken.substring(0, 12) + '...' : null);

    // 2. Construct the websocket URL
    // Example endpoint:
    // wss://sesameai.app/agent-service-0/v1/connect?id_token=...&client_name=RP-Web&usercontext=%7B%22timezone%22%3A%22America%2FChicago%22%7D&character=Maya
    const baseUrl = "wss://sesameai.app/agent-service-0/v1/connect";
    const params = new URLSearchParams({
      id_token: idToken,
      client_name: 'RP-Web',
      usercontext: JSON.stringify({ timezone: 'America/Chicago' }),
      character: options.character.charAt(0).toUpperCase() + options.character.slice(1)
    });
    const websocketUrl = `${baseUrl}?${params.toString()}`;

    debugLog('Constructed websocket URL', websocketUrl);

    return websocketUrl;
  } catch (error: any) {
    debugLog('Error in captureWebSocketUrl', error?.message || error);
    return null;
  }
}
