import express from 'express';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { searchReddit, type RedditItem } from './reddit-rss';

dotenv.config();
const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Math.max(30000, Number(process.env.POLL_INTERVAL_SECONDS || 60) * 1000);
const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'store.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

type Rule={id:string;value:string};
type Monitor={id:string;name:string;description:string;all:Rule[];any:Rule[];exclude:Rule[];subreddits:string[];enabled:boolean;threshold:number;createdAt:string};
type Match={id:string;monitorId:string;monitorName:string;title:string;text:string;subreddit:string;author:string;url:string;createdAt:string;score:number;relevance:number;intent:string;alerted:boolean};
type Store={monitors:Monitor[];matches:Match[];seen:Record<string,number>;lastPoll:string|null;pollError:string|null;settings:{slackWebhook:string;pollInterval:number}};

const uid=(p='x')=>p+'_'+Math.random().toString(36).slice(2)+Date.now().toString(36);
const makeRule=(value:string):Rule=>({id:uid('rule'),value:value.trim()});
const defaults:Monitor[]=[
{id:'m1',name:'Brand mentions',description:'Find Nimbata mentions anywhere on Reddit.',all:[],any:[makeRule('nimbata')],exclude:[],subreddits:['all'],enabled:true,threshold:60,createdAt:new Date().toISOString()},
{id:'m2',name:'CallRail complaints',description:'Find people complaining about CallRail or looking for alternatives.',all:[],any:[makeRule('callrail'),makeRule('callrail alternative')],exclude:[],subreddits:['all'],enabled:true,threshold:60,createdAt:new Date().toISOString()},
{id:'m3',name:'Call tracking intent',description:'Find people asking about call tracking software.',all:[],any:[makeRule('call tracking'),makeRule('phone call tracking'),makeRule('call attribution')],exclude:[],subreddits:['all'],enabled:true,threshold:60,createdAt:new Date().toISOString()}
];
function save(s:Store){fs.writeFileSync(STORE_PATH,JSON.stringify(s,null,2));}
function load():Store{try{if(fs.existsSync(STORE_PATH)){const s=JSON.parse(fs.readFileSync(STORE_PATH,'utf8')) as Store;s.seen ||= {};s.pollError ||= null;s.settings ||= {slackWebhook:process.env.SLACK_WEBHOOK_URL||'',pollInterval:1};return s;}}catch(e){console.error('Store load failed',e)}const s:Store={monitors:defaults,matches:[],seen:{},lastPoll:null,pollError:null,settings:{slackWebhook:process.env.SLACK_WEBHOOK_URL||'',pollInterval:1}};save(s);return s;}
function norm(v:string){return v.toLowerCase().replace(/\s+/g,' ').trim();}
function textOf(x:RedditItem){return norm(`${x.title} ${x.text} r/${x.subreddit} u/${x.author}`);}
function ruleMatches(text:string,value:string){const q=norm(value);if(!q)return false;const exact=q.startsWith('"')&&q.endsWith('"')?q.slice(1,-1):q;return text.includes(exact);}
function monitorMatches(x:RedditItem,m:Monitor){const text=textOf(x);const allOk=!m.all.length||m.all.every(r=>ruleMatches(text,r.value));const anyOk=!m.any.length||m.any.some(r=>ruleMatches(text,r.value));const excluded=m.exclude.some(r=>ruleMatches(text,r.value));const subOk=!m.subreddits.length||m.subreddits.includes('all')||m.subreddits.map(norm).includes(norm(x.subreddit));return allOk&&anyOk&&!excluded&&subOk;}
function relevance(x:RedditItem,m:Monitor){const text=textOf(x);const positive=[...m.all,...m.any].filter(r=>ruleMatches(text,r.value)).length;const required=m.all.length+Math.max(1,m.any.length);return Math.min(99,Math.max(1,Math.round(positive/required*100)));}
function detectIntent(text:string){const t=norm(text);if(/alternative|recommend|best|looking for|switch|should i use|which .* use/.test(t))return'Buying intent';if(/complain|hate|bad|issue|problem|expensive|frustrat|disappointed/.test(t))return'Pain point';if(/what is|how do|how can|anyone know|how are/.test(t))return'Question';return'Mention';}
function searchTerms(m:Monitor){return[...m.all,...m.any].map(r=>r.value.trim()).filter(Boolean).filter((v,i,a)=>a.findIndex(x=>norm(x)===norm(v))===i).slice(0,10);}

