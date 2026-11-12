'use strict';
// omp build tracker dashboard. Data arrives either embedded (#seed, a static
// export) or live from the tracker server over server-sent events.
const C={pink:'#f92672',orange:'#fd971f',yellow:'#e6db74',green:'#a6e22e',blue:'#66d9ef',purple:'#ae81ff',mute:'#8a8672',dim:'#b8b8ac',line:'#26261e',fg:'#f8f8f2'};
const ST={live:C.green,done:C.green,built:C.blue,testing:C.yellow,active:C.yellow,building:C.orange,queued:C.mute,blocked:C.pink};
const STATUS={running:C.green,idle:C.yellow,closed:C.mute,error:C.pink};
const ENG={claude:C.orange,gpt:C.blue,codex:C.blue,gemini:C.purple,grok:C.pink,external:C.dim};
const ROLE_COL=[C.green,C.purple,C.pink,C.yellow,C.blue,C.orange,C.dim];
const colorOf=(name,map)=>{if(map[name])return map[name];let h=0;for(const c of String(name))h=(h*31+c.charCodeAt(0))>>>0;return ROLE_COL[h%ROLE_COL.length]};
const palette=c=>!c?C.dim:c.startsWith('#')?c:(C[c]||C.dim);
let S=null,charts={},LIVE=false,POLL=false;
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const isNarrow=()=>!!(window.matchMedia&&window.matchMedia('(max-width:760px)').matches);
const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const dayOf=iso=>{const d=new Date(/T/.test(iso)?iso:iso+'T00:00:00');return new Date(d.getFullYear(),d.getMonth(),d.getDate())};
const md=d=>MON[d.getMonth()]+' '+d.getDate();
const span=(a,b)=>{const x=md(dayOf(a)),y=md(dayOf(b));if(x===y)return x;return x.split(' ')[0]===y.split(' ')[0]?x+'–'+y.split(' ')[1]:x+' – '+y};
const dash=s=>String(s??'').replace(/(\d)-(\d)/g,'$1–$2');
function ago(iso){if(!iso)return'–';const m=(Date.now()-new Date(iso))/60000;return m<1?'just now':m<60?Math.round(m)+' min ago':m<1440?(m/60).toFixed(1)+' h ago':(m/1440).toFixed(1)+' d ago'}
const hm=iso=>new Date(iso).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false});
if(window.Chart){Chart.defaults.color=C.dim;Chart.defaults.font.family='Consolas, Inconsolata, monospace';Chart.defaults.font.size=isNarrow()?11:12;Chart.defaults.borderColor=C.line;Chart.defaults.plugins.legend.labels.boxWidth=10;Chart.defaults.plugins.legend.labels.boxHeight=10;Chart.defaults.animation=false}
// Update charts in place so live refreshes do not flicker.
function mk(id,cfg){if(!window.Chart)return;const el=document.getElementById(id);if(!el)return;const c=charts[id];
 if(c&&c.config.type===cfg.type&&c.canvas===el){c.data.labels=cfg.data.labels;cfg.data.datasets.forEach((d,i)=>{if(c.data.datasets[i])Object.assign(c.data.datasets[i],d);else c.data.datasets.push(d)});c.data.datasets.length=cfg.data.datasets.length;c.options=cfg.options;c.update('none');return}
 if(c)c.destroy();charts[id]=new Chart(el,cfg)}
function empty(id,msg){const e=document.getElementById('e-'+id);const cv=document.getElementById('c-'+id);if(!e)return;e.hidden=!msg;if(msg)e.textContent=msg;if(cv)cv.hidden=!!msg}
const tip={backgroundColor:'#111',borderColor:C.line,borderWidth:1,titleColor:C.fg,bodyColor:C.fg};
const xt=n=>({ticks:{maxTicksLimit:n,maxRotation:0,autoSkip:true},grid:{display:false}});
function ring(p){const r=52,c=2*Math.PI*r,v=Math.max(0,Math.min(100,+p||0));
 $('#ring').innerHTML=`<svg viewBox="0 0 120 120" preserveAspectRatio="xMidYMid meet"><circle cx="60" cy="60" r="${r}" stroke="#1d1d16" stroke-width="10" fill="none"/><circle cx="60" cy="60" r="${r}" stroke="${C.green}" stroke-width="10" fill="none" stroke-linecap="round" stroke-dasharray="${(c*v/100).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 60 60)"/></svg><div class="t"><b>${v}%</b><span>overall</span></div>`;
 $('#ring').setAttribute('aria-label','overall progress '+v+'%');$('#ring').title=S.overall_method||''}
function split(label,obj,cols){const ks=Object.keys(obj).filter(k=>obj[k]>0);
 return `<div class="split">${label?`<div class="sl">${esc(label)}</div>`:''}<div class="sb">${ks.map(k=>`<i style="flex:${obj[k]};background:${cols[k]||colorOf(k,cols)}" title="${esc(k)}: ${obj[k]}"></i>`).join('')}</div><div class="lg">${ks.map(k=>`<span><i class="sw" style="background:${cols[k]||colorOf(k,cols)}"></i>${esc(k)}<b>${obj[k]}</b></span>`).join('')||'<span>none</span>'}</div></div>`}
const cnt=(arr,key)=>arr.reduce((m,a)=>(m[a[key]]=(m[a[key]]||0)+1,m),{});
function cpRow(x){return `<div class="cpi"><span class="node ${esc(x.state)}"></span><div class="b"><div class="t"><span class="n">${esc(x.step)}</span><span class="st c-${esc(x.state)}">${esc(x.state)}</span></div><div class="eta">${esc(dash(x.eta||''))}</div><div class="own">${esc(x.owner||'')}</div>${x.note?`<div class="nt">${esc(x.note)}</div>`:''}</div></div>`}
function more(items,n,label,key){if(items.length<=n)return items.join('');return items.slice(0,n).join('')+`<details class="more" data-k="${esc(key||label)}"><summary>${label} (${items.length-n})</summary>${items.slice(n).join('')}</details>`}
const agentName=id=>{const a=(S.agents||[]).find(x=>x.id===id);return a?a.name:id};

