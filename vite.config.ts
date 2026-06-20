import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// @ts-ignore - plain JS dev-server plugin; no type declarations needed
import { crmDataPlugin } from './crm-data-plugin.mjs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), crmDataPlugin()],
})
