import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Slider from '@mui/material/Slider';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import { AnalyticsService } from '../../services/analyticsService';
import SimilarityGraph from '../SimilarityGraph';
import ToolUsageChart from '../ToolUsageChart';
import IpActivityTable from '../IpActivityTable';
import LogMiner from '../LogMiner';
import BlocklistPanel from '../BlocklistPanel';
import { Credentials } from '@aws-sdk/client-cognito-identity';

function StatusChip({ status }: { status: string }) {
    const color = status === 'available' ? 'success'
        : status === 'stopped' ? 'default'
        : 'warning';
    return <Chip label={status} color={color as any} size="small" />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <Box sx={{ mb: 4 }}>
            <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>{title}</Typography>
            {children}
        </Box>
    );
}

export default function AnalyticsPage({ creds }: { creds: Credentials }) {
    const service = useMemo(() => new AnalyticsService(creds), [creds]);
    const [rdsStatus, setRdsStatus] = useState<string>('unknown');
    const [rdsEndpoint, setRdsEndpoint] = useState<string | undefined>();
    const [statusLoading, setStatusLoading] = useState(false);
    const [actionLoading, setActionLoading] = useState(false);
    const [importResult, setImportResult] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const [shutdownAt, setShutdownAt] = useState<string | null>(null);
    const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Similarity graph
    const [nodes, setNodes] = useState<any[]>([]);
    const [edges, setEdges] = useState<any[]>([]);
    const [threshold, setThreshold] = useState(0.85);
    const [graphLoading, setGraphLoading] = useState(false);
    const [graphError, setGraphError] = useState<string | null>(null);

    // Tool usage & IP activity
    const [toolRows, setToolRows] = useState<any[]>([]);
    const [ipRows, setIpRows] = useState<any[]>([]);
    const [analyticsError, setAnalyticsError] = useState<string | null>(null);

    // Blocklist
    const [blocklist, setBlocklist] = useState<any[]>([]);

    const fetchStatus = useCallback(async () => {
        setStatusLoading(true);
        try {
            const r = await service.getRdsStatus();
            setRdsStatus(r.status);
            setRdsEndpoint(r.endpoint);
        } catch {
            setRdsStatus('error');
        } finally {
            setStatusLoading(false);
        }
    }, [service]);

    const fetchTimer = useCallback(async () => {
        try {
            const r = await service.getTimer();
            setShutdownAt(r.shutdownAt ?? null);
        } catch {
            // non-fatal — timer display just won't show
        }
    }, [service]);

    useEffect(() => { fetchStatus(); }, [fetchStatus]);
    useEffect(() => { fetchTimer(); }, [fetchTimer]);

    useEffect(() => {
        if (!shutdownAt) {
            if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
            setSecondsLeft(null);
            return;
        }
        const tick = () => {
            const secs = Math.max(0, Math.round((new Date(shutdownAt).getTime() - Date.now()) / 1000));
            setSecondsLeft(secs);
            if (secs === 0) {
                clearInterval(timerRef.current!);
                timerRef.current = null;
                setShutdownAt(null);
            }
        };
        tick();
        timerRef.current = setInterval(tick, 1000);
        return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
    }, [shutdownAt]);

    // Poll while transitioning
    useEffect(() => {
        if (rdsStatus === 'starting' || rdsStatus === 'stopping') {
            if (!pollRef.current) {
                pollRef.current = setInterval(fetchStatus, 5000);
            }
        } else {
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
            }
        }
        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
        };
    }, [rdsStatus, fetchStatus]);

    const rdsAction = async (action: () => Promise<any>) => {
        setActionLoading(true);
        try {
            await action();
            await fetchStatus();
        } finally {
            setActionLoading(false);
        }
    };

    const importNow = async () => {
        setActionLoading(true);
        try {
            const r = await service.importGenerate();
            setImportResult(`Queued ${r.queued} records`);
        } catch (e: any) {
            setImportResult(`Error: ${e.message}`);
        } finally {
            setActionLoading(false);
        }
    };

    const extendTimer = async () => {
        setActionLoading(true);
        try {
            const r = await service.extendTimer();
            setShutdownAt(r.shutdownAt);
        } catch (e: any) {
            console.error('Failed to extend timer', e);
        } finally {
            setActionLoading(false);
        }
    };

    const loadGraph = useCallback(async (t: number) => {
        setGraphLoading(true);
        setGraphError(null);
        try {
            const [n, e] = await Promise.all([
                service.query('nodes'),
                service.query('similarity_graph', { threshold: t }),
            ]);
            setNodes(n ?? []);
            setEdges(e ?? []);
        } catch (e: any) {
            setGraphError(e?.message ?? 'Failed to load analytics');
        } finally {
            setGraphLoading(false);
        }
    }, [service]);

    const loadAnalytics = useCallback(async () => {
        setAnalyticsError(null);
        try {
            const [tools, ips, bl] = await Promise.all([
                service.query('tool_usage'),
                service.query('ip_activity'),
                service.getBlocklist(),
            ]);
            setToolRows(tools ?? []);
            setIpRows(ips ?? []);
            setBlocklist(bl ?? []);
        } catch (e: any) {
            setAnalyticsError(e?.message ?? 'Failed to load analytics');
        }
    }, [service]);

    const refreshBlocklist = async () => {
        const bl = await service.getBlocklist();
        setBlocklist(bl ?? []);
    };

    const handleBlock = async (ip: string, reason: string) => {
        await service.addToBlocklist(ip, reason);
        await refreshBlocklist();
    };

    const formatCountdown = (secs: number) => {
        const m = Math.floor(secs / 60).toString().padStart(2, '0');
        const s = (secs % 60).toString().padStart(2, '0');
        return `${m}:${s}`;
    };

    return (
        <Box sx={{ p: 3, maxWidth: 1200 }}>

            {/* RDS Control */}
            <Section title="RDS Control">
                <Card>
                    <CardContent>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                <Typography>Status:</Typography>
                                {statusLoading
                                    ? <CircularProgress size={16} />
                                    : <StatusChip status={rdsStatus} />}
                                {rdsEndpoint && (
                                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                                        {rdsEndpoint}
                                    </Typography>
                                )}
                            </Box>
                            <Button variant="outlined" size="small" onClick={fetchStatus} disabled={statusLoading}>
                                Refresh
                            </Button>
                        </Box>
                        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 2 }}>
                            <Button
                                variant="contained"
                                disabled={actionLoading || rdsStatus === 'available'}
                                onClick={async () => { await rdsAction(() => service.startRds()); await fetchTimer(); }}
                            >
                                ▶ Start RDS
                            </Button>
                            <Button
                                variant="outlined"
                                disabled={actionLoading || rdsStatus !== 'available'}
                                onClick={async () => { await rdsAction(() => service.takeSnapshot()); setShutdownAt(null); }}
                            >
                                ● Backup &amp; Stop
                            </Button>
                            <Button
                                variant="outlined"
                                disabled={actionLoading || rdsStatus !== 'available'}
                                onClick={async () => { await rdsAction(() => service.stopRds()); setShutdownAt(null); }}
                            >
                                ■ Stop RDS
                            </Button>
                            <Button
                                variant="outlined"
                                color="warning"
                                disabled={actionLoading}
                                onClick={() => rdsAction(() => service.restoreSnapshot())}
                            >
                                ⟳ Restore snapshot
                            </Button>
                            <Button
                                variant="contained"
                                color="secondary"
                                disabled={actionLoading || rdsStatus !== 'available'}
                                onClick={importNow}
                            >
                                ↓ Import now
                            </Button>
                            {actionLoading && <CircularProgress size={20} />}
                        </Box>
                        {importResult && (
                            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                                {importResult}
                            </Typography>
                        )}
                        {secondsLeft !== null && (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}>
                                <Typography variant="body2" color="text.secondary">
                                    ⏱ {formatCountdown(secondsLeft)} remaining
                                </Typography>
                                <Button
                                    size="small"
                                    variant="outlined"
                                    onClick={extendTimer}
                                    disabled={actionLoading}
                                >
                                    Extend Time
                                </Button>
                            </Box>
                        )}
                    </CardContent>
                </Card>
            </Section>

            <Divider sx={{ my: 3 }} />

            {/* Analytics — only visible when RDS is up */}
            <Box sx={{ display: 'flex', gap: 2, mb: 3, alignItems: 'center' }}>
                <Button variant="outlined" onClick={() => { loadGraph(threshold); loadAnalytics(); }}>
                    Load analytics
                </Button>
                {graphLoading && <CircularProgress size={20} />}
                {graphError && (
                    <Typography color="error" variant="caption">{graphError}</Typography>
                )}
                {analyticsError && (
                    <Typography color="error" variant="caption">{analyticsError}</Typography>
                )}
            </Box>

            {/* Similarity graph */}
            {nodes.length > 0 && (
                <Section title="Semantic similarity graph">
                    <Box sx={{ mb: 2, maxWidth: 400 }}>
                        <Typography gutterBottom>Similarity threshold: {threshold}</Typography>
                        <Slider
                            min={0.7} max={0.99} step={0.01}
                            value={threshold}
                            onChange={(_, v) => setThreshold(v as number)}
                            onChangeCommitted={(_, v) => loadGraph(v as number)}
                        />
                    </Box>
                    <SimilarityGraph nodes={nodes} edges={edges} />
                </Section>
            )}

            {/* Tool usage */}
            {toolRows.length > 0 && (
                <Section title="Tool usage">
                    <ToolUsageChart rows={toolRows} />
                </Section>
            )}

            {/* IP activity */}
            {ipRows.length > 0 && (
                <Section title="IP activity">
                    <IpActivityTable rows={ipRows} onBlock={ip => handleBlock(ip, 'manual block')} />
                </Section>
            )}

            <Divider sx={{ my: 3 }} />

            {/* Log miner */}
            <Section title="CloudFront log miner">
                <LogMiner service={service} onBlock={handleBlock} />
            </Section>

            <Divider sx={{ my: 3 }} />

            {/* Blocklist */}
            <Section title="IP blocklist">
                <BlocklistPanel service={service} entries={blocklist} onRefresh={refreshBlocklist} />
            </Section>
        </Box>
    );
}