// ---- render ----
function render(){
 if(!S)return;const s=S,ag=s.agents||[],run=ag.filter(a=>a.status==='running').length,narrow=isNarrow();
 const sub=(s.labels&&s.labels.subtitle)||'build tracker';
 document.title=`${s.title} ${sub}`;$('#h1').innerHTML=`<b>${esc(s.title)}</b> ${esc(sub)}`;
 ring(s.overall_pct);$('#headline').textContent=s.headline||'';$('#upd').textContent=ago(s.generated_at)+', '+hm(s.generated_at);
 $('#gitmeta').innerHTML=s.git?`${esc(s.git.branch)} <span>${esc(s.git.tip)}</span>`:'';
 const sh=s.share,cf=s.cloudflare,links=[];
 if(sh&&sh.url)links.push(`<a href="${esc(sh.url)}" target="_blank" rel="noopener" title="${sh.mode==='funnel'?'Anyone with this link can view (read-only, secrets redacted)':'Visible to your tailnet devices'}">${sh.mode==='funnel'?'public link':'tailnet link'}</a>`);
 else if(sh&&sh.error&&sh.mode!=='off')links.push(`<span class="stale" title="${esc(sh.error)}">share not live</span>`);
 if(cf&&cf.enabled&&cf.url)links.push(`<a href="${esc(cf.url)}" target="_blank" rel="noopener" title="Always-on copy on Cloudflare${cf.lastPush?', last push '+esc(ago(cf.lastPush)):''}${cf.error?' — push error: '+esc(cf.error):''}"${cf.error?' class="stale"':''}>cloudflare link</a>`);
 $('#sharemeta').innerHTML=s.public?'<span class="ro">read-only view</span>':links.join(' · ');
 const infra=(s.labels&&s.labels.infra)||'Infrastructure';$('#nav-infra').textContent=infra;
 $('#factstitle').textContent=(s.labels&&s.labels.facts)||'Live';$('#rulestitle').textContent=(s.labels&&s.labels.rules)||'Approvals in force';
 const engines=cnt(ag,'engine');
 const k=[
  s.merges?[s.merges.last3h,'merges, 3 h',s.merges.last24+' in 24 h']:['–','merges, 3 h','no git repository'],
  s.prs?[s.prs.open,'open PRs',s.prs.drafts+' drafts']:['–','open PRs','no forge configured'],
  s.issues?[s.issues.open,'open issues',s.issues.closed+'/'+s.issues.total+' closed'+(s.issues.source==='map'?' · from map':'')]:['–','open issues','none recorded'],
  [run+' / '+ag.length,'agents running',Object.entries(engines).map(([e,n])=>n+' '+e).join(' · ')],
  [s.activity.posts24,'tracker posts, 24 h','']];
 $('#kpis').innerHTML=k.map(x=>`<div class="card kpi"><div class="v num">${esc(x[0])}</div><div class="l">${esc(x[1])}</div>${x[2]?`<div class="d">${esc(x[2])}</div>`:''}</div>`).join('');
 $('#areas').innerHTML=(s.areas||[]).map(a=>`<div class="row"><div class="top"><span class="n">${esc(a.name)}</span><span class="p">${a.pct}%</span></div><div class="bar"><i style="width:${a.pct}%;background:${ST[a.state]||C.orange}"></i></div><div class="sub"><span class="st c-${esc(a.state)}">${esc(a.state)}</span><span>${esc(a.note||'')}</span></div></div>`).join('')||'<div class="empty">No areas yet. Agents add them with an <code>area</code> op.</div>';
 const cp=s.critical_path||[],derived=cp.some(x=>x.derived);
 $('#cpsrc').textContent=$('#cpsrc2').textContent=derived?'from the lead agent\'s todo list':'';
 $('#cpfull').innerHTML=cp.map(cpRow).join('')||'<div class="empty">No critical path yet.</div>';
 $('#cpmini').innerHTML=cp.filter(x=>x.state!=='done').slice(0,7).map(cpRow).join('')||'<div class="empty">Nothing queued.</div>';
 renderTimeline();
 // overview charts
 $('#mrgsrc').textContent=s.merges?s.merges.source+' · last 48 h, UTC':'last 48 h, UTC';
 if(s.merges){empty('merges','');const mh=s.merges.per_hour;mk('c-merges',{type:'bar',data:{labels:mh.map(x=>x[0].slice(5,10)+' '+x[0].slice(11,13)+'h'),datasets:[{label:'merges',data:mh.map(x=>x[1]),backgroundColor:C.green,borderRadius:2,barPercentage:.85}]},options:{maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:tip},scales:{x:xt(narrow?4:8),y:{beginAtZero:true,ticks:{precision:0,maxTicksLimit:6}}}}})}else empty('merges','No git repository found.');
 $('#agtot').textContent=ag.length+' total';
 // Freshness counts open agents only, by when they last did anything (finished agents are expected to be quiet).
 const open=ag.filter(a=>a.status!=='closed'),actMin=a=>a.active_min??(a.updated?Math.round((Date.now()-Date.parse(a.updated))/60000):1e9);
 const fb={'≤10 min':0,'10–60 min':0,'>1 h':0};open.forEach(a=>{const m=actMin(a);m<=10?fb['≤10 min']++:m<=60?fb['10–60 min']++:fb['>1 h']++});
 const fbc={'≤10 min':C.green,'10–60 min':C.yellow,'>1 h':C.pink},fbl=`Open agents by last activity (${open.length})`;
 $('#agstatus').innerHTML=ag.length?split('Status',cnt(ag,'status'),STATUS)+split('Engine',engines,ENG)+split(fbl,fb,fbc):'<div class="empty">No agents have reported yet.</div>';
 $('#agmix').innerHTML=[split('Engine',engines,ENG),split('Role',cnt(ag,'kind'),{}),split(fbl,fb,fbc)].map(x=>`<div>${x}</div>`).join('');
 // chunks
 const pc=m=>{const t=m.closed+m.open;return t?Math.round(100*m.closed/t):0};
 const ms=[...(s.milestones||[])].sort((a,b)=>pc(b)-pc(a)||(b.closed+b.open)-(a.closed+a.open));$('#chunkbox').style.height=(Math.max(1,ms.length)*24+40)+'px';
 if(!narrow)mk('c-chunks',{type:'bar',data:{labels:ms.map(m=>m.title),datasets:[{label:'closed',data:ms.map(m=>m.closed),backgroundColor:C.green,borderRadius:2},{label:'open',data:ms.map(m=>m.open),backgroundColor:'#3a382c',borderRadius:2}]},options:{indexAxis:'y',maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:tip},scales:{x:{stacked:true,ticks:{precision:0}},y:{stacked:true,ticks:{autoSkip:false},grid:{display:false}}}}});
 $('#t-chunks').innerHTML=ms.map(m=>{const p=pc(m);return `<div class="row"><div class="top"><span class="n">${esc(m.title)}<span class="src">${esc(m.source)}</span></span><span class="p">${p}%</span></div><div class="bar"><i style="width:${p}%;background:${p==100?C.green:p>=50?C.yellow:C.orange}"></i></div><div class="sub num">${m.closed} closed · ${m.open} open</div></div>`}).join('')||'<div class="empty">No chunks yet.</div>';
 renderFilters();renderAgents();renderPRs();
 const recent=(s.merges&&s.merges.recent)||[];
 $('#merges').innerHTML=more(recent.map(m=>`<div class="it"><span class="tm num">${new Date(m.t*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',hour12:false})}</span>${m.pr?'#'+m.pr+' ':''}${esc(m.title)}</div>`),8,'Earlier merges','merges')||'<div class="empty">No merges in the last 48 h.</div>';
 const bk={'<2 h':0,'2–6 h':0,'6–24 h':0,'1–2 d':0,'>2 d':0};((s.prs&&s.prs.list)||[]).forEach(p=>{const a=p.age_h;a<2?bk['<2 h']++:a<6?bk['2–6 h']++:a<24?bk['6–24 h']++:a<48?bk['1–2 d']++:bk['>2 d']++});
 if(s.prs){empty('prage','');mk('c-prage',{type:'bar',data:{labels:Object.keys(bk),datasets:[{data:Object.values(bk),backgroundColor:C.blue,borderRadius:3}]},options:{maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:tip},scales:{x:{grid:{display:false}},y:{beginAtZero:true,ticks:{precision:0}}}}})}
 else empty('prage',s.forge_error?'Forge error: '+s.forge_error:'No forge configured. Set "forge" in .omp/tracker/config.json.');
 const cph=s.activity.per_hour;mk('c-comments',{type:'line',data:{labels:cph.map(x=>x[0].slice(11,13)+'h'),datasets:[{label:'posts',data:cph.map(x=>x[1]),borderColor:C.purple,backgroundColor:'#ae81ff22',fill:true,tension:.25,borderWidth:2,pointRadius:narrow?0:2}]},options:{maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:tip},scales:{x:xt(narrow?6:12),y:{beginAtZero:true,ticks:{maxTicksLimit:6,precision:0}}}}});
 if(s.issues){empty('issues','');$('#isssrc').textContent=s.issues.source==='map'?'from map issues':s.issues.source;const idd=s.issues.days;mk('c-issues',{type:'bar',data:{labels:idd.map(x=>x[0].slice(5)),datasets:[{label:'opened',data:idd.map(x=>x[1]),backgroundColor:C.orange,borderRadius:2},{label:'closed',data:idd.map(x=>x[2]),backgroundColor:C.green,borderRadius:2}]},options:{maintainAspectRatio:false,plugins:{legend:{position:'top',align:'end'},tooltip:tip},scales:{x:xt(narrow?5:10),y:{beginAtZero:true,ticks:{maxTicksLimit:6,precision:0}}}}})}else{empty('issues','No issues yet. Configure a forge or record issues on map nodes.');$('#isssrc').textContent=''}
 const who=p=>p.agent?`<span class="who">· ${esc(agentName(p.agent))}</span>`:'';
 $('#blkwin').textContent='last '+s.windows.blockersHours+' h';
 $('#blockers').innerHTML=(s.blockers||[]).map(b=>`<div class="it"><span class="tm">${ago(b.t)}${who(b)}</span>${esc(b.text)}</div>`).join('')||`<div class="empty">No blockers posted in the last ${s.windows.blockersHours} hours.</div>`;
 $('#decisions').innerHTML=more((s.decisions||[]).map(d=>`<div class="it"><span class="tm">${ago(d.t)}${who(d)}</span>${esc(d.text)}</div>`),8,'Older','dec')||'<div class="empty">None yet.</div>';
 $('#notes').innerHTML=more((s.notes||[]).map(d=>`<div class="it"><span class="tm">${ago(d.t)}${who(d)}</span>${esc(d.text)}</div>`),8,'Older','notes')||'<div class="empty">None yet.</div>';
 $('#live').innerHTML=(s.facts||[]).map(r=>`<b>${esc(r.key)}</b><span>${esc(r.value)}</span>`).join('')||'<span class="empty">No facts recorded.</span>';
 $('#appr').textContent=s.rules||'None recorded.';
 $('#t-owner').innerHTML=(s.owner_items||[]).map(r=>`<div class="li"><span class="k">${esc(r.key==='-'?'—':r.key)}</span><span>${esc(r.text)}</span></div>`).join('')||'<div class="empty">Nothing waiting on you.</div>';
 $('#t-est').innerHTML=(s.estimates||[]).map(r=>`<div class="li"><span>${esc(r.label)}</span><span class="r">${esc(dash(r.when))}</span></div>`).join('')||'<div class="empty">No estimates.</div>';
 $('#footer').innerHTML=`${esc(s.footer?s.footer+' · ':'')}Sources: ${s.sources.map(esc).join(', ')}. ${POLL?'Hosted copy: refreshes every few seconds while the tracker runs.':LIVE?'Live: updates stream as agents post.':'Snapshot taken '+esc(new Date(s.generated_at).toLocaleString())+'.'}${s.public?' Read-only view; secrets redacted.':''}${s.forge_error&&!s.public?' Forge error: '+esc(s.forge_error):''}`;
 renderTabs();renderMap();renderHist();
}

function renderTimeline(){const s=S,DAY=86400000,today=new Date();
 const comp=(s.phases||[]).filter(c=>c.start&&c.end),est=(s.estimates||[]).filter(e=>e.end||e.start);
 const starts=[...comp.map(c=>dayOf(c.start)),...est.map(e=>dayOf(e.start||e.end))],ends=[...comp.map(c=>dayOf(c.end)),...est.map(e=>dayOf(e.end||e.start))];
 if(!starts.length){$('#gantt').innerHTML='<div class="empty">No phases or dated estimates yet.</div>';$('#donephases').innerHTML='<div class="empty">No completed phases yet.</div>';return}
 const t0=new Date(Math.min(...starts,+dayOf(today.toISOString())-DAY)),t1=new Date(Math.max(...ends,+dayOf(today.toISOString())+DAY)+DAY),sp=t1-t0;
 const pos=d=>Math.max(0,Math.min(100,(d-t0)/sp*100)),todayM=`<div class="gtoday" style="left:${pos(today)}%"></div>`;
 const bar=(a,b,cls)=>`<div class="gbar${cls}" style="left:${pos(a)}%;width:${Math.max(.8,pos(b)-pos(a))}%"></div>`;
 const done=comp.map(c=>`<div class="grow"><div class="gl"><span>✓ ${esc(c.phase)}</span><span class="gd">${span(c.start,c.end)}</span></div><div class="gtrack">${bar(dayOf(c.start),new Date(+dayOf(c.end)+DAY),' ok')}${todayM}</div></div>`).join('');
 const est2=est.map(e=>{const a=e.start?(/T/.test(e.start)?new Date(e.start):dayOf(e.start)):today,b=e.end?(/T/.test(e.end)?new Date(e.end):new Date(+dayOf(e.end)+DAY)):new Date(+a+DAY);return `<div class="grow"><div class="gl"><span>${esc(e.label)}</span><span class="gd">${esc(dash(e.when))}</span></div><div class="gtrack">${bar(a,b,'')}${todayM}</div></div>`}).join('');
 const days=Math.round(sp/DAY),step=Math.max(1,Math.ceil(days/5));const ticks=[];for(let d=0;d<days;d+=step)ticks.push(`<span style="left:${pos(new Date(+t0+d*DAY))}%">${md(new Date(+t0+d*DAY))}</span>`);
 $('#gantt').innerHTML=done+est2+`<div class="grow"><div class="desk"></div><div class="gaxis">${ticks.join('')}</div></div>`;
 $('#donephases').innerHTML=comp.slice().sort((a,b)=>a.end<b.end?1:-1).map(c=>`<div class="ph"><div class="top"><b>${esc(c.phase)}</b><span>${span(c.start,c.end)}</span></div><ul>${(c.items||[]).map(i=>`<li>${esc(i)}</li>`).join('')}</ul></div>`).join('')||'<div class="empty">No completed phases yet.</div>'}

