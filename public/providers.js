
window.TeeRadarProviders = (function(){
  function qs(obj){
    const p = new URLSearchParams();
    Object.entries(obj).forEach(([k,v])=>{ if(v!==undefined && v!==null && String(v).length) p.set(k,String(v)); });
    return p.toString();
  }
  function proceedUrl(courseName, date, time, configMap, searchFallback){
    const cfg = configMap[courseName];
    if(!cfg){ return searchFallback(courseName); }
    const provider = (cfg.provider||'').toLowerCase();
    let url = null;
    if(provider==='miclub'){
      if(cfg.bookingResourceId && cfg.feeGroupId){
        const base = `https://${cfg.domain}/guests/bookings/ViewPublicTimesheet.msp`;
        url = `${base}?` + qs({bookingResourceId:cfg.bookingResourceId, selectedDate:date, feeGroupId:cfg.feeGroupId, mobile:'true', selectedTime:time});
      }else if(cfg.calendarUrl){
        try{ const u = new URL(cfg.calendarUrl); if(date) u.searchParams.set('selectedDate', date); url = u.toString(); }catch(e){ url = cfg.calendarUrl; }
      }
    }else if(provider==='lightspeed' || provider==='chronogolf'){
      if(cfg.calendarUrl){ try{ const u=new URL(cfg.calendarUrl); if(date) u.searchParams.set('date', date); url=u.toString(); }catch(e){ url=cfg.calendarUrl; } }
    }else if(provider==='quick18'){
      if(cfg.calendarUrl){
        try{
          const u=new URL(cfg.calendarUrl);
          if(date){ if(!u.searchParams.has('selectedDate')) u.searchParams.set('date', date); else u.searchParams.set('selectedDate', date); }
          url=u.toString();
        }catch(e){ url=cfg.calendarUrl; }
      }
    }
    return url || cfg.calendarUrl || searchFallback(courseName);
  }
  return { proceedUrl };
})();
