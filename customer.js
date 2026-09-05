// ===========================
// ADMIN PAGE DETECTION
// ===========================
const isAdminPage = (window.location.hash === '#admin');
// MENU is defined as a global in index.html before this script loads.

// ===========================
// APP STATE
// ===========================
let currentTable = null;
let cart = [];
let activeCategory = 0;
let activeFilter = 'all';
let cartIdCounter = 0;

// ===========================
// API CONFIG
// ===========================
const API_BASE = window.location.origin + '/api';
let API_TOKEN = localStorage.getItem('toc_api_token') || '';

async function apiCall(method, path, body) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const opts = { method, headers: { 'Content-Type': 'application/json' }, signal: controller.signal };
    if (API_TOKEN) opts.headers['X-Admin-Token'] = API_TOKEN;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    clearTimeout(timeout);
    if (!res.ok) throw new Error('API error: ' + res.status);
    return await res.json();
  } catch(e) {
    console.warn('API unavailable:', e.message);
    return null;
  }
}

// ===========================
// PERSISTENCE
// ===========================
async function loadOrders() {
  const apiData = await apiCall('GET', '/orders');
  if (apiData !== null) return apiData;
  try { return JSON.parse(localStorage.getItem('toc_orders'))||[] } catch(e){ return [] }
}
function saveOrders(o){ localStorage.setItem('toc_orders',JSON.stringify(o)) }
async function loadExpenses() {
  const apiData = await apiCall('GET', '/expenses');
  if (apiData !== null) return apiData;
  try { return JSON.parse(localStorage.getItem('toc_expenses'))||[] } catch(e){ return [] }
}
function saveExpenses(e){ localStorage.setItem('toc_expenses',JSON.stringify(e)) }
function loadAdminAuth(){ return localStorage.getItem('toc_admin_auth')==='true' }
function saveAdminAuth(v){ localStorage.setItem('toc_admin_auth',v?'true':'false') }
function setApiToken(t){ API_TOKEN=t; localStorage.setItem('toc_api_token',t); }

// ===========================
// UTILITY
// ===========================
function $(id){ return document.getElementById(id) }
function formatPrice(n){ return '\u20B9'+Number(n).toLocaleString('en-IN') }
async function genOrderId(){
  const d=new Date();
  const ds=d.getFullYear().toString()+String(d.getMonth()+1).padStart(2,'0')+String(d.getDate()).padStart(2,'0');
  const orders=await loadOrders();
  const todayOrders=orders.filter(o=>o.id.startsWith('ORD-'+ds));
  const num=(todayOrders.length+1).toString().padStart(4,'0');
  return 'ORD-'+ds+'-'+num;
}
function showToast(msg){
  const t=document.createElement('div');
  t.className='toast'; t.textContent=msg;
  document.body.appendChild(t);
  setTimeout(()=>t.remove(),2500);
}

// ===========================
// TABLE / LANDING
// ===========================
if(!isAdminPage){
(function initLanding(){
  const urlParams=new URLSearchParams(window.location.search);
  const tableParam=urlParams.get('table');
  if(tableParam && !isNaN(tableParam) && Number(tableParam)>0){
    currentTable=Number(tableParam);
    showMenu();
  }
  $('continueBtn').addEventListener('click',()=>{
    const v=parseInt($('tableInput').value);
    if(!v||v<1||v>100){ $('tableError').classList.add('show'); return }
    $('tableError').classList.remove('show');
    currentTable=v;
    showMenu();
  });
  $('tableInput').addEventListener('keydown',e=>{ if(e.key==='Enter') $('continueBtn').click() });
  $('tableBadge').addEventListener('click',()=>{
    if(confirm('Change table number?')){
      currentTable=null; cart=[];
      $('landing').classList.remove('hidden');
      $('mainContent').classList.remove('active');
      $('header').style.display='none';
      $('footer').style.display='none';
      $('floatingCart').classList.remove('show');
      $('tableInput').value='';
      $('tableInput').focus();
    }
  });
})();
}

