import { federation } from '@module-federation/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Two builds from one codebase:
//   pnpm build         → standalone admin.nakomis.com (base /)
//   pnpm build:remote  → Module Federation remote for nakomis-shell (base /remotes/admin/, dist-remote/)
export default defineConfig(({ mode }) => {
  const remote = mode === 'remote'
  return {
  base: remote ? '/remotes/admin/' : '/',
  plugins: [
    react(),
    federation({
      name: 'admin',
      filename: 'remoteEntry.js',
      exposes: { './App': './src/ShellApp.tsx' },
      shared: {
        react: { singleton: true },
        'react-dom': { singleton: true },
      },
      dts: false,
    }),
  ],
  build: {
    sourcemap: true,
    outDir: remote ? 'dist-remote' : 'dist',
  },
  }
})
