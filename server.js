const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CLASS_JOIN_CODE = process.env.CLASS_JOIN_CODE || (IS_PRODUCTION ? '' : 'NODDIN2026');
const ADMIN_SEED_PIN = process.env.ADMIN_PIN || (IS_PRODUCTION ? '' : '900090');
const TEACHER_SEED_PIN = process.env.TEACHER_PIN || (IS_PRODUCTION ? '' : '800080');
const sessions = new Map();
const loginAttempts = new Map();
const joinAttempts = new Map();

if (IS_PRODUCTION) {
  const missing=[];
  if(!CLASS_JOIN_CODE)missing.push('CLASS_JOIN_CODE');
  if(!ADMIN_SEED_PIN)missing.push('ADMIN_PIN');
  if(!TEACHER_SEED_PIN)missing.push('TEACHER_PIN');
  if(missing.length){console.error(`SECURITY ERROR: ${missing.join(', ')} must be set in production.`);process.exit(1)}
  if(!validPin(ADMIN_SEED_PIN)||!validPin(TEACHER_SEED_PIN)){console.error('SECURITY ERROR: ADMIN_PIN and TEACHER_PIN must each be 6-8 digits.');process.exit(1)}
}

function blankDb(){return{nextIds:{user:1,product:1,order:1,orderItem:1,adjustment:1},users:[],products:[],orders:[],orderItems:[],adjustments:[]}}
function loadDb(){try{return fs.existsSync(DATA_FILE)?JSON.parse(fs.readFileSync(DATA_FILE,'utf8')):blankDb()}catch(e){console.error(e);return blankDb()}}
let db=loadDb();
function ensureDbShape(){
  const blank=blankDb();
  db.nextIds={...blank.nextIds,...(db.nextIds||{})};
  for(const k of ['users','products','orders','orderItems','adjustments']) if(!Array.isArray(db[k])) db[k]=[];
  for(const u of db.users){if(u.accountDisabled===undefined)u.accountDisabled=false;if(u.sellerBanned===undefined)u.sellerBanned=false}
}
ensureDbShape();
function saveDb(){fs.mkdirSync(path.dirname(DATA_FILE),{recursive:true});const tmp=DATA_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(db,null,2));fs.renameSync(tmp,DATA_FILE)}
function nextId(k){return db.nextIds[k]++}
function now(){return new Date().toISOString()}
function normalizeUsername(v){return String(v||'').trim().toLowerCase().replace(/[^a-z0-9._-]/g,'')}
function validPin(v){return /^\d{6,8}$/.test(String(v||''))}
function pinHash(pin){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(String(pin),salt,64).toString('hex');return `${salt}:${hash}`}
function pinOk(pin,stored){try{const[salt,hex]=stored.split(':');const a=crypto.scryptSync(String(pin),salt,64);const b=Buffer.from(hex,'hex');return a.length===b.length&&crypto.timingSafeEqual(a,b)}catch{return false}}
function secretOk(a,b){const ah=crypto.createHash('sha256').update(String(a||'')).digest();const bh=crypto.createHash('sha256').update(String(b||'')).digest();return crypto.timingSafeEqual(ah,bh)}
function getUser(id){return db.users.find(u=>u.id===Number(id))}
function reservedForBuyer(id){return db.orders.filter(o=>o.buyerId===Number(id)&&o.status==='pending').reduce((s,o)=>s+o.total,0)}
function safeUser(u){if(!u)return null;const r=reservedForBuyer(u.id);return{id:u.id,username:u.username,role:u.role,dashBalance:u.dashBalance,reservedDash:r,availableDash:u.dashBalance-r,sellerBanned:!!u.sellerBanned,accountDisabled:!!u.accountDisabled}}
function restoreInventory(order){for(const i of db.orderItems.filter(x=>x.orderId===order.id)){const p=db.products.find(x=>x.id===i.productId);if(p)p.quantity+=i.qty}}
function orderView(o){return{...o,buyerName:getUser(o.buyerId)?.username||'unknown',sellerName:getUser(o.sellerId)?.username||'unknown',items:db.orderItems.filter(i=>i.orderId===o.id).map(i=>({...i,productName:db.products.find(p=>p.id===i.productId)?.name||'Deleted product'}))}}