function showMenu(){
  $('landing').classList.add('hidden');
  $('mainContent').style.display='';
  $('mainContent').classList.add('active');
  $('header').style.display='flex';
  $('footer').style.display='block';
  $('tableBadge').textContent='TABLE '+currentTable;
  $('cartTableLabel').textContent='TABLE '+currentTable;
  buildCategories();
  buildMenu();
  updateCart();
}

// ===========================
// CATEGORIES
// ===========================
function buildCategories(){
  const track=$('categoryTrack');
  track.innerHTML='';
  MENU.forEach((cat,i)=>{
    const btn=document.createElement('button');
    btn.className='category-chip'+(i===activeCategory?' active':'');
    btn.textContent=cat.icon+' '+cat.cat;
    btn.addEventListener('click',()=>{
      activeCategory=i;
      document.querySelectorAll('.category-chip').forEach(c=>c.classList.remove('active'));
      btn.classList.add('active');
      const el=document.querySelector('.menu-category[data-cat="'+i+'"]');
      if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
    });
    track.appendChild(btn);
  });
}

// ===========================
// FILTERS
// ===========================
if(!isAdminPage){
document.querySelectorAll('.filter-chip').forEach(chip=>{
  chip.addEventListener('click',()=>{
    activeFilter=chip.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach(c=>c.classList.remove('active'));
    chip.classList.add('active');
    buildMenu();
  });
});
}

// ===========================
// MENU RENDERING
// ===========================
function buildMenu(){
  const sec=$('menuSection');
  sec.innerHTML='';
  MENU.forEach((cat,catIdx)=>{
    const section=document.createElement('div');
    section.className='menu-category';
    section.dataset.cat=catIdx;
    let isJain=cat.cat==='JAIN MENU';
    let filteredItems=cat.items;
    if(activeFilter==='veg') filteredItems=cat.items;
    if(activeFilter==='jain' && !isJain) return;
    if(activeFilter==='jain' && isJain) filteredItems=cat.items;
    if(activeFilter==='all') filteredItems=cat.items;
    if(filteredItems.length===0) return;
    let html='<div class="menu-category-title"><span class="cat-icon">'+cat.icon+'</span> '+cat.cat+'</div>';
    if(cat.note) html+='<div class="menu-note">'+cat.note+'</div>';
    html+='<div class="menu-grid">';
    filteredItems.forEach((item, itemIdx)=>{
      const key=catIdx+'-'+itemIdx;
      html+='<div class="menu-card" data-key="'+key+'">';
      html+='<img class="menu-card-img" src="'+item.img+'" alt="'+item.name+'" loading="lazy">';
      html+='<div class="menu-card-body">';
      html+='<div class="menu-card-name">'+item.name+'</div>';
      if(item.desc) html+='<div class="menu-card-desc">'+item.desc+'</div>';
      html+='<div class="menu-card-bottom">';
      if(item.halfFull){
        html+='<div class="menu-card-price"><div class="half-full"><span>Half <strong>'+formatPrice(item.halfPrice)+'</strong></span><span>Full <strong>'+formatPrice(item.price)+'</strong></span></div></div>';
      } else {
        html+='<div class="menu-card-price">'+formatPrice(item.price)+'</div>';
      }
      html+='<button class="btn-add" onclick="handleAddClick('+catIdx+','+itemIdx+')">ADD</button>';
      html+='</div></div></div>';
    });
    html+='</div>';
    section.innerHTML=html;
    sec.appendChild(section);
  });
}

// ===========================
// ADD TO CART / OPTIONS
// ===========================
function handleAddClick(catIdx, itemIdx){
  const item=MENU[catIdx].items[itemIdx];
  const hasOptions=item.options && item.options.length>0;
  const hasPizzaAddons=item.pizzaAddons;
  const hasCheesecakeAddons=item.cheesecakeAddons;
  const hasHalfFull=item.halfFull;
  if(hasOptions || hasPizzaAddons || hasCheesecakeAddons || hasHalfFull){
    openOptionsModal(catIdx, itemIdx);
  } else {
    addToCart({catIdx,itemIdx,name:item.name,price:item.price,img:item.img,qty:1,options:[],addons:[]});
  }
}

