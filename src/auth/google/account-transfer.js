// Backward-compatible Google entry points over the generic transfer module.
export { TRANSFER_VERSION, TRANSFERABLE_PROVIDERS } from '../account-transfer.js';
import { buildAccountExport, normalizeAccountImport } from '../account-transfer.js';
export const buildGoogleExport = accounts => buildAccountExport('google', accounts);
export const normalizeGoogleImport = input => normalizeAccountImport('google', input);
