window.TeeRadarProviders = {
  proceedUrl: function(courseName, dateISO, time, cfg, officialUrlFn){
    const base = (cfg && cfg[courseName] && cfg[courseName].base) || null;
    if(base && dateISO){
      const d = dateISO; // YYYY-MM-DD
      return base.replace('YYYY-MM-DD', d);
    }
    return officialUrlFn(courseName);
  }
};
