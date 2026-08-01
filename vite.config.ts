import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/*.png'],
      manifest: {
        name: 'Avioane — Joc cu Prieteni',
        short_name: 'Avioane',
        description: 'Jocul clasic de avioane pe grilă 10×10. Joacă pe același telefon sau online cu un prieten.',
        theme_color: '#1a1440',
        background_color: '#0d0a1f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        lang: 'ro',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
  },
})
