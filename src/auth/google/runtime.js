import { getClientVersion, generateSmartUserAgent } from './version-detector.js';
// Runtime adapter for the reference Antigravity onboarding implementation.
export const ANTIGRAVITY_ENDPOINT_FALLBACKS = ['https://daily-cloudcode-pa.googleapis.com', 'https://cloudcode-pa.googleapis.com'];
export const ONBOARD_USER_ENDPOINTS = ANTIGRAVITY_ENDPOINT_FALLBACKS;
export const CLIENT_METADATA = { ideType: 9, platform: process.platform === 'win32' ? 5 : process.platform === 'darwin' ? (process.arch === 'arm64' ? 2 : 1) : process.platform === 'linux' ? (process.arch === 'arm64' ? 4 : 3) : 0, pluginType: 2 };
export const ANTIGRAVITY_HEADERS = { 'User-Agent': generateSmartUserAgent(), 'X-Client-Version': getClientVersion(), 'Content-Type': 'application/json', 'X-Client-Name': 'antigravity', 'x-goog-api-client': 'gl-node/18.18.2 fire/0.8.6 grpc/1.10.x' };
export const LOAD_CODE_ASSIST_HEADERS = ANTIGRAVITY_HEADERS;
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Do not log upstream payloads or credentials in the admin plane.
export const logger = { debug() {}, info() {}, warn() {}, success() {} };
export const throttledFetch = (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
