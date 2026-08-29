const state = { me:null, products:[], cart:{}, view:'marketplace' };
const $ = s => document.querySelector(s);

async function api(url, options={}) {
  let res;
  try {
    res = await fetch(url, { headers:{'Content-Type':'application/json', ...(options.headers||{})}, ...options });
  } catch (err) {
    if (location.protocol === 'file:') {
      throw new Error('Dash Cash was opened as a file. Start the server, then open http://localhost:3000 in Chrome.');
    }
    throw new Error('Cannot reach the Dash Cash server. Make sure node server.js is running, then reload this page.');
  }
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
function toast(msg, error=false){ const t=$('#toast'); t.textContent=msg; t.className='toast show'+(error?' error':''); setTimeout(()=>t.className='toast',2600); }
function esc(s){ return String(s??'').replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':'&quot;'}[c])); }
function fmt(n){ return Number(n||0).toLocaleString(); }
function statusBadge(s){ return `<span class="badge ${s}">${esc(s.replaceAll('_',' '))}</span>`; }

function navItems(){
  const items=[];
  if(state.me.role==='student') items.push(['marketplace','🛍 Marketplace'],['cart','🛒 Cart'],['orders','📦 My Orders'],['seller','🏪 Seller'],['pin','🔐 My PIN']);
  if(['teacher','admin'].includes(state.me.role)) items.push(['teacher','🎓 Dash Cash']);
  if(state.me.role==='admin') items.push(['admin','🛡 Admin']);
  return items;
}
function renderNav(){
  $('#nav').innerHTML=navItems().map(([id,label])=>`<button data-view="${id}" class="${state.view===id?'active':''}">${label}</button>`).join('');
  $('#nav').onclick=e=>{ const b=e.target.closest('[data-view]'); if(!b)return; state.view=b.dataset.view; render(); };
}
function renderHeader(){
  $('#welcome').textContent=`${state.me.username} • ${state.me.role}`+(state.me.sellerBanned?' • selling paused':'')+(state.me.accountDisabled?' • account disabled':'');
  $('#balance').textContent=fmt(state.me.availableDash);
}
async function refreshMe(){ state.me=(await api('/api/me')).user; renderHeader(); }

async function render(){
  renderNav(); renderHeader();
  try{
    if(state.view==='marketplace') await marketplace();
    if(state.view==='cart') await cartView();
    if(state.view==='orders') await ordersView();
    if(state.view==='seller') await sellerView();
    if(state.view==='teacher') await teacherView();
    if(state.view==='admin') await adminView();
    if(state.view==='pin') pinView();
  }catch(e){ toast(e.message,true); }
}

async function marketplace(){
  state.products=(await api('/api/products')).products;
  $('#view').innerHTML=`<div class="toolbar"><label>Search products<input id="search" placeholder="Try bookmark..."></label><div><b>${state.products.length}</b> products</div></div><div id="products" class="grid"></div>`;
  const draw=()=>{
    const q=$('#search').value.toLowerCase();
    const list=state.products.filter(p=>(p.name+' '+p.description+' '+p.sellerName).toLowerCase().includes(q));
    $('#products').innerHTML=list.length?list.map(p=>`<article class="card product"><div class="split"><span class="badge">Seller: ${esc(p.sellerName)}</span><span>${p.quantity} left</span></div><h3>${esc(p.name)}</h3><p>${esc(p.description)}</p><div class="split"><div class="price">${fmt(p.price)} 💸</div><button data-add="${p.id}" ${p.sellerId===state.me.id?'disabled':''}>Add to cart</button></div></article>`).join(''):`<div class="empty">No products match your search.</div>`;
  };
  draw(); $('#search').oninput=draw;
  $('#products').onclick=e=>{ const b=e.target.closest('[data-add]'); if(!b)return; const id=Number(b.dataset.add); const p=state.products.find(x=>x.id===id); state.cart[id]=Math.min((state.cart[id]||0)+1,p.quantity); toast(`${p.name} added to cart`); };
}

async function cartView(){
  state.products=(await api('/api/products')).products;
  for(const id of Object.keys(state.cart)) if(!state.products.find(p=>p.id===Number(id))) delete state.cart[id];
  const rows=Object.entries(state.cart).map(([id,qty])=>({p:state.products.find(x=>x.id===Number(id)),qty})).filter(x=>x.p);
  const total=rows.reduce((s,x)=>s+x.p.price*x.qty,0);
  $('#view').innerHTML=rows.length?`<div class="card"><h2>Shopping cart</h2>${rows.map(x=>`<div class="split" style="margin:12px 0"><div><b>${esc(x.p.name)}</b><div class="muted">${fmt(x.p.price)} each • seller ${esc(x.p.sellerName)}</div></div><div class="row"><input class="qty" type="number" min="1" max="${x.p.quantity}" value="${x.qty}" data-qty="${x.p.id}"><button class="danger" data-remove="${x.p.id}">Remove</button></div></div>`).join('')}<hr><div class="split"><div><div class="muted">Total to reserve</div><div class="price">${fmt(total)} 💸</div><small>You have ${fmt(state.me.availableDash)} available.</small></div><button id="checkout" ${total>state.me.availableDash?'disabled':''}>Place order${rows.length>1?'s':''}</button></div></div>`:`<div class="empty">Your cart is empty. Add something from the marketplace.</div>`;
  $('#view').oninput=e=>{ if(e.target.matches('[data-qty]')){ const id=Number(e.target.dataset.qty); const p=state.products.find(x=>x.id===id); state.cart[id]=Math.max(1,Math.min(Number(e.target.value)||1,p.quantity)); cartView(); } };
  $('#view').onclick=async e=>{
    const rm=e.target.closest('[data-remove]'); if(rm){ delete state.cart[Number(rm.dataset.remove)]; return cartView(); }
    if(e.target.id==='checkout'){
      try{ const items=Object.entries(state.cart).map(([productId,qty])=>({productId:Number(productId),qty:Number(qty)})); const d=await api('/api/checkout',{method:'POST',body:JSON.stringify({items})}); state.cart={}; state.me=d.user; toast('Order placed! Dash Cash is reserved until sellers approve.'); state.view='orders'; render(); }catch(err){toast(err.message,true)}
    }
  };
}

async function ordersView(){
  const orders=(await api('/api/orders')).orders;
  $('#view').innerHTML=`<h2>Orders</h2>${orders.length?orders.map(orderCard).join(''):'<div class="empty">No orders yet.</div>'}`;
  $('#view').onclick=async e=>{
    const c=e.target.closest('[data-cancel]'); if(!c)return;
    try{ const d=await api(`/api/orders/${c.dataset.cancel}/cancel`,{method:'POST'}); state.me=d.user; toast('Order cancelled. Reserved Dash Cash released.'); render(); }catch(err){toast(err.message,true)}
  };
}
function orderCard(o){
  const mine=o.buyerId===state.me.id;
  return `<article class="card order"><div class="split"><div><b>Order #${o.id}</b> ${statusBadge(o.status)}<div class="muted">Buyer: ${esc(o.buyerName)} • Seller: ${esc(o.sellerName)}</div></div><div class="price">${fmt(o.total)} 💸</div></div><ul class="order-items">${o.items.map(i=>`<li>${i.qty} × ${esc(i.productName)} @ ${fmt(i.unitPrice)}</li>`).join('')}</ul>${mine&&o.status==='pending'?`<button class="danger" data-cancel="${o.id}">Cancel pending order</button>`:''}</article>`;
}

async function sellerView(){
  const [prodData,orderData,statsData]=await Promise.all([api('/api/seller/products'),api('/api/orders'),api('/api/stats')]);
  const myOrders=orderData.orders.filter(o=>o.sellerId===state.me.id);
  const s=statsData.seller;
  $('#view').innerHTML=`${state.me.sellerBanned?'<div class="card seller-disabled"><b>⚠️ Your selling access is paused by an admin.</b> You can still buy items.</div>':''}<div class="stats"><div class="stat"><span>Waiting</span><strong>${s.ordersWaiting}</strong></div><div class="stat"><span>Dash earned</span><strong>${fmt(s.dashEarned)}</strong></div><div class="stat"><span>Units sold</span><strong>${s.unitsSold}</strong></div><div class="stat"><span>Active products</span><strong>${s.activeProducts}</strong></div></div><div class="grid" style="grid-template-columns:1fr 2fr"><form id="productForm" class="card"><h2>Add product</h2><label>Name<input id="pName" maxlength="60" required></label><label>Description<textarea id="pDesc" maxlength="200"></textarea></label><label>Price (Dash Cash)<input id="pPrice" type="number" min="1" step="1" required></label><label>Inventory quantity<input id="pQty" type="number" min="1" max="999" step="1" required></label><button ${state.me.sellerBanned?'disabled':''}>List product</button></form><div><h2>Seller orders</h2>${myOrders.length?myOrders.map(sellerOrderCard).join(''):'<div class="empty">No seller orders yet.</div>'}</div></div><h2>Your products</h2><div class="grid">${prodData.products.length?prodData.products.map(p=>`<div class="card"><h3>${esc(p.name)}</h3><div class="price">${fmt(p.price)} 💸</div><p>${esc(p.description)}</p><label>Inventory<input type="number" min="0" max="999" value="${p.quantity}" data-prod-qty="${p.id}"></label><button class="ghost" data-toggle="${p.id}" data-active="${p.active}">${p.active?'Pause listing':'Resume listing'}</button></div>`).join(''):'<div class="empty">You have not listed anything yet.</div>'}</div>`;
  $('#productForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/products',{method:'POST',body:JSON.stringify({name:$('#pName').value,description:$('#pDesc').value,price:Number($('#pPrice').value),quantity:Number($('#pQty').value)})});toast('Product listed!');sellerView()}catch(err){toast(err.message,true)}};
  $('#view').onclick=async e=>{
    const b=e.target.closest('[data-status]'); if(b){try{await api(`/api/orders/${b.dataset.order}/status`,{method:'POST',body:JSON.stringify({status:b.dataset.status})});toast('Order updated.');await refreshMe();sellerView()}catch(err){toast(err.message,true)}return}
    const t=e.target.closest('[data-toggle]'); if(t){try{await api(`/api/products/${t.dataset.toggle}`,{method:'PATCH',body:JSON.stringify({active:t.dataset.active!=='true'})});sellerView()}catch(err){toast(err.message,true)}}
  };
  $('#view').onchange=async e=>{if(e.target.matches('[data-prod-qty]')){try{await api(`/api/products/${e.target.dataset.prodQty}`,{method:'PATCH',body:JSON.stringify({quantity:Number(e.target.value)})});toast('Inventory updated.')}catch(err){toast(err.message,true)}}};
}
function sellerOrderCard(o){
  let actions='';
  if(o.status==='pending') actions=`<button data-order="${o.id}" data-status="accepted">Accept</button> <button class="danger" data-order="${o.id}" data-status="rejected">Reject</button>`;
  if(o.status==='accepted') actions=`<button data-order="${o.id}" data-status="ready">Mark ready for pickup</button>`;
  if(o.status==='ready') actions=`<button data-order="${o.id}" data-status="completed">Mark completed</button>`;
  return `<article class="card order"><div class="split"><div><b>Order #${o.id}</b> ${statusBadge(o.status)}<div class="muted">Buyer: ${esc(o.buyerName)}</div></div><div class="price">${fmt(o.total)} 💸</div></div><ul>${o.items.map(i=>`<li>${i.qty} × ${esc(i.productName)}</li>`).join('')}</ul><div class="row">${actions}</div></article>`;
}

