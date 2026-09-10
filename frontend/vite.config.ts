import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Proxy API requests to the backend
      '/shows': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/seats': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
})
