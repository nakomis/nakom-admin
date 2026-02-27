import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';

interface ToolRow { tool: string; uses: number; }

export default function ToolUsageChart({ rows }: { rows: ToolRow[] }) {
    if (rows.length === 0) return <Typography color="text.secondary">No tool usage data.</Typography>;
    const max = Math.max(...rows.map(r => Number(r.uses)));
    return (
        <Box>
            {rows.map(r => (
                <Box key={r.tool} sx={{ display: 'flex', alignItems: 'center', mb: 0.5, gap: 1 }}>
                    <Typography sx={{ minWidth: 200, fontFamily: 'monospace', fontSize: 13 }}>{r.tool}</Typography>
                    <Box sx={{ flexGrow: 1, bgcolor: 'grey.200', height: 18, borderRadius: 1, overflow: 'hidden' }}>
                        <Box sx={{
                            width: `${(Number(r.uses) / max) * 100}%`,
                            height: '100%',
                            bgcolor: 'primary.main',
                        }} />
                    </Box>
                    <Typography sx={{ minWidth: 40, textAlign: 'right', fontSize: 13 }}>{r.uses}</Typography>
                </Box>
            ))}
        </Box>
    );
}