async function teacherView(){
  const users=(await api('/api/manage/users')).users;
  $('#view').innerHTML=`<div class="card"><h2>🎓 Dash Cash controls</h2><p>Add or remove Dash Cash for students. Pending-order reservations cannot be taken away.</p><form id="balanceForm" class="toolbar"><label>Student<select id="balUser">${users.filter(u=>u.role==='student').map(u=>`<option value="${u.id}">${esc(u.username)} — ${fmt(u.dashBalance)} total / ${fmt(u.availableDash)} available</option>`).join('')}</select></label><label>Adjustment<input id="balAmount" type="number" step="1" placeholder="50 or -20" required></label><label>Reason<input id="balNote" maxlength="100" placeholder="Great classwork"></label><button>Update balance</button></form></div><div class="table-wrap"><table><thead><tr><th>User</th><th>Role</th><th>Total</th><th>Reserved</th><th>Available</th><th>Account</th><th>Selling</th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.username)}</td><td>${u.role}</td><td>${fmt(u.dashBalance)}</td><td>${fmt(u.reservedDash)}</td><td>${fmt(u.availableDash)}</td><td>${u.accountDisabled?'Disabled':'Active'}</td><td>${u.role==='student'?(u.sellerBanned?'Paused':'Allowed'):'—'}</td></tr>`).join('')}</tbody></table></div>`;
  $('#balanceForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/manage/balance',{method:'POST',body:JSON.stringify({userId:Number($('#balUser').value),amount:Number($('#balAmount').value),note:$('#balNote').value})});toast('Dash Cash updated.');await refreshMe();teacherView()}catch(err){toast(err.message,true)}};
}

async function adminView(){
  const [usersData,sales]=await Promise.all([api('/api/manage/users'),api('/api/admin/sales')]);
  const students=usersData.users.filter(u=>u.role==='student');
  const manageable=usersData.users.filter(u=>u.role!=='admin');
  $('#view').innerHTML=`<div class="stats"><div class="stat"><span>Approved sales</span><strong>${fmt(sales.totalSales)} 💸</strong></div><div class="stat"><span>Completed sales</span><strong>${fmt(sales.completedSales)} 💸</strong></div><div class="stat"><span>Approved orders</span><strong>${sales.orderCount}</strong></div><div class="stat"><span>Students</span><strong>${students.length}</strong></div></div><div class="grid"><form id="banForm" class="card"><h2>Ban / unban seller</h2><label>Student<select id="banUser">${students.map(u=>`<option value="${u.id}">${esc(u.username)} — ${u.sellerBanned?'PAUSED':'allowed'}</option>`).join('')}</select></label><label>Action<select id="banValue"><option value="true">Pause selling</option><option value="false">Allow selling</option></select></label><button>Apply</button></form><form id="accountForm" class="card"><h2>Disable / enable account</h2><label>User<select id="accountUser">${manageable.map(u=>`<option value="${u.id}">${esc(u.username)} (${u.role}) — ${u.accountDisabled?'DISABLED':'active'}</option>`).join('')}</select></label><label>Action<select id="accountValue"><option value="true">Disable account</option><option value="false">Enable account</option></select></label><button class="danger">Apply</button></form><form id="resetForm" class="card"><h2>Reset PIN</h2><label>User<select id="pinUser">${usersData.users.map(u=>`<option value="${u.id}">${esc(u.username)} (${u.role})</option>`).join('')}</select></label><label>New 6–8 digit PIN<input id="newPin" type="password" inputmode="numeric" minlength="6" maxlength="8" required></label><button class="warning">Reset PIN</button></form></div><div class="card"><h2>Security controls</h2><p>✓ Class join code required for new students<br>✓ 6–8 digit PINs<br>✓ Login lockout after repeated failed attempts<br>✓ Disable/enable accounts and invalidate their sessions<br>✓ Ban/unban selling separately<br>✓ See all sales and orders<br>✓ Reset PINs</p></div><h2>All marketplace orders</h2>${sales.orders.length?sales.orders.map(orderCard).join(''):'<div class="empty">No orders yet.</div>'}`;
  $('#banForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/ban',{method:'POST',body:JSON.stringify({userId:Number($('#banUser').value),banned:$('#banValue').value==='true'})});toast('Seller access updated.');adminView()}catch(err){toast(err.message,true)}};
  $('#accountForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/account-status',{method:'POST',body:JSON.stringify({userId:Number($('#accountUser').value),disabled:$('#accountValue').value==='true'})});toast('Account status updated.');adminView()}catch(err){toast(err.message,true)}};
  $('#resetForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/admin/reset-pin',{method:'POST',body:JSON.stringify({userId:Number($('#pinUser').value),newPin:$('#newPin').value})});$('#newPin').value='';toast('PIN reset.')}catch(err){toast(err.message,true)}};
}

function pinView(){
  $('#view').innerHTML=`<form id="pinForm" class="card" style="max-width:480px"><h2>Change my PIN</h2><label>Current PIN<input id="oldPin" type="password" inputmode="numeric" minlength="6" maxlength="8" required></label><label>New 6–8 digit PIN<input id="myNewPin" type="password" inputmode="numeric" minlength="6" maxlength="8" required></label><button>Change PIN</button></form>`;
  $('#pinForm').onsubmit=async e=>{e.preventDefault();try{await api('/api/me/pin',{method:'POST',body:JSON.stringify({oldPin:$('#oldPin').value,newPin:$('#myNewPin').value})});e.target.reset();toast('PIN changed.')}catch(err){toast(err.message,true)}};
}

$('#loginForm').onsubmit=async e=>{e.preventDefault();try{state.me=(await api('/api/login',{method:'POST',body:JSON.stringify({username:$('#loginUsername').value,pin:$('#loginPin').value})})).user;startApp()}catch(err){toast(err.message,true)}};
$('#registerForm').onsubmit=async e=>{e.preventDefault();try{state.me=(await api('/api/register',{method:'POST',body:JSON.stringify({username:$('#regUsername').value,pin:$('#regPin').value,joinCode:$('#regJoinCode').value})})).user;startApp()}catch(err){toast(err.message,true)}};
$('#logoutBtn').onclick=async()=>{await api('/api/logout',{method:'POST'});state.me=null;state.cart={};$('#appScreen').classList.add('hidden');$('#authScreen').classList.remove('hidden')};
function startApp(){ $('#authScreen').classList.add('hidden'); $('#appScreen').classList.remove('hidden'); state.view=state.me.role==='student'?'marketplace':'teacher'; render(); }

(async()=>{try{state.me=(await api('/api/me')).user;startApp()}catch{}})();
