import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
  envPrefix: ['VITE_', 'TAURI_'],
});