function openOptionsModal(catIdx, itemIdx){
  const item=MENU[catIdx].items[itemIdx];
  const modal=$('optionsModal');
  const content=$('optionsContent');
  let html='<div class="modal-handle"></div>';
  html+='<div class="modal-title">'+item.name+'</div>';
  if(item.desc) html+='<div class="modal-desc">'+item.desc+'</div>';
  let basePrice=item.price;
  let selectedVariant=null;
  let selectedOptions=[];
  let selectedAddons=[];
  if(item.halfFull){
    html+='<div class="option-group"><div class="option-label">Select Size</div>';
    html+='<div class="option-item selected" data-type="variant" data-value="half" onclick="selectOption(this,\'variant\')"><div class="option-radio"></div><span class="option-item-label">Half</span><span class="option-item-price">'+formatPrice(item.halfPrice)+'</span></div>';
    html+='<div class="option-item" data-type="variant" data-value="full" onclick="selectOption(this,\'variant\')"><div class="option-radio"></div><span class="option-item-label">Full</span><span class="option-item-price">'+formatPrice(item.price)+'</span></div>';
    html+='</div>';
    basePrice=item.halfPrice;
  }
  if(item.options && item.options.length>0){
    html+='<div class="option-group"><div class="option-label">Choose</div>';
    item.options.forEach((opt,i)=>{
      html+='<div class="option-item'+(i===0?' selected':'')+'" data-type="option" data-value="'+opt+'" onclick="selectOption(this,\'option\')"><div class="option-radio"></div><span class="option-item-label">'+opt+'</span></div>';
    });
    html+='</div>';
    selectedOptions=[item.options[0]];
  }
  if(item.pizzaAddons){
    html+='<div class="option-group"><div class="option-label">Extra Cheese \u2014 \u20B980</div>';
    html+='<div class="option-item" data-type="addon" data-name="Extra Cheese" data-price="80" onclick="selectOption(this,\'addon\')"><div class="option-checkbox"></div><span class="option-item-label">Extra Cheese</span><span class="option-item-price">\u20B980</span></div>';
    html+='</div>';
    const toppings=['Corn','Jalapeno','Black Olive','Zucchini','Mushroom','Red/Yellow Bell Pepper','Broccoli','Capsicum','Paneer','Onions'];
    html+='<div class="option-group"><div class="option-label">Extra Topping \u2014 \u20B930 each</div>';
    toppings.forEach(t=>{
      html+='<div class="option-item" data-type="addon" data-name="'+t+'" data-price="30" onclick="selectOption(this,\'addon\')"><div class="option-checkbox"></div><span class="option-item-label">'+t+'</span><span class="option-item-price">\u20B930</span></div>';
    });
    html+='</div>';
  }
  if(item.cheesecakeAddons){
    const toppings=[{n:'Chocolate',p:30},{n:'Hazelnut',p:40},{n:'Strawberry',p:40},{n:'Blueberry',p:40},{n:'Nutella',p:60},{n:'Biscoff',p:70}];
    html+='<div class="option-group"><div class="option-label">Add Toppings</div>';
    toppings.forEach(t=>{
      html+='<div class="option-item" data-type="addon" data-name="'+t.n+'" data-price="'+t.p+'" onclick="selectOption(this,\'addon\')"><div class="option-checkbox"></div><span class="option-item-label">'+t.n+'</span><span class="option-item-price">'+formatPrice(t.p)+'</span></div>';
    });
    html+='</div>';
  }
  html+='<button class="modal-add-btn" onclick="addFromModal('+catIdx+','+itemIdx+')">ADD TO ORDER</button>';
  content.innerHTML=html;
  content.dataset.catIdx=catIdx;
  content.dataset.itemIdx=itemIdx;
  content.dataset.basePrice=basePrice;
  modal.classList.add('active');
}

