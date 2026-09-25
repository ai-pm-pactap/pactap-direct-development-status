import { loadReport } from './report-source.mjs';
const $ = id => document.getElementById(id);
const POLL_MS = 40_000;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value) : null;
const plain = value => typeof value === 'string' ? value : '';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const records = value => Array.isArray(value) ? value.filter(object) : [];
const strings = value => Array.isArray(value) ? value.filter(value => typeof value === 'string') : [];
const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
const element = (tag, className = '', value = '') => { const node = document.createElement(tag); node.className = className; node.textContent = value; return node; };
const dateText = value => validDate(value) ? dateFormat.format(validDate(value)) : 'Not reported';
const number = value => Number.isSafeInteger(value) && value >= 0;
const progressValid = value => object(value) && number(value.completed) && number(value.total) && value.total > 0 && value.completed <= value.total && typeof value.unit === 'string';
const stateNames = {active:'Active',running:'Running',planned:'Planned',done:'Done',blocked:'Blocked',idle:'Idle',review:'In review',passed:'Passed',pass:'Passed',failed:'Failed'};
const routeNames = {sensitive:'Sensitive',routine:'Routine',clerical:'Clerical',coordination:'Coordination'};
let lastReport = null, activeRequest = null, refreshFailed = false, taskPage = 0, nextPollAt = Date.now() + POLL_MS, renderSignature = '';
let lifecycle = null, timer = null;

