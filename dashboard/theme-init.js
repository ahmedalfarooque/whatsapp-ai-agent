// Applies the remembered appearance (light by default, or the original dark theme) before first paint.
// An external file on purpose: the server's Content-Security-Policy only allows scripts from this origin.
try {
  var stored = localStorage.getItem('workspace.theme');
  if (stored === 'dark' || stored === 'light') document.documentElement.setAttribute('data-theme', stored);
} catch (e) { /* storage unavailable: the default (light) stays */ }
