import * as d3 from 'd3';
import { useEffect, useRef } from 'react';

interface Node { id: string; userMessage: string; ip: string; }
interface Edge { id_a: string; id_b: string; similarity: number; }

export default function SimilarityGraph({ nodes, edges }: {
    nodes: Node[]; edges: Edge[];
}) {
    const svgRef = useRef<SVGSVGElement>(null);

    useEffect(() => {
        if (!svgRef.current || nodes.length === 0) return;
        const svg = d3.select(svgRef.current);
        svg.selectAll('*').remove();

        const width = svgRef.current.clientWidth || 900;
        const height = 600;

        const d3Nodes = nodes.map(n => ({ ...n })) as any[];
        const nodeById = new Map(d3Nodes.map(n => [n.id, n]));

        const d3Links = edges
            .filter(e => nodeById.has(e.id_a) && nodeById.has(e.id_b))
            .map(e => ({
                source: nodeById.get(e.id_a),
                target: nodeById.get(e.id_b),
                similarity: e.similarity,
            }));

        const simulation = d3.forceSimulation(d3Nodes)
            .force('link', d3.forceLink(d3Links)
                .id((d: any) => d.id)
                .distance((d: any) => (1 - d.similarity) * 200))
            .force('charge', d3.forceManyBody().strength(-80))
            .force('center', d3.forceCenter(width / 2, height / 2));

        const link = svg.append('g').selectAll('line').data(d3Links)
            .join('line').attr('stroke', '#444').attr('stroke-opacity', 0.6);

        const colorScale = d3.scaleOrdinal(d3.schemeTableau10);
        const node = (svg.append('g').selectAll('circle').data(d3Nodes)
            .join('circle') as d3.Selection<SVGCircleElement, any, SVGGElement, unknown>)
            .attr('r', 6)
            .attr('fill', (d: any) => colorScale(d.ip))
            .call(d3.drag<SVGCircleElement, any>()
                .on('start', (event, d) => {
                    if (!event.active) simulation.alphaTarget(0.3).restart();
                    d.fx = d.x; d.fy = d.y;
                })
                .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
                .on('end', (event, d) => {
                    if (!event.active) simulation.alphaTarget(0);
                    d.fx = null; d.fy = null;
                })
            );

        node.append('title').text((d: any) => `${d.ip}\n${(d.userMessage ?? '').slice(0, 80)}`);

        simulation.on('tick', () => {
            link
                .attr('x1', (d: any) => d.source.x)
                .attr('y1', (d: any) => d.source.y)
                .attr('x2', (d: any) => d.target.x)
                .attr('y2', (d: any) => d.target.y);
            node.attr('cx', (d: any) => d.x).attr('cy', (d: any) => d.y);
        });

        return () => { simulation.stop(); };
    }, [nodes, edges]);

    return <svg ref={svgRef} width="100%" height={600} style={{ background: '#1e1e1e', display: 'block' }} />;
}
