(function(){
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get('backend');
  if (fromQuery !== null) {
    if (fromQuery.trim().length > 0) localStorage.setItem('teeradar_backend_url', fromQuery.trim().replace(/\/+$/,''));
    else localStorage.removeItem('teeradar_backend_url');
  }
  const stored = localStorage.getItem('teeradar_backend_url') || '';
  window.TEERADAR_BACKEND = stored || ''; // same-origin
})();