/**
 * The cv-chat analytics tab (ADMIN-12).
 *
 * Reads from Cal over the mTLS bridge, not from AWS — see `cvChatService.ts`
 * for why that is a separate client from `analyticsService.ts`. Everything on
 * this page comes from Luke's `admin_analytics`; nothing here touches Aurora,
 * which is what ADMIN-10 retires.
 *
 * The tab is gated twice over. The Cognito session gets it rendered, and the
 * browser's client certificate gets the requests past Leia — a machine
 * without one shows the page and every panel fails, which is intended: this is
 * visitor data from a public site and it does not leave the house on a session
 * cookie alone.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Alert, Box, Button, Chip, CircularProgress, Slider, Stack, Typography,
} from '@mui/material';
import SimilarityGraph3D, { type Graph3DNode } from '../graph/SimilarityGraph3D';
import {
    CvChatService, type CvChatGraph, type CvChatStats, type CvChatNeighbour,
} from '../../services/cvChatService';

/** Where Cal is reached. Same host the portal's docker-status uses. */
const CAL_API = 'https://api.cal.home.nakomis.com';

function Section({ title, action, children }: {
    title: string; action?: React.ReactNode; children: React.ReactNode;
}) {
    return (
        <Box sx={{
            mb: 3, p: 3,
            background: 'linear-gradient(135deg, #1e1e1e 0%, #2d2d2d 100%)',
            borderRadius: '12px', border: '1px solid #404040',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}>
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
                <Typography variant="h6" sx={{ fontWeight: 600 }}>{title}</Typography>
                {action}
            </Stack>
            {children}
        </Box>
    );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <Box>
            <Typography variant="h5" sx={{ fontWeight: 600 }}>{value}</Typography>
            <Typography variant="caption" color="text.secondary">{label}</Typography>
            {hint && (
                <Typography variant="caption" color="text.secondary" display="block">{hint}</Typography>
            )}
        </Box>
    );
}

