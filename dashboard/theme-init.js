// Applies the remembered appearance (light by default, or the original dark theme) and the remembered language/direction
// before first paint. An external file on purpose: the server's Content-Security-Policy only allows scripts from this origin.
try {
  var stored = localStorage.getItem('workspace.theme');
  if (stored === 'dark' || stored === 'light') document.documentElement.setAttribute('data-theme', stored);
} catch (e) { /* storage unavailable: the default (light) stays */ }
try {
  if (localStorage.getItem('workspace.lang') === 'ar') {
    document.documentElement.setAttribute('lang', 'ar');
    document.documentElement.setAttribute('dir', 'rtl');
  }
} catch (e) { /* storage unavailable: English / left-to-right stays */ }
