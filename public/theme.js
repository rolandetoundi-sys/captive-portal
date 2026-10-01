(() => {
  const storageKey = 'cncc-color-theme';
  const getSavedTheme = () => {
    try {
      return localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  };

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      const nextTheme = theme === 'dark' ? 'light' : 'dark';
      const label = nextTheme === 'dark' ? 'Activer le thème sombre' : 'Activer le thème clair';
      button.setAttribute('aria-label', label);
      button.title = label;
    });
  }

  applyTheme(getSavedTheme());

  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(document.documentElement.dataset.theme || getSavedTheme());
    document.querySelectorAll('.theme-toggle').forEach((button) => {
      button.addEventListener('click', () => {
        const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        try {
          localStorage.setItem(storageKey, theme);
        } catch {
          // Le thème reste modifiable même si le stockage est désactivé.
        }
        applyTheme(theme);
      });
    });
  });

  window.addEventListener('storage', (event) => {
    if (event.key === storageKey) applyTheme(event.newValue === 'dark' ? 'dark' : 'light');
  });
})();