// ---- agents ----
function fillSelect(sel,values,allLabel){const el=$(sel),cur=el.value;const opts=[...new Set(values)].filter(Boolean).sort();
 const want=`<option value="">${allLabel}</option>`+opts.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');if(el.dataset.sig!==want){el.innerHTML=want;el.dataset.sig=want;el.value=opts.includes(cur)?cur:''}}
function renderFilters(){const ag=S.agents||[];fillSelect('#fa-eng',ag.map(a=>a.engine),'All engines');fillSelect('#fa-kind',ag.map(a=>a.kind),'All roles');fillSelect('#fp-a',((S.prs&&S.prs.list)||[]).map(p=>p.author),'All authors')}
const minAgo=m=>m<1?'just now':m<120?m+' min ago':m<2880?(m/60).toFixed(1)+' h ago':(m/1440).toFixed(1)+' d ago';
function fresh(a){const m=a.active_min??Math.max(0,Math.round((Date.now()-Date.parse(a.updated))/60000));
 if(a.status==='closed')return `<span class="note">finished ${minAgo(m)}</span>`;
 if(a.stale)return `<span class="stale" title="Reports from outside omp and has been silent for over 30 min">silent ${minAgo(m)}</span>`;
 const c=m>60?'stale':m>10?'warm':'fresh';return `<span class="${c}">active ${minAgo(m)}</span>`}
function renderAgents(){if(!S)return;const e=$('#fa-eng').value,k=$('#fa-kind').value,st=$('#fa-st').value,q=($('#fa-q').value||'').toLowerCase();
 const order={running:0,idle:1,error:2,closed:3},act=a=>a.active_min??0;
 const rows=(S.agents||[]).filter(a=>(!e||a.engine===e)&&(!k||a.kind===k)&&(!st||a.status===st)&&(!q||[a.name,a.focus,a.last,a.now,a.model,a.thinking,a.action].join(' ').toLowerCase().includes(q)))
  .sort((a,b)=>(order[a.status]??9)-(order[b.status]??9)||(a.stale?1:0)-(b.stale?1:0)||act(a)-act(b));
 $('#agcount').textContent=rows.length+' of '+(S.agents||[]).length;
 $('#agentgrid').innerHTML=rows.map(a=>{const todo=a.todo_total?`<div class="todo"><div class="bar"><i style="width:${Math.round(100*a.todo_done/a.todo_total)}%;background:${C.green}"></i></div><span>${a.todo_done}/${a.todo_total} todos</span></div>`:'';
  const todoList=(a.todo||[]).map(p=>`<div><span class="lb">${esc(p.name)}</span><ul>${p.tasks.map(t=>`<li class="${t.status==='completed'?'done':esc(t.status)}">${esc(t.content)}</li>`).join('')}</ul></div>`).join('');
  const statusWord=a.stale?'silent':a.status,statusCol=a.stale?C.mute:(STATUS[a.status]||C.purple);
  return `<div class="agent${a.status==='closed'||a.stale?' dim':''}"><div class="h"><b style="color:${colorOf(a.engine,ENG)}">${esc(a.name)}</b><span class="st" style="color:${statusCol}">${esc(statusWord)}</span></div><div class="m">${esc(a.engine)} · <span class="mdl">${esc(a.model||'')}</span>${a.thinking?` · thinking <b class="th th-${esc(a.thinking)}">${esc(a.thinking)}</b>`:''} · ${esc(a.kind)}${a.runs>1?` · ${a.runs} runs`:''} · ${fresh(a)}</div><div class="now">${a.now?esc(a.now):'<span class="note">No recent update.</span>'}</div>${a.action?`<div class="act" title="${esc(a.action)}">${esc(a.action)}</div>`:''}${todo}<details data-k="ag-${esc(a.id)}"><summary>Focus, last post and todos</summary>${a.focus?`<div><span class="lb">Focus: </span>${esc(a.focus)}</div>`:''}${a.last?`<div><span class="lb">Last post: </span>${esc(a.last)}${a.last_min!=null?` <span class="lb">(${minAgo(a.last_min)})</span>`:''}</div>`:''}<div><span class="lb">Started: </span>${ago(a.started)} · <span class="lb">seen: </span>${ago(a.updated)}</div><div><span class="lb">ID: </span>${esc(a.id)}</div>${todoList}</details></div>`}).join('')||'<div class="empty">No agents match.</div>'}

// ---- PRs ----
let prSort={k:'n',d:-1};
const age=h=>h<48?(+h).toFixed(1)+' h':(h/24).toFixed(1)+' d';
function renderPRs(){if(!S)return;if(!S.prs){$('#prcount').textContent='';$('#t-prs').innerHTML=`<div class="empty">${S.forge_error?'Forge error: '+esc(S.forge_error):'No forge configured. Set <code>forge</code> in .omp/tracker/config.json (github or gitea).'}</div>`;return}
 const a=$('#fp-a').value,d=$('#fp-d').value,q=($('#fp-q').value||'').toLowerCase();
 let rows=(S.prs.list||[]).filter(p=>(!a||p.author===a)&&(d===''||String(+p.draft)===d)&&(!q||(p.title+' '+p.branch).toLowerCase().includes(q)));
 rows.sort((x,y)=>(x[prSort.k]>y[prSort.k]?1:-1)*prSort.d);$('#prcount').textContent=rows.length+' shown';
 const hd='<div class="pr hd">'+[['n','#'],['title','Title'],['author','Author'],['branch','Branch'],['age_h','Age'],['draft','Draft']].map(c=>`<span data-k="${c[0]}">${c[1]}${prSort.k===c[0]?(prSort.d>0?' ▲':' ▼'):''}</span>`).join('')+'</div>';
 $('#t-prs').innerHTML=hd+(rows.map(p=>`<div class="pr"><span class="pn num">#${p.n}</span><span class="pt">${esc(p.title)}</span><span class="pa" style="color:${colorOf(p.author,ENG)}">${esc(p.author)}</span><span class="pb">${esc(p.branch)}</span><span class="pg">${age(p.age_h)}</span><span class="pd">${p.draft?'draft':''}</span></div>`).join('')||'<div class="empty">No PRs match.</div>');
 document.querySelectorAll('#t-prs .hd span').forEach(th=>th.onclick=()=>{const k=th.dataset.k;prSort={k,d:prSort.k===k?-prSort.d:(k==='n'||k==='age_h'?-1:1)};renderPRs()})}

// ---- trends ----
function renderHist(){const h=[...(S.history||[])].sort((a,b)=>a.t<b.t?-1:1),narrow=isNarrow();
 $('#histnote').textContent=h.length?`${h.length} snapshots since ${new Date(h[0].t).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})}.`:'No history yet: the server records a snapshot every few minutes.';
 const L=h.map(x=>new Date(x.t).toLocaleString([],{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}));
 const line=(id,key,col)=>mk(id,{type:'line',data:{labels:L,datasets:[{data:h.map(x=>x[key]),borderColor:col,backgroundColor:col+'22',fill:true,tension:.25,borderWidth:2,pointRadius:0,spanGaps:true}]},options:{maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:tip},scales:{x:xt(narrow?3:5),y:{ticks:{maxTicksLimit:5}}}}});
 line('h-pct','overall_pct',C.green);line('h-iss','open_issues',C.orange);line('h-mrg','merges24',C.blue)}

// ---- system map ----
const MST={live:C.green,testing:C.yellow,building:C.orange,planned:C.mute,blocked:C.pink};
const MDASH={live:'',testing:'',building:'5 3',planned:'2 3',blocked:''};
const MRES={running:C.yellow,pass:C.green,fail:C.pink,stopped:C.pink,'no result':C.mute};
const FS={built:[C.green,'','built'],progress:[C.orange,'5 3','in progress'],planned:[C.mute,'2 3','planned'],future:[C.purple,'2 3','future']};
const DASH={solid:'',dashed:'5 4',dotted:'1.5 3.5'};
let SEL=null,FSEL=null,MAPVIEW='now',TNB=[],LAYOUT_W=0;
const def=v=>(S&&S.map&&S.map[v])||{items:[],edges:[],edgeKinds:{}};
const item=(v,id)=>def(v).items.find(i=>i.id===id);
const isContainer=(v,id)=>def(v).items.some(i=>i.parent===id);
const mname=id=>{const it=item('now',id);return it?(it.full||it.label):id};
const mstate=id=>{const n=(S.nodes||{})[id];return n&&MST[n.state]?n.state:'planned'};
const hasStatus=id=>!!(S.nodes||{})[id];
const missues=id=>(((S.nodes||{})[id]||{}).issues)||[];
const mnote=id=>((S.nodes||{})[id]||{}).note||'';
const mtests=id=>(S.tests||[]).filter(t=>t.node===id);
const mlive=id=>(S.testing_now||[]).filter(x=>x.node===id);
function sinceAgo(iso){const t=Date.parse(iso);if(!iso||isNaN(t))return 'since ?';const m=Math.max(0,Math.round((Date.now()-t)/60000));return 'since '+(m<60?m+'m':m<1440?Math.floor(m/60)+'h '+(m%60)+'m':Math.floor(m/1440)+'d '+Math.floor(m%1440/60)+'h')+' ago'}

// Text measurement for layout and truncation.
const MEAS=document.createElement('canvas').getContext('2d');
function tw(text,font){MEAS.font=font;return MEAS.measureText(String(text)).width}
const F_LEAF='600 11px Consolas, Inconsolata, monospace',F_TITLE='700 11px Consolas, Inconsolata, monospace',F_SUB='9.5px Consolas, Inconsolata, monospace';
function fit(text,max,font){text=String(text);if(tw(text,font)<=max)return text;while(text.length>1&&tw(text+'…',font)>max)text=text.slice(0,-1);return text+'…'}

