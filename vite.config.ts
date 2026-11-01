import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/target/**', '**/src-tauri/**', '**/.superpowers/**', '**/artifacts/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: { target: 'es2022' },
});
