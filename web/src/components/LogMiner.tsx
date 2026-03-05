import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { AnalyticsService } from '../services/analyticsService';

const FLAG_COLORS: Record<string, 'error' | 'warning' | 'default'> = {
    SCANNER: 'error',
    HIGH_VOLUME: 'warning',
};

const FLAG_DESCRIPTIONS: Record<string, string> = {
    SCANNER: 'High proportion of requests for known scanner paths (e.g. /.env, /wp-admin, /phpmyadmin)',
    HIGH_VOLUME: 'Unusually high request volume compared to other IPs in the period',
};

// Known crawler PTR hostname patterns → friendly label
const CRAWLER_PATTERNS: Array<{ re: RegExp; label: string }> = [
    { re: /\.googlebot\.com\.?$/i,   label: 'Googlebot' },
    { re: /\.google\.com\.?$/i,      label: 'Google' },
    { re: /\.search\.msn\.com\.?$/i, label: 'Bingbot' },
    { re: /\.crawl\.yahoo\.net\.?$/i,label: 'Yahoo' },
    { re: /\.crawl\.baidu\.com\.?$/i,label: 'Baidu' },
    { re: /\.yandex\.(ru|com)\.?$/i, label: 'Yandex' },
    { re: /\.semrush\.com\.?$/i,     label: 'SEMrush' },
    { re: /\.ahrefs\.com\.?$/i,      label: 'Ahrefs' },
    { re: /\.moz\.com\.?$/i,         label: 'Moz' },
];

async function checkCrawler(ip: string): Promise<string | null> {
    // Reverse the IP octets for PTR lookup: 1.2.3.4 → 4.3.2.1.in-addr.arpa
    const ptr = ip.split('.').reverse().join('.') + '.in-addr.arpa';
    try {
        const res = await fetch(
            `https://cloudflare-dns.com/dns-query?name=${ptr}&type=PTR`,
            { headers: { Accept: 'application/dns-json' } },
        );
        if (!res.ok) return null;
        const data = await res.json();
        const hostnames: string[] = (data.Answer ?? []).map((a: any) => a.data as string);
        for (const host of hostnames) {
            for (const { re, label } of CRAWLER_PATTERNS) {
                if (re.test(host)) return label;
            }
        }
    } catch {
        // Network failure — silently ignore
    }
    return null;
}

export default function LogMiner({ service, onBlock }: { service: AnalyticsService; onBlock: (ip: string, reason: string) => void }) {
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<any | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [crawlerIds, setCrawlerIds] = useState<Record<string, string | null>>({});
    const [crawlerChecking, setCrawlerChecking] = useState(false);

    const mine = async (days: number) => {
        setLoading(true);
        setError(null);
        setCrawlerIds({});
        try {
            const r = await service.mineLogs(days);
            setResult(r);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    const identifyCrawlers = async () => {
        if (!result) return;
        setCrawlerChecking(true);
        const entries = await Promise.all(
            (result.suspects ?? []).map(async (s: any) => [s.ip, await checkCrawler(s.ip)] as [string, string | null])
        );
        setCrawlerIds(Object.fromEntries(entries));
        setCrawlerChecking(false);
    };

    return (
        <Box>
            <Box sx={{ display: 'flex', gap: 2, mb: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button variant="outlined" onClick={() => mine(7)} disabled={loading}>Last 7 days</Button>
                <Button variant="outlined" onClick={() => mine(30)} disabled={loading}>Last 30 days</Button>
                {result && (
                    <Button variant="outlined" onClick={identifyCrawlers} disabled={crawlerChecking || loading}>
                        Identify crawlers
                    </Button>
                )}
                {(loading || crawlerChecking) && <CircularProgress size={20} />}
            </Box>
            {error && <Typography color="error">{error}</Typography>}
            {result && (
                <Box>
                    <Typography variant="caption" color="text.secondary">
                        {result.period} — {result.filesScanned} files scanned
                    </Typography>
                    <TableContainer sx={{ maxHeight: 400, mt: 1 }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell>IP</TableCell>
                                <TableCell align="right">Requests</TableCell>
                                <TableCell align="right">Scanner rate</TableCell>
                                <TableCell align="right">Error rate</TableCell>
                                <TableCell>Flags</TableCell>
                                {Object.keys(crawlerIds).length > 0 && <TableCell>Crawler</TableCell>}
                                <TableCell />
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {(result.suspects ?? []).map((s: any) => (
                                <TableRow key={s.ip} hover>
                                    <TableCell sx={{ fontFamily: 'monospace' }}>{s.ip}</TableCell>
                                    <TableCell align="right">{s.totalRequests}</TableCell>
                                    <TableCell align="right">{(s.scannerHitRate * 100).toFixed(1)}%</TableCell>
                                    <TableCell align="right">{(s.errorRate * 100).toFixed(1)}%</TableCell>
                                    <TableCell>
                                        {(s.flags ?? []).map((f: string) => (
                                            <Tooltip key={f} title={FLAG_DESCRIPTIONS[f] ?? f} arrow>
                                                <Chip label={f} size="small" color={FLAG_COLORS[f] ?? 'default'} sx={{ mr: 0.5 }} />
                                            </Tooltip>
                                        ))}
                                    </TableCell>
                                    {Object.keys(crawlerIds).length > 0 && (
                                        <TableCell>
                                            {s.ip in crawlerIds
                                                ? crawlerIds[s.ip]
                                                    ? <Chip label={crawlerIds[s.ip]!} size="small" color="success" />
                                                    : <Typography variant="caption" color="text.disabled">—</Typography>
                                                : null}
                                        </TableCell>
                                    )}
                                    <TableCell>
                                        <Button size="small" color="error" onClick={() => onBlock(s.ip, s.flags.join(', '))}>
                                            + Block
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                    </TableContainer>
                </Box>
            )}
        </Box>
    );
}
