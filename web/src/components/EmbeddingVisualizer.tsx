import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import { UMAP } from 'umap-js';
import Plotly from 'plotly.js-dist-min';
import { AnalyticsService, EmbeddingRecord } from '../services/analyticsService';

type Status = 'idle' | 'fetching' | 'reducing' | 'done' | 'error';

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Stable sequence of colours for country groups
const PALETTE = [
    '#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f',
    '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac',
];

function buildTraces(records: EmbeddingRecord[], coords: number[][]): Plotly.Data[] {
    // Group by country so each gets its own legend entry and colour
    const groups = new Map<string, { x: number[]; y: number[]; z: number[]; labelText: string[]; hoverText: string[] }>();

    records.forEach((r, i) => {
        const country = r.country ?? 'Unknown';
        if (!groups.has(country)) groups.set(country, { x: [], y: [], z: [], labelText: [], hoverText: [] });
        const g = groups.get(country)!;
        g.x.push(coords[i][0]);
        g.y.push(coords[i][1]);
        g.z.push(coords[i][2]);
        // Truncate long messages for the tooltip; escape HTML to prevent XSS
        const raw = r.user_message ?? '';
        const dateStr = new Date(r.recorded_at).toLocaleDateString('en-GB');
        const msg = escapeHtml(raw.length > 120 ? raw.slice(0, 120) + '…' : raw);
        g.hoverText.push(`<b>${escapeHtml(country)}</b><br>${dateStr}<br>${msg}`);
        g.labelText.push(`${dateStr} · ${escapeHtml(raw.slice(0, 30))}`);
    });

    return Array.from(groups.entries()).map(([country, g], idx) => ({
        type: 'scatter3d' as const,
        mode: 'markers' as const,
        name: country,
        x: g.x,
        y: g.y,
        z: g.z,
        text: g.labelText,
        hovertext: g.hoverText,
        hovertemplate: '%{hovertext}<extra></extra>',
        textposition: 'top center' as const,
        textfont: { size: 9, color: '#bcc4d0' },
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
    const [showLabels, setShowLabels] = useState(true);
    const plotRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        return () => {
            if (plotRef.current) Plotly.purge(plotRef.current);
        };
    }, []);

    // 't' keyboard shortcut toggles point labels on the 3D graph
    useEffect(() => {
        if (status !== 'done') return;
        const handler = (e: KeyboardEvent) => {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
            if (e.key === 't' || e.key === 'T') setShowLabels(prev => !prev);
        };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [status]);

    const restyleLabels = useCallback((show: boolean) => {
        if (!plotRef.current) return;
        Plotly.restyle(plotRef.current, { mode: show ? 'markers+text' : 'markers' } as any);
    }, []);

    useEffect(() => {
        if (status !== 'done') return;
        restyleLabels(showLabels);
    }, [showLabels, status, restyleLabels]);

    const load = async () => {
        setError(null);
        setShowLabels(true);
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
                paper_bgcolor: '#1a2332',
                plot_bgcolor: '#1a2332',
                font: { color: '#e0e0e0' },
                margin: { l: 0, r: 0, t: 0, b: 0 },
                legend: { bgcolor: 'rgba(0,0,0,0.4)', bordercolor: '#444', borderwidth: 1 },
                modebar: { bgcolor: 'rgba(26,35,50,0.85)', color: '#8090a0', activecolor: '#1976d2' } as any,
                scene: {
                    bgcolor: '#1a2332',
                    xaxis: { showgrid: true, gridcolor: '#3a5575', showticklabels: false, title: { text: '' } },
                    yaxis: { showgrid: true, gridcolor: '#3a5575', showticklabels: false, title: { text: '' } },
                    zaxis: { showgrid: true, gridcolor: '#3a5575', showticklabels: false, title: { text: '' } },
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
                        {recordCount} records · drag to rotate · scroll to zoom · t {showLabels ? 'hides' : 'shows'} labels
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
