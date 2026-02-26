import Config from '../config/config';

async function apiCall<T>(path: string, method = 'GET', body?: object): Promise<T> {
    const idToken = (window as any).__oidc_user?.id_token;
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
