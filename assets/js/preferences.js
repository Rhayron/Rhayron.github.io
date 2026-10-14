try {
  const theme = localStorage.getItem('rhayron-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* The page also works with storage disabled. */ }
