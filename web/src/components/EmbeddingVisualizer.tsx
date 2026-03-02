import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { UMAP } from 'umap-js';
import Plotly from 'plotly.js-dist-min';
import { AnalyticsService, EmbeddingRecord } from '../services/analyticsService';

type Status = 'idle' | 'fetching' | 'reducing' | 'done' | 'error';

// Stable sequence of colours for country groups
const PALETTE = [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];

function buildTraces(records: EmbeddingRecord[], coords: number[][]): Plotly.Data[] {
    // Group by country so each gets its own legend entry and colour
    const groups = new Map<string, { x: number[]; y: number[]; z: number[]; text: string[] }>();

    records.forEach((r, i) => {
        const country = r.country ?? 'Unknown';
        if (!groups.has(country)) groups.set(country, { x: [], y: [], z: [], text: [] });
        const g = groups.get(country)!;
        g.x.push(coords[i][0]);
        g.y.push(coords[i][1]);
        g.z.push(coords[i][2]);
        // Truncate long messages for the tooltip
        const msg = r.user_message?.length > 120
            ? r.user_message.slice(0, 120) + '…'
            : (r.user_message ?? '');
        g.text.push(`<b>${country}</b><br>${new Date(r.recorded_at).toLocaleDateString('en-GB')}<br>${msg}`);
    });

    return Array.from(groups.entries()).map(([country, g], idx) => ({
        type: 'scatter3d' as const,
        mode: 'markers' as const,
        name: country,
        x: g.x,
        y: g.y,
        z: g.z,
        text: g.text,
        hovertemplate: '%{text}<extra></extra>',
        marker: {
            size: 4,
            color: PALETTE[idx % PALETTE.length],
            opacity: 0.85,
        },
    }));
}

export default function EmbeddingVisualizer({ service }: { service: AnalyticsService }) {
    const [status, setStatus] = useState<Status>('idle');
    const [error, setError] = useState<string | null>(null);
    const [recordCount, setRecordCount] = useState<number | null>(null);
    const plotRef = useRef<HTMLDivElement>(null);

    const load = async () => {
        setError(null);
        setStatus('fetching');
        try {
            const records = await service.exportEmbeddings();
            setRecordCount(records.length);

            if (records.length < 4) {
                throw new Error(`Need at least 4 records to visualise (have ${records.length})`);
            }

            setStatus('reducing');

            // Build the embedding matrix: Float32Array is faster for UMAP
            const matrix = records.map(r => r.embedding);

            // Run UMAP — nNeighbors capped at dataset size minus one
            const nNeighbors = Math.min(15, records.length - 1);
            const umap = new UMAP({ nComponents: 3, nNeighbors });
            const coords = await umap.fitAsync(matrix, (_epoch) => {
                // Callback fires each epoch; returning nothing continues normally.
                // Re-setting status triggers a re-render so the spinner stays alive.
                setStatus('reducing');
            });

            // Render with Plotly
            const traces = buildTraces(records, coords);
            const layout: Partial<Plotly.Layout> = {
                paper_bgcolor: '#1e1e1e',
                plot_bgcolor: '#1e1e1e',
                font: { color: '#e0e0e0' },
                margin: { l: 0, r: 0, t: 0, b: 0 },
                legend: { bgcolor: 'rgba(0,0,0,0.4)', bordercolor: '#444', borderwidth: 1 },
                scene: {
                    bgcolor: '#1e1e1e',
                    xaxis: { showgrid: true, gridcolor: '#333', showticklabels: false, title: { text: '' } },
                    yaxis: { showgrid: true, gridcolor: '#333', showticklabels: false, title: { text: '' } },
                    zaxis: { showgrid: true, gridcolor: '#333', showticklabels: false, title: { text: '' } },
                    camera: { eye: { x: 1.5, y: 1.5, z: 1.0 } },
                },
            };

            await Plotly.react(plotRef.current!, traces, layout, {
                responsive: true,
                displaylogo: false,
                modeBarButtonsToRemove: ['toImage'],
            });

            setStatus('done');
        } catch (e: any) {
            setError(e?.message ?? 'Unknown error');
            setStatus('error');
        }
    };

    return (
        <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
                <Button
                    variant="outlined"
                    onClick={load}
                    disabled={status === 'fetching' || status === 'reducing'}
                >
                    {status === 'done' ? 'Reload' : 'Load visualisation'}
                </Button>

                {(status === 'fetching' || status === 'reducing') && (
                    <>
                        <CircularProgress size={20} />
                        <Typography variant="body2" color="text.secondary">
                            {status === 'fetching'
                                ? 'Fetching embeddings…'
                                : 'Running UMAP (this may take a few seconds)…'}
                        </Typography>
                    </>
                )}

                {status === 'done' && recordCount !== null && (
                    <Typography variant="body2" color="text.secondary">
                        {recordCount} records · drag to rotate · scroll to zoom
                    </Typography>
                )}

                {status === 'error' && (
                    <Typography variant="body2" color="error">{error}</Typography>
                )}
            </Box>

            {/* Plotly mounts here; hidden until done so layout isn't affected */}
            <Box
                ref={plotRef}
                sx={{
                    width: '100%',
                    height: 600,
                    borderRadius: 1,
                    overflow: 'hidden',
                    display: status === 'done' ? 'block' : 'none',
                }}
            />
        </Box>
    );
}
