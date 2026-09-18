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
let currentOrderType = 'dine-in';
let currentDeliveryRegion = null;

// IST Timezone Utility (Asia/Kolkata, UTC+05:30)
const IST_OFFSET = 5.5 * 60 * 60 * 1000; // +05:30 in ms
function getISTDate(date) {
  const d = date || new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  return new Date(utc + IST_OFFSET);
}
function formatISTDateTime(date) {
  const d = getISTDate(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  let hours = d.getHours();
  const min = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return { date: dd + '/' + mm + '/' + yyyy, time: String(hours).padStart(2, '0') + ':' + min + ' ' + ampm + ' IST' };
}
function formatISTDate(date) {
  return formatISTDateTime(date).date;
}
function formatISTTime(date) {
  return formatISTDateTime(date).time;
}
function formatISTFull(date) {
  const { date: d, time: t } = formatISTDateTime(date);
  return d + ', ' + t;
}

// ===========================
// API CONFIG
// ===========================
const API_BASE = window.location.origin + '/api';
let API_TOKEN = localStorage.getItem('toc_api_token') || '';

async function apiCall(method, path, body) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const opts = { method, headers: { 'Content-Type': 'application/json' }, signal: controller.signal };
    
    // Diagnostic: log request details (without exposing token)
    console.log(`[API] ${method} ${API_BASE + path} | hasToken: ${!!API_TOKEN}`);
    
    if (API_TOKEN) opts.headers['X-Admin-Token'] = API_TOKEN;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(API_BASE + path, opts);
    clearTimeout(timeout);
    
    // Diagnostic: log response status
    console.log(`[API] Response: ${res.status} ${res.statusText}`);
    
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      console.error(`[API] Error response: ${res.status} - ${errorText}`);
      throw new Error('API error: ' + res.status);
    }
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
async function loadBills() {
  const apiData = await apiCall('GET', '/bills');
  if (apiData !== null) return apiData;
  try { return JSON.parse(localStorage.getItem('toc_bills'))||[] } catch(e){ return [] }
}
function saveBills(b){ localStorage.setItem('toc_bills',JSON.stringify(b)) }
async function getBill(billNumber) {
  const apiData = await apiCall('GET', '/bills/' + billNumber);
  if (apiData !== null) return apiData;
  const bills = await loadBills();
  return bills.find(b => b.bill_number === billNumber) || null;
}
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
const TOTAL_TABLES = 20;

