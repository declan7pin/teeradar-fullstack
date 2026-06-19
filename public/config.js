(function(){

  const params = new URLSearchParams(location.search);

  const fromQuery = params.get("backend");

  if (fromQuery !== null) {
    const cleanUrl = fromQuery.trim().replace(/\/+$/,'');

    if (cleanUrl.length > 0) {
      localStorage.setItem(
        "teeradar_backend_url",
        cleanUrl
      );
    } else {
      localStorage.removeItem(
        "teeradar_backend_url"
      );
    }
  }

  const stored =
    localStorage.getItem(
      "teeradar_backend_url"
    ) || "";

  window.TEERADAR_BACKEND =
    stored ||
    "https://teeradar.com.au";

  window.apiUrl = function(path){
    return `${window.TEERADAR_BACKEND}${path}`;
  };

})();