async function poll(s:Store){const fresh:Match[]=[];const now=Date.now();for(const m of s.monitors.filter(x=>x.enabled)){for(const term of searchTerms(m)){try{const items=await searchReddit(term,25);for(const item of items){if(!item.url||s.seen[item.id])continue;s.seen[item.id]=now;if(!monitorMatches(item,m))continue;const rel=relevance(item,m);if(rel<m.threshold)continue;fresh.push({id:uid('match'),monitorId:m.id,monitorName:m.name,title:item.title||'(Reddit post)',text:item.text.slice(0,1200),subreddit:item.subreddit,author:item.author,url:item.url,createdAt:item.createdAt,score:item.score,relevance:rel,intent:detectIntent(item.title+' '+item.text),alerted:false});}}catch(e){console.error(`RSS search failed for ${m.name}/${term}`,e);}}}s.matches.unshift(...fresh);s.matches=s.matches.slice(0,2000);const cutoff=now-86400000;for(const[id,t]of Object.entries(s.seen))if(t<cutoff)delete s.seen[id];s.lastPoll=new Date().toISOString();return fresh;}
async function sendSlack(url:string,m:Match){if(!url)return false;const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:`*🔥 Reddit match — ${m.monitorName}*\n*r/${m.subreddit}* · ${m.relevance}% relevance · ${m.intent}\n\n*${m.title}*\n${m.text.slice(0,700)}\n\n<${m.url}|View on Reddit>`})});return r.ok;}

const app=express();app.use(express.json({limit:'1mb'}));
app.get('/api/data',(_req,res)=>{const s=load();const cutoff=Date.now()-86400000;res.json({monitors:s.monitors,matches:s.matches.slice(0,200),stats:{matches24h:s.matches.filter(m=>new Date(m.createdAt).getTime()>cutoff).length,alerts24h:s.matches.filter(m=>m.alerted&&new Date(m.createdAt).getTime()>cutoff).length,monitors:s.monitors.length,lastPoll:s.lastPoll,pollError:s.pollError},settings:{slackConfigured:Boolean(s.settings.slackWebhook||process.env.SLACK_WEBHOOK_URL),redditConfigured:true,source:'Reddit RSS search',pollInterval:s.settings.pollInterval}});});
app.post('/api/monitors',(req,res)=>{const b=req.body||{};const clean=(v:unknown):Rule[]=>Array.isArray(v)?v.map(String).map(x=>x.trim()).filter(Boolean).map(makeRule):[];const name=String(b.name||'').trim();const all=clean(b.all),any=clean(b.any),exclude=clean(b.exclude);if(!name)return res.status(400).json({error:'Monitor name is required'});if(!all.length&&!any.length)return res.status(400).json({error:'Add at least one include keyword or phrase'});const s=load();const m:Monitor={id:uid('mon'),name,description:String(b.description||'').trim(),all,any,exclude,subreddits:Array.isArray(b.subreddits)&&b.subreddits.length?b.subreddits.map(String).map(x=>x.trim()).filter(Boolean):['all'],enabled:true,threshold:Math.max(1,Math.min(99,Number(b.threshold)||60)),createdAt:new Date().toISOString()};s.monitors.unshift(m);save(s);res.json(m);});
app.patch('/api/monitors/:id',(req,res)=>{const s=load(),m=s.monitors.find(x=>x.id===req.params.id);if(!m)return res.status(404).json({error:'not found'});if(typeof req.body.enabled==='boolean')m.enabled=req.body.enabled;if(typeof req.body.threshold==='number')m.threshold=Math.max(1,Math.min(99,req.body.threshold));save(s);res.json(m);});
app.delete('/api/monitors/:id',(req,res)=>{const s=load();s.monitors=s.monitors.filter(m=>m.id!==req.params.id);save(s);res.json({success:true});});
app.post('/api/settings',(req,res)=>{const s=load();if(typeof req.body.slackWebhook==='string')s.settings.slackWebhook=req.body.slackWebhook.trim();save(s);res.json({success:true});});
app.post('/api/poll',async(_req,res)=>{const s=load();try{const matches=await poll(s);let alerts=0;for(const m of matches){m.alerted=await sendSlack(s.settings.slackWebhook||process.env.SLACK_WEBHOOK_URL||'',m);if(m.alerted)alerts++;}s.pollError=null;save(s);res.json({success:true,matches:matches.length,alerts,lastPoll:s.lastPoll});}catch(e:any){s.pollError=e?.message||'Polling failed';s.lastPoll=new Date().toISOString();save(s);res.status(500).json({error:s.pollError});}});
app.get('/api/health',(_req,res)=>res.json({ok:true,lastPoll:load().lastPoll}));

async function start(){const prod=process.env.NODE_ENV==='production';if(!prod){const vite=await createViteServer({server:{middlewareMode:true,host:'0.0.0.0'},appType:'spa'});app.use(vite.middlewares);}else{app.use(express.static(path.join(process.cwd(),'dist')));app.get('*',(_req,res)=>res.sendFile(path.join(process.cwd(),'dist','index.html')));}app.listen(PORT,()=>console.log(`Reddit Listening running on port ${PORT}`));let running=false;const run=async()=>{if(running)return;running=true;const s=load();try{const matches=await poll(s);let alerts=0;for(const m of matches){m.alerted=await sendSlack(s.settings.slackWebhook||process.env.SLACK_WEBHOOK_URL||'',m);if(m.alerted)alerts++;}s.pollError=null;save(s);console.log(`Poll complete: ${matches.length} matches, ${alerts} alerts`);}catch(e){s.pollError=e instanceof Error?e.message:'Polling failed';save(s);console.error('Background poll failed',e);}finally{running=false;}};await run();setInterval(run,POLL_INTERVAL_MS);}
start().catch(e=>{console.error(e);process.exit(1);});
