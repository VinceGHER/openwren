import { defineConfig } from 'astro/config';

// Static output (the default). No adapters, no integrations.
export default defineConfig({
  site: 'https://openwren.app',
  // Keep line breaks in the HTML: compressing them removes the space before a link that starts a line.
  compressHTML: false,
  markdown: {
    // Code blocks are styled by the site's own CSS, so they follow light and dark.
    syntaxHighlight: false,
  },
});
