(function(){
  'use strict';
  const root=document.documentElement; root.classList.add('js');
  const reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css=(name)=>getComputedStyle(root).getPropertyValue(name).trim();

  /* ---------- revelação: só o que está abaixo da dobra espera ---------- */
  const rvs=[...document.querySelectorAll('.rv')];
  const vh=innerHeight;
  rvs.forEach(el=>{ if(el.getBoundingClientRect().top>vh*0.92) el.classList.add('pending'); else el.classList.add('in'); });
  if('IntersectionObserver' in window){
    const io=new IntersectionObserver(es=>es.forEach(e=>{ if(e.isIntersecting){ e.target.classList.add('in'); e.target.classList.remove('pending'); io.unobserve(e.target);} }),{rootMargin:'0px 0px -8% 0px',threshold:.08});
    rvs.forEach(el=>io.observe(el));
  } else rvs.forEach(el=>{el.classList.add('in');el.classList.remove('pending');});
  function sweep(){ const lim=innerHeight*0.96; rvs.forEach(el=>{ if(el.classList.contains('pending')&&el.getBoundingClientRect().top<lim){ el.classList.add('in'); el.classList.remove('pending'); } }); }
  addEventListener('scroll',sweep,{passive:true}); setTimeout(sweep,400);

  /* ---------- régua: capítulo ativo ---------- */
  const links=[...document.querySelectorAll('.rail nav a[data-spy]')];
  const secs=links.map(a=>document.getElementById(a.dataset.spy)).filter(Boolean);
  function spy(){
    let cur=null; const y=scrollY+innerHeight*0.35;
    secs.forEach(s=>{ if(s.offsetTop<=y) cur=s.id; });
    links.forEach(a=>a.classList.toggle('on',a.dataset.spy===cur));
    links.forEach(a=>{ if(a.dataset.spy===cur) a.setAttribute('aria-current','location'); else a.removeAttribute('aria-current'); });
  }
  addEventListener('scroll',spy,{passive:true}); spy();

  /* ---------- fig. 0: phased array com refração ---------- */
  (function(){
    const cv=document.getElementById('onda-cv'); if(!cv) return;
    const ctx=cv.getContext('2d');
    const C1=1480,C2=5900,N=64;
    let W=0,H=0,CX=0,els=[],focus={x:0,y:0},target={x:0,y:0},auto=true,raf=0,last=0;
    const t0=performance.now();
    function iface(x){ return H*0.52 + Math.sin(x/W*Math.PI*2.2+0.9)*H*0.014; }
    function resize(){
      const r=cv.getBoundingClientRect(); const dpr=Math.min(2,devicePixelRatio||1);
      W=r.width;H=r.height; cv.width=Math.round(W*dpr); cv.height=Math.round(H*dpr); ctx.setTransform(dpr,0,0,dpr,0,0);
      els=[]; CX=W>900?W*0.68:W*0.5; const span=W>900?Math.min(W*0.4,560):Math.min(W*0.62,720); const x0=CX-span/2; const y=H*0.14;
      for(let i=0;i<N;i++) els.push({x:x0+span*(i/(N-1)),y});
      focus.x=CX;focus.y=H*0.76;target.x=focus.x;target.y=focus.y;
      draw(performance.now());
    }
    function tof(e,px,f){ const py=iface(px); return Math.hypot(px-e.x,py-e.y)/C1+Math.hypot(f.x-px,f.y-py)/C2; }
    function refr(e,f){
      let lo=Math.min(e.x,f.x)-W*0.2, hi=Math.max(e.x,f.x)+W*0.2;
      for(let k=0;k<26;k++){ const m1=lo+(hi-lo)/3,m2=hi-(hi-lo)/3; if(tof(e,m1,f)<tof(e,m2,f)) hi=m2; else lo=m1; }
      const x=(lo+hi)/2; return {x,y:iface(x)};
    }
    function draw(now){
      const accent=css('--accent')||'#8f1f6e', mute=css('--mute')||'#777', line=css('--line')||'#ccc', fg=css('--fg')||'#111';
      ctx.clearRect(0,0,W,H);
      const t=(now-t0)/1000;
      if(auto){ const amp=W>900?W*0.1:W*0.16; target.x=CX+Math.sin(t*0.21)*amp; target.y=H*0.76+Math.cos(t*0.16)*H*0.07; }
      focus.x+=(target.x-focus.x)*0.06; focus.y+=(target.y-focus.y)*0.06;
      const f=focus;
      // hachura do aço
      ctx.save(); ctx.beginPath(); ctx.moveTo(0,iface(0)); for(let x=0;x<=W;x+=12) ctx.lineTo(x,iface(x)); ctx.lineTo(W,H); ctx.lineTo(0,H); ctx.closePath(); ctx.clip();
      ctx.strokeStyle=line; ctx.globalAlpha=.55; ctx.lineWidth=1; ctx.beginPath();
      for(let x=-H;x<W+H;x+=22){ ctx.moveTo(x,H); ctx.lineTo(x+H*0.6,iface(x)-20); }
      ctx.stroke(); ctx.restore();
      // interface
      ctx.strokeStyle=mute; ctx.globalAlpha=.9; ctx.lineWidth=1.2; ctx.beginPath(); ctx.moveTo(0,iface(0)); for(let x=0;x<=W;x+=8) ctx.lineTo(x,iface(x)); ctx.stroke();
      // ROI
      const rw=W>900?Math.min(W*0.3,400):Math.min(W*0.5,420), rh=H*0.36; const rx=CX-rw/2, ry=H*0.58;
      ctx.setLineDash([3,5]); ctx.strokeStyle=mute; ctx.globalAlpha=.5; ctx.strokeRect(rx,ry,rw,rh); ctx.setLineDash([]);
      // raios
      const paths=[]; let tmax=0;
      for(const e of els){ const p=refr(e,f); const d1=Math.hypot(p.x-e.x,p.y-e.y), d2=Math.hypot(f.x-p.x,f.y-p.y); const T=d1/C1+d2/C2; if(T>tmax) tmax=T; paths.push({e,p,d1,d2,T}); }
      ctx.lineWidth=1; ctx.strokeStyle=accent;
      for(const r of paths){ ctx.globalAlpha=.10+.16*(1-(r.T/tmax)); ctx.beginPath(); ctx.moveTo(r.e.x,r.e.y); ctx.lineTo(r.p.x,r.p.y); ctx.lineTo(f.x,f.y); ctx.stroke(); }
      // pulsos com atraso de disparo: todos chegam juntos
      const period=2.8; const phase=((t%period)/period)*tmax*1.25;
      ctx.fillStyle=accent;
      for(const r of paths){
        const delay=tmax-r.T; const s=phase-delay; if(s<0||s>r.T) continue;
        let x,y; const T1=r.d1/C1;
        if(s<T1){ const k=s/T1; x=r.e.x+(r.p.x-r.e.x)*k; y=r.e.y+(r.p.y-r.e.y)*k; }
        else { const k=(s-T1)/(r.d2/C2); x=r.p.x+(f.x-r.p.x)*k; y=r.p.y+(f.y-r.p.y)*k; }
        ctx.globalAlpha=.85; ctx.beginPath(); ctx.arc(x,y,1.6,0,Math.PI*2); ctx.fill();
      }
      // chegada: flash no foco
      const arrive=phase>tmax&&phase<tmax*1.12;
      ctx.globalAlpha=1;
      // elementos
      ctx.fillStyle=fg; for(const e of els){ ctx.globalAlpha=.8; ctx.fillRect(e.x-1,e.y-4,2,8); }
      // foco
      ctx.globalAlpha=1; ctx.strokeStyle=accent; ctx.lineWidth=1.4; const R=arrive?9:6;
      ctx.beginPath(); ctx.moveTo(f.x-R,f.y); ctx.lineTo(f.x+R,f.y); ctx.moveTo(f.x,f.y-R); ctx.lineTo(f.x,f.y+R); ctx.stroke();
      if(arrive){ ctx.globalAlpha=.35; ctx.beginPath(); ctx.arc(f.x,f.y,14,0,Math.PI*2); ctx.stroke(); }
      // rótulos
      ctx.globalAlpha=.9; ctx.fillStyle=mute; ctx.font='11px "IBM Plex Mono", Menlo, monospace'; ctx.textBaseline='middle';
      ctx.fillText('64 elementos · phased array', els[0].x, els[0].y-16);
      const lx=W-172; ctx.fillText('água · c₁ = 1480 m/s', lx, iface(lx)-14);
      ctx.fillText('aço · c₂ = 5900 m/s', lx, iface(lx)+16);
      ctx.fillText('ROI 512 × 512', rx+8, ry+rh-12);
      ctx.fillText('foco · TOF máx. '+(tmax*1e6).toFixed(1)+' µs', Math.min(f.x+14,W-170), f.y-14);
    }
    function loop(now){ raf=requestAnimationFrame(loop); if(now-last<1000/60) return; last=now; draw(now); }
    const hero=cv.parentElement;
    hero.addEventListener('pointermove',e=>{ const r=cv.getBoundingClientRect(); const x=e.clientX-r.left, y=e.clientY-r.top; if(e.pointerType==='touch') return; auto=false; target.x=Math.max(20,Math.min(W-20,x)); target.y=Math.max(iface(x)+30,Math.min(H-16,y)); });
    hero.addEventListener('pointerleave',()=>{auto=true;});
    addEventListener('resize',resize); resize();
    if(reduce){ draw(performance.now()); } else {
      const vis=new IntersectionObserver(es=>es.forEach(e=>{ if(e.isIntersecting){ if(!raf) raf=requestAnimationFrame(loop);} else { cancelAnimationFrame(raf); raf=0; } }));
      vis.observe(cv);
    }
    const mq=matchMedia('(prefers-color-scheme: dark)'); mq.addEventListener&&mq.addEventListener('change',()=>draw(performance.now()));
  })();

  /* ---------- comparador ---------- */
  (function(){ const c=document.getElementById('cmp'), r=document.getElementById('cmp-range'); if(!c||!r) return;
    r.addEventListener('input',()=>c.style.setProperty('--cut',(100-r.value)+'%')); })();

  /* ---------- carimbo PASS ---------- */
  (function(){ const f=document.getElementById('ficha'); if(!f) return; if(reduce){ f.classList.add('in'); return; }
    const io=new IntersectionObserver(es=>es.forEach(e=>{ if(e.isIntersecting){ f.classList.add('in'); io.disconnect(); } }),{threshold:.35}); io.observe(f); })();

  /* ---------- Hina: retrato que acompanha o ponteiro ---------- */
  (function(){
    const p=document.getElementById('portrait'); if(!p||reduce) return; const card=p.querySelector('.card');
    let tx=0,ty=0,cx=0,cy=0,raf=0;
    const sec=document.getElementById('presenca');
    sec.addEventListener('pointermove',e=>{ if(e.pointerType==='touch') return; const r=card.getBoundingClientRect(); const mx=(e.clientX-(r.left+r.width/2))/innerWidth, my=(e.clientY-(r.top+r.height/2))/innerHeight; tx=Math.max(-1,Math.min(1,mx*2)); ty=Math.max(-1,Math.min(1,my*2)); if(!raf) raf=requestAnimationFrame(tick); });
    sec.addEventListener('pointerleave',()=>{ tx=0;ty=0; if(!raf) raf=requestAnimationFrame(tick); });
    function tick(){ cx+=(tx-cx)*.08; cy+=(ty-cy)*.08; card.style.transform=`rotateY(${(cx*7).toFixed(2)}deg) rotateX(${(-cy*6).toFixed(2)}deg) translate(${(cx*6).toFixed(1)}px,${(cy*4).toFixed(1)}px)`;
      if(Math.abs(tx-cx)>.002||Math.abs(ty-cy)>.002) raf=requestAnimationFrame(tick); else raf=0; }
  })();

  /* ---------- PAD ---------- */
  (function(){
    const base={p:.6,a:.4,d:.5}; const v={...base}; const el={p:'pad-p',a:'pad-a',d:'pad-d'}; const vl={p:'pad-pv',a:'pad-av',d:'pad-dv'}; const mood=document.getElementById('pad-mood'); if(!mood) return;
    const fmt=n=>n.toFixed(2).replace('.',',');
    function label(){ const dp=v.p-base.p, da=v.a-base.a, dd=v.d-base.d;
      if(Math.abs(dp)<.06&&Math.abs(da)<.06&&Math.abs(dd)<.06) return 'tranquila, na linha de base';
      if(dp>.12&&da>.12) return 'animada, falando mais rápido';
      if(dp>.12) return 'contente, tom mais quente';
      if(dp<-.12&&da>.12) return 'irritada, respostas curtas';
      if(dp<-.12&&da<-.05) return 'quieta, meio chateada';
      if(da>.15&&dd>.1) return 'atenta, tomando a frente';
      if(da<-.12) return 'sonolenta, fala mansa';
      return 'curiosa'; }
    function render(){ for(const k in el){ document.getElementById(el[k]).style.width=(v[k]*100)+'%'; document.getElementById(vl[k]).textContent=fmt(v[k]); } mood.textContent=label(); }
    document.querySelectorAll('#pad button').forEach(b=>b.addEventListener('click',()=>{ const [dp,da,dd]=b.dataset.pad.split(',').map(Number); v.p=Math.max(0,Math.min(1,v.p+dp)); v.a=Math.max(0,Math.min(1,v.a+da)); v.d=Math.max(0,Math.min(1,v.d+dd)); render(); }));
    render();
    setInterval(()=>{ let moved=false; for(const k in v){ const d=base[k]-v[k]; if(Math.abs(d)>.002){ v[k]+=d*.06; moved=true; } } if(moved) render(); },160);
  })();

  /* ---------- genoma: radar ---------- */
  (function(){
    const svg=document.getElementById('radar'); if(!svg) return; const NS='http://www.w3.org/2000/svg';
    const dims=['formal','sarcasmo','calor','verboso','curiosa','humor','iniciativa','afeto','ironia','foco'];
    const attr=[.35,.3,.8,.45,.7,.55,.5,.75,.3,.6]; const gen=attr.map(a=>a+(Math.random()-.5)*.2); const cur=gen.slice(); let turno=0;
    const cx=100,cy=100,R=72; const n=dims.length;
    const pt=(i,r)=>{ const a=-Math.PI/2+i*2*Math.PI/n; return [cx+Math.cos(a)*r*R, cy+Math.sin(a)*r*R]; };
    const mk=(tag,at)=>{ const e=document.createElementNS(NS,tag); for(const k in at) e.setAttribute(k,at[k]); svg.appendChild(e); return e; };
    for(const r of [.25,.5,.75,1]) mk('polygon',{class:'web',points:dims.map((_,i)=>pt(i,r).join(',')).join(' ')});
    dims.forEach((d,i)=>{ const [x,y]=pt(i,1); mk('line',{class:'ax',x1:cx,y1:cy,x2:x,y2:y}); const [lx,ly]=pt(i,1.17); const t=mk('text',{x:lx,y:ly,'text-anchor':'middle','dominant-baseline':'middle'}); t.textContent=d; });
    mk('polygon',{class:'attr',points:attr.map((a,i)=>pt(i,a).join(',')).join(' ')});
    const poly=mk('polygon',{class:'gen',points:''}); const tl=mk('text',{class:'turno',x:cx,y:cy+2,'text-anchor':'middle','dominant-baseline':'middle'});
    function render(){ poly.setAttribute('points',cur.map((g,i)=>pt(i,g).join(',')).join(' ')); tl.textContent='turno '+turno; }
    function mutate(){ turno++; for(let i=0;i<n;i++){ gen[i]+= (Math.random()*2-1)*.03 + (attr[i]-gen[i])*.08; gen[i]=Math.max(.05,Math.min(1,gen[i])); } }
    render();
    if(reduce){ return; }
    setInterval(mutate,1500);
    (function anim(){ let m=false; for(let i=0;i<n;i++){ const d=gen[i]-cur[i]; if(Math.abs(d)>.0005){ cur[i]+=d*.1; m=true; } } if(m) render(); requestAnimationFrame(anim); })();
  })();

  /* ---------- pomodoro ---------- */
  (function(){ const t=document.getElementById('pomo-t'), arc=document.getElementById('pomo-arc'); if(!t) return; const total=25*60; let left=total; const L=326.7;
    function render(){ const m=Math.floor(left/60), s=left%60; t.textContent=String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); arc.setAttribute('stroke-dashoffset',(L*(1-left/total)).toFixed(1)); }
    render(); if(reduce) return; setInterval(()=>{ left--; if(left<0) left=total; render(); },1000); })();

  /* ---------- percurso ---------- */
  (function(){
    const g=document.getElementById('ruler-ticks'); if(!g) return; const NS='http://www.w3.org/2000/svg';
    const x=y=>20+(y-2019)*(860/7.6);
    const evs=[[2019,'Eng. Elétrica, UTFPR',1],[2021,'P&D Copel · termografia',-1],[2021.2,'YOLOv3 do zero',1],[2022.2,'ART · firmware de locomotivas',-1],[2023.2,'Caterpillar · ErrorProofing',1],[2023.0,'Mestrado CPGEI',-1],[2023.8,'CaosDiffusion',1],[2025.5,'Container Occupancy',-1],[2025.95,'GenStock Studio',1],[2026.45,'Hina',-1],[2026.8,'Coado',-1]];
    for(let y=2019;y<=2026;y++){ const l=document.createElementNS(NS,'line'); l.setAttribute('class','tk'); l.setAttribute('x1',x(y)); l.setAttribute('x2',x(y)); l.setAttribute('y1',64); l.setAttribute('y2',76); g.appendChild(l); const t=document.createElementNS(NS,'text'); t.setAttribute('class','yr'); t.setAttribute('x',x(y)); t.setAttribute('y',92); t.setAttribute('text-anchor','middle'); t.textContent=y; g.appendChild(t); }
    evs.forEach(([y,n,side],i)=>{ const px=x(y); const c=document.createElementNS(NS,'circle'); c.setAttribute('class','dot'); c.setAttribute('cx',px); c.setAttribute('cy',70); c.setAttribute('r',3.5); g.appendChild(c);
      const ty=side>0?(i%2?28:44):(i%2?118:134); const l=document.createElementNS(NS,'line'); l.setAttribute('class','tk'); l.setAttribute('x1',px); l.setAttribute('x2',px); l.setAttribute('y1',70); l.setAttribute('y2',side>0?ty+4:ty-10); l.setAttribute('opacity','.5'); g.appendChild(l);
      const t=document.createElementNS(NS,'text'); t.setAttribute('class','ev'); t.setAttribute('x',px); t.setAttribute('y',ty); t.setAttribute('text-anchor','middle'); t.textContent=n; g.appendChild(t); });
  })();

  /* ---------- copiar e-mail ---------- */
  (function(){ const b=document.getElementById('copy-mail'), m=document.getElementById('mail'); if(!b) return;
    b.addEventListener('click',()=>{ const txt=m.textContent; const ok=()=>{ b.textContent='copiado'; setTimeout(()=>b.textContent='copiar',1600); };
      if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(ok).catch(()=>{ sel(); }); } else sel();
      function sel(){ const r=document.createRange(); r.selectNodeContents(m); const s=getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent='selecionado'; setTimeout(()=>b.textContent='copiar',1600); } }); })();
})();