// Flow layout: containers wrap their children left to right; leaves in a
// row stretch to fill it; containers in a row share its height.
function layoutMap(view,width){const d=def(view),kids={},byId={};
 for(const it of d.items){byId[it.id]=it}
 for(const it of d.items){const p=it.parent&&byId[it.parent]?it.parent:'';(kids[p]=kids[p]||[]).push(it)}
 const G=8,PX=8,LEAF_MIN=100,LEAF_MAX=260;
 function box(it,maxW){const ch=kids[it.id]||[];
  if(!ch.length){const lines=it.sub?String(it.sub).split('\n').length:0;const want=Math.max(tw(it.label,F_LEAF),...(it.sub?String(it.sub).split('\n').map(l=>tw(l,F_SUB)):[0]))+34;
   return {it,leaf:true,w:it.wide?maxW:Math.min(maxW,Math.max(LEAF_MIN,Math.min(LEAF_MAX,want))),h:40+(lines?lines*12:0),nat:0}}
  const subLines=it.sub?String(it.sub).split('\n').length:0,top=24+subLines*12,inner=maxW-2*PX;
  const rows=[];let row=null,x=0;
  for(const c of ch){const b=box(c,inner);
   if(!row||c.break||it.flow==='column'||(x>0&&x+b.w>inner)){row={items:[],w:0,h:0};rows.push(row);x=0}
   row.items.push(b);b.rx=x;x+=b.w+G;row.w=x-G;row.h=Math.max(row.h,b.h)}
  const titleW=tw(it.label,F_TITLE)+90,contentW=Math.max(0,...rows.map(r=>r.w));
  let w=it.wide?maxW:Math.min(maxW,Math.max(titleW,contentW+2*PX,subLines?Math.max(...String(it.sub).split('\n').map(l=>tw(l,F_SUB)))+2*PX:0));
  const innerW=w-2*PX;
  for(const r of rows){const leaves=r.items.filter(b=>b.leaf&&!b.it.wide),extra=innerW-r.w;
   if(extra>0&&leaves.length&&leaves.length===r.items.length){const add=extra/leaves.length;let xx=0;for(const b of r.items){b.w=Math.min(LEAF_MAX*1.6,b.w+add);b.rx=xx;xx+=b.w+G}r.w=xx-G}
   for(const b of r.items)if(!b.leaf)b.stretchH=r.h}
  let y=top;for(const r of rows){for(const b of r.items)b.ry=y;y+=r.h+G}
  const h=Math.max(y-G+PX,top+12);
  return {it,leaf:false,w,h,rows,top}}
 const roots=kids['']||[],RG=26,rows=[];let row=null,x=0;
 const bs=roots.map(r=>box(r,width));
 for(const b of bs){if(!row||b.it.break||x+b.w>width){row={items:[],h:0};rows.push(row);x=0}row.items.push(b);b.rx=x;x+=b.w+RG;row.h=Math.max(row.h,b.h)}
 for(const r of rows){const leaves=r.items.filter(b=>b.leaf);if(leaves.length===r.items.length){const used=r.items.reduce((s,b)=>s+b.w,0)+(r.items.length-1)*RG,add=Math.max(0,(width-used)/r.items.length);let xx=0;for(const b of r.items){b.w=Math.min(LEAF_MAX*1.6,b.w+add);b.rx=xx;xx+=b.w+RG}}for(const b of r.items)if(!b.leaf)b.stretchH=r.h}
 let y=0;for(const r of rows){for(const b of r.items)b.ry=y;y+=r.h+RG}
 const rects={},order=[];
 function place(b,ox,oy,depth){const h=b.stretchH&&!b.leaf?Math.max(b.h,b.stretchH):b.h,r={id:b.it.id,it:b.it,x:ox+b.rx,y:oy+b.ry,w:b.w,h,leaf:b.leaf,depth};rects[r.id]=r;order.push(r);
  if(!b.leaf)for(const rr of b.rows)for(const c of rr.items)place(c,r.x+PX,r.y,depth+1)}
 for(const b of bs)place(b,2,2,0);
 return {rects,order,w:width,h:Math.max(60,y-RG+6)}}

// Edge routing: orthogonal A* on a 4 px grid. Boxes other than the two ends and the
// containers holding them are obstacles, so lines run in the gaps between boxes.
const RG_CELL=4,TURN=6;
function routeGrid(L){const W=Math.ceil((L.w+12)/RG_CELL),H=Math.ceil((L.h+12)/RG_CELL);return {W,H,used:new Uint8Array(W*H)}}
function ancestors(L,id){const out=new Set();let p=L.rects[id]&&L.rects[id].it.parent;while(p&&L.rects[p]){out.add(p);p=L.rects[p].it.parent}return out}
function routeAround(L,G,a,b){
 const {W,H}=G,blocked=new Uint8Array(W*H),skip=new Set([...ancestors(L,a.id),...ancestors(L,b.id)]);
 const mark=(r,pad)=>{const x0=Math.max(0,Math.floor((r.x-pad)/RG_CELL)),x1=Math.min(W-1,Math.floor((r.x+r.w+pad)/RG_CELL)),y0=Math.max(0,Math.floor((r.y-pad)/RG_CELL)),y1=Math.min(H-1,Math.floor((r.y+r.h+pad)/RG_CELL));
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){const cx=x*RG_CELL+2,cy=y*RG_CELL+2;if(cx>r.x-pad&&cx<r.x+r.w+pad&&cy>r.y-pad&&cy<r.y+r.h+pad)blocked[y*W+x]=1}};
 for(const r of L.order)if(!skip.has(r.id))mark(r,2);
 // Lines that hug a border read as part of the box: make cells near any border (containers we pass through included) cost more.
 const near=new Uint8Array(W*H);
 for(const r of L.order){const band=7,xs=[r.x,r.x+r.w],ys=[r.y,r.y+r.h];
  for(let y=Math.max(0,Math.floor((r.y-band)/RG_CELL));y<=Math.min(H-1,Math.floor((r.y+r.h+band)/RG_CELL));y++)for(let x=Math.max(0,Math.floor((r.x-band)/RG_CELL));x<=Math.min(W-1,Math.floor((r.x+r.w+band)/RG_CELL));x++){
   const cx=x*RG_CELL+2,cy=y*RG_CELL+2;if(xs.some(v=>Math.abs(cx-v)<band)||ys.some(v=>Math.abs(cy-v)<band))near[y*W+x]=1}}
 // Ports: cells just outside each side of a box, middle 70%, with the direction pointing away from (start) or into (goal) the box.
 const DX=[1,-1,0,0],DY=[0,0,1,-1];// 0 right,1 left,2 down,3 up
 const ports=(r,into)=>{const out=[],cxs=[],cys=[];const x0=r.x+r.w*.15,x1=r.x+r.w*.85,y0=r.y+r.h*.15,y1=r.y+r.h*.85,mx=r.x+r.w/2,my=r.y+r.h/2;
  for(let x=Math.ceil(x0/RG_CELL);x*RG_CELL+2<=x1;x++)cxs.push(x);for(let y=Math.ceil(y0/RG_CELL);y*RG_CELL+2<=y1;y++)cys.push(y);
  const top=Math.floor((r.y-3)/RG_CELL),bot=Math.floor((r.y+r.h+3)/RG_CELL),lef=Math.floor((r.x-3)/RG_CELL),rig=Math.floor((r.x+r.w+3)/RG_CELL);
  for(const x of cxs){const off=Math.abs(x*RG_CELL+2-mx)/RG_CELL*.3;out.push({x,y:top,d:into?2:3,off,side:'t'},{x,y:bot,d:into?3:2,off,side:'b'})}
  for(const y of cys){const off=Math.abs(y*RG_CELL+2-my)/RG_CELL*.3;out.push({x:lef,y,d:into?0:1,off,side:'l'},{x:rig,y,d:into?1:0,off,side:'r'})}
  return out.filter(p=>p.x>=0&&p.y>=0&&p.x<W&&p.y<H&&!blocked[p.y*W+p.x])};
 const starts=ports(a,false),goals=ports(b,true);if(!starts.length||!goals.length)return null;
 const goalAt=new Map(goals.map(g=>[g.y*W+g.x,g]));
 const bx0=b.x/RG_CELL,bx1=(b.x+b.w)/RG_CELL,by0=b.y/RG_CELL,by1=(b.y+b.h)/RG_CELL;
 const h=(x,y)=>Math.max(0,bx0-x,x-bx1)+Math.max(0,by0-y,y-by1);
 const N=W*H*4,g=new Float32Array(N).fill(Infinity),prev=new Int32Array(N).fill(-1);
 // Binary heap of [f, state].
 const heap=[];const push=(f,s)=>{heap.push([f,s]);let i=heap.length-1;while(i>0){const p=(i-1)>>1;if(heap[p][0]<=heap[i][0])break;[heap[p],heap[i]]=[heap[i],heap[p]];i=p}};
 const pop=()=>{const top=heap[0],last=heap.pop();if(heap.length){heap[0]=last;let i=0;for(;;){const l=2*i+1,r=l+1;let m=i;if(l<heap.length&&heap[l][0]<heap[m][0])m=l;if(r<heap.length&&heap[r][0]<heap[m][0])m=r;if(m===i)break;[heap[m],heap[i]]=[heap[i],heap[m]];i=m}}return top};
 for(const s of starts){const st=(s.y*W+s.x)*4+s.d,c=s.off;if(c<g[st]){g[st]=c;push(c+h(s.x,s.y),st)}}
 let end=-1,steps=0;
 while(heap.length&&steps++<200000){const [,st]=pop(),cell=st>>2,d=st&3,x=cell%W,y=(cell-x)/W,cost=g[st];
  const gp=goalAt.get(cell);if(gp&&gp.d===d){end=st;break}
  for(let nd=0;nd<4;nd++){if((d===0&&nd===1)||(d===1&&nd===0)||(d===2&&nd===3)||(d===3&&nd===2))continue;
   const nx=x+DX[nd],ny=y+DY[nd];if(nx<0||ny<0||nx>=W||ny>=H)continue;const nc=ny*W+nx;if(blocked[nc]&&!goalAt.has(nc))continue;
   const c=cost+1+(nd!==d?TURN:0)+(G.used[nc]?3:0)+(near[nc]?1.5:0)+(goalAt.has(nc)?goalAt.get(nc).off:0),ns=nc*4+nd;if(c<g[ns]){g[ns]=c;prev[ns]=st;push(c+h(nx,ny),ns)}}}
 if(end<0)return null;
 const cells=[];for(let s=end;s>=0;s=prev[s])cells.push(s>>2);cells.reverse();
 for(const c of cells)G.used[c]=1;
 const P=cells.map(c=>[(c%W)*RG_CELL+2,Math.floor(c/W)*RG_CELL+2]);
 // Snap the ends onto the box borders.
 const s0=starts.find(s=>s.y*W+s.x===cells[0]),g0=goalAt.get(cells[cells.length-1]);
 const snap=(p,side,r,gap)=>side==='t'?[p[0],r.y-gap]:side==='b'?[p[0],r.y+r.h+gap]:side==='l'?[r.x-gap,p[1]]:[r.x+r.w+gap,p[1]];
 P.unshift(snap(P[0],s0.side,a,0));P.push(snap(P[P.length-1],g0.side,b,2));
 // Collapse to corners.
 const pts=[P[0]];for(let i=1;i<P.length-1;i++){const [x0,y0]=pts[pts.length-1],[x1,y1]=P[i],[x2,y2]=P[i+1];if(!((x0===x1&&x1===x2)||(y0===y1&&y1===y2)))pts.push(P[i])}pts.push(P[P.length-1]);
 return {pts,blocked,W,H}}
