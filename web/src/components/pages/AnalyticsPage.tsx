/**
 * The Analytics tab, after Aurora (ADMIN-8/9/10).
 *
 * What changed and why:
 *
 *   * **The Aurora Database section is gone.** Start/stop/snapshot/restore
 *     existed because the console's data lived in a cluster that cost money to
 *     leave running, so someone had to turn it on before reading anything and
 *     remember to turn it off. The data now lives on Luke, which is on anyway.
 *     Nothing here starts or stops.
 *   * **Tool usage and IP activity come from Cal**, not from `/query/{type}`
 *     against Aurora. Same shapes, same panels — see cvChatService.
 *   * **The 2D similarity graph and the UMAP embedding view are gone**, both
 *     replaced by the 3D graph on its own tab. They existed as two views of
 *     the same relationships, and the 3D one is the same relationships again.
 *     Keeping all three would mean three things to keep in step.
 *
 * What stayed on AWS, deliberately: the CloudFront log miner (CloudWatch
 * Logs) and the IP blocklist (DynamoDB). Neither ever touched Aurora, and
 * neither has anything to do with the home estate.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { AnalyticsService } from '../../services/analyticsService';
import { CvChatService, type CvChatStats } from '../../services/cvChatService';
import ToolUsageChart from '../ToolUsageChart';
import IpActivityTable from '../IpActivityTable';
import LogMiner from '../LogMiner';
import BlocklistPanel from '../BlocklistPanel';
import { Credentials } from '@aws-sdk/client-cognito-identity';

/** Where Cal is reached, matching CvChatGraphPage. */
const CAL_API = 'https://api.cal.home.nakomis.com';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <Box sx={{
            mb: 3,
            p: 3,
            background: 'linear-gradient(135deg, #1e1e1e 0%, #2d2d2d 100%)',
            borderRadius: '12px',
            border: '1px solid #404040',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}>
            <Typography variant="h6" sx={{ mb: 2, fontWeight: 600 }}>{title}</Typography>
            {children}
        </Box>
    );
}

export default function AnalyticsPage({ creds, token }: { creds: Credentials; token: string }) {
    const service = useMemo(() => new AnalyticsService(creds), [creds]);
    const cal = useMemo(() => new CvChatService(CAL_API, token), [token]);

    const [stats, setStats] = useState<CvChatStats | null>(null);
    const [calError, setCalError] = useState<string | null>(null);
    const [calLoading, setCalLoading] = useState(false);

    const [blocklist, setBlocklist] = useState<any[]>([]);
    const [importResult, setImportResult] = useState<string | null>(null);
    const [importing, setImporting] = useState(false);

    const loadCal = useCallback(async () => {
        setCalLoading(true);
        setCalError(null);
        try {
            setStats(await cal.stats());
        } catch (e) {
            setCalError(e instanceof Error ? e.message : String(e));
            setStats(null);
        } finally {
            setCalLoading(false);
        }
    }, [cal]);

    useEffect(() => { void loadCal(); }, [loadCal]);

    const refreshBlocklist = useCallback(async () => {
        try {
            setBlocklist(await service.getBlocklist() ?? []);
        } catch {
            // Silent: this runs on mount and the SigV4 credentials may not be
            // ready yet. The panel has its own refresh button.
        }
    }, [service]);

    useEffect(() => { void refreshBlocklist(); }, [refreshBlocklist]);

    const handleBlock = async (ip: string, reason: string) => {
        await service.addToBlocklist(ip, reason);
        await refreshBlocklist();
    };

    /**
     * Kicks the forwarder. It now enqueues onto SQS for Cal rather than
     * embedding with Bedrock and writing to Aurora, so "done" means *queued* —
     * the rows appear once Cal has embedded them, which is not instant.
     */
    const importNow = async () => {
        setImporting(true);
        try {
            const r = await service.importGenerate();
            setImportResult(
                r.queued === 0
                    ? 'Nothing new to forward.'
                    : `Queued ${r.queued} record(s) for Cal. They appear here once embedded.`,
            );
        } catch (e: any) {
            setImportResult(`Error: ${e.message}`);
        } finally {
            setImporting(false);
        }
    };

    return (
        <Box sx={{ p: 3, maxWidth: 1200 }}>
            {calError && (
                <Alert
                    severity="error"
                    sx={{ mb: 3 }}
                    action={<Button color="inherit" size="small" onClick={() => void loadCal()}>Retry</Button>}
                >
                    {calError}
                </Alert>
            )}

            <Section title="Ingest">
                <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Button variant="contained" color="secondary" disabled={importing} onClick={importNow}>
                        ↓ Forward new records
                    </Button>
                    {importing && <CircularProgress size={20} />}
                    <Button variant="outlined" size="small" disabled={calLoading} onClick={() => void loadCal()}>
                        Refresh
                    </Button>
                    {calLoading && <CircularProgress size={18} />}
                </Box>
                {importResult && (
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                        {importResult}
                    </Typography>
                )}
                {stats && (
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                        {stats.total_records.toLocaleString()} record(s) stored,{' '}
                        {stats.embedded_records.toLocaleString()} embedded,{' '}
                        {stats.edges.toLocaleString()} similarity edge(s).
                    </Typography>
                )}
            </Section>

            {stats && stats.tools.length > 0 && (
                <Section title="Tool usage">
                    <ToolUsageChart rows={stats.tools} />
                </Section>
            )}

            {stats && stats.ips.length > 0 && (
                <Section title="IP activity">
                    <IpActivityTable
                        rows={stats.ips}
                        onBlock={(ip) => handleBlock(ip, 'manual block')}
                    />
                </Section>
            )}

            <Section title="CloudFront log miner">
                <LogMiner service={service} onBlock={handleBlock} />
            </Section>

            <Section title="IP blocklist">
                <BlocklistPanel service={service} entries={blocklist} onRefresh={refreshBlocklist} />
            </Section>
        </Box>
    );
}