if(!isAdminPage){
(function initLanding(){
  const urlParams=new URLSearchParams(window.location.search);
  const tableParam=urlParams.get('table');
  // Validate URL/QR table parameter
  if(tableParam){
    const v=Number(tableParam);
    if(Number.isInteger(v) && v>=1 && v<=TOTAL_TABLES){
      currentTable=v;
      currentOrderType='dine-in';
      showMenu();
    } else {
      $('tableError').textContent = 'Please enter a table number between 1-' + TOTAL_TABLES + '.';
      $('tableError').classList.add('show');
    }
  }
  $('continueBtn').addEventListener('click',()=>{
    const v=Number($('tableInput').value);
    if(!Number.isInteger(v) || v<1 || v>TOTAL_TABLES){
      $('tableError').textContent = 'Please enter a table number between 1-' + TOTAL_TABLES + '.';
      $('tableError').classList.add('show');
      return;
    }
    $('tableError').classList.remove('show');
    currentTable=v;
    currentOrderType='dine-in';
    showMenu();
  });
  $('tableInput').addEventListener('keydown',e=>{ if(e.key==='Enter') $('continueBtn').click() });
  $('tableBadge').addEventListener('click',()=>{
    if(confirm('Change table number?')){
      currentTable=null; cart=[]; currentOrderType='dine-in'; currentDeliveryRegion=null;
      $('landing').classList.remove('hidden');
      $('mainContent').classList.remove('active');
      $('header').style.display='none';
      $('footer').style.display='none';
      $('floatingCart').classList.remove('show');
      $('tableInput').value='';
      $('tableInput').focus();
      $('tableError').classList.remove('show');
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
// MENU ICON HELPERS
// ===========================
function getItemIcon(item, cat){
  if(item.icon) return item.icon;
  const name=item.name.toLowerCase();
  const catName=cat?cat.cat.toLowerCase():'';
  // Pizza
  if(name.includes('pizza')) return '🍕';
  // Pasta
  if(name.includes('pasta')||name.includes('penne')||name.includes('spaghetti')||name.includes('ravioli')||name.includes('gnocchi')) return '🍝';
  // Burger
  if(name.includes('burger')) return '🍔';
  // Fries / wedges / chips
  if(name.includes('fries')||name.includes('wedges')||name.includes('chips')) return '🍟';
  // Momos
  if(name.includes('momos')||name.includes('momos')) return '🥟';
  // Rice / biryani
  if(name.includes('rice')||name.includes('biryani')) return '🍚';
  // Noodles
  if(name.includes('noodle')) return '🍜';
  // Soup
  if(name.includes('soup')) return '🍲';
  // Milkshake
  if(name.includes('milkshake')) return '🥤';
  // Coffee
  if(name.includes('coffee')) return '☕';
  // Tea
  if(name.includes('tea')) return '🫖';
  // Chocolate / hot chocolate
  if(name.includes('chocolate')) return '🍫';
  // Mocktail / cocktail-style
  if(name.includes('mocktail')) return '🍹';
  // Dessert / cake / brownie / sundae
  if(name.includes('cake')||name.includes('brownie')||name.includes('sundae')||name.includes('waffle')||name.includes('dessert')) return '🍰';
  // Cheesecake
  if(name.includes('cheesecake')) return '🍰';
  // Cheese-based
  if(name.includes('cheese')) return '🧀';
  // Bread / garlic bread / toast / bruschetta
  if(name.includes('bread')||name.includes('toast')||name.includes('bruschetta')) return '🍞';
  // Nachos
  if(name.includes('nachos')||name.includes('nachos')) return '🫓';
  // Bao
  if(name.includes('bao')) return '🫓';
  // Fondue
  if(name.includes('fondue')) return '🫕';
  // Soup / oriental / soups
  if(name.includes('soup')) return '🍜';
  // Chinese starters / gravy
  if(name.includes('gravy')||name.includes('starter')) return '🥡';
  // Dip
  if(name.includes('dip')) return '🫙';
  // Beverage / drink / coke / sprite / thums up / bisleri / water
  if(name.includes('beverage')||name.includes('drink')||name.includes('coke')||name.includes('sprite')||name.includes('water')||name.includes('bisleri')||name.includes('thums up')) return '🥤';
  // Shake / smoothie-type
  if(name.includes('shake')) return '🥤';
  // Desserts / ice cream
  if(name.includes('ice cream')||name.includes('icecream')) return '🍦';
  // Fruit / berry / mango / strawberry / blueberry
  if(name.includes('berry')||name.includes('mango')||name.includes('strawberry')||name.includes('apple')) return '🍎';
  // Oriental express
  if(catName.includes('oriental')||catName.includes('soup')) return '🍜';
  // Chinese
  if(catName.includes('chinese')) return '🥡';
  // Jak/Jain
  if(catName.includes('jain')) return '🙏';
  // Dessert
  if(catName.includes('dessert')) return '🍰';
  // Default food icon
  return '🍽️';
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
    let html='<div class="menu-category-title"><span class="cat-icon">'+(cat.icon||'')+'</span> '+cat.cat+'</div>';
    if(cat.note) html+='<div class="menu-note">'+cat.note+'</div>';
    html+='<div class="menu-grid">';
    filteredItems.forEach((item, itemIdx)=>{
      const key=catIdx+'-'+itemIdx;
      const itemIcon=getItemIcon(item,cat);
      html+='<div class="menu-card" data-key="'+key+'">';
      html+='<div class="menu-card-icon">'+itemIcon+'</div>';
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
      items: cart.map(c=>({name:c.name,price:c.price,qty:c.qty,options:c.options||[]})),
      order_type: currentOrderType,
      delivery: currentOrderType==='delivery' ? { region: currentDeliveryRegion } : null
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
// MY BILL — customer bill verification (bill BEFORE payment)
// The customer can inspect table number, every item, qty, price and total.
// No payment method is shown until payment has actually been recorded.
// ===========================
function customerBillHTML(bill, fallbackTable){
  const tableNum = bill.table || fallbackTable;
  const unpaid = (bill.payment_status || 'UNPAID') !== 'PAID';
  const items = bill.items && bill.items.length ? bill.items : (bill.orders || []).reduce((acc, o) => acc.concat((o.items || []).map(it => ({ name: it.name, qty: it.qty, price: it.price, options: it.options || [] }))), []);
  let rows = '';
  let idx = 0;
  items.forEach(it => {
    idx++;
    const opts = it.options && it.options.length ? '<span class="item-opts">' + it.options.join(', ') + '</span>' : '';
    rows += '<tr>' +
      '<td class="rb-td-num">' + idx + '</td>' +
      '<td>' + it.name + opts + '</td>' +
      '<td class="num">' + it.qty + '</td>' +
      '<td class="amt">' + formatPrice(it.price) + '</td>' +
      '<td class="amt">' + formatPrice(it.price * it.qty) + '</td>' +
    '</tr>';
  });
  const billDate = bill.bill_date || bill.payment_date || '';
  const billTime = bill.bill_time || bill.payment_time || '';
  let paySection;
  if (unpaid) {
    paySection = '<div class="rb-paystatus unpaid">' +
      '<div class="rb-ps-label">Payment Status</div>' +
      '<div class="rb-ps-value">UNPAID</div>' +
      '<div class="rb-ps-sub">Please verify your items, then pay at the counter.</div>' +
    '</div>';
  } else {
    paySection = '<div class="rb-paystatus paid">' +
      '<div class="rb-ps-label">Payment Status</div>' +
      '<div class="rb-ps-value"><span class="rb-ps-check">\u2713</span>PAID</div>' +
    '</div>' +
    '<div class="rb-paymethod">' +
      (bill.payment_method === 'SPLIT' ?
        '<div class="rb-pm-row"><span>Cash Paid</span><strong>' + formatPrice(bill.cash_amount || 0) + '</strong></div>' +
        '<div class="rb-pm-row"><span>Online Paid</span><strong>' + formatPrice(bill.online_amount || 0) + '</strong></div>' :
        bill.payment_method === 'CASH' ?
        '<div class="rb-pm-row"><span>Cash Paid</span><strong>' + formatPrice(bill.cash_amount || bill.total || 0) + '</strong></div>' :
        '<div class="rb-pm-row"><span>Online Paid</span><strong>' + formatPrice(bill.online_amount || bill.total || 0) + '</strong></div>'
      ) +
      '<div class="rb-pm-row rb-pm-total"><span>Total Paid</span><strong>' + formatPrice(bill.total) + '</strong></div>' +
      (bill.payment_date || bill.paid_at ? '<div class="rb-pm-row rb-pm-paidat"><span>Paid At</span><strong>' + (bill.payment_date || '') + (bill.payment_time ? ' \u00b7 ' + bill.payment_time : '') + '</strong></div>' : '') +
    '</div>';
  }
  return '<div class="receipt-bill" id="printableBill">' +
    '<div class="rb-botanical-tl">\ud83c\udf3f</div>' +
    '<div class="rb-botanical-br">\ud83c\udf3f</div>' +
    '<div class="rb-header">' +
      '<div class="rb-stars">\u2736  \u2736  \u2736</div>' +
      '<div class="rb-cafe">THE OREGANO CAFE</div>' +
      '<div class="rb-tag">Premium Cafe \u00b7 Est. 2019 \u00b7 Bhiwandi</div>' +
    '</div>' +
    '<div class="rb-section-title">Customer Bill</div>' +
    '<div class="rb-meta">' +
      '<div><span>Bill No.</span><strong>' + bill.bill_number + '</strong></div>' +
      '<div><span>Table No.</span><strong>' + tableNum + '</strong></div>' +
      '<div><span>Date</span><strong>' + billDate + '</strong></div>' +
      '<div><span>Time</span><strong>' + billTime + '</strong></div>' +
      (bill.session_id ? '<div><span>Session</span><strong>' + bill.session_id + '</strong></div>' : '') +
    '</div>' +
    '<table class="rb-table">' +
      '<thead><tr><th class="rb-th-num">#</th><th>Item</th><th class="num">Qty</th><th class="amt">Price</th><th class="amt">Total</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>' +
    '<div class="rb-totals">' +
      '<div class="rb-trow"><span>Subtotal</span><span>' + formatPrice(bill.subtotal != null ? bill.subtotal : bill.total) + '</span></div>' +
      '<div class="rb-trow grand"><span>TOTAL AMOUNT</span><span>' + formatPrice(bill.total) + '</span></div>' +
    '</div>' +
    paySection +
    '<div class="rb-thanks">' +
      '<div class="rb-thanks-msg">Thank you for dining with us.</div>' +
      '<div class="rb-thanks-brand">THE OREGANO CAFE</div>' +
      '<div class="rb-thanks-tagline">Good Food. Warm Moments. Beautifully Served.</div>' +
    '</div>' +
  '</div>';
}

async function loadMyBill(){
  if (!currentTable) { showToast('Please enter your table number first.'); return; }
  // Public endpoint — customers never log in.
  let result = await apiCall('GET', '/customer/tables/' + currentTable + '/current-bill');
  // Fallback for older servers: admin endpoint if a token happens to exist.
  if (!result && API_TOKEN) result = await apiCall('GET', '/tables/' + currentTable + '/current-bill');
  if (!result || !result.session) {
    // No session yet — friendly empty state instead of a bare toast.
    $('myBillContent').innerHTML = '<div class="modal-handle"></div><div class="modal-title">MY BILL</div>' +
      '<p class="modal-desc">Nothing on your bill yet. Your bill is generated once your orders are served — ask our staff whenever you are ready.</p>' +
      '<button class="modal-add-btn" onclick="closeMyBill()">CLOSE</button>';
    $('myBillOverlay').classList.add('active');
    return;
  }
  const content = $('myBillContent');
  if (result.bill) {
    // Generated bill exists — show it (UNPAID or PAID with the real method)
    content.innerHTML = customerBillHTML(result.bill, currentTable) +
      '<div class="bill-no-print" style="text-align:center;margin-top:16px;display:flex;gap:10px;justify-content:center">' +
        '<button class="btn-order" style="width:auto;padding:12px 24px" onclick="printMyBill()">🖨 PRINT BILL</button>' +
        '<button class="btn-cancel-modal btn-view" style="padding:12px 24px;border-radius:var(--radius-md)" onclick="closeMyBill()">CLOSE</button>' +
      '</div>';
  } else {
    // No bill generated yet — show a live preview of consumed items
    const items = (result.orders || []).reduce((acc, o) => acc.concat((o.items || []).map(it => ({ name: it.name, qty: it.qty, price: it.price, options: it.options || [] }))), []);
    if (!items.length) {
      content.innerHTML = '<div class="modal-handle"></div><div class="modal-title">MY BILL</div>' +
        '<p class="modal-desc">No items on your bill yet. Ask our staff for your bill when you are ready.</p>' +
        '<button class="modal-add-btn" onclick="closeMyBill()">CLOSE</button>';
      $('myBillOverlay').classList.add('active');
      return;
    }
    let rows = '';
    items.forEach(it => {
      rows += '<tr><td>' + it.name + '</td><td class="num">' + it.qty + '</td><td class="amt">' + formatPrice(it.price) + '</td><td class="amt">' + formatPrice(it.price * it.qty) + '</td></tr>';
    });
    content.innerHTML = '<div class="receipt-bill">' +
      '<div class="rb-botanical-tl">\ud83c\udf3f</div>' +
      '<div class="rb-botanical-br">\ud83c\udf3f</div>' +
      '<div class="rb-header"><div class="rb-stars">\u2736  \u2736  \u2736</div><div class="rb-cafe">THE OREGANO CAFE</div><div class="rb-tag">Premium Cafe \u00b7 Est. 2019 \u00b7 Bhiwandi</div></div>' +
      '<div class="rb-section-title">Bill Preview</div>' +
      '<div class="rb-meta"><div><span>Table No.</span><strong>' + currentTable + '</strong></div><div><span>Session</span><strong>' + result.session.id + '</strong></div></div>' +
      '<table class="rb-table"><thead><tr><th class="rb-th-num">#</th><th>Item</th><th class="num">Qty</th><th class="amt">Price</th><th class="amt">Total</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="rb-totals"><div class="rb-trow grand"><span>TOTAL SO FAR</span><span>' + formatPrice(result.total) + '</span></div></div>' +
      '<div class="rb-paystatus unpaid"><div class="rb-ps-label">Payment Status</div><div class="rb-ps-value">BILL NOT GENERATED</div><div class="rb-ps-sub">Ask our staff to generate your bill.</div></div>' +
      '</div>' +
      '<div class="bill-no-print" style="text-align:center;margin-top:16px"><button class="btn-view" style="padding:12px 24px" onclick="closeMyBill()">CLOSE</button></div>';
  }
  $('myBillOverlay').classList.add('active');
}

function printMyBill(){
  var billEl = document.querySelector('#myBillContent #printableBill');
  if (!billEl) { showToast('Nothing to print.'); return; }
  var billHTML = billEl.outerHTML;
  var printCSS = [
    '@page { size: A4 portrait; margin: 18mm 15mm; }',
    'body { font-family: Inter, -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 0; background: #fff; color: #2B211B; -webkit-print-color-adjust: exact; print-color-adjust: exact; line-height: 1.6; }',
    '.receipt-bill { max-width: 100%; box-shadow: none; border: none; border-radius: 0; padding: 28px 24px 20px; background: #FCF9F3; border: none; border-top: 3px solid #243B2A; }',
    '.rb-botanical-tl, .rb-botanical-br { display: none; }',
    '.rb-header { padding-bottom: 18px; margin-bottom: 16px; }',
    '.rb-header::before { background: #E8DDCC; }',
    '.rb-cafe { font-size: 20px !important; letter-spacing: 4px; color: #243B2A; }',
    '.rb-tag { font-size: 7.5px; letter-spacing: 3px; }',
    '.rb-section-title { font-size: 10px; margin: 18px 0 12px; }',
    '.rb-meta { padding: 12px 10px; margin-bottom: 2px; }',
    '.rb-meta span { font-size: 7px; }',
    '.rb-meta strong { font-size: 11px; }',
    '.rb-table { width: 100%; border-collapse: collapse; }',
    '.rb-table th { font-size: 6.5px; padding-bottom: 7px; }',
    '.rb-table td { padding: 7px 4px; font-size: 10.5px; }',
    '.rb-table th.rb-th-num, .rb-table td.rb-td-num { text-align: center; width: 32px; }',
    '.rb-table th.num, .rb-table td.num { text-align: center; }',
    '.rb-table th.amt, .rb-table td.amt { text-align: right; }',
    '.rb-trow.grand { padding: 12px 4px 6px; }',
    '.rb-trow.grand span:first-child { font-size: 9px; }',
    '.rb-trow.grand span:last-child { font-size: 20px; }',
    '.rb-paystatus { margin-top: 14px; padding: 12px 10px; }',
    '.rb-paymethod { padding: 12px 10px; }',
    '.rb-thanks { padding-top: 16px; margin-top: 12px; }',
    '.rb-thanks::before { background: #FCF9F3; }',
    '.bill-no-print { display: none !important; }'
  ].join('\n');
  var printDoc = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Bill - The Oregano Cafe</title><style>' + printCSS + '</style></head><body>' + billHTML + '</body></html>';
  var printWindow = window.open('', '_blank', 'width=800,height=600');
  if (!printWindow) { showToast('Please allow popups to print the bill.'); return; }
  printWindow.document.open();
  printWindow.document.write(printDoc);
  printWindow.document.close();
  printWindow.focus();
  setTimeout(function(){ try { printWindow.print(); } catch(e) { console.warn('[PRINT] failed:', e.message); } }, 500);
}

function closeMyBill(){ $('myBillOverlay').classList.remove('active'); }
if(!isAdminPage){
  const mbBtn = $('myBillBtn');
  if (mbBtn) mbBtn.addEventListener('click', loadMyBill);
  const mbOv = $('myBillOverlay');
  if (mbOv) mbOv.addEventListener('click', e => { if (e.target === mbOv) closeMyBill(); });
}

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