function labelSpot(route,text){const {pts,blocked,W,H}=route,w=tw(text,F_SUB)+6;let best=null;
 for(let i=0;i<pts.length-1;i++){const [x0,y0]=pts[i],[x1,y1]=pts[i+1],len=Math.abs(x1-x0)+Math.abs(y1-y0);
  const vertical=x0===x1,box=vertical?{x:x0+4,y:(y0+y1)/2-7,w,h:12}:{x:(x0+x1)/2-w/2,y:y0-14,w,h:12};
  if(vertical?len<18:len<w+8)continue;
  let free=true;for(let y=Math.floor(box.y/RG_CELL);free&&y<=Math.floor((box.y+box.h)/RG_CELL);y++)for(let x=Math.floor(box.x/RG_CELL);x<=Math.floor((box.x+box.w)/RG_CELL);x++){if(x<0||y<0||x>=W||y>=H||blocked[y*W+x]){free=false;break}}
  if(free&&(!best||len>best.len))best={len,x:vertical?box.x:(x0+x1)/2,y:vertical?(y0+y1)/2+3.5:y0-4,c:!vertical}}
 return best}
// Fallback when no route exists (should not happen with free gaps): a direct elbow.
function routeEdge(a,b){const acx=a.x+a.w/2,acy=a.y+a.h/2,bcx=b.x+b.w/2,bcy=b.y+b.h/2,ab=a.y+a.h,bb=b.y+b.h;
 if(b.y>=ab||a.y>=bb){const down=b.y>=ab,sy=down?ab:a.y,ey=down?b.y-2:bb+2,my=(sy+ey)/2;return `M${acx},${sy}V${my}H${bcx}V${ey}`}
 const right=bcx>acx,sx=right?a.x+a.w:a.x,ex=right?b.x-2:b.x+b.w+2,mx=(sx+ex)/2;return `M${sx},${acy}H${mx}V${bcy}H${ex}`}

function issMark(id,x,y){const n=missues(id).filter(i=>i.status!=='fixed').length;if(!n)return;TNB.push(`<g data-n="${esc(id)}"><title>${n} open issue(s) found in testing</title><circle cx="${x}" cy="${y}" r="8" fill="${C.pink}" stroke="#000" stroke-width="1.5"/><text x="${x}" y="${y+3.4}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#000">!${n>1?n:''}</text></g>`)}
function tnowMark(id,x,y,w,h,rx){const n=mlive(id).length;if(!n)return '';
 TNB.push(`<g data-n="${esc(id)}"><title>${n} under test now</title><circle cx="${x+w}" cy="${y}" r="8" fill="${C.blue}" stroke="#000" stroke-width="1.5"/><text x="${x+w}" y="${y+3.4}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#000">${n}</text></g>`);
 return `<rect class="tnow" x="${x-4}" y="${y-4}" width="${w+8}" height="${h+8}" rx="${rx+3}" fill="none" stroke="${C.blue}" stroke-width="2.2"/>`}
function mbadge(id,cx,cy){const ts=mtests(id);if(!ts.length)return '';const r=ts[0].result,col=MRES[r]||C.mute,run=ts.some(t=>t.result==='running');
 return `<g${run?' class="pulse"':''}><title>${ts.length} test(s) in the last ${S.windows.testsHours} h; latest ${esc(r)}</title><circle cx="${cx}" cy="${cy}" r="7.5" fill="${col}"/><text x="${cx}" y="${cy+3.4}" text-anchor="middle" font-size="9.5" font-weight="700" fill="#000">${ts.length}</text></g>`}

function markers(kinds,prefix){return `<defs>${Object.entries(kinds).map(([k,e])=>`<marker id="${prefix}${esc(k)}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0.5L7.5,4L0,7.5z" fill="${palette(e.color)}"/></marker>`).join('')}</defs>`}
function edgeKinds(view){const d=def(view),k=Object.assign({},d.edgeKinds);for(const e of d.edges)if(!k[e.kind||'_'])k[e.kind||'_']={color:'dim',style:'solid'};return k}
function edgesSVG(view,L,prefix,withLabels){const d=def(view),kinds=edgeKinds(view),out=[],labels=[],G=routeGrid(L);
 for(const e of d.edges){const a=L.rects[e.from],b=L.rects[e.to];if(!a||!b)continue;const k=kinds[e.kind||'_'],col=palette(k.color);
  const r=routeAround(L,G,a,b),dpath=r?'M'+r.pts.map(p=>p.join(',')).join('L'):routeEdge(a,b),spot=r&&e.label?labelSpot(r,e.label):null;
  out.push(`<path d="${dpath}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linejoin="round" stroke-dasharray="${DASH[k.style]||''}" marker-end="url(#${prefix}${esc(e.kind||'_')})"${e.both?` marker-start="url(#${prefix}${esc(e.kind||'_')})"`:''}>${e.label?`<title>${esc(e.label)}</title>`:''}</path>`);
  if(withLabels&&spot)labels.push(`<text class="lbl" x="${spot.x}" y="${spot.y}"${spot.c?' text-anchor="middle"':''} font-size="9.5" fill="${col}" stroke="#030302" stroke-width="4" paint-order="stroke">${esc(e.label)}</text>`)}
 return out.join('')+labels.join('')}

function mapSVG(width,opt){const o=opt||{},L=layoutMap('now',width),out=[],prefix=o.mini?'am-':'ar-';TNB=[];
 out.push(`<svg class="mapsvg" viewBox="0 0 ${L.w+4} ${L.h+4}" role="img" aria-label="System map: what is built and what is being tested">${markers(edgeKinds('now'),prefix)}`);
 for(const r of L.order){const {id,it,x,y,w,h}=r,sel=SEL===id;
  if(!r.leaf){const st=hasStatus(id)?mstate(id):null,col=st?MST[st]:'#3a3a2e';
   out.push(`<g data-n="${esc(id)}"><rect class="nb" x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${r.depth===0?'#030302':'#080806'}" stroke="${sel?C.fg:col}" stroke-opacity="${st?.85:1}" stroke-width="${sel?2.6:st?1.5:1}" stroke-dasharray="${st?MDASH[st]:''}"/>${tnowMark(id,x,y,w,h,9)}`);issMark(id,x,y);
   const stw=st?st.length*6+28:0;out.push(`<text x="${x+8}" y="${y+16}" font-size="11" font-weight="700" fill="${st?C.fg:C.dim}">${esc(fit(it.label,w-16-stw,F_TITLE))}</text>`);
   if(st){out.push(`<text x="${x+w-8}" y="${y+16}" text-anchor="end" font-size="9" font-weight="700" letter-spacing=".06em" fill="${col}">${st.toUpperCase()}</text>`);out.push(mbadge(id,x+w-8-st.length*6-12,y+12))}
   if(it.sub)String(it.sub).split('\n').forEach((l,i)=>out.push(`<text x="${x+8}" y="${y+30+12*i}" font-size="9.5" fill="${C.mute}">${esc(fit(l,w-16,F_SUB))}</text>`));
   out.push('</g>');continue}
  const st=mstate(id),col=MST[st],run=mtests(id).some(t=>t.result==='running');
  out.push(`<g data-n="${esc(id)}">${run?`<rect class="pulse" x="${x-3}" y="${y-3}" width="${w+6}" height="${h+6}" rx="8" fill="none" stroke="${C.yellow}" stroke-width="1.5"/>`:''}<rect class="nb" x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${col}" fill-opacity=".09" stroke="${sel?C.fg:col}" stroke-width="${sel?2.6:st==='blocked'?2:1.5}" stroke-dasharray="${MDASH[st]}"/>${tnowMark(id,x,y,w,h,6)}`);issMark(id,x,y);
  out.push(`<title>${esc(mname(id))}</title><text x="${x+8}" y="${y+17}" font-size="11" font-weight="600" fill="${C.fg}">${esc(fit(it.label,w-30,F_LEAF))}</text>`);
  let ly=y+31;if(it.sub)String(it.sub).split('\n').forEach(l=>{out.push(`<text x="${x+8}" y="${ly}" font-size="9" fill="${C.mute}">${esc(fit(l,w-16,F_SUB))}</text>`);ly+=12});
  out.push(`<text x="${x+8}" y="${ly}" font-size="8.5" font-weight="700" letter-spacing=".06em" fill="${col}">${st.toUpperCase()}</text>${mbadge(id,x+w-12,y+h-13)}</g>`)}
 out.push(edgesSVG('now',L,prefix,!o.mini));
 out.push(...TNB,'</svg>');return out.join('')}