function validate(report) {
  if (!object(report) || ![undefined,1,2].includes(report.schemaVersion) || !['updatedAt','startedAt','targetAt'].every(key => validDate(report[key])) || typeof report.headline !== 'string' || typeof report.summary !== 'string') throw Error('Invalid status metadata');
  for (const key of ['blockers','agents','milestones','checks','links']) if (!Array.isArray(report[key]) || report[key].length > 100 || !report[key].every(object)) throw Error('Invalid status collection');
  if (report.refreshedAt != null && !validDate(report.refreshedAt)) throw Error('Invalid collector timestamp');
  if (report.schemaVersion === 2) {
    if (!Array.isArray(report.tasks) || report.tasks.length > 500 || new Set(report.tasks.map(task => task?.id)).size !== report.tasks.length) throw Error('Invalid task set');
    for (const task of report.tasks) if (!object(task) || !['id','module','title','owner','detail','nextAction'].every(key => typeof task[key] === 'string') || !['planned','active','blocked','done'].includes(task.state) || !validDate(task.updatedAt) || !Array.isArray(task.dependsOn) || !task.dependsOn.every(value => typeof value === 'string')) throw Error('Invalid task');
    if (!object(report.completion) || typeof report.completion.basis !== 'string' || typeof report.completion.label !== 'string' || !number(report.completion.productionModulesComplete) || !number(report.completion.productionModulesTotal) || report.completion.productionModulesComplete > report.completion.productionModulesTotal) throw Error('Invalid acceptance basis');
  }
  if(report.forecast!=null){const f=report.forecast;if(!object(f)||!validDate(f.assessedAt)||Date.parse(f.assessedAt)>Date.now()+5000||!plain(f.basis).trim()||!plain(f.reviewTrigger).trim()||!Array.isArray(f.conditions)||f.conditions.length>20||f.conditions.some(c=>!plain(c).trim())||(f.expectedAt===null?f.confidence!=='unavailable':!validDate(f.expectedAt)||!['low','medium','high'].includes(f.confidence)||Date.parse(f.expectedAt)<Date.parse(f.assessedAt)))throw Error('Invalid completion forecast');}
  if(report.runtimeObservation!=null){
    const r=report.runtimeObservation,roster=records(r?.agents);
    if(!object(r)||r.source!=='collaboration.list_agents'||!validDate(r.observedAt)||Date.parse(r.observedAt)>Date.now()+5000||!Array.isArray(r.agents)||roster.length!==r.agents.length||roster.length<1||roster.length>100||new Set(roster.map(a=>a.id)).size!==roster.length||new Set(roster.map(a=>a.name)).size!==roster.length||roster.filter(a=>a.kind==='coordinator').length!==1)throw Error('Invalid runtime observation');
    for(const a of roster)if(typeof a.id!=='string'||!/^\/root(?:\/[a-z0-9_]+)*$/.test(a.name)||!['coordinator','worker'].includes(a.kind)||!['running','completed','errored','terminated','unknown'].includes(a.state)||(a.kind==='coordinator')!==(a.name==='/root'))throw Error('Invalid runtime identity');
  }
  for(const task of records(report.tasks))if(task.kind!=null&&!['acceptance','checkpoint'].includes(task.kind))throw Error('Invalid checklist kind');
  for (const agent of report.agents) {
    if (agent.lastActivityAt != null && !validDate(agent.lastActivityAt)) throw Error('Invalid agent timestamp');
    if (agent.progress != null && !progressValid(agent.progress)) throw Error('Invalid agent progress');
  }
  return report;
}
function safeLink(href, kind) {
  if (typeof href !== 'string') return null;
  try { const url = new URL(href, location.href); if (url.username || url.password || !['http:','https:'].includes(url.protocol)) return null;
    if (kind === 'checkpoint') return url.protocol === 'https:' && url.hostname === 'github.com' && !url.port ? url.href : null;
    return url.origin === location.origin ? url.href : null;
  } catch { return null; }
}
function badge(state) {
  const node = element('span', 'state', stateNames[state] || state || 'Not reported');
  node.dataset.tone = ['blocked','failed'].includes(state) ? 'danger' : ['review','stale','pending'].includes(state) ? 'warning' : ['done','pass','passed','verified'].includes(state) ? 'success' : 'neutral';
  return node;
}
function item(title, detail, state, key) {
  const node = element('article','item'), heading = element('div','item-heading');
  node.dataset.key = key || title;
  heading.append(element('h3','',title || 'Unnamed record')); if (state) heading.append(badge(state)); node.append(heading);
  if (detail) node.append(element('p','',detail)); return node;
}
function detailBlock(title, key) { const node = element('details'); node.dataset.key = key; node.append(element('summary','',title)); return node; }
function detailLine(node, label, value) { if (value) node.append(element('p','',label + ': ' + value)); }
function renderList(id, list, empty, renderer) {
  const host = $(id), opened = new Set([...host.querySelectorAll('details[open]')].map(node => node.dataset.key));
  const focused = host.contains(document.activeElement) && document.activeElement?.tagName === 'SUMMARY' ? document.activeElement.parentElement.dataset.key : null;
  const nodes = list.map(renderer); host.replaceChildren(...(nodes.length ? nodes : [element('p','empty',empty)]));
  for (const node of host.querySelectorAll('details')) { node.open = opened.has(node.dataset.key); if (focused && node.dataset.key === focused) node.querySelector('summary').focus({preventScroll:true}); }
}
function duration(ms) { const minutes = Math.max(0,Math.floor(ms / 60_000)); return Math.floor(minutes / 60) + ' h ' + minutes % 60 + ' min'; }
function renderTasks() {
  if (!lastReport) return;
  const tasks = records(lastReport.tasks), filter = $('task-filter').value, query = $('task-search').value.trim().toLocaleLowerCase();
  const matched = tasks.filter(task => (filter === 'all' || task.state === filter) && [task.title,task.module,task.owner,task.id].map(plain).join(' ').toLocaleLowerCase().includes(query)).sort((a,b)=>({active:0,blocked:1,planned:2,done:3}[a.state]-{active:0,blocked:1,planned:2,done:3}[b.state]));
  taskPage=Math.min(taskPage,Math.max(0,Math.ceil(matched.length/6)-1));const visible=matched.slice(taskPage*6,taskPage*6+6);
  $('task-pages').hidden=matched.length<=6;$('previous-tasks').disabled=taskPage===0;$('next-tasks').disabled=(taskPage+1)*6>=matched.length;setText('task-page','Page '+(taskPage+1)+' of '+Math.max(1,Math.ceil(matched.length/6)));
  setText('task-count', tasks.length ? matched.length + ' of ' + tasks.length + ' tasks' : 'Not reported');
  setText('task-basis', lastReport.schemaVersion === 2 ? 'Tracked delivery steps. Open a task for evidence, dependencies and its next action.' : 'This legacy snapshot reports module milestones only. Granular task progress is unavailable.');
  renderList('tasks', visible, tasks.length ? 'No tasks match these filters. Change the state or search to see more.' : 'Granular tasks have not been reported. Module milestones remain available below.', task => {
    const node = item(task.title,'',task.state,task.id), meta = element('div','task-meta');
    [task.module, task.owner || 'Owner not reported', routeNames[task.route] || 'Route not reported'].forEach(value => meta.append(element('span','',value))); node.append(meta);
    if (task.state !== 'done') detailLine(node,'Next',task.nextAction || 'Not reported');
    const details = detailBlock('Details, evidence and dependencies','task-' + task.id);
    if (task.detail) details.append(element('p','',task.detail));
    detailLine(details,'Done evidence',plain(task.doneEvidence) || 'Not reported');
    if(strings(task.acceptanceCriteria).length){details.append(element('p','','Acceptance criteria'));const list=element('ul');for(const criterion of strings(task.acceptanceCriteria))list.append(element('li','',criterion));details.append(list);}
    if(object(task.source)){detailLine(details,'Source',plain(task.source.title));detailLine(details,'Source file',plain(task.source.path));detailLine(details,'Source SHA-256',plain(task.source.sha256));}
    const names = strings(task.dependsOn).map(id => tasks.find(candidate => candidate.id === id)?.title || id);
    detailLine(details,'Depends on',names.length ? names.join('; ') : 'No dependencies declared');
    detailLine(details,'Status updated',dateText(task.updatedAt));
    if (task.state === 'done') detailLine(details,'Next',task.nextAction || 'No next action declared');
    node.append(details); return node;
  });
}
function runtimeFresh(report) {
  const observation=report.runtimeObservation, at=validDate(observation?.observedAt);
  return object(observation)&&observation.source==='collaboration.list_agents'&&at&&Date.now()-at.getTime()<=90_000&&at.getTime()<=Date.now()+5000&&observation.stale!==true;
}
function updateRuntime(report) {
  const observation=report.runtimeObservation, roster=records(observation?.agents), fresh=runtimeFresh(report)&&!refreshFailed&&navigator.onLine!==false, workers=roster.filter(a=>a.kind==='worker');
  setText('agent-count',records(report.agents).length+' retained records');
  setText('runtime-summary',roster.length?'At the last observation: '+roster.filter(a=>a.kind==='coordinator').length+' parent task; '+workers.filter(a=>a.state==='running').length+' running workers; '+workers.filter(a=>a.state==='completed').length+' completed workers; '+workers.filter(a=>!['running','completed'].includes(a.state)).length+' other or unknown workers.':'Runtime counts unavailable. Milestones do not establish how many workers are running.');
  setText('runtime-source',roster.length?'Source: collaboration.list_agents, captured by coordinator at '+observation.observedAt+'. '+(fresh?'Recent observation (90-second freshness window).':'Stale observation; current runtime state is unknown.'):'No valid tool observation. Current runtime state is unknown.');
  for(const node of $('agents').querySelectorAll('[data-runtime-id]')){const entry=roster.find(a=>a.id===node.dataset.runtimeId);node.textContent=fresh&&entry?'Observed '+entry.state:'Runtime unknown';node.dataset.tone=fresh?'neutral':'warning';}
}
function renderAgents(report) {
  const agents=records(report.agents), roster=records(report.runtimeObservation?.agents);
  renderList('agents',agents,'No assignment records reported.',agent=>{
    const runtime=roster.find(a=>a.id===agent.id),dispatch=records(report.dispatches).find(a=>a.id===agent.id);
    const node=item(plain(agent.name),'','',plain(agent.id)||plain(agent.name));const state=badge('unknown');state.dataset.runtimeId=plain(agent.id);node.querySelector('.item-heading').append(state);
    node.append(element('p','agent-task',plain(agent.task)||'Assignment not reported'));
    node.append(element('p','metadata',runtime?runtime.name+' · '+(runtime.kind==='coordinator'?'Parent task':'Internal worker'):'Canonical runtime identity unavailable'));
    node.append(element('p','metadata',dispatch?.model?'Requested model: '+dispatch.model+' · '+(dispatch.effort||'effort unavailable'):'Requested model unavailable'));
    node.append(element('p','metadata','Reported work stage: '+(stateNames[agent.state]||plain(agent.state)||'Unavailable')));
    if(progressValid(agent.progress)){const p=agent.progress;node.append(element('p','','Reported milestone: '+p.completed+' / '+p.total+' '+p.unit));const bar=element('progress');bar.max=p.total;bar.value=p.completed;bar.setAttribute('aria-label',plain(agent.name)+': reported milestone '+p.completed+' of '+p.total+' '+p.unit);node.append(bar);}
    else node.append(element('p','metadata','Milestone progress not reported'));
    node.append(element('p','metadata','Milestone reported at: '+dateText(agent.lastActivityAt)+(agent.stale===true?' · Stale report':'')));
    const details=detailBlock('Assignment and reporting source','agent-'+(plain(agent.id)||plain(agent.name)));
    detailLine(details,'Reported route',routeNames[agent.route]||'Not reported');detailLine(details,'Update',plain(agent.detail));detailLine(details,'Next',plain(agent.nextAction));detailLine(details,'Milestone source',plain(agent.source)||'Coordinator snapshot');
    detailLine(details,'Dispatch evidence',plain(dispatch?.source)||'No model-selection receipt recorded');detailLine(details,'Actual inference model','Unavailable; a requested model is not per-call telemetry');detailLine(details,'Token usage',plain(agent.tokenUsage?.scope)||'Per-agent tokens unavailable');node.append(details);return node;
  });updateRuntime(report);
}
function renderRouting(report) {
  const routingOpen=$('routing').querySelector('details')?.open===true, routingFocused=$('routing').querySelector('summary')===document.activeElement;
  const routing = object(report.routing) ? report.routing : {}, roles = records(routing.roles);
  renderList('routing',roles,'Routing policy and reasoning have not been reported.',role => {
    const node = item(routeNames[role.route] || plain(role.route),plain(role.when),'',plain(role.route));
    node.append(element('p','metadata',(plain(role.model)||'Model not reported') + ' · ' + (plain(role.effort)||'Reasoning not reported')));
    detailLine(node,'Review',plain(role.review)); return node;
  });
  if (records(routing.decisions).length || strings(routing.limitations).length) {
    const details = detailBlock('Assignment decisions and limitations','routing-decisions');
    for (const decision of records(routing.decisions)) { const task = records(report.tasks).find(task => task.id === decision.taskId);const node=item(task?.title || plain(decision.taskId),plain(decision.reason),plain(decision.reviewState));node.append(element('p','metadata',[decision.agentId,routeNames[decision.route] || decision.route,decision.model].map(plain).filter(Boolean).join(' · ')));details.append(node); }
    for (const limitation of strings(routing.limitations)) details.append(element('p','',limitation)); $('routing').append(details);details.open=routingOpen;if(routingFocused)details.querySelector('summary').focus({preventScroll:true});
  }
}
function renderUsage(report) {
  const usage=object(report.usage)?report.usage:{}, goal=usage.goal, account=usage.account; $('usage').replaceChildren();
  if (object(goal) && number(goal.tokens) && validDate(goal.asOf) && plain(goal.scope)) {
    const node=item('Reported goal-token aggregate','','','goal-usage');node.append(element('p','usage-number',goal.tokens.toLocaleString() + ' tokens'));node.append(element('p','',goal.scope));node.append(element('p','metadata','As of ' + dateText(goal.asOf))); $('usage').append(node);
  } else $('usage').append(element('p','empty','Goal token usage unavailable. No value is inferred from task progress.'));
  if (object(account) && Number.isFinite(account.usedPercent) && account.usedPercent>=0 && account.usedPercent<=100 && Number.isFinite(account.remainingPercent) && account.remainingPercent>=0 && account.remainingPercent<=100 && validDate(account.asOf) && plain(account.scope)) {
    const node=item('Shared account allowance','','','account-usage');node.append(element('p','',account.usedPercent + '% used · ' + account.remainingPercent + '% remaining'));node.append(element('p','metadata',account.scope+(number(account.windowMinutes)?' · '+account.windowMinutes.toLocaleString()+'-minute window':'')));
    const reset=Number.isFinite(account.resetsAt)?new Date(account.resetsAt*1000):null;node.append(element('p','metadata','As of ' + dateText(account.asOf) + (reset && Number.isFinite(reset.getTime())?' · Resets ' + dateFormat.format(reset):'')));$('usage').append(node);
  } else $('usage').append(element('p','metadata','Account allowance not reported.'));
  $('usage').append(element('p','metadata','These are historical tool observations, not live meters. Refreshing this page does not query usage tools. Per-agent tokens, actual model telemetry and billing cost are unavailable; account limits and goal tokens have different scopes.'));
}
function renderForecast(report) {
  const forecast=report.forecast;setText('forecast-at',forecast?.expectedAt?(Date.parse(forecast.expectedAt)<Date.now()?'Past estimate; reassessment needed: ':'Estimated ')+dateText(forecast.expectedAt):'Not yet estimable');setText('forecast-confidence',forecast?.expectedAt?'Confidence: '+forecast.confidence:'Confidence not established');setText('forecast-basis',plain(forecast?.basis)||'The target date is not a verified completion forecast.');setText('forecast-observed',forecast?'Assessed '+dateText(forecast.assessedAt)+' · Target attainment is not confirmed.':'Forecast assessment unavailable; target attainment is not confirmed.');$('forecast-conditions').replaceChildren(...strings(forecast?.conditions).map(c=>element('li','',c)));setText('forecast-review',plain(forecast?.reviewTrigger)||'A forecast requires resolved dependencies and measured delivery evidence.');
}
function render(report) {
  setText('outcome-title',plain(report.headline)||'No outcome reported'); setText('summary',plain(report.summary)||'No summary reported.');
  setText('started-at',dateText(report.startedAt));setText('target-at',dateText(report.targetAt));
  renderForecast(report);
  setText('report-source',plain(report.integrity?.source)||'Coordinator snapshot · legacy format');
  const tasks=records(report.tasks),p=report.completion,groups=tasks.filter(t=>t.kind==='acceptance'),checkpoints=tasks.filter(t=>t.kind==='checkpoint');
  $('acceptance-progress').hidden=!groups.length;$('checkpoint-progress').hidden=!checkpoints.length;
  setText('progress-value',groups.length?groups.filter(t=>t.state==='done').length+' / '+groups.length+' criteria groups complete':'Criteria-group completion unavailable');
  if(groups.length){$('acceptance-progress').max=groups.length;$('acceptance-progress').value=groups.filter(t=>t.state==='done').length;}
  setText('checkpoint-value',checkpoints.length?checkpoints.filter(t=>t.state==='done').length+' / '+checkpoints.length+' implementation checkpoints complete':'Checkpoint count unavailable');
  if(checkpoints.length){$('checkpoint-progress').max=checkpoints.length;$('checkpoint-progress').value=checkpoints.filter(t=>t.state==='done').length;}
  setText('progress-basis',report.schemaVersion===2?p.basis+' · Production modules complete: '+p.productionModulesComplete+' / '+p.productionModulesTotal+'.':'A classified delivery checklist is required before showing progress.');
  const blockers=records(report.blockers),errors=strings(report.integrity?.errors); setText('blocker-count',blockers.length+' blockers'+(errors.length?' · '+errors.length+' source issues':'')); $('blockers-section').classList.toggle('clear',!blockers.length&&!errors.length);
  renderList('blockers',blockers,'No dependency blockers reported.',entry=>item(plain(entry.title),plain(entry.detail),plain(entry.state)));
  errors.forEach(error=>$('blockers').append(item('Status source needs attention',error,'blocked')));
  renderTasks();renderAgents(report);renderRouting(report);renderUsage(report);
  const checks=records(report.checks);setText('check-count',checks.length+' reported');
  renderList('checks',checks,'No verification evidence reported.',entry=>{const node=item(plain(entry.name),'',plain(entry.result));node.classList.add('evidence-row');const detail=element('div');detail.append(element('p','',plain(entry.detail)),element('p','metadata','Observed '+dateText(entry.observedAt)));node.append(detail);return node;});
  const modules=records(report.modules);renderList('modules',modules,'No detailed module acceptance report available.',entry=>{const node=item(plain(entry.id)+' · '+plain(entry.title),plain(entry.acceptance),plain(entry.status));const selected=tasks.filter(task=>strings(entry.taskIds).includes(task.id));node.append(element('p','metadata',selected.length&&selected.length===strings(entry.taskIds).length?selected.filter(task=>task.state==='done').length+' / '+selected.length+' tracked steps done':'Tracked-step links unavailable or incomplete'));return node;});
  const milestones=records(report.milestones);setText('milestone-count',(modules.length?modules.length+' modules · ':'')+milestones.length+' milestones');renderList('milestones',milestones,'No module milestones reported.',entry=>item(plain(entry.title)||plain(entry.id),plain(entry.detail),plain(entry.state)));
  renderList('activity',records(report.activity).slice(0,50),'No activity stream reported.',entry=>{const node=item(plain(entry.title),plain(entry.detail),plain(entry.type));node.append(element('p','metadata',dateText(entry.at)));return node;});
  const links=records(report.links).filter(entry=>safeLink(entry.href,'artifact'));renderList('links',links,'No artifact links reported.',entry=>{const link=element('a','',plain(entry.label)||'Open artifact');link.href=safeLink(entry.href,'artifact');return link;});
  const checkpoint=report.checkpoint,url=object(checkpoint)&&plain(checkpoint.commit)&&validDate(checkpoint.verifiedAt)?safeLink(checkpoint.url,'checkpoint'):null;
  renderList('checkpoint',url?[checkpoint]:[],'No verified private checkpoint reported.',entry=>{const node=element('div'),link=element('a','',plain(entry.commit));link.href=url;link.rel='noopener noreferrer';node.append(link,element('p','','Verified '+dateText(entry.verifiedAt)));return node;});
}
function updateClock() {
  setText('clock',clockFormat.format(new Date()));setText('next-poll',activeRequest?'Refresh in progress':navigator.onLine===false?'Auto-refresh pending connection':'Next refresh in '+Math.max(0,Math.ceil((nextPollAt-Date.now())/1000))+' s');
  if(!lastReport)return;
  const age=Date.now()-validDate(lastReport.updatedAt).getTime();setText('updated-at',dateText(lastReport.updatedAt));setText('snapshot-age',age < -60_000?'Snapshot clock is ahead':age<60_000?'Reported less than a minute ago':'Reported '+duration(age)+' ago');
  const start=validDate(lastReport.startedAt).getTime(),target=validDate(lastReport.targetAt).getTime();setText('elapsed',Date.now()<start?'Start is in the future':duration(Date.now()-start));setText('remaining',target<Date.now()?'Target passed by '+duration(Date.now()-target):duration(target-Date.now()));
  updateRuntime(lastReport);if(lastReport.forecast?.expectedAt&&Date.parse(lastReport.forecast.expectedAt)<Date.now())setText('forecast-at','Past estimate; reassessment needed: '+dateText(lastReport.forecast.expectedAt));updateNotice();
}
function updateNotice() {
  const notice=$('notice');notice.className='notice';let message;
  if(!lastReport){message=refreshFailed?'Status unavailable. Select Refresh now to retry.':'Loading the latest reported evidence…';if(refreshFailed)notice.classList.add('error');}
  else {const age=Date.now()-validDate(lastReport.updatedAt).getTime(),stale=age>300_000||age < -60_000;
    if(navigator.onLine===false){message='Offline. Showing the last received snapshot; evidence may be stale.';notice.classList.add('warning');}
    else if(refreshFailed){message='Refresh failed. The last valid snapshot is retained. Select Refresh now to retry.';notice.classList.add('warning');}
    else if(stale){message='Evidence is more than 5 minutes old or its clock is ahead. A recent fetch does not make the reported work current.';notice.classList.add('warning');}
    else message='Coordinator snapshot is recent. Each evidence source has its own timestamp; this is not a production or release approval.';
    if(lastReport.refreshedAt)message+=' Collector refreshed '+dateText(lastReport.refreshedAt)+'.';
  }
  setText('notice',message);setText('connection',navigator.onLine===false?'Offline':activeRequest?'Refreshing':refreshFailed?'Refresh failed':lastReport?'Snapshot received':'Connecting');
  $('connection').dataset.tone=refreshFailed||navigator.onLine===false?'warning':'neutral';
}
async function refresh() {
  if(!lifecycle||activeRequest)return;
  const owner=lifecycle;
  if(navigator.onLine===false){refreshFailed=true;nextPollAt=Date.now()+POLL_MS;updateNotice();return;}
  const controller=new AbortController();activeRequest=controller;const timeout=setTimeout(()=>controller.abort(),8000);$('refresh').disabled=true;$('refresh').textContent='Refreshing…';updateNotice();updateClock();
  try {
    const report=validate(await loadReport(controller.signal));
    if(owner!==lifecycle||controller.signal.aborted)return;
    if(lastReport && Date.parse(report.updatedAt)<Date.parse(lastReport.updatedAt))throw Error('Older snapshot');
    const signature=JSON.stringify({...report,refreshedAt:undefined});lastReport=report;refreshFailed=false;
    if(signature!==renderSignature){render(report);renderSignature=signature;}
  } catch {if(owner===lifecycle)refreshFailed=true;}
  finally {clearTimeout(timeout);if(owner===lifecycle){activeRequest=null;nextPollAt=Date.now()+POLL_MS;$('refresh').disabled=false;$('refresh').textContent='Refresh now';updateClock();updateNotice();}}
}
export function disposeDashboard() {
  lifecycle?.abort(); lifecycle=null;
  clearInterval(timer); timer=null;
  activeRequest?.abort(); activeRequest=null;
  lastReport=null; renderSignature=''; refreshFailed=false; taskPage=0;
}
export function startDashboard(initialReport) {
  if(lifecycle)return;
  const report=initialReport===undefined?null:validate(initialReport);
  lifecycle=new AbortController();const options={signal:lifecycle.signal};
  $('refresh').addEventListener('click',refresh,options);$('task-filter').addEventListener('change',()=>{taskPage=0;renderTasks();},options);$('task-search').addEventListener('input',()=>{taskPage=0;renderTasks();},options);
  $('previous-tasks').addEventListener('click',()=>{taskPage--;renderTasks();$('tasks-title').setAttribute('tabindex','-1');$('tasks-title').focus({preventScroll:true});$('tasks-title').scrollIntoView({block:'start'});},options);$('next-tasks').addEventListener('click',()=>{taskPage++;renderTasks();$('tasks-title').setAttribute('tabindex','-1');$('tasks-title').focus({preventScroll:true});$('tasks-title').scrollIntoView({block:'start'});},options);
  window.addEventListener('offline',()=>{updateClock();updateNotice();},options);window.addEventListener('online',refresh,options);
  nextPollAt=Date.now()+POLL_MS;
  if(report){lastReport=report;render(report);renderSignature=JSON.stringify({...report,refreshedAt:undefined});updateClock();updateNotice();}else refresh();
  timer=setInterval(()=>{updateClock();if(!activeRequest&&Date.now()>=nextPollAt)refresh();},1000);
}
if(!$('protected-content'))startDashboard();
