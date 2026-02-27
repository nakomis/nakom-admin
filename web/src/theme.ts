import { createTheme } from '@mui/material/styles';
import { blue, green } from '@mui/material/colors';

export const theme = createTheme({
    typography: {
        fontFamily: ['Roboto', 'Helvetica', 'Arial', 'sans-serif'].join(','),
        fontSize: 14,
    },
    palette: {
        mode: 'light',
        primary: { main: blue['A700'] },
        secondary: { main: green[900] },
    },
});