const fcol=id=>{const f=item('future',id);return f&&FS[f.state]?FS[f.state][0]:'#3a3a2e'};
const flabel=f=>(FS[f.state][2]+(f.ref?' '+f.ref:'')).toUpperCase();
function futSVG(width){const L=layoutMap('future',width),out=[];
 out.push(`<svg class="mapsvg" viewBox="0 0 ${L.w+4} ${L.h+4}" role="img" aria-label="Future-state system map">${markers(edgeKinds('future'),'fa-')}`);
 for(const r of L.order){const {id,it,x,y,w,h}=r,f=FS[it.state]?it:null,col=fcol(id),sel=FSEL===id,lab=f?flabel(f):'';
  if(!r.leaf){out.push(`<g data-f="${esc(id)}"><rect class="nb" x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${r.depth===0?'#030302':'#080806'}" stroke="${sel?C.fg:col}" stroke-opacity="${f?.85:1}" stroke-width="${sel?2.6:f?1.5:1}" stroke-dasharray="${f?FS[f.state][1]:''}"/>`);
   const lw=f?lab.length*6+16:0;out.push(`<text x="${x+8}" y="${y+16}" font-size="11" font-weight="700" fill="${f?C.fg:C.dim}">${esc(fit(it.label,w-16-lw,F_TITLE))}</text>`);
   if(f)out.push(`<text x="${x+w-8}" y="${y+16}" text-anchor="end" font-size="9" font-weight="700" letter-spacing=".06em" fill="${col}">${esc(lab)}</text>`);
   if(it.sub)String(it.sub).split('\n').forEach((l,i)=>out.push(`<text x="${x+8}" y="${y+30+12*i}" font-size="9.5" fill="${C.mute}">${esc(fit(l,w-16,F_SUB))}</text>`));
   out.push('</g>');continue}
  out.push(`<g data-f="${esc(id)}"><rect class="nb" x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${col}" fill-opacity=".09" stroke="${sel?C.fg:col}" stroke-width="${sel?2.6:1.5}" stroke-dasharray="${f?FS[f.state][1]:''}"/><title>${esc(it.full||it.label)}</title><text x="${x+8}" y="${y+17}" font-size="11" font-weight="600" fill="${C.fg}">${esc(fit(it.label,w-16,F_LEAF))}</text>`);
  let ly=y+31;if(it.sub)String(it.sub).split('\n').forEach(l=>{out.push(`<text x="${x+8}" y="${ly}" font-size="9" fill="${C.mute}">${esc(fit(l,w-16,F_SUB))}</text>`);ly+=12});
  out.push(`<text x="${x+8}" y="${ly}" font-size="8.5" font-weight="700" letter-spacing=".06em" fill="${col}">${esc(fit(lab,w-16,F_SUB))}</text></g>`)}
 out.push(edgesSVG('future',L,'fa-',true));out.push('</svg>');return out.join('')}

function futPanel(p){const f=item('future',FSEL);p.hidden=false;const st=FS[f.state];
 p.innerHTML=`<div class="ph2"><b>${esc(f.full||f.label)}</b><button class="x" data-close="1">close</button></div><div>${st?`<span class="st" style="color:${st[0]}">${esc(st[2])}</span>`:''}${f.ref?`<span class="iss">${esc(f.ref)}</span>`:''}</div><div class="pn">${esc(f.desc||'')||'No description.'}</div>${f.now&&item('now',f.now)?`<a class="golive" href="#map/${esc(f.now)}">See it live → Now view</a>`:''}`}
function fselNode(id){FSEL=(id&&id!==FSEL&&item('future',id))?id:null;drawMap();if(FSEL&&!isNarrow()){const p=$('#mappanel');if(p&&p.scrollIntoView)p.scrollIntoView({block:'nearest'})}}
function mapCounts(){const c={live:0,testing:0,building:0,planned:0,blocked:0};for(const it of def('now').items){if(isContainer('now',it.id)&&!hasStatus(it.id))continue;c[mstate(it.id)]++}return c}
function mapWidth(){const box=$('#mapbox');return Math.max(330,Math.min(1600,Math.floor((box&&box.clientWidth)||1000)-4))}
function drawMap(){const box=$('#mapbox'),fut=MAPVIEW==='future',d=def(MAPVIEW);LAYOUT_W=mapWidth();
 box.innerHTML=d.items.length?(fut?futSVG(LAYOUT_W):mapSVG(LAYOUT_W)):`<div class="mapempty">${fut?'No future-state map yet. Agents draw one with a <code>map</code> op and <code>view: "future"</code>.':'No system map yet. Agents draw one with a <code>map</code> op: boxes (items with optional parent containers) and edges.'}</div>`;
 document.querySelectorAll('#mapseg button').forEach(b=>{const on=b.getAttribute('data-view')===MAPVIEW;b.classList.toggle('on',on);b.setAttribute('aria-pressed',on?'true':'false')});
 const lgEdges=view=>Object.entries(def(view).edgeKinds||{}).filter(([,e])=>e.label).map(([,e])=>`<span><i class="ln" style="border-top:2px ${e.style||'solid'} ${palette(e.color)}"></i>${esc(e.label)}</span>`).join('');
 if(fut){$('#mapsum').textContent='future state · the stated direction';
  $('#maplegend').innerHTML='<div class="maplegend">'+Object.keys(FS).map(s=>`<span><i class="bx" style="border-color:${FS[s][0]};border-style:${FS[s][1]?(FS[s][1]==='2 3'?'dotted':'dashed'):'solid'};background:${FS[s][0]}18"></i>${FS[s][2]}</span>`).join('')+'</div><div class="maplegend">'+lgEdges('future')+'</div>';
  $('#mapnote').textContent='Tap a box to see its status, what it is and its issue.'}
 else{const c=mapCounts(),nt=(S.testing_now||[]).length;$('#mapsum').textContent=`${c.live} live · ${c.testing} testing · ${c.building} building · ${c.blocked} blocked${nt?` · ${nt} under test now`:''}`;
  $('#maplegend').innerHTML='<div class="maplegend">'+Object.keys(MST).map(s=>`<span><i class="bx" style="border-color:${MST[s]};border-style:${MDASH[s]?(s==='planned'?'dotted':'dashed'):'solid'};background:${MST[s]}18"></i>${s}</span>`).join('')+`<span><i class="bx tn"></i>testing now</span><span><i class="bx" style="border-radius:50%;background:${C.pink};border-color:${C.pink}"></i>open issues from testing</span></div><div class="maplegend">`+lgEdges('now')+'</div>';
  $('#mapnote').textContent='Tap a box to see its status and its tests.'}
 renderPanel()}
function setMapView(v){location.hash=v==='future'?'map/future':'map'}
function failInfo(t){if(!['fail','stopped','no result'].includes(t.result))return '';const n=(S.test_notes||{})[t.id]||{},why=n.why?[n.why]:(t.why||[]),nx=n.next||t.next||'';
 const res=t.resolved?`<div class="tf ok">Resolved: ${esc(t.resolved.name)} passed at ${hm(t.resolved.t)}.</div>`:(t.node&&mstate(t.node)==='live'?`<div class="tf ok">Superseded: ${esc(mname(t.node))} is live now.</div>`:`<div class="tf open">Not resolved yet.</div>`);
 if(t.result==='no result')return `<div class="tfx">${res}<div class="tf">Started, but no result was posted within ${S.windows.noResultHours} h.</div></div>`;
 return `<div class="tfx">${res}${why.length?`<div class="tf why"><span class="lb">Why: </span>${esc(why[0])}</div>`:'<div class="tf why"><span class="lb">Why: </span>no reason was stated in the post.</div>'}<details class="tfd" data-k="tf-${esc(t.id)}" onclick="event.stopPropagation()"><summary>More</summary>${why.slice(1).map(w=>`<div class="tf">${esc(w)}</div>`).join('')}${nx?`<div class="tf"><span class="lb">Next: </span>${esc(nx)}</div>`:''}<div class="tf note">Test ${esc(t.id)}${t.agent?' · posted by '+esc(agentName(t.agent)):''}</div></details></div>`}
function testRow(t,showNode){const bad=['fail','stopped'].includes(t.result)&&!t.resolved&&!(t.node&&mstate(t.node)==='live');
 return `<div class="tr${bad?' bad':''}" data-n="${esc(t.node)}"><span class="tm">${hm(t.t)}</span><span class="rs r-${t.result==='no result'?'none':esc(t.result)}">${esc(t.result)}</span><span class="tn">${esc(t.name)}</span>${showNode?`<span class="tw">${[t.node?mname(t.node):'',t.lane,ago(t.t)].filter(Boolean).map(esc).join(' · ')}</span>`:''}${failInfo(t)}</div>`}
function tnowRow(x,showNode){return `<div class="tr" data-n="${esc(x.node)}"><span class="tn">${showNode&&x.node?`<b>${esc(mname(x.node))}</b> · `:''}${esc(x.what)}</span><span class="ag">${esc(sinceAgo(x.since))}</span><span class="tw">${[x.lane,x.where,x.agent?agentName(x.agent):''].filter(Boolean).map(esc).join(' · ')||'no lane or place given'}</span></div>`}
function renderMap(){drawMap();const ts=S.tests||[];$('#testwin').textContent='last '+S.windows.testsHours+' h';
 const openF=ts.filter(t=>['fail','stopped'].includes(t.result)&&!t.resolved&&!(t.node&&mstate(t.node)==='live'));
 $('#testlist').innerHTML=(openF.length?`<div class="failsum">${openF.length} failed test${openF.length>1?'s':''} not yet resolved: ${openF.map(t=>esc(t.name)).join(' · ')}</div>`:(ts.some(t=>['fail','stopped'].includes(t.result))?`<div class="failsum ok">Every failure in the last ${S.windows.testsHours} h has a later passing run.</div>`:''))+(more(ts.map(t=>testRow(t,true)),14,'Earlier tests','tests')||`<div class="empty">No test runs posted in the last ${S.windows.testsHours} h.</div>`);
 renderMini()}
function invHTML(id){const I=((S.nodes||{})[id]||{}).inventory;if(!I||!(I.items||[]).length)return `<h3>What is stood up</h3><div class="note">No inventory recorded for this part yet.</div>`;
 return `<h3>What is stood up <small>${I.asof?'as of '+esc(new Date(I.asof).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false})):''}</small></h3>${I.summary?`<div class="pn">${esc(I.summary)}</div>`:''}<ul class="inv">${I.items.map(x=>`<li><span class="ist c-${esc(x.state||'live')}">${esc(x.state||'live')}</span><b>${esc(x.what)}</b>${x.detail?`<div class="idt">${esc(x.detail)}</div>`:''}</li>`).join('')}</ul>${I.source?`<div class="note">Source: ${esc(I.source)}</div>`:''}`}
