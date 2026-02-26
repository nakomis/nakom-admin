import Config from '../config/config';

async function apiCall<T>(path: string, method = 'GET', body?: object): Promise<T> {
    // Get token from react-oidc-context's storage
    let idToken: string | undefined;

    // Check localStorage for oidc.user key with our configuration
    const storageKey = `oidc.user:${Config.cognito.authority}:${Config.cognito.userPoolClientId}`;
    try {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
            const userData = JSON.parse(stored);
            idToken = userData.access_token;
            console.log('Token found in localStorage:', !!idToken);
        } else {
            console.warn('No user data in localStorage for key:', storageKey);
        }
    } catch (e) {
        console.warn('Failed to get token from localStorage:', e);
    }

    if (!idToken) {
        console.error('No access token found - user may not be authenticated');
    }
    const res = await fetch(`${Config.apiEndpoint}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`API ${method} ${path} → ${res.status}`);
    return res.json();
}

export const AnalyticsService = {
    getRdsStatus: () => apiCall<{ status: string; endpoint?: string }>('/rds/status'),
    startRds: () => apiCall('/rds/start', 'POST'),
    stopRds: () => apiCall('/rds/stop', 'POST'),
    takeSnapshot: () => apiCall('/rds/snapshot', 'POST'),
    listSnapshots: () => apiCall<any[]>('/rds/snapshots'),
    restoreSnapshot: () => apiCall('/rds/restore', 'POST'),
    importGenerate: () => apiCall<{ queued: number }>('/import/generate', 'POST'),
    query: (queryType: string, params?: object) =>
        apiCall<any[]>(`/query/${queryType}`, 'POST', params),
    mineLogs: (days: number) => apiCall<any>('/logs/mine', 'POST', { days }),
    getBlocklist: () => apiCall<any[]>('/blocklist'),
    addToBlocklist: (ip: string, reason: string) =>
        apiCall('/blocklist', 'POST', { action: 'add', ip, reason }),
    removeFromBlocklist: (ip: string) =>
        apiCall(`/blocklist/${encodeURIComponent(ip)}`, 'DELETE'),
};
