// Copied from antigravity-claude-proxy/src/auth/oauth.js; see ../oauth-license.txt.
import { ANTIGRAVITY_ENDPOINT_FALLBACKS, LOAD_CODE_ASSIST_HEADERS, CLIENT_METADATA, logger, throttledFetch } from './runtime.js';
import { onboardUser, getDefaultTierId } from './onboarding.js';

export async function discoverProjectId(accessToken) {
    let loadCodeAssistData = null;

    for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
        try {
            const response = await throttledFetch(`${endpoint}/v1internal:loadCodeAssist`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                    ...LOAD_CODE_ASSIST_HEADERS
                },
                body: JSON.stringify({
                    metadata: CLIENT_METADATA,
                    mode: 1
                })
            });

            if (!response.ok) continue;

            const data = await response.json();
            loadCodeAssistData = data;

            if (typeof data.cloudaicompanionProject === 'string') {
                return data.cloudaicompanionProject;
            }
            if (data.cloudaicompanionProject?.id) {
                return data.cloudaicompanionProject.id;
            }

            // No project found - try to onboard
            logger.info('[OAuth] No project in loadCodeAssist response, attempting onboardUser...');
            break;
        } catch (error) {
            logger.warn(`[OAuth] Project discovery failed at ${endpoint}:`, error.message);
        }
    }

    // Try onboarding if we got a response but no project
    if (loadCodeAssistData) {
        const tierId = getDefaultTierId(loadCodeAssistData.allowedTiers) || 'FREE';
        logger.info(`[OAuth] Onboarding user with tier: ${tierId}`);

        const onboardedProject = await onboardUser(accessToken, tierId);
        if (onboardedProject) {
            logger.success(`[OAuth] Successfully onboarded, project: ${onboardedProject}`);
            return onboardedProject;
        }
    }

    return null;
}