function securityHeaders(extra={}){return{'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",...extra}}
function send(res,status,data,headers={}){res.writeHead(status,securityHeaders({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers}));res.end(JSON.stringify(data))}
function cookieMap(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const [k,...r]=part.trim().split('=');if(k)out[k]=decodeURIComponent(r.join('='))}return out}
function currentUser(req){const token=cookieMap(req).dash_session;const s=token&&sessions.get(token);if(!s||s.expires<Date.now()){if(token)sessions.delete(token);return null}const u=getUser(s.userId);if(!u||u.accountDisabled){sessions.delete(token);return null}return u}
function loginCookie(userId){const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{userId,expires:Date.now()+8*60*60*1000});let c=`dash_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;if(IS_PRODUCTION)c+='; Secure';return c}
function logoutCookie(req){const token=cookieMap(req).dash_session;if(token)sessions.delete(token);return 'dash_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'}
function invalidateUserSessions(userId){for(const[token,s]of sessions.entries())if(s.userId===Number(userId))sessions.delete(token)}
function requireUser(req,res){const u=currentUser(req);if(!u){send(res,401,{error:'Please log in.'});return null}return u}
function requireRoles(req,res,...roles){const u=requireUser(req,res);if(!u)return null;if(!roles.includes(u.role)){send(res,403,{error:'You do not have permission.'});return null}return u}
async function body(req){return await new Promise((resolve,reject)=>{let d='';req.on('data',c=>{d+=c;if(d.length>200000){reject(new Error('Request too large'));req.destroy()}});req.on('end',()=>{if(!d)return resolve({});try{resolve(JSON.parse(d))}catch{reject(new Error('Bad JSON'))}});req.on('error',reject)})}
function clientIp(req){return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim()}
function rateState(map,key,maxFailures,windowMs,blockMs){
  const t=Date.now();let r=map.get(key);
  if(!r||t-r.windowStart>windowMs){r={windowStart:t,failures:0,blockedUntil:0};map.set(key,r)}
  if(r.blockedUntil>t)return{blocked:true,retrySeconds:Math.ceil((r.blockedUntil-t)/1000)};
  if(r.blockedUntil&&r.blockedUntil<=t){r.failures=0;r.blockedUntil=0;r.windowStart=t}
  return{blocked:false,recordFailure(){r.failures++;if(r.failures>=maxFailures)r.blockedUntil=Date.now()+blockMs},clear(){map.delete(key)}};
}

function seed(){
  if(db.users.length)return;
  const users=IS_PRODUCTION
    ? [['admin',ADMIN_SEED_PIN,'admin',0],['teacher',TEACHER_SEED_PIN,'teacher',0]]
    : [['admin',ADMIN_SEED_PIN,'admin',500],['teacher',TEACHER_SEED_PIN,'teacher',500],['alex','111111','student',150],['sam','222222','student',120]];
  for(const[x,pin,role,balance]of users){if(!validPin(pin))throw new Error(`${role} PIN must be 6-8 digits.`);db.users.push({id:nextId('user'),username:x,pinHash:pinHash(pin),role,dashBalance:balance,sellerBanned:false,accountDisabled:false,createdAt:now()})}
  if(!IS_PRODUCTION){
    const alex=db.users.find(u=>u.username==='alex'),sam=db.users.find(u=>u.username==='sam');
    db.products.push({id:nextId('product'),sellerId:alex.id,name:'Custom Bookmark',description:'A handmade school bookmark.',price:15,quantity:8,active:true,createdAt:now()},{id:nextId('product'),sellerId:sam.id,name:'Mystery Pencil Pack',description:'A surprise pack of fun pencils.',price:20,quantity:5,active:true,createdAt:now()});
  }
  saveDb();
  console.log(IS_PRODUCTION?'Production admin/teacher accounts seeded.':'Demo accounts seeded. Use 6-8 digit PINs and change admin/teacher PINs before real use.');
  if(!IS_PRODUCTION)console.log(`Local demo class join code: ${CLASS_JOIN_CODE}`);
}

function staticFile(req,res,pathname){
  const map={'/':'index.html','/index.html':'index.html','/styles.css':'styles.css','/app.js':'app.js'};const name=map[pathname];if(!name)return false;
  const file=path.join(PUBLIC_DIR,name),type=name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.js')?'application/javascript; charset=utf-8':'text/html; charset=utf-8';
  res.writeHead(200,securityHeaders({'Content-Type':type,'Cache-Control':name==='index.html'?'no-store':'public, max-age=300'}));fs.createReadStream(file).pipe(res);return true;
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`),p=url.pathname,m=req.method;
  try{
    if(m==='GET'&&staticFile(req,res,p))return;
    if(m==='GET'&&p==='/api/health')return send(res,200,{ok:true});

    if(m==='POST'&&p==='/api/login'){
      const b=await body(req),username=normalizeUsername(b.username),key=`${clientIp(req)}|${username||'blank'}`,lim=rateState(loginAttempts,key,5,10*60*1000,15*60*1000);
      if(lim.blocked)return send(res,429,{error:`Too many login attempts. Try again in about ${Math.ceil(lim.retrySeconds/60)} minute(s).`},{'Retry-After':String(lim.retrySeconds)});
      const u=db.users.find(x=>x.username===username);
      if(!u||!pinOk(b.pin,u.pinHash)){lim.recordFailure();return send(res,401,{error:'Wrong username or PIN.'})}
      if(u.accountDisabled){lim.recordFailure();return send(res,403,{error:'This account is disabled. Ask your teacher or admin.'})}
      lim.clear();return send(res,200,{user:safeUser(u)},{'Set-Cookie':loginCookie(u.id)});
    }
    if(m==='POST'&&p==='/api/logout')return send(res,200,{ok:true},{'Set-Cookie':logoutCookie(req)});
    if(m==='POST'&&p==='/api/register'){
      const b=await body(req),username=normalizeUsername(b.username),pin=String(b.pin||''),joinCode=String(b.joinCode||'').trim(),key=clientIp(req),lim=rateState(joinAttempts,key,5,15*60*1000,30*60*1000);
      if(lim.blocked)return send(res,429,{error:`Too many join-code attempts. Try again in about ${Math.ceil(lim.retrySeconds/60)} minute(s).`},{'Retry-After':String(lim.retrySeconds)});
      if(!secretOk(joinCode,CLASS_JOIN_CODE)){lim.recordFailure();return send(res,403,{error:'Incorrect class join code.'})}
      lim.clear();
      if(username.length<3||username.length>20)return send(res,400,{error:'Username must be 3-20 letters/numbers.'});
      if(!validPin(pin))return send(res,400,{error:'PIN must be 6-8 numbers.'});
      if(db.users.some(u=>u.username===username))return send(res,409,{error:'That username is already taken.'});
      const u={id:nextId('user'),username,pinHash:pinHash(pin),role:'student',dashBalance:0,sellerBanned:false,accountDisabled:false,createdAt:now()};db.users.push(u);saveDb();return send(res,200,{user:safeUser(u)},{'Set-Cookie':loginCookie(u.id)});
    }

    if(m==='GET'&&p==='/api/me'){const u=requireUser(req,res);if(u)return send(res,200,{user:safeUser(u)});return}
    if(m==='POST'&&p==='/api/me/pin'){
      const u=requireUser(req,res);if(!u)return;const b=await body(req);
      if(!pinOk(b.oldPin,u.pinHash))return send(res,400,{error:'Current PIN is wrong.'});
      if(!validPin(b.newPin))return send(res,400,{error:'New PIN must be 6-8 numbers.'});
      if(String(b.oldPin)===String(b.newPin))return send(res,400,{error:'Choose a different PIN.'});
      u.pinHash=pinHash(b.newPin);invalidateUserSessions(u.id);saveDb();return send(res,200,{ok:true,user:safeUser(u)},{'Set-Cookie':loginCookie(u.id)});
    }

    if(m==='GET'&&p==='/api/products'){
      const u=requireUser(req,res);if(!u)return;
      const products=db.products.filter(x=>{const seller=getUser(x.sellerId);return x.active&&x.quantity>0&&seller&&!seller.sellerBanned&&!seller.accountDisabled}).map(x=>({...x,sellerName:getUser(x.sellerId)?.username||'unknown'})).sort((a,b)=>b.id-a.id);return send(res,200,{products});
    }
    if(m==='GET'&&p==='/api/seller/products'){const u=requireUser(req,res);if(!u)return;return send(res,200,{products:u.role==='student'?db.products.filter(x=>x.sellerId===u.id).sort((a,b)=>b.id-a.id):[]})}
    if(m==='POST'&&p==='/api/products'){
      const u=requireUser(req,res);if(!u)return;if(u.role!=='student')return send(res,403,{error:'Only student sellers can list products.'});if(u.sellerBanned)return send(res,403,{error:'Your selling access has been paused by an admin.'});
      const b=await body(req),name=String(b.name||'').trim(),description=String(b.description||'').trim(),price=Number(b.price),quantity=Number(b.quantity);
      if(name.length<2||name.length>60)return send(res,400,{error:'Product name must be 2-60 characters.'});if(!Number.isInteger(price)||price<1||price>100000)return send(res,400,{error:'Price must be a whole number of Dash Cash.'});if(!Number.isInteger(quantity)||quantity<1||quantity>999)return send(res,400,{error:'Quantity must be 1-999.'});
      const product={id:nextId('product'),sellerId:u.id,name,description:description.slice(0,200),price,quantity,active:true,createdAt:now()};db.products.push(product);saveDb();return send(res,200,{product});
    }
    let match=p.match(/^\/api\/products\/(\d+)$/);if(m==='PATCH'&&match){const u=requireUser(req,res);if(!u)return;const prod=db.products.find(x=>x.id===Number(match[1]));if(!prod)return send(res,404,{error:'Product not found.'});if(prod.sellerId!==u.id&&u.role!=='admin')return send(res,403,{error:'Not your product.'});if(prod.sellerId===u.id&&u.sellerBanned)return send(res,403,{error:'Selling access is paused.'});const b=await body(req);if(b.active!==undefined)prod.active=!!b.active;if(b.quantity!==undefined){const q=Number(b.quantity);if(!Number.isInteger(q)||q<0||q>999)return send(res,400,{error:'Quantity must be 0-999.'});prod.quantity=q}saveDb();return send(res,200,{product:prod})}

    if(m==='POST'&&p==='/api/checkout'){
      const buyer=requireUser(req,res);if(!buyer)return;if(buyer.role!=='student')return send(res,403,{error:'Teacher/admin accounts cannot place marketplace orders.'});const b=await body(req),cart=Array.isArray(b.items)?b.items:[];if(!cart.length)return send(res,400,{error:'Your cart is empty.'});const expanded=[];
      for(const row of cart){const prod=db.products.find(x=>x.id===Number(row.productId)),qty=Number(row.qty),seller=prod&&getUser(prod.sellerId);if(!prod||!prod.active)return send(res,400,{error:'A product in your cart is no longer available.'});if(prod.sellerId===buyer.id)return send(res,400,{error:'You cannot buy your own product.'});if(!seller||seller.sellerBanned||seller.accountDisabled)return send(res,400,{error:`${prod.name} is temporarily unavailable.`});if(!Number.isInteger(qty)||qty<1||qty>prod.quantity)return send(res,400,{error:`Not enough inventory for ${prod.name}.`});expanded.push({prod,qty,lineTotal:prod.price*qty})}
      const total=expanded.reduce((s,x)=>s+x.lineTotal,0),available=buyer.dashBalance-reservedForBuyer(buyer.id);if(total>available)return send(res,400,{error:`You only have ${available} available Dash Cash.`});const groups=new Map();for(const x of expanded){if(!groups.has(x.prod.sellerId))groups.set(x.prod.sellerId,[]);groups.get(x.prod.sellerId).push(x)}const created=[];
      for(const[sellerId,items]of groups){const o={id:nextId('order'),buyerId:buyer.id,sellerId:Number(sellerId),status:'pending',total:items.reduce((s,x)=>s+x.lineTotal,0),createdAt:now(),updatedAt:now()};db.orders.push(o);for(const x of items){x.prod.quantity-=x.qty;db.orderItems.push({id:nextId('orderItem'),orderId:o.id,productId:x.prod.id,qty:x.qty,unitPrice:x.prod.price})}created.push(orderView(o))}saveDb();return send(res,200,{orders:created,user:safeUser(buyer)});
    }

    if(m==='GET'&&p==='/api/orders'){const u=requireUser(req,res);if(!u)return;let orders=u.role==='admin'?db.orders:u.role==='teacher'?[]:db.orders.filter(o=>o.buyerId===u.id||o.sellerId===u.id);return send(res,200,{orders:orders.map(orderView).sort((a,b)=>b.id-a.id)})}
    match=p.match(/^\/api\/orders\/(\d+)\/cancel$/);if(m==='POST'&&match){const u=requireUser(req,res);if(!u)return;const o=db.orders.find(x=>x.id===Number(match[1]));if(!o||o.buyerId!==u.id)return send(res,404,{error:'Order not found.'});if(o.status!=='pending')return send(res,400,{error:'Only pending orders can be cancelled.'});restoreInventory(o);o.status='cancelled';o.updatedAt=now();saveDb();return send(res,200,{order:orderView(o),user:safeUser(u)})}
    match=p.match(/^\/api\/orders\/(\d+)\/status$/);if(m==='POST'&&match){const u=requireUser(req,res);if(!u)return;const o=db.orders.find(x=>x.id===Number(match[1]));if(!o)return send(res,404,{error:'Order not found.'});if(u.role!=='admin'&&o.sellerId!==u.id)return send(res,403,{error:'Only this seller can update the order.'});if(u.role==='student'&&u.sellerBanned)return send(res,403,{error:'Selling access is paused.'});const b=await body(req),target=String(b.status||''),allowed={pending:['accepted','rejected'],accepted:['ready'],ready:['completed'],completed:[],rejected:[],cancelled:[]};if(!allowed[o.status]?.includes(target))return send(res,400,{error:`Cannot move ${o.status} to ${target}.`});if(target==='accepted'){const buyer=getUser(o.buyerId),seller=getUser(o.sellerId),pending=reservedForBuyer(buyer.id);if(!buyer||buyer.accountDisabled)return send(res,400,{error:'Buyer account is disabled. Reject or cancel this order.'});if(!seller||seller.accountDisabled)return send(res,400,{error:'Seller account is disabled.'});if(buyer.dashBalance<pending)return send(res,400,{error:'Buyer no longer has enough Dash Cash. Ask a teacher/admin to fix the balance or reject the order.'});buyer.dashBalance-=o.total;seller.dashBalance+=o.total}if(target==='rejected')restoreInventory(o);o.status=target;o.updatedAt=now();saveDb();return send(res,200,{order:orderView(o)})}

    if(m==='GET'&&p==='/api/stats'){const u=requireUser(req,res);if(!u)return;if(u.role!=='student')return send(res,200,{seller:null,buyer:null});const so=db.orders.filter(o=>o.sellerId===u.id),bo=db.orders.filter(o=>o.buyerId===u.id),approved=so.filter(o=>['accepted','ready','completed'].includes(o.status));return send(res,200,{seller:{ordersWaiting:so.filter(o=>o.status==='pending').length,dashEarned:approved.reduce((s,o)=>s+o.total,0),unitsSold:approved.flatMap(o=>db.orderItems.filter(i=>i.orderId===o.id)).reduce((s,i)=>s+i.qty,0),activeProducts:db.products.filter(p=>p.sellerId===u.id&&p.active).length},buyer:{pendingOrders:bo.filter(o=>o.status==='pending').length,completedOrders:bo.filter(o=>o.status==='completed').length}})}

    if(m==='GET'&&p==='/api/manage/users'){const u=requireRoles(req,res,'teacher','admin');if(u)return send(res,200,{users:db.users.map(safeUser).sort((a,b)=>a.username.localeCompare(b.username))});return}
    if(m==='POST'&&p==='/api/manage/balance'){const actor=requireRoles(req,res,'teacher','admin');if(!actor)return;const b=await body(req),target=getUser(b.userId),amount=Number(b.amount);if(!target)return send(res,404,{error:'User not found.'});if(!Number.isInteger(amount)||amount===0||Math.abs(amount)>100000)return send(res,400,{error:'Enter a whole-number adjustment.'});const nb=target.dashBalance+amount;if(nb<reservedForBuyer(target.id))return send(res,400,{error:'Balance cannot go below Dash Cash currently reserved for pending orders.'});if(nb<0)return send(res,400,{error:'Balance cannot be negative.'});target.dashBalance=nb;db.adjustments.push({id:nextId('adjustment'),actorId:actor.id,userId:target.id,amount,note:String(b.note||'').trim().slice(0,100),createdAt:now()});saveDb();return send(res,200,{user:safeUser(target)})}
    if(m==='POST'&&p==='/api/admin/ban'){const u=requireRoles(req,res,'admin');if(!u)return;const b=await body(req),target=getUser(b.userId);if(!target||target.role!=='student')return send(res,400,{error:'Choose a student seller.'});target.sellerBanned=!!b.banned;saveDb();return send(res,200,{user:safeUser(target)})}
    if(m==='POST'&&p==='/api/admin/account-status'){
      const u=requireRoles(req,res,'admin');if(!u)return;const b=await body(req),target=getUser(b.userId),disabled=!!b.disabled;
      if(!target)return send(res,404,{error:'User not found.'});if(target.id===u.id)return send(res,400,{error:'You cannot disable your own admin account.'});if(target.role==='admin')return send(res,400,{error:'Admin accounts cannot be disabled here.'});
      target.accountDisabled=disabled;if(disabled&&target.role==='student')target.sellerBanned=true;invalidateUserSessions(target.id);saveDb();return send(res,200,{user:safeUser(target)});
    }
    if(m==='POST'&&p==='/api/admin/reset-pin'){
      const u=requireRoles(req,res,'admin');if(!u)return;const b=await body(req),target=getUser(b.userId);if(!target)return send(res,404,{error:'User not found.'});if(!validPin(b.newPin))return send(res,400,{error:'PIN must be 6-8 numbers.'});target.pinHash=pinHash(b.newPin);invalidateUserSessions(target.id);saveDb();return send(res,200,{ok:true});
    }
    if(m==='GET'&&p==='/api/admin/sales'){const u=requireRoles(req,res,'admin');if(!u)return;const orders=db.orders.filter(o=>['accepted','ready','completed'].includes(o.status));return send(res,200,{totalSales:orders.reduce((s,o)=>s+o.total,0),completedSales:db.orders.filter(o=>o.status==='completed').reduce((s,o)=>s+o.total,0),orderCount:orders.length,orders:db.orders.map(orderView).sort((a,b)=>b.id-a.id)})}

    send(res,404,{error:'Not found.'});
  }catch(e){console.error(e);if(!res.headersSent)send(res,500,{error:'Server error.'})}
});

seed();server.listen(PORT,'0.0.0.0',()=>console.log(`Dash Cash Noddin running on port ${PORT}`));