function selectOption(el, type){
  if(type==='variant'||type==='option'){
    el.closest('.option-group').querySelectorAll('.option-item').forEach(o=>o.classList.remove('selected'));
    el.classList.add('selected');
  } else {
    el.classList.toggle('selected');
  }
}

function addFromModal(catIdx, itemIdx){
  const content=$('optionsContent');
  const item=MENU[catIdx].items[itemIdx];
  let basePrice=Number(content.dataset.basePrice);
  let options=[];
  let addons=[];
  let addonTotal=0;
  let variantLabel='';
  content.querySelectorAll('.option-item.selected').forEach(el=>{
    const type=el.dataset.type;
    if(type==='variant'){
      variantLabel=el.dataset.value;
      basePrice=Number(el.dataset.value==='half'?item.halfPrice:item.price);
    }
    if(type==='option') options.push(el.dataset.value);
    if(type==='addon'){
      addons.push({name:el.dataset.name,price:Number(el.dataset.price)});
      addonTotal+=Number(el.dataset.price);
    }
  });
  const unitPrice=basePrice+addonTotal;
  const displayName=item.name+(variantLabel?' ('+variantLabel.charAt(0).toUpperCase()+variantLabel.slice(1)+')':'');
  const optionStr=options.concat(addons.map(a=>a.name)).join(', ');
  addToCart({catIdx,itemIdx,name:displayName,price:unitPrice,img:item.img,qty:1,options:optionStr?options.concat(addons.map(a=>a.name)):[]});
  $('optionsModal').classList.remove('active');
}

if(!isAdminPage && $('optionsModal')){
$('optionsModal').addEventListener('click',e=>{
  if(e.target===$('optionsModal')) $('optionsModal').classList.remove('active');
});
}

// ===========================
// CART
// ===========================
function addToCart(item){
  cartIdCounter++;
  const cartItem={...item,cartId:cartIdCounter};
  const existing=cart.find(c=>c.name===cartItem.name && JSON.stringify(c.options)===JSON.stringify(cartItem.options));
  if(existing){ existing.qty++; } else { cart.push(cartItem); }
  updateCart();
  showToast('\u2713 Added to order');
}

function updateCart(){
  const totalItems=cart.reduce((s,c)=>s+c.qty,0);
  const totalPrice=cart.reduce((s,c)=>s+(c.price*c.qty),0);
  const badge=$('cartBadge');
  if(totalItems>0){
    badge.style.display='flex';
    badge.textContent=totalItems;
    badge.classList.remove('bump');
    void badge.offsetWidth;
    badge.classList.add('bump');
  } else { badge.style.display='none'; }
  const fc=$('floatingCart');
  if(totalItems>0){
    fc.classList.add('show');
    $('floatingCartInfo').textContent=totalItems+' item'+(totalItems>1?'s':'')+' \u00B7 '+formatPrice(totalPrice);
  } else { fc.classList.remove('show'); }
  renderCartItems();
}

function renderCartItems(){
  const container=$('cartItems');
  if(cart.length===0){
    container.innerHTML='<div class="cart-empty"><div class="cart-empty-icon">\uD83D\uDED2</div><h3>YOUR ORDER IS EMPTY</h3><p>Add something delicious to get started.</p></div>';
    $('cartFooter').style.display='none';
    return;
  }
  let html='';
  cart.forEach((item,i)=>{
    html+='<div class="cart-item">';
    html+='<div class="cart-item-info">';
    html+='<div class="cart-item-name">'+item.name+'</div>';
    if(item.options && item.options.length>0) html+='<div class="cart-item-options">'+item.options.join(', ')+'</div>';
    html+='<div class="cart-item-controls"><div class="cart-item-qty">';
    html+='<button class="cart-qty-btn" onclick="cartQty('+-+item.cartId+')">\u2212</button>';
    html+='<span class="cart-qty-num">'+item.qty+'</span>';
    html+='<button class="cart-qty-btn" onclick="cartQty('+item.cartId+')">+</button>';
    html+='</div>';
    html+='<span class="cart-item-total">'+formatPrice(item.price*item.qty)+'</span>';
    html+='</div>';
    html+='<span class="cart-item-remove" onclick="removeCartItem('+item.cartId+')">Remove</span>';
    html+='</div></div>';
  });
  container.innerHTML=html;
  const total=cart.reduce((s,c)=>s+(c.price*c.qty),0);
  $('cartSubtotal').textContent=formatPrice(total);
  $('cartTotal').textContent=formatPrice(total);
  $('cartFooter').style.display='block';
}

