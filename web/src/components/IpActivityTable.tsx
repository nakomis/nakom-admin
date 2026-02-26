import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Button from '@mui/material/Button';

interface IpRow {
    ip: string;
    total_requests: number;
    active_days: number;
    first_seen: string;
    last_seen: string;
    rate_limit_hits: number;
}

export default function IpActivityTable({ rows, onBlock }: {
    rows: IpRow[];
    onBlock: (ip: string) => void;
}) {
    if (rows.length === 0) return null;
    return (
        <Table size="small" sx={{ fontFamily: 'monospace' }}>
            <TableHead>
                <TableRow>
                    <TableCell>IP</TableCell>
                    <TableCell align="right">Requests</TableCell>
                    <TableCell align="right">Days</TableCell>
                    <TableCell>First seen</TableCell>
                    <TableCell>Last seen</TableCell>
                    <TableCell align="right">Rate limits</TableCell>
                    <TableCell />
                </TableRow>
            </TableHead>
            <TableBody>
                {rows.map(r => (
                    <TableRow key={r.ip} hover>
                        <TableCell sx={{ fontFamily: 'monospace' }}>{r.ip}</TableCell>
                        <TableCell align="right">{r.total_requests}</TableCell>
                        <TableCell align="right">{r.active_days}</TableCell>
                        <TableCell>{new Date(r.first_seen).toLocaleDateString()}</TableCell>
                        <TableCell>{new Date(r.last_seen).toLocaleDateString()}</TableCell>
                        <TableCell align="right">{r.rate_limit_hits}</TableCell>
                        <TableCell>
                            <Button size="small" color="error" onClick={() => onBlock(r.ip)}>
                                + Block
                            </Button>
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    );
}
