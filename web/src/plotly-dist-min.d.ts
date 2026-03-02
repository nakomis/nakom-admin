// Type shim: plotly.js-dist-min is a pre-bundled build of plotly.js with identical API
declare module 'plotly.js-dist-min' {
    export * from 'plotly.js';
    import Plotly from 'plotly.js';
    export default Plotly;
}
