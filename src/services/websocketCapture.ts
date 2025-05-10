import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const DEFAULT_API_KEY = "AIzaSyDtC7Uwb5pGAsdmrH2T4Gqdk5Mga07jYPM";

interface CaptureOptions {
  character: 'maya' | 'miles';
  timeout?: number;
}

const FIREBASE_AUTH_BASE_URL = "https://identitytoolkit.googleapis.com/v1/accounts";
const FIREBASE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";

function getFirebaseClientHeader(): string {
  const today = new Date().toISOString().split('T')[0];
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

function getHeaders(_requestType: string): Record<string, string> {
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

function getEndpointUrl(requestType: string): string {
  if (requestType === 'refresh') {
    return FIREBASE_TOKEN_URL;
  } else {
    const endpoint = requestType === 'signup' ? 'signUp' : requestType;
    return `${FIREBASE_AUTH_BASE_URL}:${endpoint}`;
  }
}

export async function createAnonymousAccount(): Promise<{ idToken: string, refreshToken: string }> {
  const url = getEndpointUrl('signup');
  const headers = getHeaders('signup');
  const payload = { returnSecureToken: true };

  try {
    const response = await axios.post(url, payload, {
      headers,
      params: { key: DEFAULT_API_KEY }
    });

    if (response.data.error) {
      throw new Error(`API Error: ${response.data.error.message}`);
    }

    return {
      idToken: response.data.idToken,
      refreshToken: response.data.refreshToken
    };
  } catch (error: any) {
    throw error;
  }
}

export async function captureVoiceStream(options: CaptureOptions) {
  try {
    const sessionId = uuidv4();
    // No-op in this minimal version
  } catch (err: any) {
    throw err;
  }
}

export async function captureWebSocketUrl(options: CaptureOptions): Promise<string | null> {
  try {
    const { idToken } = await createAnonymousAccount();

    const baseUrl = "wss://sesameai.app/agent-service-0/v1/connect";
    const params = new URLSearchParams({
      id_token: idToken,
      client_name: 'RP-Web',
      usercontext: JSON.stringify({ timezone: 'America/Chicago' }),
      character: options.character.charAt(0).toUpperCase() + options.character.slice(1)
    });
    const websocketUrl = `${baseUrl}?${params.toString()}`;
    return websocketUrl;
  } catch (error: any) {
    return null;
  }
}
