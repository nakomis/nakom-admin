import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import { AnalyticsService } from '../services/analyticsService';

interface BlockEntry { ip: string; blockedAt: string; reason: string; }

export default function BlocklistPanel({
    entries,
    onRefresh,
}: {
    entries: BlockEntry[];
    onRefresh: () => void;
}) {
    const [newIp, setNewIp] = useState('');
    const [newReason, setNewReason] = useState('');
    const [busy, setBusy] = useState(false);

    const add = async () => {
        if (!newIp.trim()) return;
        setBusy(true);
        try {
            await AnalyticsService.addToBlocklist(newIp.trim(), newReason.trim());
            setNewIp('');
            setNewReason('');
            onRefresh();
        } finally {
            setBusy(false);
        }
    };

    const remove = async (ip: string) => {
        setBusy(true);
        try {
            await AnalyticsService.removeFromBlocklist(ip);
            onRefresh();
        } finally {
            setBusy(false);
        }
    };

    const sorted = [...entries].sort((a, b) =>
        new Date(b.blockedAt).getTime() - new Date(a.blockedAt).getTime()
    );

    return (
        <Box>
            <Box sx={{ display: 'flex', gap: 1, mb: 2, alignItems: 'flex-end' }}>
                <TextField
                    label="IP address"
                    size="small"
                    value={newIp}
                    onChange={e => setNewIp(e.target.value)}
                    sx={{ width: 200 }}
                />
                <TextField
                    label="Reason"
                    size="small"
                    value={newReason}
                    onChange={e => setNewReason(e.target.value)}
                    sx={{ width: 240 }}
                />
                <Button variant="contained" color="error" onClick={add} disabled={busy || !newIp.trim()}>
                    Block
                </Button>
            </Box>

            {sorted.length === 0
                ? <Typography color="text.secondary">No blocked IPs.</Typography>
                : (
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell>IP</TableCell>
                                <TableCell>Blocked at</TableCell>
                                <TableCell>Reason</TableCell>
                                <TableCell />
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {sorted.map(e => (
                                <TableRow key={e.ip} hover>
                                    <TableCell sx={{ fontFamily: 'monospace' }}>{e.ip}</TableCell>
                                    <TableCell>{new Date(e.blockedAt).toLocaleString()}</TableCell>
                                    <TableCell>{e.reason}</TableCell>
                                    <TableCell>
                                        <Button size="small" onClick={() => remove(e.ip)} disabled={busy}>
                                            Unblock
                                        </Button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )
            }
        </Box>
    );
}