function renderPanel(){const p=$('#mappanel');if(MAPVIEW==='future'){if(FSEL&&item('future',FSEL))futPanel(p);else{p.hidden=true;p.innerHTML=''}return}
 if(!SEL||!item('now',SEL)){p.hidden=true;p.innerHTML='';return}
 const st=mstate(SEL),ts=mtests(SEL),lv=mlive(SEL),is=missues(SEL);p.hidden=false;
 const ic=x=>x.status==='fixed'?'live':(x.status==='open'?'blocked':'building');
 const node=(S.nodes||{})[SEL]||{},ck=(S.checks||[]).filter(c=>c.node===SEL),bind=node.bind||{};
 const bindTxt=[bind.ci?`CI runs of <b>${esc(bind.ci)}</b> post tests here`:'',bind.label?`issues labeled <b>${esc(bind.label)}</b> show here`:''].filter(Boolean).join(' · ');
 const checksHTML=ck.length?`<h3>Health checks <small>${ck.length}${node.auto==='probes'?' · these set the state':''}</small></h3><div class="tests">${ck.map(c=>{const r=c.result;return `<div class="tr${r&&!r.ok?' bad':''}"><span class="tm">${r?hm(r.t):'–'}</span><span class="rs ${r?(r.ok?'r-pass':'r-fail'):'r-none'}">${r?(r.ok?'pass':'fail'):'pending'}</span><span class="tn">${esc(c.name)}</span><span class="tw">${esc(c.kind)}${c.kind==='cmd'?'':' '+esc(c.target)} · every ${c.everySeconds}s${r?` · ${esc(r.detail)} · ${r.ok?'passing':'failing'} ${esc(sinceAgo(r.since))}`:''}</span></div>`}).join('')}</div>`:'';
 p.innerHTML=`<div class="ph2"><b>${esc(mname(SEL))}</b><button class="x" data-close="1">close</button></div><div><span class="st c-${st}">${esc(st)}</span>${node.auto==='probes'?'<span class="iss">from health checks</span>':''}</div><div class="pn">${esc(mnote(SEL))||'No note yet.'}${bindTxt?`<div class="note" style="margin-top:6px">Auto: ${bindTxt}.</div>`:''}</div>`+checksHTML+
  (lv.length?`<h3 style="color:${C.blue}">Testing now <small>${lv.length}</small></h3><div class="tests tnl">${lv.map(x=>tnowRow(x,false)).join('')}</div>`:'')+
  (is.length?`<h3 style="color:${C.pink}">Issues found in testing <small>${is.length}</small></h3><div class="tests">${is.map(x=>`<div class="cpi"><span class="node ${ic(x)}"></span><div class="b"><div class="t"><span class="n">${esc(x.what)}</span><span class="st c-${ic(x)}">${esc(x.status)}</span></div>${x.fix?`<div class="nt">${esc(x.fix)}</div>`:''}${x.lane||x.when?`<div class="own">${[x.lane,x.when?ago(x.when):''].filter(Boolean).map(esc).join(' · ')}</div>`:''}</div></div>`).join('')}</div>`:'')+
  invHTML(SEL)+`<h3>Tests, last ${S.windows.testsHours} h</h3><div class="tests">${ts.map(t=>testRow(t,false)).join('')||`<div class="empty">No tests posted for this part in the last ${S.windows.testsHours} h.</div>`}</div>`}
function renderMini(){const el=$('#mapmini');const c=mapCounts(),ts=S.tests||[],items=def('now').items,narrow=isNarrow();
 const lvn=[...new Set((S.testing_now||[]).map(x=>x.node).filter(Boolean))];
 let left;
 if(!items.length)left='<div class="mapempty">No system map yet.</div>';
 else if(narrow)left=split('',c,MST)+`<div class="chips">${lvn.map(k=>`<button class="chip tnc" data-go="${esc(k)}"><span class="tcn">${mlive(k).length}</span><span class="st" style="color:${C.blue}">testing now</span>${esc(mname(k))}</button>`).join('')}${items.filter(i=>['blocked','testing'].includes(mstate(i.id))&&(!isContainer('now',i.id)||hasStatus(i.id))).sort((a,b)=>['blocked','testing'].indexOf(mstate(a.id))-['blocked','testing'].indexOf(mstate(b.id))).map(i=>`<button class="chip" data-go="${esc(i.id)}"><span class="st c-${mstate(i.id)}">${esc(mstate(i.id))}</span>${esc(mname(i.id))}</button>`).join('')}</div><div class="note" style="margin-top:8px">${c.building} parts building, ${c.planned} planned. <a href="#map">Open the map</a> to see them all.</div>`;
 else{// A hidden overview has no width; derive it from <main> so the mini map is not drawn oversized.
  const avail=el.clientWidth||(($('main').clientWidth||1040)-40);const w=Math.max(330,avail-(window.innerWidth>=1100?384:0)-4);left=`<div class="mapbox">${mapSVG(w,{mini:1})}</div>`}
 const al=S.testing_now||[],tl=$('#tnowlist');tl.innerHTML=al.map(x=>tnowRow(x,true)).join('')||'<div class="empty">Nothing under test</div>';$('#tnowsum').textContent=al.length?`${al.length} active · tap to open on the map`:'';
 el.innerHTML=`<div class="mm"><div>${left}</div><div><div class="sl">Tests now and recent</div><div class="tests">${ts.slice(0,narrow?4:7).map(t=>testRow(t,false)).join('')||`<div class="empty">No test runs posted in the last ${S.windows.testsHours} h.</div>`}</div></div></div>`}
function selNode(id){SEL=(id&&id!==SEL)?id:null;drawMap();if(SEL&&!isNarrow()){const p=$('#mappanel');if(p&&p.scrollIntoView)p.scrollIntoView({block:'nearest'})}}
function mapClick(e){const t=e.target;if(!t||!t.closest)return;const vb=t.closest('[data-view]');if(vb){setMapView(vb.getAttribute('data-view'));return}if(t.closest('.golive')||t.closest('details'))return;
 if(MAPVIEW==='future'){if(t.closest('[data-close]')){fselNode(null);return}const f=t.closest('[data-f]');if(f){fselNode(f.getAttribute('data-f'));return}const n=t.closest('[data-n]');if(n&&n.getAttribute('data-n'))location.hash='map/'+n.getAttribute('data-n');return}
 if(t.closest('[data-close]')){selNode(null);return}const n=t.closest('[data-n]');if(n&&n.getAttribute('data-n'))selNode(n.getAttribute('data-n'))}
function miniClick(e){const t=e.target;if(!t||!t.closest||t.closest('details'))return;const g=t.closest('[data-go]')||t.closest('[data-n]');if(!g)return;const id=g.getAttribute('data-go')||g.getAttribute('data-n');if(id){SEL=id;location.hash='map/'+id}}
$('#v-map').addEventListener('click',mapClick);$('#mapmini').addEventListener('click',miniClick);$('#tnowlist').addEventListener('click',miniClick);
document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(MAPVIEW==='future'){if(FSEL)fselNode(null)}else if(SEL)selNode(null)});
let rsz;window.addEventListener('resize',()=>{clearTimeout(rsz);rsz=setTimeout(()=>{if(!S)return;if(mapWidth()!==LAYOUT_W)drawMap();renderMini()},120)});
['#fa-eng','#fa-kind','#fa-st','#fa-q'].forEach(s=>$(s).addEventListener('input',renderAgents));['#fp-a','#fp-d','#fp-q'].forEach(s=>$(s).addEventListener('input',renderPRs));
$('#fp-s').addEventListener('input',()=>{const v=($('#fp-s').value||'n:-1').split(':');prSort={k:v[0],d:+v[1]};renderPRs()});

// ---- custom tabs ----
// Agents design these per run: a list of typed blocks (table, stats, kv, list, text, chart).
const XSORT={};
const SERIES_COL=[C.green,C.blue,C.orange,C.purple,C.yellow,C.pink,C.dim];
const STATE_COL={live:C.green,done:C.green,pass:C.green,ok:C.green,best:C.green,built:C.blue,testing:C.yellow,active:C.yellow,running:C.yellow,building:C.orange,partial:C.orange,queued:C.mute,planned:C.mute,dropped:C.mute,skipped:C.mute,blocked:C.pink,fail:C.pink,failed:C.pink,error:C.pink};
const fmtNum=(v,d)=>typeof v==='number'?v.toLocaleString(undefined,{minimumFractionDigits:d??0,maximumFractionDigits:d??(Math.abs(v)<10?3:1)}):esc(v);
const fmtTokens=v=>typeof v!=='number'?esc(v):v>=1e6?(v/1e6).toFixed(2)+'M':v>=1e3?(v/1e3).toFixed(0)+'k':String(v);
function textHTML(t){return String(t||'').split(/\n{2,}/).map(p=>{const lines=p.split('\n');if(lines.every(l=>/^\s*[-*] /.test(l)))return `<ul class="xul">${lines.map(l=>`<li>${esc(l.replace(/^\s*[-*] /,''))}</li>`).join('')}</ul>`;return `<p>${lines.map(esc).join('<br>')}</p>`}).join('')}
function cellHTML(col,v,ctx){if(v===undefined||v===null||v==='')return '<span class="note">–</span>';const k=col.kind||'text';
 if(k==='number')return `<span class="num">${fmtNum(v,col.digits)}</span>`;
 if(k==='tokens')return `<span class="num">${fmtTokens(v)}</span>`;
 if(k==='pct')return typeof v==='number'?`<span class="xsc"><span class="num">${fmtNum(v,col.digits??0)}%</span><i class="xbar"><b style="width:${Math.max(0,Math.min(100,v))}%"></b></i></span>`:esc(v);
 if(k==='score'){if(typeof v!=='number')return esc(v);const {min,max}=ctx[col.key]||{min:0,max:1},span=max-min||1,best=col.lowerBetter?v===min:v===max;
  const w=col.lowerBetter?(max-v)/span:(v-Math.min(0,min))/((max-Math.min(0,min))||1);return `<span class="xsc${best?' best':''}"><span class="num">${fmtNum(v,col.digits)}</span><i class="xbar"><b style="width:${Math.max(3,Math.min(100,w*100))}%"></b></i></span>`}
 if(k==='delta'){if(typeof v!=='number')return esc(v);const good=col.lowerBetter?v<0:v>0;return `<span class="num" style="color:${v===0?C.dim:good?C.green:C.pink}">${v>0?'+':''}${fmtNum(v,col.digits)}</span>`}
 if(k==='state')return `<span class="st" style="color:${STATE_COL[String(v).toLowerCase()]||C.dim}">${esc(v)}</span>`;
 return esc(v)}
