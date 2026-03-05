import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
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

export default function LogMiner({ service, onBlock }: { service: AnalyticsService; onBlock: (ip: string, reason: string) => void }) {
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<any | null>(null);
    const [error, setError] = useState<string | null>(null);

    const mine = async (days: number) => {
        setLoading(true);
        setError(null);
        try {
            const r = await service.mineLogs(days);
            setResult(r);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <Box>
            <Box sx={{ display: 'flex', gap: 2, mb: 2, alignItems: 'center' }}>
                <Button variant="outlined" onClick={() => mine(7)} disabled={loading}>Last 7 days</Button>
                <Button variant="outlined" onClick={() => mine(30)} disabled={loading}>Last 30 days</Button>
                {loading && <CircularProgress size={20} />}
            </Box>
            {error && <Typography color="error">{error}</Typography>}
            {result && (
                <Box>
                    <Typography variant="caption" color="text.secondary">
                        {result.period} — {result.filesScanned} files scanned
                    </Typography>
                    <Table size="small" sx={{ mt: 1 }}>
                        <TableHead>
                            <TableRow>
                                <TableCell>IP</TableCell>
                                <TableCell align="right">Requests</TableCell>
                                <TableCell align="right">Scanner rate</TableCell>
                                <TableCell align="right">Error rate</TableCell>
                                <TableCell>Flags</TableCell>
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
                                    <TableCell>
                                        <Button size="small" color="error" onClick={() => onBlock(s.ip, s.flags.join(', '))}>
                                            + Block
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </Box>
            )}
        </Box>
    );
}
