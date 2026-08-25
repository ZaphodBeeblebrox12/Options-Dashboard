/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: '#0a0a0f',
          panel: '#111118',
          border: '#1a1a2e',
          text: '#e0e0e0',
          muted: '#6b7280',
          atm: '#eab308',
          ce: '#ef4444',
          pe: '#22c55e',
          futures: '#3b82f6',
          maxpain: '#d946ef',
          gammaflip: '#06b6d4',
        },
      },
    },
  },
  plugins: [],
}