function tableHTML(t,b){const cols=b.columns||[],key=`${t.id}/${b.id}`,srt=XSORT[key]||{k:b.sort,d:b.sortDir||(b.sort?'desc':'asc')};
 let rows=[...(b.rows||[])];
 if(srt.k){const col=cols.find(c=>c.key===srt.k),dir=srt.d==='asc'?1:-1;rows.sort((x,y)=>{const a=x[srt.k],c=y[srt.k];if(a==null&&c==null)return 0;if(a==null)return 1;if(c==null)return -1;
  return (typeof a==='number'&&typeof c==='number'?a-c:String(a).localeCompare(String(c),undefined,{numeric:true}))*dir});
  // Muted / unranked rows (references, dropped arms) stay below the ranked ones.
  rows.sort((x,y)=>(x._unranked||x._muted?1:0)-(y._unranked||y._muted?1:0));void col}
 const ctx={};for(const c of cols)if(c.kind==='score'){const vs=rows.filter(r=>!r._unranked&&!r._muted).map(r=>r[c.key]).filter(v=>typeof v==='number');if(vs.length)ctx[c.key]={min:Math.min(...vs),max:Math.max(...vs)}}
 let rank=0;
 const head=(b.rank?'<th class="xrk">#</th>':'')+cols.map(c=>`<th data-xs="${esc(key)}" data-k="${esc(c.key)}" class="${['number','score','pct','delta','tokens'].includes(c.kind)?'r':''}">${esc(c.label||c.key)}${srt.k===c.key?(srt.d==='asc'?' ▲':' ▼'):''}</th>`).join('');
 const body=rows.map(r=>{const unr=r._unranked||r._muted;const rk=b.rank?`<td class="xrk">${unr?'–':++rank}</td>`:'';
  return `<tr class="${r._muted?'mut':''}${r._highlight?' hi':''}">${rk}${cols.map(c=>`<td class="${['number','score','pct','delta','tokens'].includes(c.kind)?'r':''}">${cellHTML(c,r[c.key],ctx)}</td>`).join('')}</tr>${r._note?`<tr class="xnote${r._muted?' mut':''}"><td colspan="${cols.length+(b.rank?1:0)}">${esc(r._note)}</td></tr>`:''}`}).join('');
 return `<div class="xtw"><table class="xt"><thead><tr>${head}</tr></thead><tbody>${body||`<tr><td colspan="${cols.length+(b.rank?1:0)}" class="empty">No rows yet.</td></tr>`}</tbody></table></div>`}
function blockHTML(t,b,opener){let inner='';
 if(b.kind==='table')inner=tableHTML(t,b);
 else if(b.kind==='stats')inner=`<div class="xstats">${(b.items||[]).map(i=>`<div class="xstat"><div class="v num"${i.state?` style="color:${STATE_COL[String(i.state).toLowerCase()]||C.fg}"`:''}>${esc(i.value??'–')}</div><div class="l">${esc(i.label||'')}</div>${i.sub?`<div class="d">${esc(i.sub)}</div>`:''}</div>`).join('')}</div>`;
 else if(b.kind==='kv')inner=`<div class="kv">${(b.items||[]).map(i=>`<b>${esc(i.label||'')}</b><span>${esc(i.value??i.text??'')}${i.sub?` <span class="note">${esc(i.sub)}</span>`:''}</span>`).join('')}</div>`;
 else if(b.kind==='list')inner=`<div class="xlist">${(b.items||[]).map(i=>`<div class="xli">${i.state?`<span class="st" style="color:${STATE_COL[String(i.state).toLowerCase()]||C.dim}">${esc(i.state)}</span>`:''}<div><div>${esc(i.text??i.label??'')}${i.value!=null?` <b class="num">${esc(i.value)}</b>`:''}</div>${i.sub?`<div class="note">${esc(i.sub)}</div>`:''}</div></div>`).join('')||'<div class="empty">Nothing yet.</div>'}</div>`;
 else if(b.kind==='text')inner=`<div class="xtext">${textHTML(b.text)}</div>`;
 else if(b.kind==='chart')inner=`<div class="chartbox${b.chart==='hbar'?' xh':''}" style="${b.chart==='hbar'?`height:${Math.max(120,(b.labels||[]).length*26+40)}px`:''}"><canvas id="xc-${esc(t.id)}-${esc(b.id)}"></canvas></div>`;
 return `<div class="card${b.half?' half':''}" data-block="${esc(t.id)}/${esc(b.id)}">${b.title?`<h2><span>${opener||''}${esc(b.title)}</span><small>${b.kind==='table'?`${(b.rows||[]).length} rows · `:''}updated ${ago(b.updated)}</small></h2>`:''}${b.note?`<div class="note xbn">${esc(b.note)}</div>`:''}${inner}</div>`}
function drawCharts(t,blocks,suffix){for(const b of blocks){if(b.kind!=='chart')continue;const id=`xc-${t.id}-${b.id}${suffix}`;const el=document.getElementById(id);if(!el)continue;
 const type=b.chart==='line'?'line':'bar',series=b.series||[];
 mk(id,{type,data:{labels:b.labels||[],datasets:series.map((s,i)=>{const col=s.color?palette(s.color):SERIES_COL[i%SERIES_COL.length];return {label:s.name,data:s.values,backgroundColor:type==='line'?col+'22':col,borderColor:col,borderWidth:type==='line'?2:0,borderRadius:2,fill:type==='line'&&series.length===1,tension:.25,pointRadius:type==='line'?2:0,spanGaps:true}})},
  options:{indexAxis:b.chart==='hbar'?'y':'x',maintainAspectRatio:false,plugins:{legend:{display:series.length>1,position:'top',align:'end'},tooltip:tip},scales:{x:{grid:{display:b.chart==='hbar'},ticks:{autoSkip:true,maxRotation:0}},y:{grid:{display:b.chart!=='hbar'},beginAtZero:true,ticks:{autoSkip:false}}}}})}}
function renderTabs(){const tabs=S.tabs||[];
 const sig=tabs.map(t=>t.id+':'+t.title).join('|');
 if($('#navx').dataset.sig!==sig){$('#navx').dataset.sig=sig;$('#navx').innerHTML=tabs.map(t=>`<a href="#x-${esc(t.id)}">${esc(t.title)}</a>`).join('');
  $('#xviews').innerHTML=tabs.map(t=>`<section class="view" id="v-x-${esc(t.id)}"></section>`).join('');route()}
 for(const t of tabs){const sec=document.getElementById('v-x-'+t.id);if(!sec)continue;
  // Charts keep their canvas across renders; rebuild only the non-chart blocks' HTML when the structure is unchanged.
  sec.innerHTML=`${t.note?`<div class="xhead">${esc(t.note)}</div>`:''}<div class="xgrid">${t.blocks.map(b=>blockHTML(t,b)).join('')||'<div class="card"><div class="empty">This tab has no blocks yet.</div></div>'}</div>`;
  drawCharts(t,t.blocks,'')}
 const pins=tabs.flatMap(t=>t.blocks.filter(b=>b.pin).map(b=>({t,b})));
 $('#pinned').innerHTML=pins.map(({t,b})=>blockHTML(t,{...b,title:b.title||t.title},`<a class="xopen" href="#x-${esc(t.id)}">${esc(t.title)} ›</a> `).replace(/id="xc-([^"]+)"/,'id="xc-$1-pin"')).join('');
 for(const {t,b} of pins)drawCharts(t,[b],'-pin');
 // Table header clicks sort; state is kept per block across live updates.
 document.querySelectorAll('th[data-xs]').forEach(th=>th.onclick=()=>{const key=th.dataset.xs,k=th.dataset.k,cur=XSORT[key]||{};XSORT[key]={k,d:cur.k===k&&cur.d==='desc'?'asc':'desc'};renderTabs()})}

// ---- routing ----
const views=['overview','map','path','chunks','agents','prs','activity','feeds','infra','owner'];
const allViews=()=>[...views,...((S&&S.tabs)||[]).map(t=>'x-'+t.id)];
function route(){const sp=new URLSearchParams(location.search||''),qs=sp.get('tab'),hp=(location.hash||'').slice(1).split('/'),hv=hp[0],vs=allViews(),v=vs.includes(hv)?hv:vs.includes(qs)?qs:'overview';
 if(v==='map'){const fut=views.includes(hv)?hp[1]==='future':sp.get('view')==='future';MAPVIEW=fut?'future':'now';
  if(fut){const f=hp[2]||sp.get('node');FSEL=f||null}else{const nd=hp[1]||sp.get('node');SEL=nd?decodeURIComponent(nd):null}}
 vs.forEach(x=>{const el=document.getElementById('v-'+x);if(el)el.classList.toggle('act',x===v)});
 document.querySelectorAll('nav a').forEach(a=>a.classList.toggle('act',a.getAttribute('href')==='#'+v));centerTab();
 if(S&&v==='map')drawMap();
 if(S&&v==='overview')renderMini();
 Object.values(charts).forEach(c=>c.resize&&c.resize())}
function centerTab(){const n=$('#nav'),a=n&&n.querySelector('a.act');if(a&&n.clientWidth)n.scrollLeft=Math.max(0,a.offsetLeft-n.offsetLeft-(n.clientWidth-a.offsetWidth)/2)}
window.addEventListener('hashchange',route);window.addEventListener('load',centerTab);window.addEventListener('resize',centerTab);

// Keep open <details> open across live re-renders.
function renderKeepingState(){const open=new Set([...document.querySelectorAll('details[data-k][open]')].map(d=>d.getAttribute('data-k')));render();
 document.querySelectorAll('details[data-k]').forEach(d=>{if(open.has(d.getAttribute('data-k')))d.open=true})}
function setLive(state){const box=$('#livebox'),dot=$('#livedot'),txt=$('#livetxt');box.classList.toggle('down',state==='down'||state==='stale');box.classList.toggle('snap',state==='snapshot');dot.classList.toggle('on',state==='live');dot.classList.toggle('off',state==='down'||state==='stale');txt.textContent=state==='live'?'live':state==='down'?'reconnecting':state==='stale'?'source offline':'snapshot'}
route();
const seedEl=document.getElementById('seed');
if(seedEl){S=JSON.parse(seedEl.textContent);setLive('snapshot');render()}
else if((document.querySelector('meta[name="tracker-transport"]')||{}).content==='poll'){
 // Hosted copy (Cloudflare): no event stream; poll the last pushed snapshot.
 LIVE=true;POLL=true;let last='';
 const poll=async()=>{try{const r=await fetch('api/snapshot',{cache:'no-store'});if(r.ok){const txt=await r.text();if(txt!==last){last=txt;S=JSON.parse(txt);renderKeepingState()}
  // The tracker pushes at least every minute while it runs; older means the source is offline.
  setLive(Date.now()-Date.parse(S.generated_at)>3*60000?'stale':'live')}else setLive('down')}catch{setLive('down')}};
 poll();setInterval(poll,8000)}
else{LIVE=true;const es=new EventSource('api/stream');
 es.addEventListener('snapshot',ev=>{S=JSON.parse(ev.data);setLive('live');renderKeepingState()});
 es.onerror=()=>setLive('down');es.onopen=()=>setLive('live')}
setInterval(()=>{if(S)$('#upd').textContent=ago(S.generated_at)+', '+hm(S.generated_at)},30000);