function cartQty(cartId){
  const item=cart.find(c=>c.cartId===Math.abs(cartId));
  if(!item) return;
  if(cartId<0){ item.qty--; if(item.qty<=0) cart=cart.filter(c=>c.cartId!==item.cartId); }
  else { item.qty++; }
  updateCart();
}

function removeCartItem(cartId){ cart=cart.filter(c=>c.cartId!==cartId); updateCart(); }

if(!isAdminPage && $('cartToggleBtn')){
  $('cartToggleBtn').addEventListener('click',()=>{ $('cartDrawer').classList.add('open'); $('cartOverlay').classList.add('active'); });
  $('floatingCartBtn').addEventListener('click',()=>{ $('cartDrawer').classList.add('open'); $('cartOverlay').classList.add('active'); });
  $('cartCloseBtn').addEventListener('click',()=>{ $('cartDrawer').classList.remove('open'); $('cartOverlay').classList.remove('active'); });
  $('cartOverlay').addEventListener('click',()=>{ $('cartDrawer').classList.remove('open'); $('cartOverlay').classList.remove('active'); });
}

// ===========================
// PLACE ORDER
// ===========================
if(!isAdminPage && $('placeOrderBtn')) $('placeOrderBtn').addEventListener('click',placeOrder);

async function placeOrder(){
  if(cart.length===0) return;
  const btn=$('placeOrderBtn');
  btn.disabled=true;
  btn.textContent='PLACING ORDER...';
  try {
    const orderData = {
      table: currentTable,
      items: cart.map(c=>({name:c.name,price:c.price,qty:c.qty,options:c.options||[]}))
    };
    let order;
    const apiResult = await apiCall('POST', '/orders', orderData);
    if (apiResult && apiResult.success) { order = apiResult.order; }
    else {
      const orderId=await genOrderId();
      const now=new Date();
      order={id:orderId,table:currentTable,items:orderData.items,total:orderData.items.reduce((s,c)=>s+(c.price*c.qty),0),status:'PENDING',date:now.toISOString().split('T')[0],time:now.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',hour12:true}),timestamp:now.toISOString(),completedAt:null,cancelledAt:null};
      const orders=await loadOrders();
      orders.push(order);
      saveOrders(orders);
    }
    const box=$('confirmBox');
    box.innerHTML='<div class="confirm-icon">\u2713</div><div class="confirm-title">ORDER RECEIVED</div><div class="confirm-msg">Your order has been received by<br>The Oregano Cafe team.</div><div class="confirm-order-id">'+order.id+'</div><div style="font-size:13px;color:var(--text-muted);margin-bottom:4px">TABLE '+currentTable+'</div><div class="confirm-order-total">'+formatPrice(order.total)+'</div><div class="confirm-msg" style="font-size:13px">Our team will prepare your order shortly.</div><button class="confirm-close-btn" onclick="closeOrderConfirm()">BACK TO MENU</button>';
    $('confirmOverlay').classList.add('active');
    cart=[]; cartIdCounter=0; updateCart();
    $('cartDrawer').classList.remove('open');
    $('cartOverlay').classList.remove('active');
  } catch(e) {
    console.error('Error placing order:', e);
    showToast('Error placing order. Please try again.');
  } finally {
    btn.disabled=false;
    btn.textContent='\uD83D\uDCCB  PLACE ORDER';
  }
}

function closeOrderConfirm(){ $('confirmOverlay').classList.remove('active'); }

// ===========================
// SEARCH
// ===========================
if(!isAdminPage && $('searchToggleBtn')){
$('searchToggleBtn').addEventListener('click',()=>{
  $('searchOverlay').classList.add('active');
  setTimeout(()=>$('searchField').focus(),100);
});
$('searchBackBtn').addEventListener('click',()=>{
  $('searchOverlay').classList.remove('active');
  $('searchField').value='';
  $('searchResults').innerHTML='<div class="search-empty"><svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><p>Type to search the menu</p></div>';
});
$('searchField').addEventListener('input',function(){
  const q=this.value.toLowerCase().trim();
  if(!q){ $('searchResults').innerHTML='<div class="search-empty"><svg fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><p>Type to search the menu</p></div>'; return }
  let results=[];
  MENU.forEach((cat,ci)=>{ cat.items.forEach((item,ii)=>{ if(item.name.toLowerCase().includes(q)||(item.desc&&item.desc.toLowerCase().includes(q))||cat.cat.toLowerCase().includes(q)){ results.push({cat:cat.cat,item,ci,ii}); } }); });
  if(results.length===0){ $('searchResults').innerHTML='<div class="search-empty"><p>NO DISHES FOUND</p></div>'; return; }
  let html='';
  results.forEach(r=>{
    html+='<div class="search-item" onclick="handleAddClick('+r.ci+','+r.ii+');$(\'searchOverlay\').classList.remove(\'active\')">';
    html+='<img class="search-item-img" src="'+r.item.img+'" alt="'+r.item.name+'">';
    html+='<div class="search-item-info"><h4>'+r.item.name+'</h4><p>'+r.cat+'</p></div>';
    html+='<span class="search-item-price">'+formatPrice(r.item.price)+'</span>';
    html+='</div>';
  });
  $('searchResults').innerHTML=html;
});
}

// ===========================
// ETIQUETTE TOGGLE
// ===========================
if(!isAdminPage && $('etiquetteToggle')){
$('etiquetteToggle').addEventListener('click',function(){
  this.classList.toggle('open');
  $('etiquetteContent').classList.toggle('open');
});
}

// ===========================
// FOOTER LINKS
// ===========================
if(!isAdminPage && $('footerMenuLink')){
$('footerMenuLink').addEventListener('click',e=>{e.preventDefault();window.scrollTo({top:0,behavior:'smooth'})});
$('footerJainLink').addEventListener('click',e=>{
  e.preventDefault();
  activeFilter='jain';
  document.querySelectorAll('.filter-chip').forEach(c=>c.classList.remove('active'));
  document.querySelector('.filter-chip[data-filter="jain"]').classList.add('active');
  buildMenu();
  window.scrollTo({top:0,behavior:'smooth'});
});
}

// ===========================
// HEADER SCROLL
// ===========================
if(!isAdminPage){
let lastScroll=0;
window.addEventListener('scroll',()=>{
  const header=$('header');
  if(!header) return;
  const st=window.scrollY;
  header.classList.toggle('scrolled',st>10);
  header.classList.toggle('hidden-up',st>lastScroll && st>100);
  lastScroll=st;
});
}

// ===========================
// Close modals on escape
// ===========================
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    const om=$('optionsModal'); if(om) om.classList.remove('active');
    const co=$('confirmOverlay'); if(co) co.classList.remove('active');
    const am=$('adminModal'); if(am) am.classList.remove('active');
    const ac=$('adminConfirm'); if(ac) ac.classList.remove('active');
    const so=$('searchOverlay'); if(so) so.classList.remove('active');
    const cd=$('cartDrawer'); if(cd) cd.classList.remove('open');
    const clo=$('cartOverlay'); if(clo) clo.classList.remove('active');
  }
});

document.querySelectorAll('form').forEach(f=>f.addEventListener('submit',e=>e.preventDefault()));
