import { createTheme } from '@mui/material/styles';
import { blue, green } from '@mui/material/colors';

export const theme = createTheme({
    typography: {
        fontFamily: ['Roboto', 'Helvetica', 'Arial', 'sans-serif'].join(','),
        fontSize: 14,
    },
    palette: {
        mode: 'dark',
        text: { secondary: '#585c64' },
        primary: { main: blue['A700'] },
        secondary: { main: green[900] },
        background: { default: '#121212', paper: '#1e1e1e' },
    },
});
