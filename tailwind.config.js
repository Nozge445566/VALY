/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Palette from the approved four-screen reference
        cream: '#f5eddc', // primary text, buttons, active icons
        mist: '#8f9bbb', // secondary text
        dusk: '#63729b', // tertiary text, inactive icons
        ink: '#0b1229', // text on cream
        plate: '#1a2552', // raised surfaces (photo, cards)
      },
      fontFamily: {
        // Text on result, history and info
        sans: ['"Geist"', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        // Wordmark and headings on the welcome and scanning screens (unchanged)
        display: ['"Helvetica Neue"', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