export default function CvChatGraphPage({ token }: { token: string }) {
    const service = useMemo(() => new CvChatService(CAL_API, token), [token]);

    const [stats, setStats] = useState<CvChatStats | null>(null);
    const [graph, setGraph] = useState<CvChatGraph | null>(null);
    const [neighbours, setNeighbours] = useState<CvChatNeighbour[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [floor, setFloor] = useState(0.55);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            // Both together: a page showing counts but no graph, or the
            // reverse, invites the reader to assume the missing half is empty.
            const [s, g] = await Promise.all([
                service.stats(),
                service.graph({ min_similarity: floor }),
            ]);
            setStats(s);
            setGraph(g);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setStats(null);
            setGraph(null);
        } finally {
            setLoading(false);
        }
    }, [service, floor]);

    useEffect(() => { void load(); }, [load]);

    useEffect(() => {
        if (!selected) { setNeighbours([]); return; }
        let cancelled = false;
        service.neighbours(selected, 10)
            .then((r) => { if (!cancelled) setNeighbours(r.neighbours); })
            .catch(() => { if (!cancelled) setNeighbours([]); });
        return () => { cancelled = true; };
    }, [service, selected]);

    // Conversation id drives the colour, so turns of one visitor's
    // conversation share a hue. Hashed rather than indexed, so a node's colour
    // does not change when the filters change what else is on screen.
    const nodes: Graph3DNode[] = useMemo(() => (graph?.nodes ?? []).map((n) => ({
        id: n.id,
        embedded: n.embedded,
        label: n.snippet ?? `${n.log_type} · ${n.recorded_at}`,
        colourKey: n.conversation_id ? hashToUnit(n.conversation_id) : undefined,
    })), [graph]);

    const selectedNode = graph?.nodes.find((n) => n.id === selected) ?? null;

    return (
        <Box>
            {error && (
                <Alert severity="error" sx={{ mb: 3 }} action={
                    <Button color="inherit" size="small" onClick={() => void load()}>Retry</Button>
                }>
                    {error}
                </Alert>
            )}

            <Section
                title="cv.nakomis.com chat"
                action={
                    <Button size="small" onClick={() => void load()} disabled={loading}>
                        {loading ? <CircularProgress size={18} /> : 'Refresh'}
                    </Button>
                }
            >
                {stats ? (
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        <Box sx={{ minWidth: 120 }}>
                            <Stat
                                label="records"
                                value={stats.total_records.toLocaleString()}
                                // Records without an embedding are events, not
                                // failures. Shown so the gap between the two
                                // numbers does not read as missing data.
                                hint={`${stats.embedded_records.toLocaleString()} embedded`}
                            />
                        </Box>
                        <Box sx={{ minWidth: 120 }}>
                            <Stat label="conversations" value={stats.conversations.toLocaleString()} />
                        </Box>
                        <Box sx={{ minWidth: 120 }}>
                            <Stat label="countries" value={stats.countries.toLocaleString()} />
                        </Box>
                        <Box sx={{ minWidth: 120 }}>
                            <Stat
                                label="tokens in / out"
                                value={`${compact(stats.total_input_tokens)} / ${compact(stats.total_output_tokens)}`}
                            />
                        </Box>
                        <Box sx={{ minWidth: 120 }}>
                            <Stat
                                label="response time"
                                value={stats.duration_p50_ms === null ? '—' : `${Math.round(stats.duration_p50_ms)}ms`}
                                // p95 alongside p50 because response time is
                                // long-tailed; a median alone hides the tail
                                // that visitors actually notice.
                                hint={stats.duration_p95_ms === null ? undefined : `p95 ${Math.round(stats.duration_p95_ms)}ms`}
                            />
                        </Box>
                        <Box sx={{ minWidth: 120 }}>
                            <Stat label="rate limited" value={stats.rate_limited.toLocaleString()} />
                        </Box>
                    </Box>
                ) : !loading && !error ? (
                    <Typography color="text.secondary">No data yet.</Typography>
                ) : null}
            </Section>

            <Section
                title="Similarity graph"
                action={
                    <Stack direction="row" spacing={2} alignItems="center">
                        {graph?.truncated && (
                            // Shown, never silent. A truncated graph presented
                            // as complete is the most misleading thing this
                            // page could do.
                            <Chip
                                size="small"
                                color="warning"
                                label={`showing ${graph.nodes.length} of more`}
                            />
                        )}
                        <Box sx={{ width: 200 }}>
                            <Typography variant="caption" color="text.secondary">
                                similarity ≥ {(graph?.applied_floor ?? floor).toFixed(2)}
                                {graph && graph.applied_floor > floor + 1e-6 && ' (clamped)'}
                            </Typography>
                            <Slider
                                size="small"
                                min={0.5} max={0.95} step={0.05}
                                value={floor}
                                onChange={(_, v) => setFloor(v as number)}
                            />
                        </Box>
                    </Stack>
                }
            >
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                    {graph
                        ? `${graph.nodes.length} nodes, ${graph.edges.length} edges. ` +
                          'Position is computed from the edges in your browser — drag to orbit, ' +
                          'scroll to zoom, click a node for its nearest neighbours.'
                        : ' '}
                </Typography>
                <SimilarityGraph3D
                    nodes={nodes}
                    edges={graph?.edges ?? []}
                    edgeFloor={graph?.applied_floor ?? floor}
                    selectedId={selected}
                    onSelect={setSelected}
                    height={620}
                />
            </Section>

            {selectedNode && (
                <Section title="Selected conversation">
                    <Typography variant="body2" sx={{ mb: 1 }}>
                        {selectedNode.snippet ?? <em>no message text — this is an event record</em>}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 2 }}>
                        {selectedNode.recorded_at}
                        {selectedNode.country ? ` · ${selectedNode.country}` : ''}
                        {selectedNode.duration_ms !== null ? ` · ${selectedNode.duration_ms}ms` : ''}
                        {selectedNode.rate_limited ? ' · rate limited' : ''}
                    </Typography>

                    <Typography variant="subtitle2" sx={{ mb: 1 }}>Nearest neighbours</Typography>
                    {neighbours.length === 0 ? (
                        <Typography variant="body2" color="text.secondary">
                            {selectedNode.embedded
                                ? 'None above the similarity floor.'
                                : 'This record has no embedding, so it has no neighbours.'}
                        </Typography>
                    ) : (
                        <Stack spacing={1}>
                            {neighbours.map((n) => (
                                <Stack key={n.id} direction="row" spacing={2} alignItems="baseline">
                                    <Chip size="small" label={n.similarity.toFixed(3)} />
                                    <Typography
                                        variant="body2"
                                        sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
                                        onClick={() => setSelected(n.id)}
                                    >
                                        {n.snippet ?? n.id}
                                    </Typography>
                                </Stack>
                            ))}
                        </Stack>
                    )}
                </Section>
            )}
        </Box>
    );
}

/** Stable 0..1 from a string, so a colour depends only on the id. */
function hashToUnit(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 1000) / 1000;
}

function compact(n: number): string {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
    return String(n);
}
