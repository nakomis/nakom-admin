import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
    typography: {
        fontFamily: ['Roboto', 'Helvetica', 'Arial', 'sans-serif'].join(','),
        fontSize: 14,
    },
    palette: {
        mode: 'dark',
        primary: { main: '#1976d2' },
        secondary: { main: '#81c784' },
        background: {
            default: '#282c34',
            paper: '#1e1e1e',
        },
    },
});
