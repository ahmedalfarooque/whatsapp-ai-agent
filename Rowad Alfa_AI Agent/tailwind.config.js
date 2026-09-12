/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#0B0D12',
        panel: '#14171F',
        panel2: '#1B1F2A',
        line: '#252A36',
        ink: '#F4F6FB',
        muted: '#9AA3B5',
        accent: '#3B82F6',
        accent2: '#22D3EE',
        offer: '#EF4444',
      },
      fontFamily: {
        display: ['Sora', 'sans-serif'],
        body: ['Inter', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      backgroundImage: {
        'accent-gradient': 'linear-gradient(135deg, #3B82F6, #22D3EE)',
      },
    },
  },
  plugins: [],
};
